[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceDirectory,
    [string]$DestinationDirectory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'BGE-RuoYi-Infra'),
    [string]$ReportPath = (Join-Path $PSScriptRoot '../../.local-web/ruoyi/logs/credential-restore.json')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'credential-status.ps1')
$report = [ordered]@{ result = 'checking'; copied = @(); destination = $DestinationDirectory }
try {
    $files = @(
        @{ Name = 'credentials.clixml'; Kind = 'Infrastructure' },
        @{ Name = 'admin-secrets.clixml'; Kind = 'Admin' }
    )
    # Validate every source and destination before writing either file. DPAPI
    # must be readable in this desktop process; never reset or invent a secret.
    foreach ($file in $files) {
        $source = Get-BgeCredentialStatus -Path (Join-Path $SourceDirectory $file.Name) -Kind $file.Kind
        if ($source.Status -ne 'ready') { throw 'Source credentials are not readable in this Windows session.' }
        $destination = Join-Path $DestinationDirectory $file.Name
        if ([IO.File]::Exists($destination)) { throw 'Destination already exists; refusing to overwrite credentials.' }
    }
    New-Item -ItemType Directory -Path $DestinationDirectory -Force | Out-Null
    foreach ($file in $files) {
        [IO.File]::Copy((Join-Path $SourceDirectory $file.Name), (Join-Path $DestinationDirectory $file.Name), $false)
        $report.copied += $file.Name
    }
    $report.result = 'restored'
    Write-Host 'Original encrypted credentials restored. No password was changed.'
}
catch {
    $report.result = 'failed'
    $report.errorType = $_.Exception.GetType().FullName
    $report.line = $_.InvocationInfo.ScriptLineNumber
    throw
}
finally {
    New-Item -ItemType Directory -Path (Split-Path -Parent $reportPath) -Force | Out-Null
    $report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportPath -Encoding UTF8
}
