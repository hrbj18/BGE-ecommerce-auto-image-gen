[CmdletBinding()]
param(
    [string]$InfrastructureCredentialPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\credentials.clixml'),
    [string]$AdminSecretPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\admin-secrets.clixml'),
    [ValidateSet('http://127.0.0.1:8001/', 'http://127.0.0.1:8001/portal/')]
    [string]$EntryUri = 'http://127.0.0.1:8001/portal/'
)

$ErrorActionPreference = 'Stop'
$portalUri = 'http://127.0.0.1:8001/portal/'
. (Join-Path $PSScriptRoot 'backend-artifact.ps1')
. (Join-Path $PSScriptRoot 'credential-status.ps1')
$launcherRunId = [Guid]::NewGuid().ToString('N')
$launcherReportPath = Join-Path $PSScriptRoot ("..\..\.local-web\ruoyi\logs\launcher-$launcherRunId.json")

function Write-LauncherReport {
    param([string]$Result, $Failure = $null)
    try {
        $states = @(
            (Get-BgeCredentialStatus -Path $InfrastructureCredentialPath -Kind Infrastructure),
            (Get-BgeCredentialStatus -Path $AdminSecretPath -Kind Admin)
        )
        $report = [ordered]@{
            time = (Get-Date).ToUniversalTime().ToString('o')
            result = $Result
            entryUri = $EntryUri
            repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
            account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
            accountSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
            localAppData = [Environment]::GetFolderPath('LocalApplicationData')
            powershellVersion = [string]$PSVersionTable.PSVersion
            credentials = @($states | Select-Object Path, Status, InvalidFields, ProbeError)
        }
        if ($null -ne $Failure) {
            # Do not persist exception messages: native tools can include secrets.
            $report.errorType = $Failure.Exception.GetType().FullName
            $report.script = $Failure.InvocationInfo.ScriptName
            $report.line = $Failure.InvocationInfo.ScriptLineNumber
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $launcherReportPath) -Force | Out-Null
        $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $launcherReportPath -Encoding UTF8
    }
    catch { Write-Warning 'The launcher diagnostic report could not be saved.' }
}

function Import-PortalEnvironment {
    . (Join-Path $PSScriptRoot 'import-admin-environment.ps1') `
        -InfrastructureCredentialPath $InfrastructureCredentialPath `
        -AdminSecretPath $AdminSecretPath

    # Dot-sourcing from inside this helper keeps ordinary variables in the
    # function scope. Promote the two values used after the helper returns so
    # freshness checks and safe backend refreshes always receive real paths.
    $script:BgeRuoYiRepositoryRoot = $BgeRuoYiRepositoryRoot
    $script:BgeRuoYiDatabaseName = $BgeRuoYiDatabaseName
}

function Test-PortalConfiguration {
    return (Test-Path -LiteralPath $InfrastructureCredentialPath) -and
        (Test-Path -LiteralPath $AdminSecretPath)
}

function Test-HttpEndpoint {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [hashtable]$Headers = @{},
        [string]$RequiredText = ''
    )

    try {
        $response = Invoke-WebRequest -Uri $Uri -Headers $Headers -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) { return $false }
        if ($RequiredText -and $response.Content -notlike "*$RequiredText*") { return $false }
        return $true
    }
    catch {
        return $false
    }
}

