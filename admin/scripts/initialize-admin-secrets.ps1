[CmdletBinding()]
param(
    [string]$SecretPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\admin-secrets.clixml'),
    [switch]$Force,
    [switch]$RemoveLegacyAdminPassword
)

$ErrorActionPreference = 'Stop'

$existingTokenSecret = $null
$existingLocalWebToken = $null
$hasLegacyAdminPassword = $false
$legacyAdminPassword = $null
if (Test-Path -LiteralPath $SecretPath) {
    $existingSecrets = Import-Clixml -LiteralPath $SecretPath
    if ($existingSecrets.RuoYiTokenSecret -is [System.Security.SecureString]) {
        $existingTokenSecret = $existingSecrets.RuoYiTokenSecret
    }
    if ($existingSecrets.LocalWebAccessToken -is [System.Security.SecureString]) {
        $existingLocalWebToken = $existingSecrets.LocalWebAccessToken
    }
    $hasLegacyAdminPassword = $existingSecrets.RuoYiAdminPassword -is [System.Security.SecureString]
    if ($hasLegacyAdminPassword) {
        $legacyAdminPassword = $existingSecrets.RuoYiAdminPassword
    }
}

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

function New-RandomSecureSecret {
    param([int]$ByteCount)

    $plainTextSecret = New-RandomSecret -ByteCount $ByteCount
    try {
        return ConvertTo-SecureString -String $plainTextSecret -AsPlainText -Force
    }
    finally {
        $plainTextSecret = $null
    }
}

if (
    -not $Force -and
    $existingTokenSecret -is [System.Security.SecureString] -and
    $existingLocalWebToken -is [System.Security.SecureString] -and
    (-not $hasLegacyAdminPassword -or -not $RemoveLegacyAdminPassword)
) {
    Write-Host '若依本机密钥已经完整存在，本次没有修改。'
    exit 0
}

$parent = Split-Path -Parent $SecretPath
New-Item -ItemType Directory -Path $parent -Force | Out-Null

$tokenSecret = if (-not $Force -and $existingTokenSecret -is [System.Security.SecureString]) {
    $existingTokenSecret
} else {
    New-RandomSecureSecret -ByteCount 64
}
$localWebToken = if (-not $Force -and $existingLocalWebToken -is [System.Security.SecureString]) {
    $existingLocalWebToken
} else {
    New-RandomSecureSecret -ByteCount 32
}
$payload = [pscustomobject]@{
    CreatedAt = (Get-Date).ToUniversalTime().ToString('o')
    RuoYiTokenSecret = $tokenSecret
    LocalWebAccessToken = $localWebToken
}
if ($hasLegacyAdminPassword -and -not $RemoveLegacyAdminPassword) {
    $payload | Add-Member -NotePropertyName RuoYiAdminPassword -NotePropertyValue $legacyAdminPassword
}
$payload | Export-Clixml -LiteralPath $SecretPath -Force

Write-Host "若依本机密钥已使用 Windows 用户保护写入 $SecretPath"
if ($hasLegacyAdminPassword -and $RemoveLegacyAdminPassword) {
    Write-Host '旧版管理员密码字段已移除；管理员密码现在只由若依账户管理。'
}
Write-Host '内部令牌内容没有输出。'
