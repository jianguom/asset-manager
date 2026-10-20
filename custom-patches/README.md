# custom-patches：fork 自定义功能的恢复机制

本目录用于**上游仓库同步后，一键恢复本 fork 的两个自定义功能**（交易流水 + 多成本法、自定义导航菜单）。

## 1. 这里有什么

| 文件 | 作用 | 当前状态 |
| --- | --- | --- |
| `restore.ps1` | 上游同步后恢复接线点的 PowerShell 脚本 | **可用**（逻辑正确） |
| `custom.patch` | fork 基线之后全部自定义差异的 git 补丁 | **已报废，需重新生成**（见第 4 节） |

## 2. `restore.ps1` 用法

```powershell
# 恢复默认 clone（%TEMP%\asset-manager-upstream）
powershell -ExecutionPolicy Bypass -File restore.ps1

# 恢复任意 fork 仓库
powershell -ExecutionPolicy Bypass -File restore.ps1 -Repo D:\myfork
```

执行流程：

1. `git status --short` 确认工作区干净
2. `git apply --3way --exclude="migrations/*" --exclude="src/trades/README.md" custom.patch`
   —— `--3way` 依据补丁里的 blob 哈希做三方合并，即使上游改过上下文也能尽量自动恢复；
   只有「同一行两处都改过」才会冲突，冲突文件会列出，需手动修。
3. 迁移**单独处理**：若上游已占用同名编号，改名后手动应用，**绝不要覆盖**
4. `git log --oneline --grep="持仓交易流水" --grep="多成本法"` 校验自定义提交是否仍在历史
5. 收尾提醒：本地 `npx vite build` + `npx vitest run --maxWorkers=1` 验证，再提交推送

**为什么排除这两类文件**：

- `migrations/*`：编号会与上游冲突，必须人工决定改名/合并，不能盲目 `git apply`
- `src/trades/README.md`：脚本里写明了「尊重你已删除它的决定」——
  该文件曾被删除过，恢复机制刻意不再自动还原它

`restore.ps1` 顶部还内联了一份接线点速查（`worker/api/index.ts`、`web/App.tsx`、`public/_headers`，
以及交易功能涉及的 `accounts.routes.ts` / `accounts.repo.ts` / `Accounts.tsx` / `version.ts` /
`locales/*` / `labels.ts` / `api-types.ts` / `worker/types.ts` / `backup.ts`）。
更详细、逐文件的接线点清单见 `src/trades/README.md` 第 7 节与 `src/custom-nav/README.md` 第 6 节。

## 3. 补丁基线

自定义功能 = **基线 `dc695c8`** 之后的所有提交：

- `550ec03` 交易流水（FIFO）
- `d204ca1` 多成本法
- `3b2b00c` 流水备注列修复
- `1644a37` 自定义导航菜单
- `cf09e14`、`779e598`、`22d6d2e` 及期间若干高度适配修复

`custom.patch` 保存的就是这一整段差异。

## 4. ⚠️ `custom.patch` 当前已报废（自指套娃）

现状：约 **46,267 行 / 1.95 MB**，文件内部**包含对自身的 diff**（13 处自引用），
且**不含**本次定稿的「嵌入模式宽高锁定 + 背景透明」方案。

成因：**生成补丁时把输出文件写在了仓库内部**（`custom-patches/custom.patch`），
导致每次「生成补丁 → 提交 → 再生成」都会把上一版补丁本身也算作差异，层层套娃，
最终补丁无法正常应用。

结论：`restore.ps1` 的**机制本身是必要的**，但配套的 `custom.patch` 需要**重新生成**。

### 重新生成方法（关键：输出不能落在仓库内）

```powershell
# 在仓库根目录执行；输出写到仓库【外面】，避免自指套娃
git diff dc695c8 HEAD -- . ":(exclude)custom-patches/custom.patch" > "$env:TEMP\custom.patch"
```

- 基线用 `dc695c8`
- 必须排除 `custom-patches/custom.patch` 自身（上例已排除；也可用 `:(exclude)custom-patches/*`）
- 生成后把文件放到 `custom-patches/custom.patch`（**只在最后一步落地**，不要再对「已含补丁的提交」重新生成）
- 落地后**不要**立即把新补丁再 commit 进仓库然后重新生成，否则又回到套娃

### 如果不想维护补丁

可只保留 `restore.ps1`（接线点速查仍有用），删除 `custom.patch`，
改为「上游同步后按两份 README 的接线点清单手工恢复」。补丁是便捷项，不是唯一手段。

## 5. 相关文档

- `src/trades/README.md` —— 交易流水 + 多成本法完整说明（含逐文件接线点）
- `src/custom-nav/README.md` —— 自定义导航菜单完整说明（含逐文件接线点）