function Test-UserPortalStack {
    $engineReady = Test-HttpEndpoint -Uri 'http://127.0.0.1:8787/health' `
        -Headers @{ Authorization = "Bearer $env:BGE_ENGINE_ACCESS_TOKEN" }
    $backendReady = Test-HttpEndpoint -Uri 'http://127.0.0.1:8080/captchaImage'
    $portalFrontendReady = Test-HttpEndpoint -Uri 'http://127.0.0.1:8003/portal/' `
        -RequiredText 'id="root"'
    $unifiedEntryReady = Test-HttpEndpoint -Uri $portalUri `
        -RequiredText 'id="root"'
    return $engineReady -and $backendReady -and $portalFrontendReady -and $unifiedEntryReady
}

function Test-BgeNodeSourceFresh {
    if (-not $BgeRuoYiRepositoryRoot) { return $false }
    $processFile = Join-Path $BgeRuoYiRepositoryRoot '.local-web\ruoyi\processes.json'
    if (-not (Test-Path -LiteralPath $processFile)) { return $false }

    try {
        $state = Get-Content -LiteralPath $processFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $managedProcessId = [int]$state.node.pid
        $managedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $managedProcessId" -ErrorAction Stop
        if (-not $managedProcess -or $managedProcess.Name -ne 'node.exe' -or
                [string]$managedProcess.CommandLine -notlike '*scripts/local-web-server.mjs*') {
            return $false
        }
        $process = Get-Process -Id $managedProcessId -ErrorAction Stop
        $sourceFiles = @(
            Get-ChildItem -LiteralPath (Join-Path $BgeRuoYiRepositoryRoot 'scripts') -File -Recurse -Include '*.mjs','*.mts'
            Get-ChildItem -LiteralPath (Join-Path $BgeRuoYiRepositoryRoot 'src') -File -Recurse -Include '*.ts','*.mjs','*.mts'
            Get-Item -LiteralPath (Join-Path $BgeRuoYiRepositoryRoot 'package.json')
        )
        $latestSource = $sourceFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        return $latestSource -and $latestSource.LastWriteTimeUtc -le $process.StartTime.ToUniversalTime()
    }
    catch {
        return $false
    }
}

function Test-BgeNodeBusy {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' `
            -Headers @{ Authorization = "Bearer $env:BGE_ENGINE_ACCESS_TOKEN" } `
            -TimeoutSec 3
        return $health.state -eq 'busy' -or [bool]$health.activeJob
    }
    catch {
        return $true
    }
}

function Test-DockerEngine {
    & cmd.exe /d /c 'docker version --format "{{.Server.Version}}" >nul 2>nul'
    return $LASTEXITCODE -eq 0
}

function Start-DockerEngine {
    if (Test-DockerEngine) { return }

    $dockerDesktopCandidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path $env:LOCALAPPDATA 'Docker\Docker Desktop.exe')
    )
    $dockerDesktopPath = $dockerDesktopCandidates |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if (-not $dockerDesktopPath) {
        throw 'Docker Desktop is not installed. Install or start Docker Desktop before retrying.'
    }

    Start-Process -FilePath $dockerDesktopPath -WindowStyle Hidden | Out-Null
    $deadline = (Get-Date).AddSeconds(120)
    do {
        if (Test-DockerEngine) { return }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw 'Docker Desktop did not become ready within 120 seconds.'
}

function Test-DockerContainer {
    param([Parameter(Mandatory = $true)][string]$Name)

    if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$') {
        throw 'The Docker container name is invalid.'
    }
    & cmd.exe /d /c ("docker container inspect `"$Name`" >nul 2>nul")
    return $LASTEXITCODE -eq 0
}

