function Get-BgeCredentialStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateSet('Infrastructure', 'Admin')][string]$Kind
    )

    $result = [pscustomobject]@{
        Path = [System.IO.Path]::GetFullPath($Path)
        Status = 'missing'
        InvalidFields = @()
        ProbeError = $null
        Value = $null
    }
    try {
        $probe = [IO.File]::Open($result.Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $probe.Dispose()
    }
    catch {
        $reason = $_.Exception.GetBaseException()
        $result.ProbeError = $reason.HResult
        if ($reason -is [UnauthorizedAccessException]) { $result.Status = 'access-denied' }
        elseif ($reason -isnot [IO.FileNotFoundException] -and $reason -isnot [IO.DirectoryNotFoundException]) {
            $result.Status = 'unreadable'
        }
        return $result
    }
    try { $value = Import-Clixml -LiteralPath $Path -ErrorAction Stop }
    catch {
        $result.Status = 'unreadable'
        return $result
    }

    $invalid = [System.Collections.Generic.List[string]]::new()
    $secretFields = @('RuoYiTokenSecret', 'LocalWebAccessToken', 'RuoYiAdminPassword')
    if ($Kind -eq 'Infrastructure') {
        $secretFields = @('MySqlPassword', 'RedisPassword')
        foreach ($field in @('MySqlHost', 'MySqlDatabase', 'MySqlUser', 'RedisHost')) {
            if ($value.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($value.$field)) {
                $invalid.Add($field)
            }
        }
        foreach ($field in @('MySqlPort', 'RedisPort')) {
            $port = 0
            if (-not [int]::TryParse([string]$value.$field, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
                $invalid.Add($field)
            }
        }
    }
    foreach ($field in $secretFields) {
        if ($value.$field -isnot [System.Security.SecureString] -or $value.$field.Length -eq 0) {
            $invalid.Add($field)
        }
    }
    $result.InvalidFields = @($invalid.ToArray())
    if ($invalid.Count) { $result.Status = 'invalid-schema' }
    else {
        $result.Status = 'ready'
        $result.Value = $value
    }
    return $result
}

function Format-BgeCredentialStatus {
    param($State)
    # Whitelist metadata only. Never format Value or a raw import exception.
    return ('status={0}; path={1}; invalidFields={2}' -f $State.Status, $State.Path, ($State.InvalidFields -join ','))
}
