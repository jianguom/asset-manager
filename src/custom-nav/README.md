# 自定义导航菜单（`src/custom-nav/`）

在顶栏追加自定义菜单项：每项可 **iframe 嵌入当前应用壳** 或 **新标签打开**。
全部代码隔离在独立目录 `src/custom-nav/`，**零数据库迁移**，配置整体存进现有 settings 表的 KV。

> 本 README 是长期留存的完整说明：设计、类型、API、前端、CSS 高度方案、接线点、踩过的坑、已知限制。

## 0. 摘要

- 引入提交：`1644a37`（菜单功能）、`cf09e14`（管理弹窗 Portal 修复）、
  `779e598`（曾支持手动宽高锁定，已于 2026-10-21 移除）、`22d6d2e`（iframe 背景透明 + 移除加载提示与「在新标签打开」入口）
- **嵌入尺寸**：菜单不配宽高；外层容器 PC 端最大 1200px 居中、移动端撑满，iframe 宽度 100%、高度跟随被嵌页面内容
- **零迁移**：不建表、不 bump `SCHEMA_VERSION`，配置存 `settings` 表 KV key = `custom_nav_items`
- 接线点仅 **3 处**：`src/worker/api/index.ts`、`src/web/App.tsx`、`public/_headers`
- 前端 API 客户端 / 文案字典均**自包含**，不依赖 `src/web/lib/*`，保证本目录可整体独立同步

## 1. 设计原则

- **零迁移**：配置是一个 JSON 数组，整表存进 `settings` 表的一行 KV；上游升级不会碰它。
- **零侵入接线**：只在上游文件里追加挂载/渲染/路由分支，不修改原有逻辑。
- **自包含**：前端不 import 上游的 api / i18n 文件，自己带一份 fetch 客户端与中英字典
  （刻意不写进 `src/shared/locales/*`，避免制造上游冲突面）。

## 2. 类型与常量（`src/custom-nav/types.ts`）

```ts
export type CustomNavMode = "embed" | "tab";

export interface CustomNavItem {
  id: string;            // 短 id：字母数字与连字符，用于站内路由 /custom/:id
  name: string;          // 菜单显示名
  url: string;           // http/https
  mode: CustomNavMode;
}

export const CUSTOM_NAV_SETTING_KEY = "custom_nav_items";
export const CUSTOM_NAV_MAX_ITEMS = 20;
export const CUSTOM_NAV_NAME_MAX = 40;
export const CUSTOM_NAV_URL_MAX = 1000;
```

函数：

- `sanitizeCustomNavItem(value)`：单条清洗。`id` 必须匹配 `/^[a-zA-Z0-9-]{1,40}$/`；
  `name` 非空且 ≤ 40；`url` 非空且 ≤ 1000 且协议为 `http:`/`https:`；`mode` 非 `tab` 时按 `embed` 兜底。
  **尺寸不再是配置项**：历史数据里的 `width` / `height` 会被丢弃（下次保存即清理干净）
- `parseCustomNavItems(raw)`：整体解析，坏数据回退空列表（不影响主页渲染），最多取 20 项
- `serializeCustomNavItems(items)`：序列化存库

> `id` 上限 40 是为兼容「前端曾用 36 位 UUID 导致保存被拒」的历史数据；
> 当前前端生成的 id 是 16 位（见 `ui/ManagePanel.tsx` 的 `newId()`）。

## 3. 服务端路由（`src/custom-nav/routes.ts`）

