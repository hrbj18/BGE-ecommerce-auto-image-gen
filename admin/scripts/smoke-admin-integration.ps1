[CmdletBinding()]
param(
    [string]$InfrastructureCredentialPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\credentials.clixml'),
    [string]$AdminSecretPath = (Join-Path $env:LOCALAPPDATA 'BGE-RuoYi-Infra\admin-secrets.clixml'),
    [string]$MySqlContainerName = 'bge-ruoyi-mysql',
    [string]$RedisContainerName = 'bge-ruoyi-redis'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'import-admin-environment.ps1') `
    -InfrastructureCredentialPath $InfrastructureCredentialPath `
    -AdminSecretPath $AdminSecretPath

$repositoryRoot = $BgeRuoYiRepositoryRoot
$database = $BgeRuoYiDatabaseName
$runtimeRoot = Join-Path $repositoryRoot '.local-web\ruoyi'
$processFile = Join-Path $runtimeRoot 'processes.json'
$logRoot = Join-Path $runtimeRoot 'logs'
$adminSecrets = Import-Clixml -LiteralPath $AdminSecretPath
$adminPassword = ConvertTo-PlainSecret $adminSecrets.RuoYiAdminPassword
$previousMySqlPassword = $env:MYSQL_PWD
$previousRedisCliAuth = $env:REDISCLI_AUTH
$env:MYSQL_PWD = $env:RUOYI_DB_PASSWORD
$env:REDISCLI_AUTH = $env:RUOYI_REDIS_PASSWORD

$adminToken = $null
$viewerToken = $null
$operatorToken = $null
$commonToken = $null
$portalTokenA = $null
$portalTokenB = $null
$viewerUserId = $null
$operatorUserId = $null
$commonUserId = $null
$portalUserIdA = $null
$portalUserIdB = $null
$portalMappedTaskId = $null
$nodeWasStopped = $false
$nodeWasRestarted = $false
$originalCaptchaValue = $null
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$viewerUserName = "bgev_$suffix"
$operatorUserName = "bgeo_$suffix"
$commonUserName = "bgec_$suffix"
$portalUserNameA = "bgepa_$suffix"
$portalUserNameB = "bgepb_$suffix"
$summary = [ordered]@{
    loopbackListeners = $false
    redisReady = $false
    frontendReady = $false
    workbenchFrontendReady = $false
    portalFrontendReady = $false
    adminLogin = $false
    dynamicBgeMenu = $false
    adminTaskList = $false
    taskCount = 0
    taskDetail = $false
    authenticatedThumbnail = $false
    viewerBgeRead = $false
    viewerSystemDenied = $false
    viewerCommonFilesDenied = $false
    viewerWorkbenchDenied = $false
    operatorWorkbenchAllowed = $false
    workbenchProxyCookieAllowed = $false
    workbenchAnonymousDenied = $false
    unrelatedRoleBgeDenied = $false
    portalRegistration = $false
    portalLogin = $false
    portalNoAdminMenu = $false
    portalExamplesRead = $false
    portalOwnTaskVisible = $false
    portalCrossUserDenied = $false
    portalCookieAssetAllowed = $false
    portalCookieAssetDenied = $false
    portalAnonymousDenied = $false
    portalMultipartValidation = $false
    upstreamDemoRemoved = $false
    nodeAnonymousDenied = $false
    nodeAuthorized = $false
    nodeDownReturns503 = $false
    nodeDownKeepsRuoYiAlive = $false
    nodeRestarted = $false
    temporaryUsersRemoved = $false
    captchaRestored = $false
}

function Invoke-MySqlQuery {
    param([Parameter(Mandatory = $true)][string]$Sql)

    $result = & docker exec --env MYSQL_PWD $MySqlContainerName `
        mysql --batch --skip-column-names --raw --host=127.0.0.1 `
        --user=$env:RUOYI_DB_USERNAME --database=$database --execute=$Sql 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "MySQL 集成验收查询失败。$($result | Select-Object -Last 3 | Out-String)"
    }
    return @($result)
}

