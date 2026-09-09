[CmdletBinding()]
param(
    [string]$AdminSecretPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\admin-secrets.clixml')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $AdminSecretPath)) {
    throw "若依本机密钥不存在。路径为 $AdminSecretPath"
}

$adminSecrets = Import-Clixml -LiteralPath $AdminSecretPath
$securePassword = $adminSecrets.RuoYiAdminPassword
if ($securePassword -isnot [System.Security.SecureString]) {
    throw '尚未保存若依管理员密码，请先完成管理员密码初始化。'
}

$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    Set-Clipboard -Value $plainPassword
}
finally {
    if ($null -ne $plainPassword) {
        $plainPassword = $null
    }
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}

Write-Host '若依管理员账号为 admin，密码已复制到 Windows 剪贴板，未在终端中显示。'