挂载点：`guarded.route("/custom-nav", customNavRoutes)`（`src/worker/api/index.ts`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/custom-nav` | `{ items }`，供顶栏渲染 |
| PUT | `/api/custom-nav` | 整表替换（管理面板保存），`{ items }` → `{ items }` |

PUT 校验：`items` 必须数组；逐条 `sanitizeCustomNavItem`，任一非法即整体 `400`；
超过 20 项 `400`；`id` 重复 `400`。写库前后取旧值写 `writeAudit`（`entity: "settings"`）。

## 4. 前端

- `src/custom-nav/ui/api.ts`：**自包含** fetch 客户端（`navApi.get()` / `navApi.put(items)`），
  自带 `CustomNavApiError`，不依赖 `src/web/lib/api.ts`
- `src/custom-nav/ui/store.ts`：模块级 Promise 缓存 + 订阅通知
  （`getNavItems(force)`、`saveNavItems(items)`、`subscribeNav(listener)`），
  顶栏与嵌入页读同一份配置，保存后通知刷新
- `src/custom-nav/ui/text.ts`：自包含中英字典（`navText(lang)`）
- `src/custom-nav/ui/CustomNav.tsx`：两个子组件
  - `CustomNavLinks`：菜单链接，`embed` 走站内 `Link → /custom/:id`，`tab` 走 `<a target="_blank" rel="noopener noreferrer">`
  - `CustomNavGear`：齿轮管理入口，**用 `createPortal` 渲染到 `document.body`**（见第 7 节第 1 条坑）
- `src/custom-nav/ui/ManagePanel.tsx`：管理面板
  - 表单：菜单名称 / 页面地址 / 打开方式（**已无宽高输入**）
  - 支持上下移动、行内编辑、删除；整表 `saveNavItems`
  - `newId()`：16 位（`crypto.randomUUID()` 去连字符后取前 16 位），避免 36 位超服务端上限
- `src/custom-nav/ui/CustomNavPage.tsx`：嵌入页 `/custom/:id`
- `src/custom-nav/ui/custom-nav.css`：前缀 `cnav-`，避免与上游样式冲突

## 5. 嵌入模式的尺寸方案（重点）

菜单里**不再配置宽高**，尺寸完全由「外层容器 + 内容高度」决定：

1. **外层容器 `.cnav-frame` 包住 iframe**：
   - PC 端 `width: 100%; max-width: 1200px; margin: 0 auto; padding: 0 16px`（居中 + 两侧留空）
   - `@media (max-width: 640px)` 去掉 `max-width` 与左右 padding → 移动端直接撑满屏幕
   - `overflow: hidden`，避免出现横向滚动
2. **iframe 宽度**：`width: 100%`，始终跟随容器；屏幕变化时由 CSS 自动重排，无需 JS
3. **iframe 高度**：自动跟随被引用页的内容高度（`CustomNavPage.tsx` 写入 inline `height`）
   - ① **同源**：`onLoad` 直接读 `contentDocument.documentElement/body.scrollHeight`，
     并用 `ResizeObserver` 监听 `documentElement` + `body`，内容变化时实时更新
   - ② **跨源**：读不到文档，改为监听对端 `postMessage`：
     上报格式 `{ type: "cnav:height", height: 1234 }`（也接受纯数字）；
     加载完成与窗口 resize 时主动发 `{ type: "cnav:request-height" }` 请求对端上报。
     只接受 `event.source === iframe.contentWindow` 的消息
   - ③ **都拿不到**（跨源且页面未配合）：CSS 兜底 `height: calc(100dvh - 170px)` + `min-height: 320px`，
     页面自身仍可滚动
   - 屏幕尺寸变化时：同源重新量取，跨源重新请求上报
4. iframe 样式：去边框、`background: transparent`（只透出本站底色）、
   `scrollbar-width: none` / `-ms-overflow-style: none` / `::-webkit-scrollbar` 全程隐藏滚动条（内容仍可滚）。
   sandbox = `allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals`。

> 调参点：容器最大宽度 `1200px`、移动端断点 `640px`、两侧留白 `16px`、兜底高度 `170px`，都在 `custom-nav.css`。
> 已彻底移除旧的 `.app-shell.has-cnav` flex 高度链与 `--cnav-extra` 变量。

## 6. 接线点（上游同步后核对，共 3 处）

| 文件 | 改动 |
| --- | --- |
| `src/worker/api/index.ts` | `guarded.route("/custom-nav", customNavRoutes)` |
| `src/web/App.tsx` | 引入 `CustomNavLinks`/`CustomNavGear`；`<nav>` 中「总览」之后追加 `<CustomNavLinks />`、「设置」之后追加 `<CustomNavGear />`；路由分支 `path.startsWith("/custom")` → `<CustomNavPage />` |
| `public/_headers` | CSP 追加 `frame-src https: http:`（iframe 嵌入外部页面必需）；文件里仍含 `X-Frame-Options: DENY` |

其余全部在 `src/custom-nav/` 独立目录，上游 merge 不会碰它；配置存 settings KV，无需迁移。
`tests/api/custom-nav.test.ts` 是配套回归用例。

## 7. 修复过程时间线（踩过的坑，避免重蹈）

1. **管理弹窗被顶栏 CSS 上下文截断**（`cf09e14`）：顶栏 `backdrop-filter` 会创建包含块，
   把 `position: fixed` 的子元素裁掉 → 改用 `createPortal(...)` 渲染到 `document.body`，`z-index: 9999`。
2. **保存被拒：id 长度超限**：前端曾用 36 位完整 UUID，超过服务端 id 上限 → 前端改生成 16 位短 id，
   服务端同时把 `id` 上限放宽到 40 以兜底历史数据（并补了回归用例）。
3. **菜单位置**：链接要**紧跟「总览」之后**，管理齿轮要**放在「设置」之后** → 拆成两个组件分别挂载。
4. **嵌入页高度适配 / 纵向滚动条**（一长串尝试）：先后试过 `100dvh` 计算、JS 文档坐标测量 + 滚动复位、
   运行时精确测量、绝对定位 `inset: 0`、把 `body` 钉死视口 + `overflow: hidden`、
   `:has()/has-cnav` 拆分、超时兜底气泡，中途定稿为「纯 CSS flex 高度链 + `--cnav-extra` 余量」，
   后又**推翻为当前方案**：菜单不再配宽高 → 外层容器 `max-width: 1200px` 居中 + iframe 高度跟随内容。
5. **iframe 背景**（`22d6d2e`）：改 `background: transparent`，并**删除加载提示气泡与两处「在新标签打开」逃生入口**。
6. **嵌入被拒绝（X-Frame-Options）**：确认该响应头由 **Cloudflare 边缘节点**注入，
   源站（Caddy/应用）的移除配置不生效；需在 Cloudflare 关闭「添加安全性标头」托管转换方可放开 iframe 嵌入。
7. **尺寸配置最终被移除**（2026-10-21）：手动填宽高对多数页面都是「猜」，改为容器统一约束 + 高度跟随内容；
   `types.ts` 删除 `width`/`height`/`CUSTOM_NAV_SIZE_*`/`normalizeSize`，管理面板删除宽高输入与 `宽×高` 角标，
   文案删除 `width`/`height`/`sizeAuto`/`sizeHint`/`invalidSize`，API 测试改为断言「历史宽高被丢弃」。

## 8. 已知限制

1. **`public/_headers` 仍含 `X-Frame-Options: DENY`**：放行 iframe 要靠 Cloudflare 关闭「添加安全性标头」
   托管转换（见第 7 节第 6 条），仅改源站头无效。
2. **被嵌页面自带底色无法透明**：跨域同源策略限制，无法覆盖被嵌站点的文档背景，只能透出本站底色。
3. **嵌入模式已无「在新标签打开」逃生口**：嵌入被拒时，唯一办法是把该菜单改成 `tab` 模式。
4. **配置是全局的**（所有登录用户共享），并非按用户隔离。
5. 最多 20 项；与上游共用 `settings` 表的 KV，key 固定为 `custom_nav_items`。
6. **跨源页面无法自动读取内容高度**（同源策略）：只有同源页面能直接量取；
   跨域页面需要对方主动 `postMessage({ type: "cnav:height", height })` 上报，
   否则退化为视口高度兜底（`calc(100dvh - 170px)`），此时若内容更长会由 iframe 自身滚动。
   隐藏的是滚动条外观，滚动能力仍保留。

## 9. 验证

```bash
npx vitest run --maxWorkers=1 tests/api/custom-nav.test.ts   # 6/6 通过
npm run lint
npx vite build
```

测试覆盖：未登录 401、空列表 → PUT 回读 → 整体覆盖、拒绝非法 url/名称/id、
36 位 UUID 样式 id 可接受（历史回归）、settings 只存一条 `custom_nav_items`（无需迁移）、
历史 `width`/`height` 被丢弃（尺寸改由容器统一控制）。

## 10. 提交历史

| 提交 | 说明 |
| --- | --- |
| `1644a37` | feat: 自定义导航菜单（src/custom-nav/，iframe 嵌入 + 每项新标签，配置存 settings KV 零迁移） |
| `cf09e14` | fix: 管理弹窗被顶栏 `backdrop-filter` 截断 → Portal 渲染到 body，z-index 提到 9999 |
| `779e598` | feat: 嵌入模式菜单支持手动锁定 iframe 宽高 |
| `22d6d2e` | fix: 嵌入页 iframe 背景透明，移除加载提示与「在新标签打开」入口 |
| 2026-10-21 | refactor: 移除手动宽高配置，改外层容器（PC ≤1200px 居中 / 移动端撑满）+ iframe 宽度 100% + 高度跟随内容 |

## 11. 上游仓库更新后的恢复办法

**前提认知**：本功能只在上游 **3 个文件**里「追加」接线；其余（类型、路由、前端组件、CSS、文案）
全部在 `src/custom-nav/` 独立目录内，上游 merge 正常**不会触碰**它们。
所以上游更新后要做的，只是核对这 3 处接线是否还在；缺失就按下面粘贴回去。

### 11.1 更新流程

```powershell
git fetch upstream
git merge upstream/main          # 或 git rebase upstream/main
git status --short               # src/custom-nav/ 下应为 0 冲突（若有冲突，见 11.5）
```

### 11.2 逐处核对与恢复

**① 服务端挂载 —— `src/worker/api/index.ts`**

核对：`Select-String -Path src\worker\api\index.ts -Pattern "custom-nav"`
缺失则加两行（`guarded` 是已套 `requireInitialized` + `requireAuthOrPublicRead` 的那个子应用）：

```ts
import customNavRoutes from "../../custom-nav/routes"; // 独立功能：自定义导航菜单（src/custom-nav/）
// ...
guarded.route("/custom-nav", customNavRoutes); // 独立功能：自定义导航菜单（src/custom-nav/）
```

**② 前端接线 —— `src/web/App.tsx`**

核对：`Select-String -Path src\web\App.tsx -Pattern "CustomNav"`
缺失则加：

```tsx
// 顶部 import 区
import { CustomNavGear, CustomNavLinks } from "../custom-nav/ui/CustomNav";
const CustomNavPage = lazy(() => import("../custom-nav/ui/CustomNavPage").then((module) => ({ default: module.CustomNavPage })));
```

```tsx
// 页面分发（Shell 内的 page 三元链）
if (path.startsWith("/custom")) return <CustomNavPage />;
```

```tsx
// 顶栏 <nav>：保持「总览」之后放链接、「设置」之后放齿轮的语义
{NAV.map((item, index) => (
  <Fragment key={item.to}>
    <Link to={item.to} className={path === item.to ? "active" : ""}>{t(item.key)}</Link>
    {index === 0 && <CustomNavLinks />}                        {/* 紧跟「总览」 */}
    {index === NAV.length - 1 && <CustomNavGear />}            {/* 放在「设置」之后 */}
  </Fragment>
))}
```

> 若上游重写了 `NAV` 结构或改成别的渲染方式，按**语义**落位即可：菜单链接紧跟「总览」，齿轮放在最后一个导航项之后。

**③ CSP 放行 —— `public/_headers`**

核对：`Select-String -Path public\_headers -Pattern "frame-src"`
缺失则在 CSP 行追加 `frame-src https: http:`（iframe 嵌入外部页面必需）：

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-src https: http:; frame-ancestors 'none'
```

