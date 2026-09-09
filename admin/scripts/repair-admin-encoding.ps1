[CmdletBinding()]
param(
    [string]$ContainerName = 'bge-ruoyi-mysql',
    [string]$InfrastructureCredentialPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\credentials.clixml'),
    [string]$AdminSecretPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\admin-secrets.clixml')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'import-admin-environment.ps1') `
    -InfrastructureCredentialPath $InfrastructureCredentialPath `
    -AdminSecretPath $AdminSecretPath

$repositoryRoot = $BgeRuoYiRepositoryRoot
$database = $BgeRuoYiDatabaseName
$coreSql = Join-Path $repositoryRoot 'admin\backend\sql\ry_20260417.sql'
$bgeMenuSql = Join-Path $repositoryRoot 'admin\sql\001-bge-readonly-menu.sql'
$referenceContainer = 'bge-ruoyi-encoding-reference-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$referenceDatabase = 'reference_ruoyi'
$temporaryDirectory = Join-Path $env:TEMP ("bge-ruoyi-encoding-" + [Guid]::NewGuid().ToString('N'))
$referencePassword = $null
$previousMySqlPassword = $env:MYSQL_PWD
$referenceStarted = $false

foreach ($requiredFile in @($coreSql, $bgeMenuSql)) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
        throw "缺少编码修复所需的 SQL 文件：$requiredFile"
    }
}

function New-RandomSecret {
    param([Parameter(Mandatory = $true)][int]$ByteCount)

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

function Invoke-TargetSql {
    param([Parameter(Mandatory = $true)][string]$Sql)

    $env:MYSQL_PWD = $env:RUOYI_DB_PASSWORD
    $result = & docker exec --env MYSQL_PWD $ContainerName `
        mysql --batch --skip-column-names --raw --default-character-set=utf8mb4 --host=127.0.0.1 `
        --user=$env:RUOYI_DB_USERNAME --database=$database --execute=$Sql 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw '无法更新若依本机数据库。'
    }
    return @($result)
}

function Wait-ReferenceMySql {
    $deadline = (Get-Date).AddSeconds(60)
    do {
        $env:MYSQL_PWD = $referencePassword
        & docker exec --env MYSQL_PWD $referenceContainer mysqladmin --host=127.0.0.1 --user=root ping --silent 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw '用于编码修复的临时 MySQL 容器未能在 60 秒内就绪。'
}

function Import-RawSqlToReference {
    param([Parameter(Mandatory = $true)][string]$Path)

    $containerSqlPath = "/tmp/bge-reference-$([Guid]::NewGuid().ToString('N')).sql"
    try {
        & docker cp $Path "${referenceContainer}:$containerSqlPath"
        if ($LASTEXITCODE -ne 0) { throw '无法复制官方 SQL 到临时参考容器。' }
        $env:MYSQL_PWD = $referencePassword
        & docker exec --env MYSQL_PWD $referenceContainer `
            mysql --default-character-set=utf8mb4 --host=127.0.0.1 --user=root --database=$referenceDatabase `
            --execute="source $containerSqlPath"
        if ($LASTEXITCODE -ne 0) { throw '无法导入官方 SQL 到临时参考容器。' }
    }
    finally {
        & docker exec $referenceContainer rm -f $containerSqlPath 2>$null | Out-Null
    }
}

function Copy-ReferenceTable {
    param(
        [Parameter(Mandatory = $true)][string]$SourceTable,
        [Parameter(Mandatory = $true)][string]$TargetTable
    )

    if ($SourceTable -notmatch '^[a-z_]+$' -or $TargetTable -notmatch '^[a-z_]+$') {
        throw '临时表名称不符合安全规则。'
    }
    $tick = [char]96
    [void](Invoke-TargetSql "DROP TABLE IF EXISTS ${tick}$TargetTable${tick}; CREATE TABLE ${tick}$TargetTable${tick} LIKE ${tick}$SourceTable${tick};")

    $remoteDumpPath = "/tmp/$TargetTable.sql"
    $hostDumpPath = Join-Path $temporaryDirectory "$TargetTable.sql"
    $dumpCommand = "mysqldump --default-character-set=utf8mb4 --no-create-info --replace --skip-triggers --compact --host=127.0.0.1 --user=root $referenceDatabase $SourceTable | sed 's/${tick}$SourceTable${tick}/${tick}$TargetTable${tick}/g' > $remoteDumpPath"
    $env:MYSQL_PWD = $referencePassword
    & docker exec --env MYSQL_PWD $referenceContainer sh -c $dumpCommand
    if ($LASTEXITCODE -ne 0) { throw "无法生成 $SourceTable 的参考数据。" }
    try {
        & docker cp "${referenceContainer}:$remoteDumpPath" $hostDumpPath
        if ($LASTEXITCODE -ne 0) { throw "无法复制 $SourceTable 的参考数据。" }
        & docker cp $hostDumpPath "${ContainerName}:$remoteDumpPath"
        if ($LASTEXITCODE -ne 0) { throw "无法向本机 MySQL 导入 $SourceTable 的参考数据。" }
        $env:MYSQL_PWD = $env:RUOYI_DB_PASSWORD
        & docker exec --env MYSQL_PWD $ContainerName `
            mysql --default-character-set=utf8mb4 --host=127.0.0.1 --user=$env:RUOYI_DB_USERNAME --database=$database `
            --execute="source $remoteDumpPath"
        if ($LASTEXITCODE -ne 0) { throw "无法加载 $SourceTable 的参考数据。" }
    }
    finally {
        & docker exec $referenceContainer rm -f $remoteDumpPath 2>$null | Out-Null
        & docker exec $ContainerName rm -f $remoteDumpPath 2>$null | Out-Null
        Remove-Item -LiteralPath $hostDumpPath -Force -ErrorAction SilentlyContinue
    }
}

try {
    New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
    $referencePassword = New-RandomSecret -ByteCount 24
    & docker run -d --rm --name $referenceContainer --env "MYSQL_ROOT_PASSWORD=$referencePassword" `
        --env "MYSQL_DATABASE=$referenceDatabase" mysql:8.4 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '无法启动用于编码修复的临时 MySQL 容器。' }
    $referenceStarted = $true
    Wait-ReferenceMySql
    Import-RawSqlToReference -Path $coreSql

    $tables = @(
        @{ Source = 'sys_menu'; Target = 'bge_encoding_menu' },
        @{ Source = 'sys_dept'; Target = 'bge_encoding_dept' },
        @{ Source = 'sys_role'; Target = 'bge_encoding_role' },
        @{ Source = 'sys_post'; Target = 'bge_encoding_post' },
        @{ Source = 'sys_dict_type'; Target = 'bge_encoding_dict_type' },
        @{ Source = 'sys_dict_data'; Target = 'bge_encoding_dict_data' },
        @{ Source = 'sys_user'; Target = 'bge_encoding_user' }
    )
    foreach ($table in $tables) {
        Copy-ReferenceTable -SourceTable $table.Source -TargetTable $table.Target
    }

    [void](Invoke-TargetSql @"
UPDATE sys_menu current_row JOIN bge_encoding_menu reference_row ON current_row.menu_id = reference_row.menu_id
SET current_row.menu_name = IF(current_row.menu_name REGEXP '^[?]+$', reference_row.menu_name, current_row.menu_name),
    current_row.remark = IF(current_row.remark REGEXP '^[?]+$', reference_row.remark, current_row.remark)
WHERE current_row.menu_name REGEXP '^[?]+$' OR current_row.remark REGEXP '^[?]+$';
UPDATE sys_dept current_row JOIN bge_encoding_dept reference_row ON current_row.dept_id = reference_row.dept_id
SET current_row.dept_name = reference_row.dept_name
WHERE current_row.dept_name REGEXP '^[?]+$';
UPDATE sys_role current_row JOIN bge_encoding_role reference_row ON current_row.role_id = reference_row.role_id
SET current_row.role_name = IF(current_row.role_name REGEXP '^[?]+$', reference_row.role_name, current_row.role_name),
    current_row.remark = IF(current_row.remark REGEXP '^[?]+$', reference_row.remark, current_row.remark)
WHERE current_row.role_name REGEXP '^[?]+$' OR current_row.remark REGEXP '^[?]+$';
UPDATE sys_post current_row JOIN bge_encoding_post reference_row ON current_row.post_id = reference_row.post_id
SET current_row.post_name = reference_row.post_name
WHERE current_row.post_name REGEXP '^[?]+$';
UPDATE sys_dict_type current_row JOIN bge_encoding_dict_type reference_row ON current_row.dict_id = reference_row.dict_id
SET current_row.dict_name = reference_row.dict_name
WHERE current_row.dict_name REGEXP '^[?]+$';
UPDATE sys_dict_data current_row JOIN bge_encoding_dict_data reference_row ON current_row.dict_code = reference_row.dict_code
SET current_row.dict_label = reference_row.dict_label
WHERE current_row.dict_label REGEXP '^[?]+$';
UPDATE sys_user current_row JOIN bge_encoding_user reference_row ON current_row.user_id = reference_row.user_id
SET current_row.nick_name = reference_row.nick_name
WHERE current_row.nick_name REGEXP '^[?]+$';
"@)

    # Re-import custom BGE rows from exact UTF-8 bytes. Its idempotent SQL also
    # corrects display labels that were previously imported through a code page.
    & (Join-Path $PSScriptRoot 'initialize-admin-db.ps1')

    $remainingMenuNames = [int](Invoke-TargetSql "SELECT COUNT(*) FROM sys_menu WHERE menu_id < 2000 AND menu_name REGEXP '^[?]+$';" | Select-Object -First 1)
    $remainingBgeMenuNames = [int](Invoke-TargetSql "SELECT COUNT(*) FROM sys_menu WHERE path IN ('bge', 'task', 'http://127.0.0.1:8001/workbench/') AND menu_name REGEXP '^[?]+$';" | Select-Object -First 1)
    if ($remainingMenuNames -ne 0 -or $remainingBgeMenuNames -ne 0) {
        throw '菜单文字编码修复后仍有问号，已停止以便保留现场。'
    }
    Write-Host '若依默认菜单与 BGE 菜单的中文编码已修复。'
}
finally {
    foreach ($tableName in @('bge_encoding_menu', 'bge_encoding_dept', 'bge_encoding_role', 'bge_encoding_post', 'bge_encoding_dict_type', 'bge_encoding_dict_data', 'bge_encoding_user')) {
        try {
            $tick = [char]96
            [void](Invoke-TargetSql "DROP TABLE IF EXISTS ${tick}$tableName${tick};")
        }
        catch { }
    }
    if ($referenceStarted) {
        & docker rm -f $referenceContainer 2>$null | Out-Null
    }
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
    $referencePassword = $null
    if ($null -eq $previousMySqlPassword) { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue }
    else { $env:MYSQL_PWD = $previousMySqlPassword }
}
