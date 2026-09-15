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

$database = $BgeRuoYiDatabaseName
$repositoryRoot = $BgeRuoYiRepositoryRoot
$databaseUser = [string]$env:RUOYI_DB_USERNAME
$officialCoreSql = Join-Path $repositoryRoot 'admin\backend\sql\ry_20260417.sql'
$officialQuartzSql = Join-Path $repositoryRoot 'admin\backend\sql\quartz.sql'
$bgeMenuSql = Join-Path $repositoryRoot 'admin\sql\001-bge-readonly-menu.sql'
$portalSql = Join-Path $repositoryRoot 'admin\sql\002-bge-portal-users.sql'
$pointsSql = Join-Path $repositoryRoot 'admin\sql\003-bge-points.sql'
$adminProductSql = Join-Path $repositoryRoot 'admin\sql\004-bge-admin-product.sql'
$accountLevelsSql = Join-Path $repositoryRoot 'admin\sql\005-bge-account-levels.sql'

foreach ($sqlFile in @($officialCoreSql, $officialQuartzSql, $bgeMenuSql, $portalSql, $pointsSql, $adminProductSql, $accountLevelsSql)) {
    if (-not (Test-Path -LiteralPath $sqlFile)) {
        throw "缺少数据库脚本 $sqlFile"
    }
}

if ($databaseUser -match '^(?i:root)$') {
    throw '若依初始化和运行必须使用专用应用账号，拒绝使用 MySQL root。'
}

$previousMySqlPassword = $env:MYSQL_PWD
$env:MYSQL_PWD = $env:RUOYI_DB_PASSWORD

function Invoke-MySqlQuery {
    param([Parameter(Mandatory = $true)][string]$Sql)

    $result = & docker exec --env MYSQL_PWD $ContainerName `
        mysql --batch --skip-column-names --raw --host=127.0.0.1 `
        --user=$env:RUOYI_DB_USERNAME --database=$database --execute=$Sql 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "MySQL 查询失败。$($result | Select-Object -Last 3 | Out-String)"
    }
    return @($result)
}

