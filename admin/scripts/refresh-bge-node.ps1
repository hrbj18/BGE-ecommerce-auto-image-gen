[CmdletBinding()]
param(
    [string]$InfrastructureCredentialPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\credentials.clixml'),
    [string]$AdminSecretPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\admin-secrets.clixml')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'import-admin-environment.ps1') `
    -InfrastructureCredentialPath $InfrastructureCredentialPath `
    -AdminSecretPath $AdminSecretPath

$repositoryRoot = $BgeRuoYiRepositoryRoot
$runtimeRoot = Join-Path $repositoryRoot '.local-web\ruoyi'
$logRoot = Join-Path $runtimeRoot 'logs'
$processFile = Join-Path $runtimeRoot 'processes.json'

function Test-LocalPort {
    param([Parameter(Mandatory = $true)][int]$Port)

    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.ConnectAsync('127.0.0.1', $Port)
        if (-not $connect.Wait(300)) { return $false }
        return $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Get-EngineHealth {
    return Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' `
        -Headers @{ Authorization = "Bearer $env:BGE_ENGINE_ACCESS_TOKEN" } `
        -TimeoutSec 3
}

function Wait-EngineReady {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [int]$TimeoutSeconds = 45
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $Process.Refresh()
        if ($Process.HasExited) {
            throw "BGE Node exited with code $($Process.ExitCode)."
        }
        try {
            $health = Get-EngineHealth
            if ($health.state -in @('ready', 'degraded')) { return }
        }
        catch {
            # The service is still starting. Detailed errors stay in its log.
        }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)
    throw 'BGE Node did not become ready within 45 seconds.'
}

function Wait-EnginePortClosed {
    $deadline = (Get-Date).AddSeconds(20)
    do {
        if (-not (Test-LocalPort -Port 8787)) { return }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    throw 'BGE Node port 8787 did not close after stopping the managed process.'
}

if (-not (Test-Path -LiteralPath $processFile)) {
    throw 'Managed RuoYi process state is missing; refusing to stop an unknown Node process.'
}

$healthBeforeRefresh = Get-EngineHealth
if ($healthBeforeRefresh.state -eq 'busy' -or $healthBeforeRefresh.activeJob) {
    throw 'BGE Node has an active image workflow; refusing to interrupt it.'
}

$processState = Get-Content -LiteralPath $processFile -Raw -Encoding UTF8 | ConvertFrom-Json
$managedProcessId = [int]$processState.node.pid
$managedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $managedProcessId" -ErrorAction SilentlyContinue
if (-not $managedProcess -or $managedProcess.Name -ne 'node.exe' -or
        [string]$managedProcess.CommandLine -notlike '*scripts/local-web-server.mjs*') {
    throw 'The recorded BGE Node process could not be verified; refusing to stop it.'
}

Stop-Process -Id $managedProcessId -Force
Wait-EnginePortClosed

$newNodeProcess = $null
try {
    $nodeCommand = (Get-Command node -ErrorAction Stop).Source
    $newNodeProcess = Start-Process -FilePath $nodeCommand `
        -ArgumentList @('scripts/local-web-server.mjs') `
        -WorkingDirectory $repositoryRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logRoot 'bge-node.out.log') `
        -RedirectStandardError (Join-Path $logRoot 'bge-node.err.log')
    Wait-EngineReady -Process $newNodeProcess

    $processState.node.pid = $newNodeProcess.Id
    $processState | Add-Member -NotePropertyName nodeRefreshedAt `
        -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force
    $temporaryFile = "$processFile.tmp"
    $processState | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryFile -Encoding UTF8
    Move-Item -LiteralPath $temporaryFile -Destination $processFile -Force
    Write-Host 'BGE Node was restarted and passed its readiness check.'
}
catch {
    if ($newNodeProcess) {
        $newNodeProcess.Refresh()
        if (-not $newNodeProcess.HasExited) {
            Stop-Process -Id $newNodeProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }
    throw
}
