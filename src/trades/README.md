# 持仓交易流水 + 多成本法（`src/trades/`）

本功能整体隔离在独立目录 `src/trades/` 中，只用少量「接线点」接入上游主程序，
目的是跟随上游仓库同步升级时把冲突面收敛到最小。

> 本 README 是**长期留存的完整说明**。时间久了照它即可恢复认知、修复被上游覆盖的接线点、
> 或在需要时重新生成补丁。文中所有路径、常量、公式均与当前代码一致。

## 0. 摘要

- 引入提交：`550ec03`（交易流水 / FIFO 逐笔）、`d204ca1`（多成本法）、`3b2b00c`（流水备注列漏查修复）
- 迁移：`migrations/0008_trades.sql`（`schema_version` = 7）、`migrations/0009_cost_method.sql`（= 8）
- `SCHEMA_VERSION`：7 → **8**（`src/shared/version.ts`）；`APP_VERSION` 当前 `0.13.0`
- 事实来源：`trades` 流水表是唯一事实来源；`holdings.qty / avg_cost / realized_pnl` 是**派生**结果
- 两个能力：
  1. **交易驱动**（按持仓开关 `holdings.trade_mode`）：开启后数量与成本由流水自动回算并锁定，禁止手改
  2. **多成本法**（按账户配置 `accounts.cost_method`）：`fifo` / `weighted` / `diluted` 三口径，账户下所有持仓统一跟随

## 1. 数据模型

### 1.1 `migrations/0008_trades.sql`（schema_version = 7）

```sql
ALTER TABLE holdings ADD COLUMN trade_mode INTEGER NOT NULL DEFAULT 0;  -- 0 手动 / 1 交易驱动
ALTER TABLE holdings ADD COLUMN realized_pnl REAL;                      -- 交易驱动持仓的累计已实现盈亏

CREATE TABLE IF NOT EXISTS trades (
  id          TEXT PRIMARY KEY,
  holding_id  TEXT NOT NULL REFERENCES holdings (id) ON DELETE CASCADE,
  side        TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  qty         REAL NOT NULL,
  price       REAL NOT NULL,              -- 成交单价（交易币种）
  fee         REAL NOT NULL DEFAULT 0,    -- 手续费：买加进成本、卖从收入扣除
  seed        INTEGER NOT NULL DEFAULT 0, -- 1 = 开启 trade_mode 时由既有持仓自动生成的「开仓基准」买入
  traded_at   TEXT NOT NULL,              -- 交易日 YYYY-MM-DD
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_holding ON trades (holding_id, traded_at, id);

INSERT INTO settings (key, value) VALUES ('schema_version', '7')
  ON CONFLICT (key) DO UPDATE SET value = '7';
```

设计要点：**只新增一张表 + 两个可选列**，不动任何既有字段/行为。`holdings.qty / avg_cost` 平时仍由主程序写；
只有当某持仓开启 `trade_mode` 后，才改由交易流水回算并写回。

### 1.2 `migrations/0009_cost_method.sql`（schema_version = 8）

```sql
ALTER TABLE accounts ADD COLUMN cost_method TEXT NOT NULL DEFAULT 'fifo';

INSERT INTO settings (key, value) VALUES ('schema_version', '8')
  ON CONFLICT (key) DO UPDATE SET value = '8';
```

口径挂在**账户**上（不是持仓）：账户下所有持仓统一跟随；切换口径只改账户配置并重算，流水不丢、可随时切回。

### 1.3 相关类型

- `src/worker/types.ts`：`AccountRow.cost_method: CostMethod`；`HoldingRow` 增加 `trade_mode?: number`、`realized_pnl?: number | null`
- `src/shared/api-types.ts`：`HoldingDto` 增加对应的可选字段
- `src/shared/labels.ts`：`COST_METHODS = ["fifo", "weighted", "diluted"] as const`、`costMethodLabel(t, value)`
- `src/shared/locales/zh.ts` / `en.ts`：`accounts.costMethod`、`costMethod.fifo|weighted|diluted` 文案

## 2. 核心概念

| 概念 | 取值 / 含义 |
| --- | --- |
| `holdings.trade_mode` | `0` 手动（原行为）；`1` 交易驱动：`qty/avg_cost/realized_pnl` 由流水推导并锁定 |
| `accounts.cost_method` | `fifo`（默认）/ `weighted` / `diluted`，账户级 |
| seed 开仓基准 | 开启交易驱动且**已有存量、无流水**时，自动补一笔 `seed=1` 的买入，使成本平滑接续 |
| 事实来源 | `trades` 表；`holdings` 的三个列是可被随时重算的派生值 |

