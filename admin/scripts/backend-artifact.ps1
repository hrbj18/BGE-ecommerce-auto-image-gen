function Get-BgeBackendRuntimeInputs {
    param([Parameter(Mandatory = $true)][string]$RepositoryRoot)

    $backendRoot = Join-Path $RepositoryRoot 'admin\backend'
    if (-not (Test-Path -LiteralPath $backendRoot)) {
        throw "RuoYi backend source directory is missing: $backendRoot"
    }

    return Get-ChildItem -LiteralPath $backendRoot -Recurse -File | Where-Object {
        $_.FullName -notmatch '[\\/]target[\\/]' -and
        ($_.Name -eq 'pom.xml' -or $_.FullName -match '[\\/]src[\\/]main[\\/]')
    }
}

function Test-BgeBackendArtifactFresh {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$BackendJar
    )

    if (-not (Test-Path -LiteralPath $BackendJar)) {
        return $false
    }

    $artifactTime = (Get-Item -LiteralPath $BackendJar).LastWriteTimeUtc
    foreach ($inputFile in Get-BgeBackendRuntimeInputs -RepositoryRoot $RepositoryRoot) {
        if ($inputFile.LastWriteTimeUtc -gt $artifactTime) {
            return $false
        }
    }
    return $true
}

function Update-BgeBackendArtifact {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$BackendJar
    )

    if (Test-BgeBackendArtifactFresh -RepositoryRoot $RepositoryRoot -BackendJar $BackendJar) {
        return $false
    }

    $mavenCommand = Get-Command mvn -ErrorAction Stop
    $backendPom = Join-Path $RepositoryRoot 'admin\backend\pom.xml'
    Write-Host 'RuoYi backend sources are newer than the runnable JAR. Rebuilding the backend...'
    Push-Location $RepositoryRoot
    try {
        & $mavenCommand.Source -f $backendPom package -DskipTests
        if ($LASTEXITCODE -ne 0) {
            throw "RuoYi backend build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath $BackendJar)) {
        throw 'RuoYi backend build completed without producing the runnable JAR.'
    }
    if (-not (Test-BgeBackendArtifactFresh -RepositoryRoot $RepositoryRoot -BackendJar $BackendJar)) {
        throw 'RuoYi backend JAR is still older than its runtime sources after the build.'
    }
    return $true
}