function Test-LocalPort {
    param([Parameter(Mandatory = $true)][int]$Port)

    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.ConnectAsync('127.0.0.1', $Port)
        if (-not $connect.Wait(500)) { return $false }
        return $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Wait-InfrastructurePorts {
    $deadline = (Get-Date).AddSeconds(90)
    do {
        if ((Test-LocalPort -Port 3306) -and (Test-LocalPort -Port 6379)) { return }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw 'MySQL or Redis did not become ready within 90 seconds.'
}

function Start-ExistingInfrastructure {
    Start-DockerEngine
    $mysqlExists = Test-DockerContainer -Name 'bge-ruoyi-mysql'
    $redisExists = Test-DockerContainer -Name 'bge-ruoyi-redis'
    if (-not $mysqlExists -or -not $redisExists) {
        throw 'The local MySQL or Redis container is missing. Run the repair launcher first.'
    }

    & cmd.exe /d /c 'docker start "bge-ruoyi-mysql" "bge-ruoyi-redis" >nul 2>nul'
    if ($LASTEXITCODE -ne 0) {
        throw 'The existing MySQL or Redis container could not be started.'
    }
    Wait-InfrastructurePorts
}

$startupMutex = [System.Threading.Mutex]::new($false, 'Local\BGE-RuoYi-Startup')
$hasStartupMutex = $false
try {
    try {
        $hasStartupMutex = $startupMutex.WaitOne([TimeSpan]::FromMinutes(4))
    }
    catch [System.Threading.AbandonedMutexException] {
        $hasStartupMutex = $true
    }
    if (-not $hasStartupMutex) {
        throw 'Another launcher is still starting the local services. Please retry in a moment.'
    }

    Write-LauncherReport -Result 'starting'

    $environmentReady = $false
    if (Test-PortalConfiguration) {
        try {
            Import-PortalEnvironment
            $environmentReady = $true
        }
        catch {
            Write-Warning 'The saved local configuration could not be loaded. Safe recovery will inspect it.'
            foreach ($state in @(
                (Get-BgeCredentialStatus -Path $InfrastructureCredentialPath -Kind Infrastructure),
                (Get-BgeCredentialStatus -Path $AdminSecretPath -Kind Admin)
            )) { Write-Host (Format-BgeCredentialStatus $state) }
        }
    }

    $portalStackReady = $environmentReady -and (Test-UserPortalStack)
    if ($portalStackReady) {
        $backendJar = Join-Path $BgeRuoYiRepositoryRoot 'admin\backend\ruoyi-admin\target\ruoyi-admin.jar'
        if (-not (Test-BgeBackendArtifactFresh -RepositoryRoot $BgeRuoYiRepositoryRoot -BackendJar $backendJar)) {
            Write-Host 'The running RuoYi backend is older than its source. Refreshing only the backend...'
            & (Join-Path $PSScriptRoot 'refresh-admin-backend.ps1') `
                -InfrastructureCredentialPath $InfrastructureCredentialPath `
                -AdminSecretPath $AdminSecretPath
            $portalStackReady = Test-UserPortalStack
        }
        if ($portalStackReady -and -not (Test-BgeNodeSourceFresh)) {
            if (Test-BgeNodeBusy) {
                Write-Host 'BGE Node sources are newer, but an image task is active. The safe refresh is deferred.'
            }
            else {
                Write-Host 'The running BGE Node service is older than its source. Refreshing it safely...'
                & (Join-Path $PSScriptRoot 'refresh-bge-node.ps1') `
                    -InfrastructureCredentialPath $InfrastructureCredentialPath `
                    -AdminSecretPath $AdminSecretPath
                $portalStackReady = Test-UserPortalStack
            }
        }
    }

    if ($portalStackReady) {
        Write-Host 'The local services are already running. Opening the selected page now.'
    }
    else {
        Write-Host 'Starting the services required by the selected page. Please wait...'
        Start-DockerEngine

        $mysqlExists = Test-DockerContainer -Name 'bge-ruoyi-mysql'
        $redisExists = Test-DockerContainer -Name 'bge-ruoyi-redis'
        if ($environmentReady -and $mysqlExists -and $redisExists) {
            Start-ExistingInfrastructure
            & (Join-Path $PSScriptRoot 'start-admin.ps1') `
                -InfrastructureCredentialPath $InfrastructureCredentialPath `
                -AdminSecretPath $AdminSecretPath
        }
        else {
            Write-Host 'Preparing the missing local infrastructure configuration safely...'
            & (Join-Path $PSScriptRoot 'recover-admin-infrastructure.ps1') `
                -InfrastructureCredentialPath $InfrastructureCredentialPath `
                -AdminSecretPath $AdminSecretPath
            Import-PortalEnvironment
            $environmentReady = $true
        }

        if (-not $environmentReady -or -not (Test-UserPortalStack)) {
            throw 'The local services did not pass their readiness checks. Read .local-web\ruoyi\logs.'
        }
    }

    Start-Process -FilePath $EntryUri
    Write-LauncherReport -Result 'ready'
    Write-Host "Page opened: $EntryUri"
}
catch {
    Write-LauncherReport -Result 'failed' -Failure $_
    Write-Host "Startup diagnostic: $([IO.Path]::GetFullPath($launcherReportPath))"
    throw
}
finally {
    if ($hasStartupMutex) {
        $startupMutex.ReleaseMutex()
    }
    $startupMutex.Dispose()
}