**seed 开仓基准的生成规则**（`repo.ts` → `enableTradeMode`）：

- 触发条件：`holding.trade_mode !== 1` 且 `listTrades()` 为空 且 `holding.qty > 0`
- 写入内容：`id = "seed:<holdingId>"`、`side = 'buy'`、`qty = holding.qty`、
  `price = holding.avg_cost ?? holding.price`、`fee = 0`、`seed = 1`、
  `traded_at = (holding.created_at ?? now).slice(0, 10)`、`note = '开仓基准（切换自原持仓）'`
- 该笔在界面上标为「开仓基准」且**不可编辑/删除**（前端按 `seed` 标识隐藏操作按钮）

## 3. 成本口径与计算细节（`src/trades/calc.ts`）

`calc.ts` 是**纯函数模块**：无任何 I/O / 框架依赖，可独立单测。

- 与主程序的隔离约定：本模块只读"交易流水"，不直接读写数据库；所有数量/单价/手续费按**交易币种**计
  （汇率由主程序统一折算）；同一持仓的流水按 `(traded_at, id)` 稳定排序后逐笔处理。
- 排序：`sortTrades` 先按 `traded_at` 字典序，再按 `id` 字典序（保证同日多笔可复现）。
- 浮点容差：`EPS = 1e-9`，`nearZero(v)` = `|v| < EPS`。

### 3.1 `fifo` 先进先出（默认）

- 买入：整笔入一批，**批成本 = qty × price + fee**
- 卖出：从最早批次开始消耗；被消耗批次的成本，整批消耗取整批成本，部分消耗按数量比例分摊：
  `allocatedCost = lot.cost * (consumed / lot.qty)`（整批时即 `lot.cost`）
- 卖出净收入 `netProceeds = qty × price − fee`，按消耗量占比分摊：`allocatedProceeds = netProceeds × (consumed / qty)`
- `realizedPnl += allocatedProceeds − allocatedCost`
- 汇总：`qty = Σ剩余批次数量`；`cost = Σ剩余批次成本`；`avgCost = qty>EPS ? cost/qty : null`（无持仓或清仓为 `null`）
- `lots`：仅 FIFO 有实际内容（`weighted`/`diluted` 为空数组，界面据此隐藏批次透视）

### 3.2 `weighted` 移动加权平均

- 买入（含费金额 `buyAmount = qty × price + fee`）：
  - `qty > EPS`：`avgCost = (qty × avgCost + buyAmount) / (qty + qty_buy)`
  - `qty ≈ 0`：`avgCost = buyAmount / qty_buy`（清仓后从该笔重新起算）
- 卖出：**均价不变**；`realizedPnl += allocatedProceeds − consumed × avgCost`（只消耗手上有的部分）
- 清仓（`qty ≈ 0`）后 `avgCost = null`
- 汇总：`cost = qty × avgCost`（无持仓为 0）

### 3.3 `diluted` 摊薄成本

- `avg_cost = (Σ买入含费 − Σ卖出净额) ÷ 当前持有数量`
- 买入：`totalBuy += qty × price + fee`；`qty += qty`
- 卖出：`netProceeds = qty × price − fee`；只消耗手上有的部分 `consumed = min(qty, qty_sell)`；
  `totalSell += netProceeds × (consumed / qty_sell)`；`qty −= consumed`
- 汇总：`cost = qty > EPS ? totalBuy − totalSell : 0`；`avgCost = qty>EPS ? cost/qty : null`
- **`realizedPnl` 恒为 0**：盈亏已融入剩余成本，再算即双重计算（界面显示「不适用」）

### 3.4 卖超处理（三口径一致）

若某笔卖出量超过当时剩余持仓（正常流程由 `checkTradeValid` 挡住），计算层**不崩溃**：
把超出部分计入 `oversoldQty`（并把对应净收入按比例计入 `soldProceeds`）。

### 3.5 `checkTradeValid(current, targetId, next)`