注意：该文件里 `X-Frame-Options: DENY` 仍在，真正拦截 iframe 的是 Cloudflare 边缘注入的头，
须在 Cloudflare 关闭「添加安全性标头」托管转换才放行（见第 8 节第 1 条）。

### 11.3 一键校验

```powershell
Select-String -Path src\worker\api\index.ts -Pattern "custom-nav"
Select-String -Path src\web\App.tsx -Pattern "CustomNav"
Select-String -Path public\_headers -Pattern "frame-src"
npx vitest run --maxWorkers=1 tests/api/custom-nav.test.ts    # 期望 6/6 通过
```

四项都命中即恢复成功。再跑 `npm run lint` 与 `npx vite build` 收尾。

### 11.4 整体丢失时的兜底

- 若 `src/custom-nav/` 目录被误删：直接从本仓库历史取回（该目录自包含、无外部依赖）：
  `git checkout <commit> -- src/custom-nav/`
- 也可运行 `custom-patches/restore.ps1`（其顶部内联了同样的接线点速查），
  但配套 `custom.patch` 已报废、需重新生成，见 `custom-patches/README.md`。

### 11.5 冲突处理

- `src/custom-nav/` 内文件若与上游冲突：这些文件上游本不该有，冲突通常意味着上游新增了同名文件
  → 保留我们的实现，必要时给文件名加前缀避免撞名。
- `src/web/App.tsx` 冲突最常见：按 11.2 ② 的片段重新落位，别整体覆盖上游改动。
- `public/_headers` 冲突：只保住 CSP 里的 `frame-src https: http:` 这一段即可。
