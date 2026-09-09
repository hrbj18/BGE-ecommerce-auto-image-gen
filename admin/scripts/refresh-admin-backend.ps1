[CmdletBinding()]
param(
    [string]$InfrastructureCredentialPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\credentials.clixml'),
    [string]$AdminSecretPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\admin-secrets.clixml')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'import-admin-environment.ps1') `
    -InfrastructureCredentialPath $InfrastructureCredentialPath `
    -AdminSecretPath $AdminSecretPath
. (Join-Path $PSScriptRoot 'backend-artifact.ps1')

$repositoryRoot = $BgeRuoYiRepositoryRoot
$runtimeRoot = Join-Path $repositoryRoot '.local-web\ruoyi'
$logRoot = Join-Path $runtimeRoot 'logs'
$processFile = Join-Path $runtimeRoot 'processes.json'
$backendJar = Join-Path $repositoryRoot 'admin\backend\ruoyi-admin\target\ruoyi-admin.jar'

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

function Wait-BackendReady {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [int]$TimeoutSeconds = 60
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $Process.Refresh()
        if ($Process.HasExited) {
            throw "RuoYi backend exited with code $($Process.ExitCode)."
        }
        try {
            $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/captchaImage' `
                -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { return }
        }
        catch {
            # The backend is still starting. Its logs retain the detailed error.
        }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)
    throw 'RuoYi backend did not become ready within 60 seconds.'
}

function Wait-BackendPortClosed {
    $deadline = (Get-Date).AddSeconds(20)
    do {
        if (-not (Test-LocalPort -Port 8080)) { return }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    throw 'RuoYi backend port 8080 did not close after stopping the managed process.'
}

function Write-ProcessState {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][int]$BackendProcessId
    )

    $State.backend.pid = $BackendProcessId
    $State | Add-Member -NotePropertyName backendRefreshedAt `
        -NotePropertyValue ((Get-Date).ToUniversalTime().ToString('o')) -Force
    $temporaryFile = "$processFile.tmp"
    $State | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporaryFile -Encoding UTF8
    Move-Item -LiteralPath $temporaryFile -Destination $processFile -Force
}

if (-not (Test-Path -LiteralPath $processFile)) {
    throw 'Managed RuoYi process state is missing; refusing to stop an unknown Java process.'
}

$processState = Get-Content -LiteralPath $processFile -Raw -Encoding UTF8 | ConvertFrom-Json
$managedProcessId = [int]$processState.backend.pid
$managedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $managedProcessId" -ErrorAction SilentlyContinue
if (-not $managedProcess -or $managedProcess.Name -notmatch '^javaw?\.exe$' -or
        [string]$managedProcess.CommandLine -notlike "*$backendJar*") {
    throw 'The recorded RuoYi backend process could not be verified; refusing to stop it.'
}

Stop-Process -Id $managedProcessId -Force
Wait-BackendPortClosed

$newBackendProcess = $null
try {
    Update-BgeBackendArtifact -RepositoryRoot $repositoryRoot -BackendJar $backendJar | Out-Null
    $javaCommand = (Get-Command java -ErrorAction Stop).Source
    $newBackendProcess = Start-Process -FilePath $javaCommand `
        -ArgumentList @('-jar', $backendJar) `
        -WorkingDirectory $repositoryRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logRoot 'ruoyi-backend.out.log') `
        -RedirectStandardError (Join-Path $logRoot 'ruoyi-backend.err.log')
    Wait-BackendReady -Process $newBackendProcess
    Write-ProcessState -State $processState -BackendProcessId $newBackendProcess.Id
    Write-Host 'RuoYi backend was rebuilt, restarted, and passed its readiness check.'
}
catch {
    if ($newBackendProcess) {
        $newBackendProcess.Refresh()
        if (-not $newBackendProcess.HasExited) {
            Stop-Process -Id $newBackendProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }
    throw
}