- 用途：写入/删除交易前，校验不会破坏「卖出不超持仓」约束（与成本口径无关，用 FIFO 判定即可，卖超量对三口径一致）
- 做法：先从 `current` 去掉 `targetId`，再加入替换后的 `next`（`next = null` 表示删除），重算 FIFO
- 返回：通过 `null`；不通过返回中文原因（`next.qty <= EPS` → `"交易数量必须大于 0"`；
  `oversoldQty > EPS` → `"交易调整后卖出数量将超过剩余持仓，请先核对交易流水"`）

## 4. 写回与生命周期（`src/trades/repo.ts`）

| 函数 | 行为 |
| --- | --- |
| `listTrades(db, holdingId)` | `SELECT id, side, qty, price, fee, seed, note, traded_at FROM trades WHERE holding_id = ? ORDER BY traded_at ASC, id ASC`，映射为 `TradeLike` |
| `getTrade(db, id)` | 按 id 取单条 |
| `toTradeLike(row)` | D1 行 → 计算层形状：`side` 非 `'sell'` 一律当 `'buy'`；`fee ?? 0`；`seed = (seed ?? 0) === 1` |
| `createTrade(db, holdingId, input)` | 先 `checkTradeValid`（卖超即抛 `INVALID_TRADE:...`）→ INSERT（`seed=0`）→ `recomputeHolding` |
| `updateTrade(db, holdingId, tradeId, patch)` | 取原值合并出 `next` → `checkTradeValid` → UPDATE → `recomputeHolding` |
| `deleteTrade(db, holdingId, tradeId)` | 取原值 → `checkTradeValid(existing, tradeId, null)` → DELETE → `recomputeHolding` |
| `accountCostMethod(db, accountId)` | 读 `accounts.cost_method`；非 `weighted`/`diluted` 一律回退 `fifo`（兼容老库无此列） |
| `recomputeHolding(db, holdingId)` | 取持仓所属账户口径 → 读全部流水 → `computeState` → 回写 `holdings.qty / avg_cost / realized_pnl`（数值经 `roundMoney` 保留 6 位小数）；**每次交易增改删都会调用** |
| `recomputeByAccount(db, accountId)` | 取该账户下所有 `trade_mode = 1` 的持仓，逐个 `recomputeHolding`（切口径后重算） |
| `enableTradeMode(db, holdingId)` | 已开启则直接重算返回（幂等）；否则必要时补 seed → 置 `trade_mode = 1` → 重算 |
| `disableTradeMode(db, holdingId)` | 先 `recomputeHolding` 冻结当前值 → 置 `trade_mode = 0`（**不清空任何交易记录**，`qty/avg_cost` 保留已算出的值，转为手动可编辑） |
| `roundMoney(v)` | `Math.round(v * 1e6) / 1e6` |

常量：`TRADE_MODE_OFF = 0`、`TRADE_MODE_ON = 1`。

### ⚠️ 重要行为提醒

**任何交易写入（create / update / delete）都会调用 `recomputeHolding`，无论 `trade_mode` 是否开启。**
`recomputeHolding` 会把 `holdings.qty / avg_cost / realized_pnl` **无条件覆盖**为流水推导值。
因此：对**未开启**交易驱动的持仓录入流水，也会改变它的数量与成本
（路由注释写的是「未开启时允许读流水、允许写（供先录入后开启）」——即允许先录入，但要意识到它会接管数值）。

## 5. HTTP API（`src/trades/routes.ts`）