function Clear-CaptchaCache {
    $result = & docker exec --env REDISCLI_AUTH $RedisContainerName `
        redis-cli --no-auth-warning -n 1 DEL 'sys_config:sys.account.captchaEnabled' 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Redis 验证码配置缓存清理失败。$($result | Select-Object -Last 2 | Out-String)"
    }
}

function Set-CaptchaValue {
    param([Parameter(Mandatory = $true)][ValidateSet('true', 'false')][string]$Value)

    [void](Invoke-MySqlQuery "UPDATE sys_config SET config_value = '$Value', update_time = NOW() WHERE config_key = 'sys.account.captchaEnabled';")
    Clear-CaptchaCache
}

function Invoke-RuoYiJson {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('GET', 'POST', 'PUT', 'DELETE')][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Token,
        [object]$Body
    )

    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(10)
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), "http://127.0.0.1:8080$Path")
    try {
        if (-not [string]::IsNullOrWhiteSpace($Token)) {
            $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Token)
        }
        if ($null -ne $Body) {
            $json = $Body | ConvertTo-Json -Depth 8 -Compress
            $request.Content = [System.Net.Http.StringContent]::new($json, [System.Text.Encoding]::UTF8, 'application/json')
        }
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        try {
            # Decode bytes explicitly so localized Node filenames never depend
            # on the current Windows ANSI code page.
            $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
            $content = [System.Text.Encoding]::UTF8.GetString($bytes)
        }
        finally {
            $response.Dispose()
        }
        if ([string]::IsNullOrWhiteSpace($content)) { throw '若依接口返回空响应。' }
        return $content | ConvertFrom-Json
    }
    finally {
        $request.Dispose()
        $client.Dispose()
    }
}

function Invoke-RuoYiWeb {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [hashtable]$Headers = @{},
        [string]$AdminTokenCookie
    )

    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(10)
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Uri)
    try {
        foreach ($header in $Headers.GetEnumerator()) {
            [void]$request.Headers.TryAddWithoutValidation([string]$header.Key, [string]$header.Value)
        }
        if (-not [string]::IsNullOrWhiteSpace($AdminTokenCookie)) {
            [void]$request.Headers.TryAddWithoutValidation('Cookie', "Admin-Token=$AdminTokenCookie")
        }
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        try {
            $headers = @{}
            foreach ($header in $response.Headers) { $headers[$header.Key] = [string]($header.Value -join ', ') }
            foreach ($header in $response.Content.Headers) { $headers[$header.Key] = [string]($header.Value -join ', ') }
            $content = [System.Text.Encoding]::UTF8.GetString($response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
            return [pscustomobject]@{
                StatusCode = [int]$response.StatusCode
                Content = $content
                Headers = $headers
            }
        }
        finally {
            $response.Dispose()
        }
    }
    finally {
        $request.Dispose()
        $client.Dispose()
    }
}

function Invoke-RuoYiMultipart {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Token
    )

    $client = [System.Net.Http.HttpClient]::new()
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "http://127.0.0.1:8080$Path")
    $form = [System.Net.Http.MultipartFormDataContent]::new()
    try {
        $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Token)
        $form.Add([System.Net.Http.StringContent]::new('门户 Multipart 回归测试', [System.Text.Encoding]::UTF8), 'productName')
        $form.Add([System.Net.Http.StringContent]::new('不得调用模型', [System.Text.Encoding]::UTF8), 'briefText')
        $file = [System.Net.Http.ByteArrayContent]::new([byte[]](1, 2, 3, 4))
        $file.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('image/png')
        $form.Add($file, 'referenceImages', 'invalid.png')
        $request.Content = $form
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        try {
            return [pscustomobject]@{
                StatusCode = [int]$response.StatusCode
                Content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            }
        }
        finally {
            $response.Dispose()
        }
    }
    finally {
        $request.Dispose()
        $form.Dispose()
        $client.Dispose()
    }
}

function Login-RuoYi {
    param(
        [Parameter(Mandatory = $true)][string]$UserName,
        [Parameter(Mandatory = $true)][string]$Password
    )

    $response = Invoke-RuoYiJson -Method POST -Path '/login' -Body @{
        username = $UserName
        password = $Password
        code = ''
        uuid = ''
    }
    if ([int]$response.code -ne 200 -or [string]::IsNullOrWhiteSpace([string]$response.token)) {
        throw '若依登录验收失败。'
    }
    return [string]$response.token
}

function Register-Portal {
    param(
        [Parameter(Mandatory = $true)][string]$UserName,
        [Parameter(Mandatory = $true)][string]$NickName,
        [Parameter(Mandatory = $true)][string]$Password
    )

    $response = Invoke-RuoYiJson -Method POST -Path '/portal-auth/register' -Body @{
        username = $UserName
        nickName = $NickName
        password = $Password
        confirmPassword = $Password
        code = ''
        uuid = ''
    }
    if ([int]$response.code -ne 200) { throw '用户端注册验收失败。' }
}

function Login-Portal {
    param(
        [Parameter(Mandatory = $true)][string]$UserName,
        [Parameter(Mandatory = $true)][string]$Password
    )

    $response = Invoke-RuoYiJson -Method POST -Path '/portal-auth/login' -Body @{
        username = $UserName
        password = $Password
        code = ''
        uuid = ''
    }
    if ([int]$response.code -ne 200 -or [string]::IsNullOrWhiteSpace([string]$response.token)) {
        throw '用户端登录验收失败。'
    }
    return [string]$response.token
}

function Test-ContainsBgeRouter {
    param([object[]]$Nodes)

    foreach ($node in @($Nodes)) {
        if (([string]$node.path).Trim('/') -eq 'bge') { return $true }
        if ($null -ne $node.children -and (Test-ContainsBgeRouter -Nodes @($node.children))) { return $true }
    }
    return $false
}

function Test-ContainsWorkbenchRouter {
    param([object[]]$Nodes)

    foreach ($node in @($Nodes)) {
        if ([string]$node.meta.link -eq 'http://127.0.0.1:8001/workbench/') { return $true }
        if ($null -ne $node.children -and (Test-ContainsWorkbenchRouter -Nodes @($node.children))) { return $true }
    }
    return $false
}

function Get-RuoYiBusinessCode {
    param([Parameter(Mandatory = $true)]$Response)

    try {
        $payload = $Response.Content | ConvertFrom-Json
        if ($null -ne $payload.code) { return [int]$payload.code }
    }
    catch {
        # A successful workbench proxy response is Node JSON, not AjaxResult.
    }
    return [int]$Response.StatusCode
}

function Wait-NodeReady {
    param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)

    $deadline = (Get-Date).AddSeconds(20)
    do {
        $Process.Refresh()
        if ($Process.HasExited) { throw 'BGE Node 恢复进程提前退出。' }
        try {
            $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/health' `
                -Headers @{ Authorization = "Bearer $env:BGE_ENGINE_ACCESS_TOKEN" } `
                -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        }
        catch {
            # 服务仍在启动。
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw 'BGE Node 在停机降级验收后没有恢复。'
}

function Restart-BgeNode {
    $nodeCommand = (Get-Command node -ErrorAction Stop).Source
    $process = Start-Process -FilePath $nodeCommand `
        -ArgumentList @('scripts/local-web-server.mjs') `
        -WorkingDirectory $repositoryRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logRoot 'bge-node.out.log') `
        -RedirectStandardError (Join-Path $logRoot 'bge-node.err.log')
    Wait-NodeReady -Process $process

    $state = Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json
    $state.node.pid = $process.Id
    $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $processFile -Encoding UTF8
    return $process
}

