[CmdletBinding()]
param(
    [string]$AdminSecretPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\admin-secrets.clixml')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $AdminSecretPath)) {
    $codexPackageRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Packages'
    $virtualizedCandidates = @(
        Get-ChildItem -LiteralPath $codexPackageRoot -Directory -Filter 'OpenAI.Codex_*' -ErrorAction SilentlyContinue |
            ForEach-Object {
                Join-Path $_.FullName 'LocalCache\Local\BGE-RuoYi-Infra\admin-secrets.clixml'
            } |
            Where-Object { Test-Path -LiteralPath $_ }
    )

    if ($virtualizedCandidates.Count -eq 1) {
        $AdminSecretPath = $virtualizedCandidates[0]
    }
    elseif ($virtualizedCandidates.Count -gt 1) {
        throw '找到多份 Codex 虚拟化若依密钥，无法安全判断当前文件。请运行若依本机环境恢复工具。'
    }
    else {
        throw "若依本机密钥不存在。路径为 $AdminSecretPath"
    }
}

$adminSecrets = Import-Clixml -LiteralPath $AdminSecretPath
$securePassword = $adminSecrets.RuoYiAdminPassword
if ($securePassword -isnot [System.Security.SecureString]) {
    throw '尚未保存若依管理员密码，请先完成管理员密码初始化。'
}

$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $clipboardCopied = $false
    $clipboardError = $null
    for ($attempt = 1; $attempt -le 6 -and -not $clipboardCopied; $attempt++) {
        try {
            Set-Clipboard -Value $plainPassword -ErrorAction Stop
            $clipboardCopied = $true
        }
        catch {
            $clipboardError = $_
            if ($attempt -lt 6) {
                Start-Sleep -Milliseconds 250
            }
        }
    }

    if (-not $clipboardCopied) {
        throw "无法写入 Windows 剪贴板。请关闭正在占用剪贴板的程序后重试。最后错误：$($clipboardError.Exception.Message)"
    }
}
finally {
    if ($null -ne $plainPassword) {
        $plainPassword = $null
    }
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}

Write-Host '若依管理员账号为 admin，密码已复制到 Windows 剪贴板，未在终端中显示。'