挂载点：`guarded.route("/holdings/:id/trades", tradesRoutes)`（`src/worker/api/index.ts`），
`guarded` 已套 `requireInitialized` + `requireAuthOrPublicRead`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/holdings/:id/trades` | 返回交易视图（见下） |
| POST | `/api/holdings/:id/trades` | 新增交易，201 + 最新视图 |
| PATCH | `/api/holdings/:id/trades/:tid` | 修改交易，返回最新视图 |
| DELETE | `/api/holdings/:id/trades/:tid` | 删除交易，返回最新视图 |
| POST | `/api/holdings/:id/trades/enable` | 开启交易驱动（必要时补 seed），返回最新视图 |
| POST | `/api/holdings/:id/trades/disable` | 关闭交易驱动（冻结当前值、保留流水），返回最新视图 |

**交易视图 `tradesView`**：`{ holdingId, tradeMode, costMethod, holding{id,name,symbol,market,currency,qty,avgCost,realizedPnl,price}, trades, state }`。

**请求体解析（`parseTradePayload`）**：

- `side`：`requireOneOf(["buy","sell"])`；新增必填
- `qty`：`requireNumber(min 0, max 1e15)`；新增必填
- `price`：`requireNumber(min 0, max 1e15)`；新增必填
- `fee`：可选，默认 0（`optionalNumber(min 0, max 1e15) ?? 0`）
- `tradedAt`：`requireString(max 10)` + 必须匹配 `/^\d{4}-\d{2}-\d{2}$/`，否则 `交易日期格式应为 YYYY-MM-DD`
- `note`：可选字符串，最长 200

所有变更操作都会 `writeAudit(...)` 写审计（`entity: "holding"`），note 分别为
「新增交易流水 / 修改交易 <id> / 删除交易 <id> / 开启交易流水驱动 / 关闭交易流水驱动」。

## 6. 前端

- `src/trades/ui/api.ts`：**自包含** fetch 客户端（不依赖 `src/web/lib/api.ts`，保证本目录可整体独立同步）。
  导出 `TradesView`、`TradeInput`、`tradesApi { get, create, update, remove, enable, disable }`。
- `src/trades/ui/TradesPage.tsx`：路由 `/trades/:holdingId`。
  - 顶部按钮切换交易驱动（开启前 `window.confirm` 提示「已有持仓会自动生成一笔开仓基准」）
  - 汇总卡：剩余数量 / 平均成本（带口径名）/ 累计已实现盈亏（`diluted` 显示「不适用」）
  - 录入/编辑表单：方向、日期、数量、单价、手续费、备注
  - 流水表：日期 / 方向（seed 标「开仓基准」）/ 数量 / 单价 / 手续费 / 备注 / 操作（seed 行不显示编辑删除）
  - FIFO 批次透视（仅 `state.lots.length > 0` 时显示：来源 / 买入日期 / 剩余数量 / 成本单价 / 剩余成本）
- `src/web/App.tsx`：`lazy` 引入 `TradesPage`；`path.startsWith("/trades")` → `<TradesPage />`
- `src/web/pages/Holdings.tsx`：非 `cash` 持仓行增加「交易」按钮 → `navigate('/trades/' + holding.id)`
- `src/web/pages/Accounts.tsx`：表单新增「成本口径」下拉（`COST_METHODS`），列表新增「成本口径」列

## 7. 接线点清单（上游同步后逐一核对，丢失则按本文重新应用）

| 文件 | 改动 |
| --- | --- |
| `migrations/0008_trades.sql` | 新增（编号可能与上游冲突，冲突时改名后手动迁移） |
| `migrations/0009_cost_method.sql` | 新增（同上） |
| `src/shared/version.ts` | `SCHEMA_VERSION` → `8` |
| `src/shared/api-types.ts` | `HoldingDto` 增加 `trade_mode?` / `realized_pnl?` / `cost_method` |
| `src/shared/labels.ts` | `COST_METHODS` + `costMethodLabel` |
| `src/shared/locales/zh.ts`、`en.ts` | `accounts.costMethod`、`costMethod.fifo|weighted|diluted` |
| `src/worker/types.ts` | `AccountRow.cost_method`、`HoldingRow.trade_mode|realized_pnl` |
| `src/worker/data/accounts.repo.ts` | `cost_method` 列读写（INSERT / UPDATE / 默认 `fifo`） |
| `src/worker/api/accounts.routes.ts` | 创建/更新接受 `costMethod`；口径变化时 `recomputeByAccount(db, id)` |
| `src/worker/api/index.ts` | `guarded.route("/holdings/:id/trades", tradesRoutes)` |
| `src/worker/api/holdings.routes.ts` | **锁定栅栏**：`trade_mode === 1` 且 payload 含 `qty`/`avgCost` → `badRequest("该持仓已启用交易流水驱动…不可手改")` |
| `src/worker/services/backup.ts` | 备份读写保留 `accounts.cost_method`（落库时 `row.cost_method ?? "fifo"`） |
| `src/web/App.tsx` | lazy `TradesPage` + `/trades` 路由分发 |
| `src/web/pages/Holdings.tsx` | 「交易」入口按钮 |
| `src/web/pages/Accounts.tsx` | 口径下拉 + 列表列 |
| `tests/trades/calc.test.ts` | 单测（FIFO / weighted / diluted / `checkTradeValid`） |

> `holdings.routes.ts` 的锁定栅栏最易被上游重写覆盖，且代码里有指向本 README 的注释，务必核对。

## 8. 已知限制与缺口（如实记录）

1. **备份不覆盖交易流水**：`src/worker/services/backup.ts` 的导出表清单**不含 `trades`**；
   导入时 `HOLDING_COLUMNS` 也**不含 `trade_mode` / `realized_pnl`**。
   ⇒ 从备份恢复后，交易驱动状态会丢失（回到手动），且流水与已实现盈亏不在备份里。
   如需要完整备份，须另行扩展 `backup.ts`（当前未覆盖，属已知缺口）。
2. **关闭交易驱动不会删除流水**：`disableTradeMode` 冻结当前 `qty/avg_cost` 为手动值，流水全部保留。
3. **账户切口径会重算账户下所有交易驱动持仓**（`recomputeByAccount`），非交易驱动的持仓不受影响。
4. **`diluted` 口径下 `realized_pnl` 恒为 0**，界面显示「不适用」，不要据此判断盈亏。
5. **seed 流水不可改删**：它是成本接续的锚点；若需调整，应先关闭再重开交易驱动。
6. **口径是账户级**：无法对同一账户下的不同持仓分别设口径。

## 9. 验证

```bash
npm run lint                       # 4 个 tsconfig 全绿
npx vite build                     # 构建（见下方 Windows 说明）
npx vitest run --maxWorkers=1      # 全部测试（含 tests/trades/calc.test.ts、tests/api/custom-nav.test.ts）
```

Windows 本地 `npm run build` 会卡在 prebuild 的 `check:env`（node_modules 里是 `workerd-windows-64`，
当前 Node 需要 `workerd-win32-64`，属上游脚本 bug，Linux CI 正常），可直接用 `npx vite build` 绕开。

## 10. 提交历史（便于回溯）

| 提交 | 说明 |
| --- | --- |
| `550ec03` | feat: 持仓交易流水（FIFO 逐笔成本，按持仓开关，独立于 src/trades/） |
| `d204ca1` | feat: 多成本法（账户级口径：FIFO / 移动加权平均 / 摊薄成本） |
| `3b2b00c` | fix: 交易流水备注不显示（`listTrades` 漏查 `note` 列，`toTradeLike` 未映射） |
| `dc695c8` | 补丁基线（custom.patch 以此为基准，见 `custom-patches/README.md`） |

## 11. 上游仓库更新后的恢复办法

**前提认知**：本功能 = 独立目录 `src/trades/` + 两个迁移 + 若干上游接线点 + 一个锁定栅栏。
上游更新**不会动** `src/trades/` 目录本身，可能覆盖的是**接线点**，也可能**占用迁移编号**。
按下面从上到下核对一遍即可恢复到可用状态。

### 11.1 更新流程

```powershell
git fetch upstream
git merge upstream/main          # 或 git rebase upstream/main
git status --short
```

### 11.2 迁移编号冲突（最容易被忽略）

上游若新增了 `migrations/0008*.sql` 或 `0009*.sql`，**不要覆盖**，把我们的两个迁移改成下一个可用编号：

- `migrations/0008_trades.sql` → 如 `0010_trades.sql`
- `migrations/0009_cost_method.sql` → 如 `0011_cost_method.sql`
- 改完后，**每个迁移文件末尾的 `INSERT INTO settings ... schema_version` 值、以及 `src/shared/version.ts` 的
  `SCHEMA_VERSION`，必须互相一致**（取「上游最大编号 + 我们的迁移数」）。
- 部署链路必须保证**自动执行迁移**，否则代码与库结构版本不一致会触发「数据库需要升级」门禁。

> 判断方法：`SELECT value FROM settings WHERE key='schema_version'` 应等于代码里的 `SCHEMA_VERSION`。
> 当前值：`SCHEMA_VERSION = 8`（对应 0009 迁移）。

### 11.3 逐处核对与恢复

按下面顺序核对，缺失就粘贴回去：

**① `src/shared/version.ts`** — `SCHEMA_VERSION`（当前 `8`，或上游更大值 + 我们的迁移数）

**② `src/worker/api/index.ts`** — 挂载交易子路由

```ts
import tradesRoutes from "../../trades/routes";
// ...
guarded.route("/holdings/:id/trades", tradesRoutes); // 独立功能：持仓交易流水（src/trades/）
```

**③ `src/worker/api/holdings.routes.ts`** — **锁定栅栏（最易被上游重写覆盖！）**
在 PATCH 处理里、构造 `patch` 之前加：

```ts
// ── 独立功能「交易流水」的锁定栅栏（src/trades/）─────────────────
if ((before.trade_mode ?? 0) === 1 && (payload.qty !== undefined || payload.avgCost !== undefined)) {
  throw badRequest("该持仓已启用交易流水驱动，数量与平均成本由交易自动计算，不可手改");
}
```

需确认该文件已有 `badRequest` 导入、`payload`（`asRecord` 结果）与 `before`（改前记录）可用。

**④ `src/web/App.tsx`** — lazy 引入 + 路由分发

```tsx
const TradesPage = lazy(() => import("../trades/ui/TradesPage").then((module) => ({ default: module.TradesPage })));
// ...
if (path.startsWith("/trades")) return <TradesPage />;
```

**⑤ `src/web/pages/Holdings.tsx`** — 非 `cash` 持仓行加「交易」入口

```tsx
{holding.class !== "cash" && (
  <button className="ghost" onClick={() => navigate(`/trades/${holding.id}`)}>交易</button>
)}
```

**⑥ `src/worker/api/accounts.routes.ts`** — 口径参数 + 切口径后重算

```ts
import { recomputeByAccount } from "../../trades/repo";
// 创建：cost_method: payload.costMethod === undefined ? "fifo" : requireOneOf(payload, "costMethod", COST_METHODS, "accounts.costMethod", t)
// 更新：if (payload.costMethod !== undefined) patch.cost_method = requireOneOf(payload, "costMethod", COST_METHODS, "accounts.costMethod", t);
if (patch.cost_method !== undefined && patch.cost_method !== (before.cost_method ?? "fifo")) {
  await recomputeByAccount(c.env.DB, id);
}
```

**⑦ `src/worker/data/accounts.repo.ts`** — `cost_method` 列（INSERT / UPDATE，缺省 `"fifo"`）

**⑧ `src/worker/types.ts`** — `AccountRow.cost_method: CostMethod`；`HoldingRow` 加 `trade_mode?: number`、`realized_pnl?: number | null`

**⑨ `src/shared/api-types.ts`** — `HoldingDto` 加对应可选字段；`src/shared/labels.ts` — `COST_METHODS` + `costMethodLabel`

**⑩ `src/shared/locales/zh.ts`、`en.ts`** — `accounts.costMethod`、`costMethod.fifo|weighted|diluted`

**⑪ `src/web/pages/Accounts.tsx`** — 表单「成本口径」下拉 + 列表「成本口径」列

**⑫ `src/worker/services/backup.ts`** — 备份读写保留 `accounts.cost_method`
（并注意：备份**不覆盖 `trades` 表与 `trade_mode/realized_pnl`**，见第 8 节第 1 条，这是已知缺口）

### 11.4 一键校验

```powershell
Select-String -Path src\worker\api\index.ts -Pattern "trades"
Select-String -Path src\worker\api\holdings.routes.ts -Pattern "trade_mode"
Select-String -Path src\shared\version.ts -Pattern "SCHEMA_VERSION"
npx vitest run --maxWorkers=1 tests/trades/calc.test.ts    # FIFO/weighted/diluted/checkTradeValid 全绿
npm run lint
npx vite build
```

### 11.5 整体丢失时的兜底

- `src/trades/` 目录自包含（只依赖上游的 `worker/core`、`worker/data`、`worker/api/validate` 等公共模块），
  可直接从历史取回：`git checkout <commit> -- src/trades/`
- 也可运行 `custom-patches/restore.ps1`（`git apply --3way --exclude="migrations/*" --exclude="src/trades/README.md"`
  主体补丁 + migrations 单独处理），但它依赖的 `custom.patch` **已报废、需重新生成**，
  见 `custom-patches/README.md`。migrations 与 README 被刻意排除，需按本文手工恢复。

### 11.6 冲突处理

- `holdings.routes.ts` 冲突最常见：按 11.3 ③ 的片段重新插回，别整体覆盖上游改动。
- `accounts.routes.ts` / `accounts.repo.ts` 冲突：保住 `cost_method` 参数、列与 `recomputeByAccount` 调用。
- `version.ts` 冲突：取「上游值」与「8」的较大者，并确保与迁移里的 `schema_version` 一致。
