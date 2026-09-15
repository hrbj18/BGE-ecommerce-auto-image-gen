param(
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$AuthenticatedLauncher = Join-Path $Root 'admin\scripts\start-user-portal.ps1'

if (-not (Test-Path -LiteralPath $AuthenticatedLauncher)) {
  throw "Authenticated portal launcher not found: $AuthenticatedLauncher"
}

if ($Check) {
  Write-Host 'Authenticated project launcher check passed.'
  Write-Host 'Admin entry: http://127.0.0.1:8001/'
  Write-Host 'User entry: http://127.0.0.1:8003/portal/'
  exit 0
}

& $AuthenticatedLauncher -EntryUri 'http://127.0.0.1:8003/portal/'
