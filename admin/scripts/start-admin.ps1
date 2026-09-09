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
$frontendRoot = Join-Path $repositoryRoot 'admin\frontend'
$workbenchFrontendRoot = Join-Path $repositoryRoot 'frontend'

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$javaCommand = (Get-Command java -ErrorAction Stop).Source
$viteScript = Join-Path $repositoryRoot 'admin\frontend\node_modules\vite\bin\vite.js'
if (-not (Test-Path -LiteralPath $viteScript)) {
    throw '若依前端依赖尚未安装。请先运行 pnpm --dir admin/frontend install --frozen-lockfile。'
}
$workbenchViteScript = Join-Path $repositoryRoot 'frontend\node_modules\vite\bin\vite.js'
if (-not (Test-Path -LiteralPath $workbenchViteScript)) {
    throw '电商作图前端依赖尚未安装。请先运行 pnpm --dir frontend install --frozen-lockfile。'
}

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

function Wait-HttpReady {
    param(
        [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Uri,
        [hashtable]$Headers = @{},
        [int]$TimeoutSeconds = 45
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $Process.Refresh()
        if ($Process.HasExited) {
            throw "$Name 启动进程已经退出，退出码为 $($Process.ExitCode)。"
        }
        try {
            $response = Invoke-WebRequest -Uri $Uri -Headers $Headers -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { return }
        }
        catch {
            # 服务仍在启动，详细原因保留在对应日志中。
        }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)
    throw "$Name 在 $TimeoutSeconds 秒内没有通过就绪检查。"
}

foreach ($portToCheck in @(8787, 8001, 8002, 8003, 8080)) {
    if (Test-LocalPort -Port $portToCheck) {
        throw "本机端口 $portToCheck 已被占用。为避免连接到错误服务，本次没有启动若依。"
    }
}

Update-BgeBackendArtifact -RepositoryRoot $repositoryRoot -BackendJar $backendJar | Out-Null

$launchedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
try {
    $nodeProcess = Start-Process -FilePath $nodeCommand `
        -ArgumentList @('scripts/local-web-server.mjs') `
        -WorkingDirectory $repositoryRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logRoot 'bge-node.out.log') `
        -RedirectStandardError (Join-Path $logRoot 'bge-node.err.log')
    $launchedProcesses.Add($nodeProcess)

    $backendProcess = Start-Process -FilePath $javaCommand `
        -ArgumentList @('-jar', $backendJar) `
        -WorkingDirectory $repositoryRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logRoot 'ruoyi-backend.out.log') `
        -RedirectStandardError (Join-Path $logRoot 'ruoyi-backend.err.log')
    $launchedProcesses.Add($backendProcess)

    # Directly launch Vite with Node so the recorded PID owns the listener.
    # Launching pnpm.cmd would record an intermediate cmd.exe process and could
    # leave the child Vite server alive when startup cleanup is required.
    $frontendProcess = Start-Process -FilePath $nodeCommand `
        -ArgumentList @($viteScript, '--host', '127.0.0.1', '--port', '8001', '--strictPort') `
        -WorkingDirectory $frontendRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logRoot 'ruoyi-frontend.out.log') `
        -RedirectStandardError (Join-Path $logRoot 'ruoyi-frontend.err.log')
    $launchedProcesses.Add($frontendProcess)

    # The React workbench stays loopback-only and is exposed only through the
    # RuoYi Vite proxy at /workbench/. Setting this process-scoped value before
    # launch avoids writing any machine-wide environment setting.
    $previousWorkbenchBase = $env:BGE_WORKBENCH_BASE
    $env:BGE_WORKBENCH_BASE = '/workbench/'
    try {
        $workbenchProcess = Start-Process -FilePath $nodeCommand `
            -ArgumentList @($workbenchViteScript, '--host', '127.0.0.1', '--port', '8002', '--strictPort') `
            -WorkingDirectory $workbenchFrontendRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logRoot 'bge-workbench.out.log') `
            -RedirectStandardError (Join-Path $logRoot 'bge-workbench.err.log')
        $launchedProcesses.Add($workbenchProcess)
    }
    finally {
        if ($null -eq $previousWorkbenchBase) { Remove-Item Env:BGE_WORKBENCH_BASE -ErrorAction SilentlyContinue }
        else { $env:BGE_WORKBENCH_BASE = $previousWorkbenchBase }
    }

    # The self-service portal uses the same React source but its own Vite base
    # so all browser assets stay under /portal/. It remains an internal
    # loopback process; users only visit 8001/portal/.
    $previousPortalBase = $env:BGE_WORKBENCH_BASE
    $env:BGE_WORKBENCH_BASE = '/portal/'
    try {
        $portalProcess = Start-Process -FilePath $nodeCommand `
            -ArgumentList @($workbenchViteScript, '--host', '127.0.0.1', '--port', '8003', '--strictPort') `
            -WorkingDirectory $workbenchFrontendRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logRoot 'bge-portal.out.log') `
            -RedirectStandardError (Join-Path $logRoot 'bge-portal.err.log')
        $launchedProcesses.Add($portalProcess)
    }
    finally {
        if ($null -eq $previousPortalBase) { Remove-Item Env:BGE_WORKBENCH_BASE -ErrorAction SilentlyContinue }
        else { $env:BGE_WORKBENCH_BASE = $previousPortalBase }
    }

    Wait-HttpReady -Process $nodeProcess -Name 'BGE Node' -Uri 'http://127.0.0.1:8787/health' `
        -Headers @{ Authorization = "Bearer $env:BGE_ENGINE_ACCESS_TOKEN" }
    Wait-HttpReady -Process $backendProcess -Name '若依后端' -Uri 'http://127.0.0.1:8080/captchaImage' -TimeoutSeconds 60
    Wait-HttpReady -Process $workbenchProcess -Name '电商作图前端' -Uri 'http://127.0.0.1:8002/workbench/'
    Wait-HttpReady -Process $portalProcess -Name '电商作图用户端' -Uri 'http://127.0.0.1:8003/portal/'
    Wait-HttpReady -Process $frontendProcess -Name '若依前端' -Uri 'http://127.0.0.1:8001'

    $state = [pscustomobject]@{
        startedAt = (Get-Date).ToUniversalTime().ToString('o')
        node = [pscustomobject]@{ pid = $nodeProcess.Id; name = 'node' }
        backend = [pscustomobject]@{ pid = $backendProcess.Id; name = 'java' }
        frontend = [pscustomobject]@{ pid = $frontendProcess.Id; name = 'node' }
        workbench = [pscustomobject]@{ pid = $workbenchProcess.Id; name = 'node' }
        portal = [pscustomobject]@{ pid = $portalProcess.Id; name = 'node' }
    }
    $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $processFile -Encoding UTF8

    Write-Host 'BGE Node、若依后端、若依前端、作图工作台和用户端门户已经在本机回环地址启动并通过就绪检查。'
    Write-Host '统一入口地址为 http://127.0.0.1:8001'
    Write-Host '用户作图入口为 http://127.0.0.1:8001/portal/'
    Write-Host "运行日志位于 $logRoot"
}
catch {
    foreach ($launchedProcess in $launchedProcesses) {
        $launchedProcess.Refresh()
        if (-not $launchedProcess.HasExited) {
            Stop-Process -Id $launchedProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }
    throw
}
