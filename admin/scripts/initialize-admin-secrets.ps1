[CmdletBinding()]
param(
    [string]$SecretPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\admin-secrets.clixml'),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$existingTokenSecret = $null
$existingLocalWebToken = $null
$existingAdminPassword = $null
if (Test-Path -LiteralPath $SecretPath) {
    $existingSecrets = Import-Clixml -LiteralPath $SecretPath
    if ($existingSecrets.RuoYiTokenSecret -is [System.Security.SecureString]) {
        $existingTokenSecret = $existingSecrets.RuoYiTokenSecret
    }
    if ($existingSecrets.LocalWebAccessToken -is [System.Security.SecureString]) {
        $existingLocalWebToken = $existingSecrets.LocalWebAccessToken
    }
    if ($existingSecrets.RuoYiAdminPassword -is [System.Security.SecureString]) {
        $existingAdminPassword = $existingSecrets.RuoYiAdminPassword
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
    $existingAdminPassword -is [System.Security.SecureString]
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
$adminPassword = $existingAdminPassword
if (-not ($adminPassword -is [System.Security.SecureString])) {
    $adminPassword = New-RandomSecureSecret -ByteCount 24
}

$payload = [pscustomobject]@{
    CreatedAt = (Get-Date).ToUniversalTime().ToString('o')
    RuoYiTokenSecret = $tokenSecret
    LocalWebAccessToken = $localWebToken
    RuoYiAdminPassword = $adminPassword
}
$payload | Export-Clixml -LiteralPath $SecretPath -Force

Write-Host "若依本机密钥已使用 Windows 用户保护写入 $SecretPath"
Write-Host '密钥内容没有输出。'
