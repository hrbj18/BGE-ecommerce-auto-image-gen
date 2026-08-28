param(
  [switch]$Check
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$FrontendUrl = "http://127.0.0.1:5173"
$BackendHealthUrl = "http://127.0.0.1:8787/health"

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

try {
  Assert-PathExists -Path $Root -Name "Project root"
  $Node = Get-Command node -ErrorAction SilentlyContinue
  $Pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if (-not $Node) { throw "Node.js 24 or newer was not found on PATH. Install Node.js, reopen the terminal, then retry." }
  if (-not $Pnpm) { throw "pnpm was not found on PATH. Run 'corepack enable', reopen the terminal, then retry." }
  $NodeVersionText = (& $Node.Source --version).Trim().TrimStart("v")
  $NodeVersion = [version]$NodeVersionText
  if ($NodeVersion.Major -lt 24) { throw "Node.js 24 or newer is required. Current version: $NodeVersionText" }

  if ($Check) {
    Write-Host "Start script check passed."
    exit 0
  }

  Set-Location -LiteralPath $Root

  Write-Host ""
  Write-Host "Starting local ecommerce image web app..."
  Write-Host "Project: $Root"
  Write-Host "Frontend: $FrontendUrl"
  Write-Host "Backend health: $BackendHealthUrl"
  Write-Host "Diagnostic log: $Root\.local-web\logs\web-session.log"
  Write-Host ""

  $frontendReady = Test-HttpOk -Url $FrontendUrl
  $backendReady = Test-HttpOk -Url $BackendHealthUrl

  if ($frontendReady -and $backendReady) {
    Write-Host "Frontend and backend are already running. Opening browser..."
    Start-Process $FrontendUrl
    Write-Host "Keep the existing terminal window open while using the app."
    Read-Host "Press Enter to close this launcher"
    exit 0
  }

  if ($frontendReady) {
    Write-Host "Frontend is already running; starting the missing backend..."
    $env:START_BACKEND_ONLY = "1"
  } elseif ($backendReady) {
    Write-Host "Backend is already running; starting the missing frontend..."
    $env:START_FRONTEND_ONLY = "1"
  } else {
    Write-Host "Starting both frontend and backend..."
  }

  & $Pnpm.Source run web

  if ($LASTEXITCODE -ne 0) {
    throw "Project exited with code $LASTEXITCODE"
  }
} catch {
  Write-Host ""
  Write-Host "Failed to start the project:"
  Write-Host $_.Exception.Message
  Write-Host ""
  Write-Host "You can also open a terminal in the project folder and run: pnpm run web"
  Write-Host ""
  Read-Host "Press Enter to close"
  exit 1
}
