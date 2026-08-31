param(
  [switch]$Check
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$FrontendUrl = "http://127.0.0.1:5173"
$BackendHealthUrl = "http://127.0.0.1:8787/health"
$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"

function Assert-PathExists {
  param(
    [string]$Path,
    [string]$Name
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Name not found: $Path"
  }
}

function Test-HttpOk {
  param([string]$Url)

  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Resolve-PnpmRunner {
  $pnpmCommand = Get-Command pnpm.cmd, pnpm -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pnpmCommand) {
    return [PSCustomObject]@{ Executable = $pnpmCommand.Source; Prefix = @(); Description = $pnpmCommand.Source }
  }

  $corepackCommand = Get-Command corepack.cmd, corepack -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $corepackCommand) {
    throw "未找到 pnpm，也未找到 Node.js 自带的 Corepack。请重新安装 Node.js 24+ 后再试。"
  }

  Write-Host "首次启动：正在通过 Corepack 启用 pnpm..."
  $enableOutput = & $corepackCommand.Source enable 2>&1
  $enableExitCode = $LASTEXITCODE
  if ($enableOutput) { $enableOutput | ForEach-Object { Write-Host $_ } }

  $pnpmCommand = Get-Command pnpm.cmd, pnpm -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($enableExitCode -eq 0 -and $pnpmCommand) {
    Write-Host "pnpm 已启用：$($pnpmCommand.Source)"
    return [PSCustomObject]@{ Executable = $pnpmCommand.Source; Prefix = @(); Description = $pnpmCommand.Source }
  }

  Write-Host "未能写入全局 pnpm 启动文件，将直接使用 Corepack 运行项目。"
  $versionOutput = & $corepackCommand.Source pnpm --version 2>&1
  $versionExitCode = $LASTEXITCODE
  if ($versionExitCode -ne 0) {
    $details = ($versionOutput | Out-String).Trim()
    if ($details) { throw "Corepack 无法启动 pnpm：$details" }
    throw "Corepack 无法启动 pnpm，退出代码：$versionExitCode"
  }

  Write-Host "Corepack pnpm 已就绪，版本：$(($versionOutput | Out-String).Trim())"
  return [PSCustomObject]@{ Executable = $corepackCommand.Source; Prefix = @("pnpm"); Description = "$($corepackCommand.Source) pnpm" }
}

try {
  Assert-PathExists -Path $Root -Name "Project root"
  $Node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $Node) { throw "没有找到 Node.js。请安装 Node.js 24 或更高版本，关闭窗口后重新启动。" }
  $NodeVersionText = (& $Node.Source --version).Trim().TrimStart("v")
  $NodeVersion = [version]$NodeVersionText
  if ($NodeVersion.Major -lt 24) { throw "需要 Node.js 24 或更高版本，当前版本：$NodeVersionText" }
  $PnpmRunner = Resolve-PnpmRunner

  if ($Check) {
    Write-Host "一键启动检查通过。"
    Write-Host "Node.js：$NodeVersionText"
    Write-Host "pnpm 运行方式：$($PnpmRunner.Description)"
    exit 0
  }

  Set-Location -LiteralPath $Root

  $rootDependencyStore = Join-Path $Root "node_modules\.pnpm"
  $frontendVite = Join-Path $Root "frontend\node_modules\vite"
  if (-not (Test-Path -LiteralPath $rootDependencyStore) -or -not (Test-Path -LiteralPath $frontendVite)) {
    Write-Host "首次启动：正在安装项目依赖，请保持网络连接..."
    $installArguments = @($PnpmRunner.Prefix) + @("install", "--frozen-lockfile")
    & $PnpmRunner.Executable @installArguments
    if ($LASTEXITCODE -ne 0) {
      throw "项目依赖安装失败，退出代码：$LASTEXITCODE"
    }
    Write-Host "项目依赖安装完成。"
  }

  Write-Host ""
  Write-Host "正在启动本地电商生图工作台..."
  Write-Host "项目目录：$Root"
  Write-Host "工作台地址：$FrontendUrl"
  Write-Host "后端健康检查：$BackendHealthUrl"
  Write-Host "诊断日志：$Root\.local-web\logs\web-session.log"
  Write-Host ""

  $frontendReady = Test-HttpOk -Url $FrontendUrl
  $backendReady = Test-HttpOk -Url $BackendHealthUrl

  if ($frontendReady -and $backendReady) {
    Write-Host "前端和后端已经运行，正在打开浏览器..."
    Start-Process $FrontendUrl
    Write-Host "使用工作台期间请保持服务窗口运行。"
    Read-Host "按 Enter 关闭本启动窗口"
    exit 0
  }

  if ($frontendReady) {
    Write-Host "前端已经运行，正在补启后端..."
    $env:START_BACKEND_ONLY = "1"
  } elseif ($backendReady) {
    Write-Host "后端已经运行，正在补启前端..."
    $env:START_FRONTEND_ONLY = "1"
  } else {
    Write-Host "正在启动前端和后端..."
  }

  $pnpmArguments = @($PnpmRunner.Prefix) + @("run", "web")
  & $PnpmRunner.Executable @pnpmArguments

  if ($LASTEXITCODE -ne 0) {
    throw "项目服务异常退出，退出代码：$LASTEXITCODE"
  }
} catch {
  Write-Host ""
  Write-Host "一键启动失败："
  Write-Host "错误原因：$($_.Exception.Message)"
  Write-Host "退出代码：1"
  Write-Host "诊断日志：$Root\.local-web\logs\web-session.log"
  Write-Host ""
  Write-Host "仍可在项目目录打开 PowerShell，运行：corepack pnpm run web"
  Write-Host ""
  Read-Host "按 Enter 关闭"
  exit 1
}
