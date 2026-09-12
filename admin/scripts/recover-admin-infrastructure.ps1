[CmdletBinding()]
param(
    [string]$MySqlContainerName = 'bge-ruoyi-mysql',
    [string]$RedisContainerName = 'bge-ruoyi-redis',
    [string]$InfrastructureCredentialPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\\credentials.clixml'),
    [string]$AdminSecretPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\\admin-secrets.clixml')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'credential-status.ps1')
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\\..')).Path

function New-RandomSecret {
    param([int]$ByteCount)

    $bytes = [byte[]]::new($ByteCount)
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
        return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    }
    finally {
        $generator.Dispose()
    }
}

function ConvertTo-PlainSecret {
    param([Parameter(Mandatory = $true)]$Value)

    if ($Value -is [System.Security.SecureString]) {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
        try {
            return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        }
        finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
    return [string]$Value
}

function Test-ContainerExists {
    param([string]$Name)

    if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$') {
        throw 'Docker 容器名称不符合安全规则。'
    }
    # Missing containers are an expected recovery state. Invoke through cmd so
    # PowerShell does not turn docker's expected non-zero exit into a
    # terminating NativeCommandError while $ErrorActionPreference is Stop.
    & cmd.exe /d /c ("docker container inspect `"$Name`" >nul 2>nul")
    return $LASTEXITCODE -eq 0
}

function Invoke-DockerQuietly {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Docker reports pull progress on stderr even when it exits successfully.
        # Do not let that progress turn into a terminating PowerShell error; the
        # caller always receives and checks Docker's real exit code instead.
        $ErrorActionPreference = 'Continue'
        $output = @(& docker @Arguments 2>$null)
        $exitCode = $LASTEXITCODE
        return [pscustomobject]@{ Output = $output; ExitCode = $exitCode }
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Backup-ReplacedCredential {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $backupPath = "$Path.unreadable.$stamp"
    Move-Item -LiteralPath $Path -Destination $backupPath -ErrorAction Stop
}

function Wait-MySqlReady {
    param([string]$RootPassword)

    $deadline = (Get-Date).AddSeconds(90)
    do {
        $result = Invoke-DockerQuietly -Arguments @('exec', '--env', "MYSQL_PWD=$RootPassword", $MySqlContainerName, 'mysqladmin', '--host=127.0.0.1', '--user=root', 'ping', '--silent')
        if ($result.ExitCode -eq 0) {
            return
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw 'MySQL 容器 90 秒内未就绪。容器和旧凭据均已保留，请查看 Docker Desktop 日志。'
}

function Wait-RedisReady {
    param([string]$Password)

    $deadline = (Get-Date).AddSeconds(45)
    do {
        $result = Invoke-DockerQuietly -Arguments @('exec', $RedisContainerName, 'redis-cli', '--no-auth-warning', '-a', $Password, 'PING')
        if ($result.ExitCode -eq 0 -and $result.Output -contains 'PONG') {
            return
        }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw 'Redis 容器 45 秒内未就绪。容器和旧凭据均已保留，请查看 Docker Desktop 日志。'
}

& cmd.exe /d /c 'docker version --format "{{.Server.Version}}" 2>nul' *> $null
if ($LASTEXITCODE -ne 0) {
    throw '当前 Windows 账户无法访问 Docker 引擎。请先在 Docker Desktop 中确认 Engine running，再从同一账户运行本脚本。'
}

$infraRead = Get-BgeCredentialStatus -Path $InfrastructureCredentialPath -Kind Infrastructure
$secretRead = Get-BgeCredentialStatus -Path $AdminSecretPath -Kind Admin
$validInfrastructure = $infraRead.Status -eq 'ready'
$validAdminSecret = $secretRead.Status -eq 'ready'
$mysqlExists = Test-ContainerExists -Name $MySqlContainerName
$redisExists = Test-ContainerExists -Name $RedisContainerName

if ($mysqlExists -xor $redisExists) {
    throw '只发现一个若依基础设施容器。为保护已有数据，脚本不会补建或删除另一个容器。请先人工确认容器状态。'
}
if ($mysqlExists -and -not $validInfrastructure) {
    throw ('BGE_EXISTING_DATABASE_CREDENTIAL_INVALID: ' + (Format-BgeCredentialStatus $infraRead) + '. Existing containers and passwords are preserved. Restore the original credential file; unreadable files require the original Windows user/machine or an intact backup.')
}

$credentialRoot = Split-Path -Parent $InfrastructureCredentialPath
New-Item -ItemType Directory -Path $credentialRoot -Force | Out-Null

if ($validInfrastructure) {
    $dbHost = [string]$infraRead.Value.MySqlHost
    $dbPort = [string]$infraRead.Value.MySqlPort
    $dbName = [string]$infraRead.Value.MySqlDatabase
    $dbUser = [string]$infraRead.Value.MySqlUser
    $dbPassword = ConvertTo-PlainSecret $infraRead.Value.MySqlPassword
    $redisPassword = ConvertTo-PlainSecret $infraRead.Value.RedisPassword
}
else {
    $dbHost = '127.0.0.1'
    $dbPort = '3306'
    $dbName = 'ruoyi_bge'
    $dbUser = 'ruoyi_bge'
    $dbPassword = New-RandomSecret -ByteCount 32
    $redisPassword = New-RandomSecret -ByteCount 32
}

if ($dbName -notmatch '^[A-Za-z0-9_-]+$' -or $dbUser -notmatch '^[A-Za-z0-9_-]+$') {
    throw '数据库名称或应用账号不符合安全规则。'
}

if ($mysqlExists) {
    $startResult = Invoke-DockerQuietly -Arguments @('start', $MySqlContainerName, $RedisContainerName)
    if ($startResult.ExitCode -ne 0) {
        throw '已有若依容器无法启动。请先在 Docker Desktop 查看容器日志。'
    }
}
else {
    $mysqlRootPassword = New-RandomSecret -ByteCount 32
    try {
        $mysqlResult = Invoke-DockerQuietly -Arguments @('run', '-d', '--name', $MySqlContainerName, '--restart', 'unless-stopped',
            '-p', '127.0.0.1:3306:3306', '--env', "MYSQL_ROOT_PASSWORD=$mysqlRootPassword", '--env', "MYSQL_DATABASE=$dbName",
            '--env', "MYSQL_USER=$dbUser", '--env', "MYSQL_PASSWORD=$dbPassword", 'mysql:8.4')
        if ($mysqlResult.ExitCode -ne 0) {
            throw 'MySQL 容器创建失败。'
        }
        Wait-MySqlReady -RootPassword $mysqlRootPassword

        $redisResult = Invoke-DockerQuietly -Arguments @('run', '-d', '--name', $RedisContainerName, '--restart', 'unless-stopped',
            '-p', '127.0.0.1:6379:6379', 'redis:7.4-alpine', 'redis-server', '--requirepass', $redisPassword)
        if ($redisResult.ExitCode -ne 0) {
            throw 'Redis 容器创建失败。'
        }
        Wait-RedisReady -Password $redisPassword
    }
    finally {
        $mysqlRootPassword = $null
    }
}

if (-not $validInfrastructure) {
    Backup-ReplacedCredential -Path $InfrastructureCredentialPath
    [pscustomobject]@{
        CreatedAt = (Get-Date).ToUniversalTime().ToString('o')
        MySqlHost = $dbHost
        MySqlPort = $dbPort
        MySqlDatabase = $dbName
        MySqlUser = $dbUser
        MySqlPassword = ConvertTo-SecureString -String $dbPassword -AsPlainText -Force
        RedisHost = '127.0.0.1'
        RedisPort = '6379'
        RedisPassword = ConvertTo-SecureString -String $redisPassword -AsPlainText -Force
    } | Export-Clixml -LiteralPath $InfrastructureCredentialPath -Force
}

if (-not $validAdminSecret) {
    Backup-ReplacedCredential -Path $AdminSecretPath
    [pscustomobject]@{
        CreatedAt = (Get-Date).ToUniversalTime().ToString('o')
        RuoYiTokenSecret = ConvertTo-SecureString -String (New-RandomSecret -ByteCount 64) -AsPlainText -Force
        LocalWebAccessToken = ConvertTo-SecureString -String (New-RandomSecret -ByteCount 32) -AsPlainText -Force
        # RuoYi validates login passwords at 20 characters; 12 bytes encode to 16 URL-safe characters.
        RuoYiAdminPassword = ConvertTo-SecureString -String (New-RandomSecret -ByteCount 12) -AsPlainText -Force
    } | Export-Clixml -LiteralPath $AdminSecretPath -Force
}

$dbPassword = $null
$redisPassword = $null

& (Join-Path $PSScriptRoot 'initialize-admin-db.ps1') `
    -ContainerName $MySqlContainerName `
    -InfrastructureCredentialPath $InfrastructureCredentialPath `
    -AdminSecretPath $AdminSecretPath

& (Join-Path $PSScriptRoot 'start-admin.ps1') `
    -InfrastructureCredentialPath $InfrastructureCredentialPath `
    -AdminSecretPath $AdminSecretPath

Write-Host '若依基础设施恢复完成，统一入口地址为 http://127.0.0.1:8001'