try {
    $redisPing = & docker exec --env REDISCLI_AUTH $RedisContainerName `
        redis-cli --no-auth-warning -n 1 PING 2>&1
    $summary.redisReady = $LASTEXITCODE -eq 0 -and [string]($redisPing | Select-Object -Last 1) -eq 'PONG'

    $listeners = @(netstat -ano | Select-String 'LISTENING' | Select-String ':8001|:8002|:8003|:8080|:8787')
    $summary.loopbackListeners = $listeners.Count -eq 5 -and @($listeners | Where-Object { $_.Line -notmatch '^\s*TCP\s+127\.0\.0\.1:' }).Count -eq 0

    $front = Invoke-WebRequest -Uri 'http://127.0.0.1:8001/' -UseBasicParsing -TimeoutSec 5
    $summary.frontendReady = $front.StatusCode -eq 200
    $workbenchFront = Invoke-WebRequest -Uri 'http://127.0.0.1:8001/workbench/' -UseBasicParsing -TimeoutSec 5
    $summary.workbenchFrontendReady = $workbenchFront.StatusCode -eq 200
    $portalFront = Invoke-WebRequest -Uri 'http://127.0.0.1:8001/portal/' -UseBasicParsing -TimeoutSec 5
    $summary.portalFrontendReady = $portalFront.StatusCode -eq 200 -and $portalFront.Content -match 'root'

    try {
        Invoke-WebRequest -Uri 'http://127.0.0.1:8787/health' -UseBasicParsing -TimeoutSec 5 | Out-Null
    }
    catch {
        $summary.nodeAnonymousDenied = $_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401
    }
    $nodeAuthorized = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/health' `
        -Headers @{ Authorization = "Bearer $env:BGE_ENGINE_ACCESS_TOKEN" } `
        -UseBasicParsing -TimeoutSec 5
    $summary.nodeAuthorized = $nodeAuthorized.StatusCode -eq 200

    $originalCaptchaValue = [string](Invoke-MySqlQuery "SELECT config_value FROM sys_config WHERE config_key = 'sys.account.captchaEnabled' LIMIT 1;" | Select-Object -First 1)
    if ($originalCaptchaValue -notin @('true', 'false')) {
        throw '无法确认验证码原始配置。'
    }
    Set-CaptchaValue -Value 'false'

    $adminToken = Login-RuoYi -UserName 'admin' -Password $adminPassword
    $summary.adminLogin = $true

    $viewerRoleId = [long](Invoke-MySqlQuery "SELECT role_id FROM sys_role WHERE role_key = 'bge_viewer' AND status = '0' AND del_flag = '0' LIMIT 1;" | Select-Object -First 1)
    $operatorRoleId = [long](Invoke-MySqlQuery "SELECT role_id FROM sys_role WHERE role_key = 'bge_operator' AND status = '0' AND del_flag = '0' LIMIT 1;" | Select-Object -First 1)
    $commonRoleId = [long](Invoke-MySqlQuery "SELECT role_id FROM sys_role WHERE role_key = 'common' AND status = '0' AND del_flag = '0' LIMIT 1;" | Select-Object -First 1)
    if ($viewerRoleId -le 0 -or $operatorRoleId -le 0 -or $commonRoleId -le 0) {
        throw '集成验收所需角色不存在。'
    }

    $viewerUserId = [long](Invoke-MySqlQuery "INSERT INTO sys_user (dept_id,user_name,nick_name,user_type,password,status,del_flag,pwd_update_date,create_by,create_time,remark) SELECT 103,'$viewerUserName','BGE Viewer','00',password,'0','0',NOW(),'acceptance',NOW(),'temporary acceptance user' FROM sys_user WHERE user_name='admin' AND del_flag='0'; SELECT LAST_INSERT_ID();" | Select-Object -Last 1)
    $operatorUserId = [long](Invoke-MySqlQuery "INSERT INTO sys_user (dept_id,user_name,nick_name,user_type,password,status,del_flag,pwd_update_date,create_by,create_time,remark) SELECT 103,'$operatorUserName','BGE Operator','00',password,'0','0',NOW(),'acceptance',NOW(),'temporary acceptance user' FROM sys_user WHERE user_name='admin' AND del_flag='0'; SELECT LAST_INSERT_ID();" | Select-Object -Last 1)
    $commonUserId = [long](Invoke-MySqlQuery "INSERT INTO sys_user (dept_id,user_name,nick_name,user_type,password,status,del_flag,pwd_update_date,create_by,create_time,remark) SELECT 103,'$commonUserName','BGE Common','00',password,'0','0',NOW(),'acceptance',NOW(),'temporary acceptance user' FROM sys_user WHERE user_name='admin' AND del_flag='0'; SELECT LAST_INSERT_ID();" | Select-Object -Last 1)
    [void](Invoke-MySqlQuery "INSERT INTO sys_user_role (user_id,role_id) VALUES ($viewerUserId,$viewerRoleId),($operatorUserId,$operatorRoleId),($commonUserId,$commonRoleId);")

    $viewerToken = Login-RuoYi -UserName $viewerUserName -Password $adminPassword
    $operatorToken = Login-RuoYi -UserName $operatorUserName -Password $adminPassword
    $commonToken = Login-RuoYi -UserName $commonUserName -Password $adminPassword

    $routers = Invoke-RuoYiJson -Method GET -Path '/getRouters' -Token $viewerToken
    $summary.dynamicBgeMenu = [int]$routers.code -eq 200 -and (Test-ContainsBgeRouter -Nodes @($routers.data))

    $operatorRouters = Invoke-RuoYiJson -Method GET -Path '/getRouters' -Token $operatorToken
    $summary.operatorWorkbenchAllowed = [int]$operatorRouters.code -eq 200 -and (Test-ContainsWorkbenchRouter -Nodes @($operatorRouters.data))

    $viewerBge = Invoke-RuoYiJson -Method GET -Path '/bge/health' -Token $viewerToken
    $summary.viewerBgeRead = [int]$viewerBge.code -eq 200
    $viewerSystem = Invoke-RuoYiJson -Method GET -Path '/system/user/list?pageNum=1&pageSize=1' -Token $viewerToken
    $summary.viewerSystemDenied = [int]$viewerSystem.code -eq 403
    $viewerFiles = Invoke-RuoYiJson -Method GET -Path '/common/download?fileName=acceptance.txt&delete=true' -Token $viewerToken
    $summary.viewerCommonFilesDenied = [int]$viewerFiles.code -eq 403
    $viewerWorkbench = Invoke-RuoYiWeb -Uri 'http://127.0.0.1:8080/workbench-api/health' `
        -AdminTokenCookie $viewerToken
    $summary.viewerWorkbenchDenied = (Get-RuoYiBusinessCode -Response $viewerWorkbench) -eq 403
    $operatorWorkbench = Invoke-RuoYiWeb -Uri 'http://127.0.0.1:8080/workbench-api/health' `
        -AdminTokenCookie $operatorToken
    $summary.operatorWorkbenchAllowed = $summary.operatorWorkbenchAllowed -and (Get-RuoYiBusinessCode -Response $operatorWorkbench) -eq 200
    $workbenchProxy = Invoke-RuoYiWeb -Uri 'http://127.0.0.1:8001/health' `
        -AdminTokenCookie $operatorToken
    $summary.workbenchProxyCookieAllowed = (Get-RuoYiBusinessCode -Response $workbenchProxy) -eq 200
    $workbenchAnonymous = Invoke-RuoYiWeb -Uri 'http://127.0.0.1:8001/health'
    $summary.workbenchAnonymousDenied = (Get-RuoYiBusinessCode -Response $workbenchAnonymous) -eq 401
    $commonBge = Invoke-RuoYiJson -Method GET -Path '/bge/health' -Token $commonToken
    $summary.unrelatedRoleBgeDenied = [int]$commonBge.code -eq 403

    $demo = Invoke-RuoYiWeb -Uri 'http://127.0.0.1:8080/test/user/list' `
        -Headers @{ Authorization = "Bearer $viewerToken" }
    $demoBodyCode = try { [int](($demo.Content | ConvertFrom-Json).code) } catch { 0 }
    $summary.upstreamDemoRemoved = $demo.StatusCode -ne 200 -or $demoBodyCode -ne 200

    $tasks = Invoke-RuoYiJson -Method GET -Path '/bge/tasks' -Token $adminToken
    $summary.adminTaskList = [int]$tasks.code -eq 200
    $taskItems = @($tasks.data.tasks)
    $summary.taskCount = $taskItems.Count
    if ($taskItems.Count -gt 0) {
        $taskId = [Uri]::EscapeDataString([string]$taskItems[0].taskId)
        $detail = Invoke-RuoYiJson -Method GET -Path "/bge/tasks/$taskId" -Token $adminToken
        $summary.taskDetail = [int]$detail.code -eq 200
        $assets = @($detail.data.output.files.main) + @($detail.data.output.files.detail)
        if ($assets.Count -gt 0) {
            $asset = Invoke-WebRequest -Uri ("http://127.0.0.1:8080" + [string]$assets[0].url) `
                -Headers @{ Authorization = "Bearer $adminToken" } -UseBasicParsing -TimeoutSec 10
            $summary.authenticatedThumbnail = $asset.StatusCode -eq 200 -and [string]$asset.Headers.'Content-Type' -like 'image/*'
        }
    }

    # Portal acceptance uses existing local task data only. It maps one
    # completed task to a temporary user so ownership filters and image-cookie
    # handling can be proven without submitting a paid generation request.
    Register-Portal -UserName $portalUserNameA -NickName 'Portal A' -Password $adminPassword
    Register-Portal -UserName $portalUserNameB -NickName 'Portal B' -Password $adminPassword
    $portalUserIdA = [long](Invoke-MySqlQuery "SELECT user_id FROM sys_user WHERE user_name = '$portalUserNameA' AND create_by = 'portal-register' LIMIT 1;" | Select-Object -First 1)
    $portalUserIdB = [long](Invoke-MySqlQuery "SELECT user_id FROM sys_user WHERE user_name = '$portalUserNameB' AND create_by = 'portal-register' LIMIT 1;" | Select-Object -First 1)
    $portalRoleGrantCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_user_role ur JOIN sys_role r ON r.role_id = ur.role_id WHERE ur.user_id IN ($portalUserIdA,$portalUserIdB) AND r.role_key = 'bge_portal_user' AND r.del_flag = '0';" | Select-Object -First 1)
    $portalUnexpectedRoleCount = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_user_role WHERE user_id IN ($portalUserIdA,$portalUserIdB);" | Select-Object -First 1)
    $summary.portalRegistration = $portalUserIdA -gt 0 -and $portalUserIdB -gt 0 -and $portalRoleGrantCount -eq 2 -and $portalUnexpectedRoleCount -eq 2

    $portalTokenA = Login-Portal -UserName $portalUserNameA -Password $adminPassword
    $portalTokenB = Login-Portal -UserName $portalUserNameB -Password $adminPassword
    $summary.portalLogin = -not [string]::IsNullOrWhiteSpace($portalTokenA) -and -not [string]::IsNullOrWhiteSpace($portalTokenB)

    $portalRouters = Invoke-RuoYiJson -Method GET -Path '/getRouters' -Token $portalTokenA
    $portalSystem = Invoke-RuoYiJson -Method GET -Path '/system/user/list?pageNum=1&pageSize=1' -Token $portalTokenA
    $portalWorkbench = Invoke-RuoYiWeb -Uri 'http://127.0.0.1:8080/workbench-api/health' -AdminTokenCookie $portalTokenA
    $portalRouterCount = @($portalRouters.data | Where-Object { $null -ne $_ }).Count
    $summary.portalNoAdminMenu = [int]$portalRouters.code -eq 200 -and $portalRouterCount -eq 0 -and [int]$portalSystem.code -eq 403 -and (Get-RuoYiBusinessCode -Response $portalWorkbench) -eq 403

    $portalExamples = Invoke-RuoYiJson -Method GET -Path '/portal-api/api/examples' -Token $portalTokenA
    $summary.portalExamplesRead = @($portalExamples.examples).Count -gt 0

    $portalCandidate = $null
    foreach ($candidate in @($taskItems)) {
        $candidateId = [string]$candidate.taskId
        if ([string]::IsNullOrWhiteSpace($candidateId)) { continue }
        $candidateDetail = Invoke-RuoYiJson -Method GET -Path ("/bge/tasks/" + [Uri]::EscapeDataString($candidateId)) -Token $adminToken
        $candidateAssets = @($candidateDetail.data.output.files.main | Where-Object { $null -ne $_ }) +
            @($candidateDetail.data.output.files.detail | Where-Object { $null -ne $_ })
        if ([int]$candidateDetail.code -eq 200 -and -not [string]::IsNullOrWhiteSpace([string]$candidateDetail.data.output.id) -and $candidateAssets.Count -gt 0) {
            $portalCandidate = $candidateDetail.data
            break
        }
    }
    if ($null -eq $portalCandidate) {
        throw '没有可用于零付费门户隔离验收的本地已完成任务。'
    }
    $portalMappedTaskId = [string]$portalCandidate.taskId
    $portalMappedOutputId = [string]$portalCandidate.output.id
    [void](Invoke-MySqlQuery "INSERT INTO bge_portal_job (job_type,job_id,owner_user_id,output_id) VALUES ('image','$portalMappedTaskId',$portalUserIdA,NULL);")

    $portalTasksA = Invoke-RuoYiJson -Method GET -Path '/portal-api/api/tasks' -Token $portalTokenA
    $portalOutputA = Invoke-RuoYiJson -Method GET -Path ("/portal-api/api/outputs/" + [Uri]::EscapeDataString($portalMappedOutputId)) -Token $portalTokenA
    $summary.portalOwnTaskVisible = @($portalTasksA.tasks).Count -eq 1 -and [string]$portalTasksA.tasks[0].taskId -eq $portalMappedTaskId -and [string]$portalOutputA.id -eq $portalMappedOutputId

    $portalCrossTask = Invoke-RuoYiJson -Method GET -Path ("/portal-api/api/tasks/" + [Uri]::EscapeDataString($portalMappedTaskId)) -Token $portalTokenB
    $portalCrossOutput = Invoke-RuoYiJson -Method GET -Path ("/portal-api/api/outputs/" + [Uri]::EscapeDataString($portalMappedOutputId)) -Token $portalTokenB
    $portalCrossCancel = Invoke-RuoYiJson -Method POST -Path ("/portal-api/api/jobs/" + [Uri]::EscapeDataString($portalMappedTaskId) + '/cancel') -Token $portalTokenB
    $portalCrossDelete = Invoke-RuoYiJson -Method DELETE -Path ("/portal-api/api/outputs/" + [Uri]::EscapeDataString($portalMappedOutputId)) -Token $portalTokenB
    $portalCrossDownload = Invoke-RuoYiJson -Method POST -Path ("/portal-api/api/outputs/" + [Uri]::EscapeDataString($portalMappedOutputId) + '/download') -Token $portalTokenB -Body @{ items = @('not-used') }
    $summary.portalCrossUserDenied = [int]$portalCrossTask.code -eq 404 -and [int]$portalCrossOutput.code -eq 404 -and [int]$portalCrossCancel.code -eq 404 -and [int]$portalCrossDelete.code -eq 404 -and [int]$portalCrossDownload.code -eq 404

    $portalAssets = @($portalOutputA.files.main | Where-Object { $null -ne $_ }) +
        @($portalOutputA.files.detail | Where-Object { $null -ne $_ })
    $portalAsset = $portalAssets | Select-Object -First 1
    if ($null -eq $portalAsset -or [string]::IsNullOrWhiteSpace([string]$portalAsset.url)) {
        $portalMainCount = @($portalOutputA.files.main | Where-Object { $null -ne $_ }).Count
        $portalDetailCount = @($portalOutputA.files.detail | Where-Object { $null -ne $_ }).Count
        throw ("门户验收任务没有可验证的成品图片（main={0}, detail={1}）。" -f $portalMainCount, $portalDetailCount)
    }
    $portalAssetAllowed = Invoke-RuoYiWeb -Uri ("http://127.0.0.1:8080" + [string]$portalAsset.url) -AdminTokenCookie $portalTokenA
    $portalAssetDenied = Invoke-RuoYiWeb -Uri ("http://127.0.0.1:8080" + [string]$portalAsset.url) -AdminTokenCookie $portalTokenB
    $summary.portalCookieAssetAllowed = $portalAssetAllowed.StatusCode -eq 200 -and [string]$portalAssetAllowed.Headers.'Content-Type' -like 'image/*'
    $summary.portalCookieAssetDenied = (Get-RuoYiBusinessCode -Response $portalAssetDenied) -eq 404
    $portalAnonymous = Invoke-RuoYiWeb -Uri 'http://127.0.0.1:8080/portal-api/api/tasks'
    $summary.portalAnonymousDenied = (Get-RuoYiBusinessCode -Response $portalAnonymous) -eq 401

    # This must pass the Java portal's parsed Multipart request through the
    # Node upload validator. The deliberately invalid image fails before any
    # model call, and the follow-up health read proves the Node service stayed alive.
    $portalInvalidBrief = Invoke-RuoYiMultipart -Path '/portal-api/api/brief-expansions' -Token $portalTokenA
    $nodeAfterPortalMultipart = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/health' `
        -Headers @{ Authorization = "Bearer $env:BGE_ENGINE_ACCESS_TOKEN" } `
        -UseBasicParsing -TimeoutSec 5
    $summary.portalMultipartValidation = $portalInvalidBrief.StatusCode -eq 400 `
        -and $portalInvalidBrief.Content -match '本次作图请求未通过本地校验' `
        -and $nodeAfterPortalMultipart.StatusCode -eq 200

    $state = Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json
    $nodePid = [int]$state.node.pid
    $nodeProcess = Get-Process -Id $nodePid -ErrorAction Stop
    if ($nodeProcess.ProcessName -ne 'node') {
        throw '进程记录中的 BGE Node 身份不正确，拒绝执行停机验收。'
    }
    Stop-Process -Id $nodePid -Force
    $nodeWasStopped = $true
    Start-Sleep -Milliseconds 500

    $degraded = Invoke-RuoYiJson -Method GET -Path '/bge/health' -Token $adminToken
    $summary.nodeDownReturns503 = [int]$degraded.code -eq 503
    $info = Invoke-RuoYiJson -Method GET -Path '/getInfo' -Token $adminToken
    $summary.nodeDownKeepsRuoYiAlive = [int]$info.code -eq 200

    [void](Restart-BgeNode)
    $nodeWasRestarted = $true
    $summary.nodeRestarted = $true

}
finally {
    foreach ($token in @($viewerToken, $operatorToken, $commonToken, $adminToken)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$token)) {
            try { [void](Invoke-RuoYiJson -Method POST -Path '/logout' -Token $token) } catch { }
        }
    }

    foreach ($token in @($portalTokenA, $portalTokenB)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$token)) {
            try { [void](Invoke-RuoYiJson -Method POST -Path '/portal-auth/logout' -Token $token) } catch { }
        }
    }

    if ($viewerUserId -or $operatorUserId -or $commonUserId -or $portalUserIdA -or $portalUserIdB) {
        $ids = @($viewerUserId, $operatorUserId, $commonUserId, $portalUserIdA, $portalUserIdB) | Where-Object { $_ } | ForEach-Object { [long]$_ }
        if ($ids.Count -gt 0) {
            $joinedIds = $ids -join ','
            try {
                [void](Invoke-MySqlQuery "DELETE FROM bge_portal_job WHERE owner_user_id IN ($joinedIds); DELETE FROM sys_user_role WHERE user_id IN ($joinedIds); DELETE FROM sys_user WHERE user_id IN ($joinedIds) AND (create_by = 'acceptance' OR create_by = 'portal-register');")
                $remaining = [int](Invoke-MySqlQuery "SELECT COUNT(*) FROM sys_user WHERE user_id IN ($joinedIds);" | Select-Object -First 1)
                $summary.temporaryUsersRemoved = $remaining -eq 0
            }
            catch {
                Write-Warning '临时验收用户清理失败，需要人工检查。'
            }
        }
    }

    if ($null -ne $originalCaptchaValue) {
        try {
            Set-CaptchaValue -Value $originalCaptchaValue
            $restored = [string](Invoke-MySqlQuery "SELECT config_value FROM sys_config WHERE config_key = 'sys.account.captchaEnabled' LIMIT 1;" | Select-Object -First 1)
            $summary.captchaRestored = $restored -eq $originalCaptchaValue
        }
        catch {
            Write-Warning '验证码配置恢复失败，需要人工检查。'
        }
    }

    if ($nodeWasStopped -and -not $nodeWasRestarted) {
        try {
            [void](Restart-BgeNode)
            $summary.nodeRestarted = $true
        }
        catch {
            Write-Warning 'BGE Node 自动恢复失败，需要重新运行启动脚本。'
        }
    }

    if ($null -eq $previousMySqlPassword) { Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue }
    else { $env:MYSQL_PWD = $previousMySqlPassword }
    if ($null -eq $previousRedisCliAuth) { Remove-Item Env:REDISCLI_AUTH -ErrorAction SilentlyContinue }
    else { $env:REDISCLI_AUTH = $previousRedisCliAuth }
}

$failed = @($summary.GetEnumerator() | Where-Object { $_.Key -ne 'taskCount' -and $_.Value -ne $true })
if ($failed.Count -gt 0) {
    throw "若依集成验收存在未通过项。$($failed.Name -join ', ')"
}
$summary | ConvertTo-Json -Compress
