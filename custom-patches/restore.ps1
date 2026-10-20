<#
restore.ps1 — 上游仓库同步后，快速恢复自定义功能（交易流水 + 多成本法 + 自定义导航菜单）
============================================================
用法：
  powershell -ExecutionPolicy Bypass -File restore.ps1                # 恢复默认 clone
  powershell -ExecutionPolicy Bypass -File restore.ps1 -Repo D:\myfork # 恢复任意 fork 仓库

原理：
  自定义功能 = fork 基线 dc695c8 之后的所有提交（550ec03 交易流水、d204ca1 多成本法、
  以及后续的 自定义导航菜单 src/custom-nav/）。
  custom.patch 保存了这一整段差异。恢复 = 用 `git apply --3way` 把差异重新打回仓库：
  --3way 依据补丁里的 blob 哈希做三方合并，即使上游改过上下文也能尽量自动恢复；
  只有"同一行两处都改过"才会冲突，冲突文件会列出，按本文件底部的手动步骤处理。
  migrations 单独处理：若上游已有同名迁移（编号冲突），改名后手动应用即可，绝不要覆盖。

自定义导航菜单接线点速查（上游同步后若接线点被上游改写，按下面恢复）：
  - src/worker/api/index.ts       挂载 guarded.route("/custom-nav", customNavRoutes)
  - src/web/App.tsx               顶部 <nav> 追加 <CustomNav />；页面分支 path.startsWith("/custom") → CustomNavPage
  - public/_headers               CSP 追加 frame-src https: http:（iframe 嵌入外部页面必需）
  其余全部在 src/custom-nav/ 独立目录，上游 merge 不会碰它；配置存 settings KV，无需迁移。

依赖：git 在 PATH 中。
#>
param(
  [string]$Repo = (Join-Path $env:TEMP "asset-manager-upstream"),
  [string]$Patch = (Join-Path $PSScriptRoot "custom.patch")
)
$ErrorActionPreference = "Stop"

if (-not (Test-Path $Repo))  { Write-Error "仓库不存在: $Repo"; exit 1 }
if (-not (Test-Path $Patch)) { Write-Error "补丁不存在: $Patch"; exit 1 }

Push-Location $Repo
try {
  Write-Host "== 0/4 当前状态（确认干净后再动手）=="
  git status --short

  Write-Host "`n== 1/4 应用主体补丁（migrations 与 src/trades/README.md 除外，三方合并）=="
  git apply --3way --exclude="migrations/*" --exclude="src/trades/README.md" $Patch
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  主体补丁应用成功。" -ForegroundColor Green
  } else {
    Write-Host "  存在冲突文件，见上方 git 的失败清单。这些文件需手动修复（步骤见文末），" -ForegroundColor Yellow
    Write-Host "  修完后可重新运行本脚本（已成功的部分不受影响，git apply 每次整体生效）。"
  }

  Write-Host "`n== 2/4 处理 migrations（编号冲突时改名）=="
  $migrationFiles = (git apply --numstat $Patch 2>$null) |
    ForEach-Object { ($_ -split "`t")[2] } |
    Where-Object { $_ -like "migrations/*" }
  foreach ($m in $migrationFiles) {
    if (Test-Path $m) {
      Write-Host "  跳过 $m ：目标已存在（上游可能占用了编号）。" -ForegroundColor Yellow
      Write-Host "    → 把补丁中该文件复制为新编号（如 0010_xxx.sql）后手动执行迁移，并检查 SCHEMA_VERSION。"
    } else {
      git apply --3way --include=$m $Patch
      if ($LASTEXITCODE -eq 0) { Write-Host "  已恢复 $m" -ForegroundColor Green }
      else { Write-Host "  恢复 $m 失败，请手动处理。" -ForegroundColor Yellow }
    }
  }

  Write-Host "`n== 3/4 校验自定义提交是否仍在历史里 =="
  git log --oneline --grep="持仓交易流水" --grep="多成本法" | ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) { Write-Host "  未检出自定义提交，请检查补丁是否完整应用。" -ForegroundColor Yellow }

  Write-Host "`n== 4/4 收尾提醒 =="
  Write-Host "  1) 本地验证：把恢复后的 src/、migrations/ 复制回本地项目，运行 npx vite build 与 npx vitest run --maxWorkers=1"
  Write-Host "  2) 提交：git add -A; git commit -m 'restore: 自定义功能' ; git push origin main"
  Write-Host "  3) Cloudflare 自动构建并执行迁移，部署完成。"

  Write-Host "`n手动修复冲突文件的方法（出现失败清单时）："
  Write-Host "  ① git apply --3way --exclude='migrations/*' --exclude='src/trades/README.md' $Patch --verbose   # 看清哪几个文件冲突"
  Write-Host "  ② 打开 custom.patch 找到对应文件的 hunk（@@ 行号块），照着补丁内容手工改回仓库文件"
  Write-Host "  ③ 常用接线点速查：src/worker/api/accounts.routes.ts（costMethod 参数+重算）、"
  Write-Host "     src/worker/data/accounts.repo.ts（cost_method 列）、src/web/pages/Accounts.tsx（口径下拉）、"
  Write-Host "     src/shared/version.ts（SCHEMA_VERSION 取两方较大值）、src/shared/locales/zh.ts|en.ts（costMethod.* 文案）、"
  Write-Host "     src/shared/labels.ts|api-types.ts、src/worker/types.ts、src/worker/services/backup.ts（cost_method 保留）"
  Write-Host "  ④ 说明：src/trades/README.md 不会被恢复（尊重你已删除它的决定）"
} finally {
  Pop-Location
}