function Import-MySqlFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    # Windows PowerShell 5.1 transcodes native-process stdin through the
    # active console code page. Copy the UTF-8 SQL bytes into the container
    # first so Chinese seed data never becomes question marks on import.
    $containerSqlPath = "/tmp/bge-import-$([Guid]::NewGuid().ToString('N')).sql"
    $containerTarget = "${ContainerName}:$containerSqlPath"
    try {
        & docker cp $Path $containerTarget
        if ($LASTEXITCODE -ne 0) {
            throw "MySQL 脚本复制到容器失败。文件为 $Path"
        }
        & docker exec --env MYSQL_PWD $ContainerName `
            mysql --default-character-set=utf8mb4 --host=127.0.0.1 `
            --user=$env:RUOYI_DB_USERNAME --database=$database `
            --execute="source $containerSqlPath"
        if ($LASTEXITCODE -ne 0) {
            throw "MySQL 脚本导入失败。文件为 $Path"
        }
    }
    finally {
        & docker exec $ContainerName rm -f $containerSqlPath 2>$null | Out-Null
    }
}

try {
    $tableCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$database';" | Select-Object -First 1)
    if ($tableCount -eq 0) {
        Write-Host '目标数据库为空，开始导入官方若依核心结构。'
        Import-MySqlFile $officialCoreSql
        Import-MySqlFile $officialQuartzSql
    }
    else {
        $requiredCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$database' AND LOWER(table_name) IN ('sys_user','sys_role','sys_menu','sys_role_menu','sys_config','qrtz_job_details');" | Select-Object -First 1)
        if ($requiredCount -ne 6) {
            throw '目标数据库非空且缺少若依核心表。为保护已有数据，脚本已停止，不会执行重置。'
        }
        Write-Host '检测到完整若依核心结构，跳过带 DROP 的官方初始化脚本。'
    }

    Import-MySqlFile $bgeMenuSql
    Import-MySqlFile $portalSql
    Import-MySqlFile $pointsSql
    Import-MySqlFile $adminProductSql
    Import-MySqlFile $accountLevelsSql

    $permissionCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_menu WHERE perms IN ('bge:task:list','bge:task:query','bge:output:view','bge:workbench:use','bge:task:retry');" | Select-Object -First 1)
    $roleCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_role WHERE role_key = 'bge_viewer' AND del_flag = '0';" | Select-Object -First 1)
    $roleMenuCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_role_menu rm JOIN sys_role r ON r.role_id = rm.role_id WHERE r.role_key = 'bge_viewer' AND r.del_flag = '0';" | Select-Object -First 1)
    $operatorRoleCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_role WHERE role_key = 'bge_operator' AND del_flag = '0';" | Select-Object -First 1)
    $operatorRoleMenuCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_role_menu rm JOIN sys_role r ON r.role_id = rm.role_id WHERE r.role_key = 'bge_operator' AND r.del_flag = '0';" | Select-Object -First 1)
    $portalRoleCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_role WHERE role_key = 'bge_portal_user' AND status = '0' AND del_flag = '0';" | Select-Object -First 1)
    $portalRoleMenuCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_role_menu rm JOIN sys_role r ON r.role_id = rm.role_id WHERE r.role_key = 'bge_portal_user' AND r.del_flag = '0';" | Select-Object -First 1)
    $portalTableCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$database' AND table_name = 'bge_portal_job';" | Select-Object -First 1)
    $pointsTableCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$database' AND table_name IN ('bge_point_account','bge_point_ledger','bge_point_price','bge_point_charge','bge_recharge_request','bge_point_price_history');" | Select-Object -First 1)
    $pointsPriceCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM bge_point_price;" | Select-Object -First 1)
    $pointsPermissionCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_menu WHERE perms IN ('bge:points:list','bge:points:adjust','bge:points:recharge:review','bge:points:price:manage');" | Select-Object -First 1)
    $customerRoleCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_role WHERE role_key IN ('bge_customer','bge_priority_customer') AND status = '0' AND del_flag = '0';" | Select-Object -First 1)
    $customerRoleMenuCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_role_menu rm JOIN sys_role r ON r.role_id=rm.role_id WHERE r.role_key IN ('bge_portal_user','bge_customer','bge_priority_customer') AND r.del_flag='0';" | Select-Object -First 1)
    $unexpectedRoleMenuCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_role_menu rm JOIN sys_role r ON r.role_id = rm.role_id JOIN sys_menu m ON m.menu_id = rm.menu_id WHERE r.role_key = 'bge_viewer' AND r.del_flag = '0' AND NOT (m.menu_id IN (SELECT menu_id FROM sys_menu WHERE (parent_id = 0 AND path = 'bge' AND menu_type = 'M') OR (parent_id = (SELECT menu_id FROM sys_menu WHERE parent_id = 0 AND path = 'bge' AND menu_type = 'M' ORDER BY menu_id LIMIT 1) AND path IN ('task','points') AND menu_type = 'C')) OR m.perms IN ('bge:task:query','bge:output:view'));" | Select-Object -First 1)
    $unexpectedOperatorRoleMenuCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_role_menu rm JOIN sys_role r ON r.role_id = rm.role_id JOIN sys_menu m ON m.menu_id = rm.menu_id WHERE r.role_key = 'bge_operator' AND r.del_flag = '0' AND NOT (m.menu_id IN (SELECT menu_id FROM sys_menu WHERE (parent_id = 0 AND path = 'bge' AND menu_type = 'M') OR (parent_id = (SELECT menu_id FROM sys_menu WHERE parent_id = 0 AND path = 'bge' AND menu_type = 'M' ORDER BY menu_id LIMIT 1) AND path IN ('task','points') AND menu_type = 'C')) OR m.perms IN ('bge:task:query','bge:output:view','bge:workbench:use','bge:task:retry','bge:points:adjust','bge:points:recharge:review'));" | Select-Object -First 1)
    $sampleEnabledCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_user WHERE user_name = 'ry' AND status = '0' AND del_flag = '0';" | Select-Object -First 1)
    $officialMenuCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_menu WHERE parent_id = 0 AND (path = 'http://ruoyi.vip' OR menu_name = '若依官网');" | Select-Object -First 1)
    $hiddenLegacyRootCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_menu WHERE parent_id = 0 AND path IN ('monitor','tool') AND visible = '1';" | Select-Object -First 1)
    $hiddenSystemMenuCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_menu WHERE parent_id = (SELECT menu_id FROM sys_menu WHERE parent_id = 0 AND path = 'system' AND menu_type = 'M' ORDER BY menu_id LIMIT 1) AND path IN ('menu','dept','post','dict','config','notice') AND visible = '1';" | Select-Object -First 1)
    $visibleSystemMenuCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_menu WHERE parent_id = (SELECT menu_id FROM sys_menu WHERE parent_id = 0 AND path = 'system' AND menu_type = 'M' ORDER BY menu_id LIMIT 1) AND path IN ('user','log') AND visible = '0';" | Select-Object -First 1)
    $hiddenRoleMenuCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_menu WHERE parent_id = (SELECT menu_id FROM sys_menu WHERE parent_id = 0 AND path = 'system' AND menu_type = 'M' ORDER BY menu_id LIMIT 1) AND path = 'role' AND visible = '1' AND status = '1';" | Select-Object -First 1)
    if ($permissionCount -ne 5 -or $roleCount -ne 1 -or $roleMenuCount -ne 5 -or $operatorRoleCount -ne 1 -or $operatorRoleMenuCount -ne 9 -or $portalRoleCount -ne 1 -or $portalRoleMenuCount -ne 0 -or $portalTableCount -ne 1 -or $pointsTableCount -ne 6 -or $pointsPriceCount -ne 12 -or $pointsPermissionCount -ne 4 -or $customerRoleCount -ne 2 -or $customerRoleMenuCount -ne 0 -or $unexpectedRoleMenuCount -ne 0 -or $unexpectedOperatorRoleMenuCount -ne 0 -or $sampleEnabledCount -ne 0 -or $officialMenuCount -ne 0 -or $hiddenLegacyRootCount -ne 2 -or $hiddenSystemMenuCount -ne 6 -or $visibleSystemMenuCount -ne 2 -or $hiddenRoleMenuCount -ne 1) {
        throw 'BGE 菜单、角色或样例账号状态验证失败。'
    }

    Write-Host '若依数据库、BGE 作图、门户、积分与任务归属表验证通过。'
}
finally {
    if ($null -eq $previousMySqlPassword) {
        Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
    }
    else {
        $env:MYSQL_PWD = $previousMySqlPassword
    }
}
