import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("Windows launcher distinguishes credential failures and never formats secret values", {
  skip: process.platform !== "win32"
}, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "bge-credential-test-"));
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    . (Join-Path $env:BGE_TEST_REPO 'admin/scripts/credential-status.ps1')
    $file = Join-Path $env:BGE_TEST_DIR 'fixture.clixml'
    function Check($expected) {
      $state = Get-BgeCredentialStatus -Path $file -Kind Infrastructure
      if ($state.Status -ne $expected) { throw ('Expected ' + $expected + ', got ' + $state.Status) }
      if ((Format-BgeCredentialStatus $state).Contains($fixtureSecret)) { throw 'Secret leaked' }
    }
    $fixtureSecret = [Guid]::NewGuid().ToString('N')
    Check 'missing'
    '<broken' | Set-Content -LiteralPath $file
    Check 'unreadable'
    $payload = [pscustomobject]@{
      MySqlHost='127.0.0.1'; MySqlPort=3306; MySqlDatabase='fixture'; MySqlUser='fixture'
      MySqlPassword=(ConvertTo-SecureString $fixtureSecret -AsPlainText -Force)
      RedisHost='127.0.0.1'; RedisPort=6379
      RedisPassword=(ConvertTo-SecureString $fixtureSecret -AsPlainText -Force)
    }
    $payload | Export-Clixml -LiteralPath $file
    Check 'ready'
    $payload.MySqlPort='3306'; $payload.RedisPort='6379'
    $payload | Export-Clixml -LiteralPath $file
    Check 'ready'
    $payload.MySqlPort=65536
    $payload | Export-Clixml -LiteralPath $file
    Check 'invalid-schema'
    $payload.MySqlPort=3306; $payload.RedisPassword=$fixtureSecret
    $payload | Export-Clixml -LiteralPath $file
    Check 'invalid-schema'
    $payload.RedisPassword=[Security.SecureString]::new()
    $payload | Export-Clixml -LiteralPath $file
    Check 'invalid-schema'
    $payload.RedisPassword=ConvertTo-SecureString $fixtureSecret -AsPlainText -Force
    $payload.MySqlHost=''
    $payload | Export-Clixml -LiteralPath $file
    Check 'invalid-schema'
    $admin = [pscustomobject]@{
      RuoYiTokenSecret=(ConvertTo-SecureString $fixtureSecret -AsPlainText -Force)
      LocalWebAccessToken=(ConvertTo-SecureString $fixtureSecret -AsPlainText -Force)
      RuoYiAdminPassword=(ConvertTo-SecureString $fixtureSecret -AsPlainText -Force)
    }
    $admin | Export-Clixml -LiteralPath $file
    if ((Get-BgeCredentialStatus -Path $file -Kind Admin).Status -ne 'ready') { throw 'Admin rejected' }
    $admin.PSObject.Properties.Remove('RuoYiAdminPassword')
    $admin | Export-Clixml -LiteralPath $file
    if ((Get-BgeCredentialStatus -Path $file -Kind Admin).Status -ne 'invalid-schema') { throw 'Missing field accepted' }
    $sourceDir = Join-Path $env:BGE_TEST_DIR 'source'
    $destinationDir = Join-Path $env:BGE_TEST_DIR 'destination'
    New-Item -ItemType Directory -Path $sourceDir | Out-Null
    $payload.MySqlHost='127.0.0.1'
    $payload | Export-Clixml -LiteralPath (Join-Path $sourceDir 'credentials.clixml')
    $admin | Add-Member -NotePropertyName RuoYiAdminPassword -NotePropertyValue (ConvertTo-SecureString $fixtureSecret -AsPlainText -Force)
    $admin | Export-Clixml -LiteralPath (Join-Path $sourceDir 'admin-secrets.clixml')
    $restoreScript = Join-Path $env:BGE_TEST_REPO 'admin/scripts/restore-local-credentials.ps1'
    $restoreReport = Join-Path $env:BGE_TEST_DIR 'restore.json'
    & $restoreScript -SourceDirectory $sourceDir -DestinationDirectory $destinationDir -ReportPath $restoreReport
    foreach ($name in @('credentials.clixml','admin-secrets.clixml')) {
      if ((Get-FileHash (Join-Path $sourceDir $name)).Hash -ne (Get-FileHash (Join-Path $destinationDir $name)).Hash) {
        throw 'Encrypted credential bytes changed'
      }
    }
    $rejected = $false
    try { & $restoreScript -SourceDirectory $sourceDir -DestinationDirectory $destinationDir -ReportPath $restoreReport }
    catch { $rejected = $true }
    if (-not $rejected) { throw 'Existing credentials overwritten' }
    if ((Get-Content $restoreReport -Raw).Contains($fixtureSecret)) { throw 'Restore report leaked a secret' }
    Write-Output 'credential-cases-passed'
  `;
  try {
    const result = spawnSync(path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
        encoding: "utf8", timeout: 20000,
        env: { ...process.env, BGE_TEST_DIR: temporary, BGE_TEST_REPO: path.resolve(import.meta.dirname, ".."),
          // Node can inherit the host PowerShell 7 module path. Use Windows
          // PowerShell's own modules to match the desktop CMD environment.
          PSModulePath: path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/Modules") }
      });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /credential-cases-passed/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
