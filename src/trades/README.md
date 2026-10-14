# 持仓交易流水（FIFO 成本）功能

在独立目录 `src/trades/` 中实现，目的是在跟随上游仓库同步升级时，把与本功能相关的代码冲突面收敛到最小。

## 功能概述

- 按持仓开关：`holdings.trade_mode`（0=手动 / 1=交易驱动）。
- 开启后，持仓的 `qty` / `avg_cost` / `realized_pnl` 由交易流水按 **FIFO 逐笔法** 自动计算并锁定（不可手改）。
- 开启时若已有存量且无流水，自动插入一笔「开仓基准」买入（seed=1），保证成本平滑接续。
- 未开启时维持原有手动模式，不受影响。

## 文件组成

| 文件 | 说明 |
| --- | --- |
| `src/trades/calc.ts` | 纯函数 FIFO 核算（无 D1/框架依赖，可独立单测） |
| `src/trades/repo.ts` | D1 读写、开仓基准、交易 → holdings 同步写回 |
| `src/trades/routes.ts` | Hono 子路由，挂载于 `/api/holdings/:id/trades` |
| `src/trades/ui/api.ts` | 自包含前端 API 客户端 |
| `src/trades/ui/TradesPage.tsx` | 交易管理页（路由 `/trades/:holdingId`） |
| `migrations/0008_trades.sql` | 追加式迁移：trades 表 + holdings 扩展列 + schema_version=7 |
| `tests/trades/calc.test.ts` | FIFO 单测 |

## 接线点（上游同步后需核对，丢失则重新应用）

1. `src/shared/version.ts` — `SCHEMA_VERSION` 升到 7（与 0008 迁移的 schema_version 对应）。
2. `src/worker/api/index.ts` — 挂载交易子路由（约 1 行）。
3. `src/worker/api/holdings.routes.ts` — PATCH 锁定栅栏：交易驱动时禁止手改 qty/avg_cost（见该文件内注释）。
4. `src/worker/types.ts` — `HoldingRow` 增加 `trade_mode`、`realized_pnl` 字段。
5. `src/shared/api-types.ts` — `HoldingDto` / `HoldingListDto` 增加对应可选字段。
6. `src/web/App.tsx` — lazy 引入 `TradesPage` + 路由分发（`/trades/*`）。
7. `src/web/pages/Holdings.tsx` — 持仓行增加「交易」入口按钮。

> 注意：`holdings.routes.ts` 第 125 行附近的锁定栅栏若被上游重写丢失，需按本 README 重新应用。

## 验证

```bash
npm run lint                       # 4 个 tsconfig 全绿
npm run build                      # vite build 成功
npx vitest run --maxWorkers=1      # 全部测试（含 calc.test.ts）
```

Windows 本地 `npm run build` 的 prebuild `check:env` 会因 workerd 平台包命名误报失败（上游脚本 bug，Linux CI 正常），可直接 `npx vite build` 验证。
