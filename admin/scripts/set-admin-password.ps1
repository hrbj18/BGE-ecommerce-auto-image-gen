[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [System.Security.SecureString]$NewPassword,
    [string]$InfrastructureCredentialPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\credentials.clixml'),
    [string]$AdminSecretPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\admin-secrets.clixml'),
    [string]$MySqlContainerName = 'bge-ruoyi-mysql',
    [string]$RedisContainerName = 'bge-ruoyi-redis'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'import-admin-environment.ps1') `
    -InfrastructureCredentialPath $InfrastructureCredentialPath `
    -AdminSecretPath $AdminSecretPath

function ConvertTo-PlainSecret {
    param([Parameter(Mandatory = $true)]$Value)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Invoke-RuoYiJson {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('POST', 'PUT')][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [object]$Body,
        [string]$Token
    )

    $headers = @{}
    if (-not [string]::IsNullOrWhiteSpace($Token)) {
        $headers.Authorization = "Bearer $Token"
    }
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$env:RUOYI_SERVER_PORT$Path" -Method $Method `
        -Headers $headers -Body ($Body | ConvertTo-Json -Compress) -ContentType 'application/json' `
        -UseBasicParsing -TimeoutSec 10
    return $response.Content | ConvertFrom-Json
}

function Invoke-MySqlQuery {
    param([Parameter(Mandatory = $true)][string]$Sql)

    $result = & docker exec --env MYSQL_PWD $MySqlContainerName `
        mysql --batch --skip-column-names --raw --host=127.0.0.1 `
        --user=$env:RUOYI_DB_USERNAME --database=$BgeRuoYiDatabaseName --execute=$Sql 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw '无法读取或更新若依验证码配置。'
    }
    return @($result)
}

function Clear-CaptchaCache {
    $result = & docker exec --env REDISCLI_AUTH $RedisContainerName `
        redis-cli --no-auth-warning -n 1 DEL 'sys_config:sys.account.captchaEnabled' 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw '无法清理若依验证码配置缓存。'
    }
}

function Set-CaptchaValue {
    param([Parameter(Mandatory = $true)][ValidateSet('true', 'false')][string]$Value)

    [void](Invoke-MySqlQuery "UPDATE sys_config SET config_value = '$Value', update_time = NOW() WHERE config_key = 'sys.account.captchaEnabled';")
    Clear-CaptchaCache
}

$newPlainPassword = ConvertTo-PlainSecret $NewPassword
$adminSecrets = Import-Clixml -LiteralPath $AdminSecretPath
$oldPassword = ConvertTo-PlainSecret $adminSecrets.RuoYiAdminPassword
$originalCaptchaValue = $null
$adminToken = $null
$verificationToken = $null
$passwordChanged = $false
$previousMySqlPassword = $env:MYSQL_PWD
$previousRedisCliAuth = $env:REDISCLI_AUTH
$env:MYSQL_PWD = $env:RUOYI_DB_PASSWORD
$env:REDISCLI_AUTH = $env:RUOYI_REDIS_PASSWORD

try {
    if ($newPlainPassword.Length -lt 6 -or $newPlainPassword.IndexOfAny([char[]]"`r`n") -ge 0 -or $newPlainPassword -eq 'admin123') {
        throw '管理员密码至少需要 6 位，且不能使用上游默认密码或控制字符。'
    }

    $originalCaptchaValue = [string](Invoke-MySqlQuery "SELECT config_value FROM sys_config WHERE config_key = 'sys.account.captchaEnabled' LIMIT 1;" | Select-Object -First 1)
    if ($originalCaptchaValue -notin @('true', 'false')) {
        throw '无法确认验证码原始配置。'
    }
    Set-CaptchaValue -Value 'false'

    $login = Invoke-RuoYiJson -Method POST -Path '/login' -Body @{ username = 'admin'; password = $oldPassword; code = ''; uuid = '' }
    if ([int]$login.code -ne 200 -or [string]::IsNullOrWhiteSpace([string]$login.token)) {
        throw '当前管理员密码验证失败，拒绝修改。'
    }
    $adminToken = [string]$login.token

    $reset = Invoke-RuoYiJson -Method PUT -Path '/system/user/profile/updatePwd' -Token $adminToken -Body @{ oldPassword = $oldPassword; newPassword = $newPlainPassword }
    if ([int]$reset.code -ne 200) {
        throw '若依拒绝修改管理员密码。'
    }
    $passwordChanged = $true

    $verification = Invoke-RuoYiJson -Method POST -Path '/login' -Body @{ username = 'admin'; password = $newPlainPassword; code = ''; uuid = '' }
    if ([int]$verification.code -ne 200 -or [string]::IsNullOrWhiteSpace([string]$verification.token)) {
        throw '新密码登录验证失败。'
    }
    $verificationToken = [string]$verification.token

    $updatedSecrets = [pscustomobject]@{
        CreatedAt = (Get-Date).ToUniversalTime().ToString('o')
        RuoYiTokenSecret = $adminSecrets.RuoYiTokenSecret
        LocalWebAccessToken = $adminSecrets.LocalWebAccessToken
        RuoYiAdminPassword = $NewPassword
    }
    $temporarySecretPath = "$AdminSecretPath.pending"
    try {
        $updatedSecrets | Export-Clixml -LiteralPath $temporarySecretPath -Force
        Move-Item -LiteralPath $temporarySecretPath -Destination $AdminSecretPath -Force
    }
    finally {
        Remove-Item -LiteralPath $temporarySecretPath -Force -ErrorAction SilentlyContinue
    }

    Write-Host '若依管理员密码已更新并通过本机登录验证。'
}
catch {
    if ($passwordChanged -and -not [string]::IsNullOrWhiteSpace($adminToken)) {
        try {
            [void](Invoke-RuoYiJson -Method PUT -Path '/system/user/profile/updatePwd' -Token $adminToken -Body @{ oldPassword = $newPlainPassword; newPassword = $oldPassword })
        }
        catch {
            Write-Warning '管理员密码回滚失败，请立即使用当前 Windows 用户下的 DPAPI 凭据排障。'
        }
    }
    throw
}
finally {
    if ($null -ne $originalCaptchaValue) {
        try { Set-CaptchaValue -Value $originalCaptchaValue } catch { Write-Warning '验证码配置恢复失败，需要人工检查。' }
    }
    if (-not [string]::IsNullOrWhiteSpace($adminToken)) {
        try { [void](Invoke-RuoYiJson -Method POST -Path '/logout' -Token $adminToken -Body @{}) } catch { }
    }
    if (-not [string]::IsNullOrWhiteSpace($verificationToken)) {
        try { [void](Invoke-RuoYiJson -Method POST -Path '/logout' -Token $verificationToken -Body @{}) } catch { }
    }
    $newPlainPassword = $null
    $oldPassword = $null
    if ($null -eq $previousMySqlPassword) { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue }
    else { $env:MYSQL_PWD = $previousMySqlPassword }
    if ($null -eq $previousRedisCliAuth) { Remove-Item Env:REDISCLI_AUTH -ErrorAction SilentlyContinue }
    else { $env:REDISCLI_AUTH = $previousRedisCliAuth }
}
