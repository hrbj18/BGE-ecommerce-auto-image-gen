[CmdletBinding()]
param(
    [string]$InfrastructureCredentialPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\credentials.clixml'),
    [string]$AdminSecretPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\admin-secrets.clixml')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'credential-status.ps1')

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

$infrastructureState = Get-BgeCredentialStatus -Path $InfrastructureCredentialPath -Kind Infrastructure
$adminSecretState = Get-BgeCredentialStatus -Path $AdminSecretPath -Kind Admin
foreach ($check in @($infrastructureState, $adminSecretState)) {
    if ($check.Status -ne 'ready') {
        throw ('BGE_CREDENTIAL_INVALID: ' + (Format-BgeCredentialStatus $check))
    }
}

$infrastructure = $infrastructureState.Value
$adminSecrets = $adminSecretState.Value
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path

$dbHost = [string]$infrastructure.MySqlHost
$dbPort = [string]$infrastructure.MySqlPort
$dbName = [string]$infrastructure.MySqlDatabase
$dbUser = [string]$infrastructure.MySqlUser
$dbPassword = ConvertTo-PlainSecret $infrastructure.MySqlPassword
$redisHost = [string]$infrastructure.RedisHost
$redisPort = [string]$infrastructure.RedisPort
$redisPassword = ConvertTo-PlainSecret $infrastructure.RedisPassword
$tokenSecret = ConvertTo-PlainSecret $adminSecrets.RuoYiTokenSecret
$localWebToken = ConvertTo-PlainSecret $adminSecrets.LocalWebAccessToken
$adminPassword = ConvertTo-PlainSecret $adminSecrets.RuoYiAdminPassword

if ($dbName -notmatch '^[A-Za-z0-9_-]+$') {
    throw 'MySQL 数据库名称不符合安全规则。'
}
foreach ($required in @($dbHost, $dbPort, $dbName, $dbUser, $dbPassword, $redisHost, $redisPort, $redisPassword, $tokenSecret, $localWebToken, $adminPassword)) {
    if ([string]::IsNullOrWhiteSpace([string]$required)) {
        throw '基础设施或若依本机密钥存在空值。'
    }
}

$env:RUOYI_DB_URL = "jdbc:mysql://${dbHost}:${dbPort}/${dbName}?useUnicode=true&characterEncoding=utf8&zeroDateTimeBehavior=convertToNull&useSSL=false&allowPublicKeyRetrieval=true&serverTimezone=GMT%2B8"
$env:RUOYI_DB_USERNAME = $dbUser
$env:RUOYI_DB_PASSWORD = $dbPassword
$env:RUOYI_REDIS_HOST = $redisHost
$env:RUOYI_REDIS_PORT = $redisPort
$env:RUOYI_REDIS_DATABASE = '1'
$env:RUOYI_REDIS_PASSWORD = $redisPassword
$env:RUOYI_TOKEN_SECRET = $tokenSecret
$env:RUOYI_PROFILE = Join-Path $repoRoot '.local-web\ruoyi\upload'
$env:RUOYI_SERVER_ADDRESS = '127.0.0.1'
$env:RUOYI_SWAGGER_ENABLED = 'false'
$env:RUOYI_SPRINGDOC_ENABLED = 'false'
$env:RUOYI_DRUID_WEB_STAT_ENABLED = 'false'
$env:RUOYI_ADMIN_BOOTSTRAP_PASSWORD = $adminPassword
$env:BGE_ENGINE_BASE_URL = 'http://127.0.0.1:8787'
$env:LOCAL_WEB_HOST = '127.0.0.1'
$env:LOCAL_WEB_PORT = '8787'
$env:LOCAL_WEB_ACCESS_MODE = 'token'
$env:LOCAL_WEB_ACCESS_TOKEN = $localWebToken
$env:LOCAL_WEB_REQUIRE_READ_TOKEN = 'true'
$env:BGE_ENGINE_ACCESS_TOKEN = $localWebToken

Set-Variable -Name BgeRuoYiDatabaseName -Value $dbName
Set-Variable -Name BgeRuoYiRepositoryRoot -Value $repoRoot
