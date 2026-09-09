[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path

Push-Location $repoRoot
try {
    & mvn -f admin/backend/pom.xml test
    if ($LASTEXITCODE -ne 0) { throw '若依后端测试失败。' }

    & mvn -f admin/backend/pom.xml package -DskipTests
    if ($LASTEXITCODE -ne 0) { throw '若依后端打包失败。' }

    & pnpm --dir admin/frontend run typecheck
    if ($LASTEXITCODE -ne 0) { throw '若依前端类型检查失败。' }

    & pnpm --dir admin/frontend run build:prod
    if ($LASTEXITCODE -ne 0) { throw '若依前端生产构建失败。' }

    & pnpm run verify:free
    if ($LASTEXITCODE -ne 0) { throw '根项目免费验证失败。' }

    Write-Host '若依后端、若依前端和根项目免费验证全部通过。'
}
finally {
    Pop-Location
}
