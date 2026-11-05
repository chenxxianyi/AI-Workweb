# 本机项目数据库（开发/测试/预发布/正式使用独立库）
#
# 用途：项目内真实 PostgreSQL 17，仅127.0.0.1；不触碰5432既有服务。现含正式数据，禁止reset。
# 数据目录：<repo>/.data/pgdata（.gitignore 已排除，不进快照）
# 端口：55432，仅监听 127.0.0.1
#
# 用法：
#   pwsh -NoProfile -File scripts/dev-db.ps1 init
#   ... start | stop | status | reset
#
# 执行遵循当前 PowerShell 策略，不覆盖系统执行策略。

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('init', 'start', 'stop', 'status', 'reset')]
    [string]$Action = 'status',
    [ValidateRange(1024,65535)][int]$Port=55432,
    [string]$DataSubdirectory='.data\pgdata'
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataDir = [IO.Path]::GetFullPath((Join-Path $repoRoot $DataSubdirectory))
if(-not $dataDir.StartsWith((Join-Path $repoRoot '.data')+[IO.Path]::DirectorySeparatorChar)){throw '数据目录必须在本项目.data内'}
$logFile = Join-Path $repoRoot ('.data\pg-'+$Port+'.log')
$role = 'aiwb'
$databases = @('aiwb_dev', 'aiwb_test')
$defaultPassword = 'aiwb_local_dev'

function Get-PgBin {
    if ($env:PG_BIN) { return $env:PG_BIN }
    $candidates = @(
        'E:\tools\PostgreSQL\17\bin',
        'C:\Program Files\PostgreSQL\17\bin'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'pg_ctl.exe')) { return $candidate }
    }
    $command = Get-Command pg_ctl -ErrorAction SilentlyContinue
    if ($command) { return (Split-Path -Parent $command.Source) }
    throw '未找到 PostgreSQL 17 的 bin 目录；请设置环境变量 PG_BIN。'
}

function Get-DevPassword {
    if ($env:AIWB_DB_PASSWORD) { return $env:AIWB_DB_PASSWORD }
    $envFile = Join-Path $repoRoot '.env'
    if (Test-Path -LiteralPath $envFile) {
        $line = Get-Content -LiteralPath $envFile |
            Where-Object { $_ -match '^DATABASE_URL=' } |
            Select-Object -First 1
        if ($line -and $line -match '://[^:]+:([^@]+)@') { return [Uri]::UnescapeDataString($Matches[1]) }
    }
    return $defaultPassword
}

$pgBin = Get-PgBin
$psql = Join-Path $pgBin 'psql.exe'
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'
$pgIsReady = Join-Path $pgBin 'pg_isready.exe'
$initdb = Join-Path $pgBin 'initdb.exe'

function Test-Ready {
    & $pgIsReady -h 127.0.0.1 -p $port -q 2>$null
    return ($LASTEXITCODE -eq 0)
}

function Wait-Ready([int]$Seconds = 30) {
    for ($i = 0; $i -lt ($Seconds * 2); $i++) {
        if (Test-Ready) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Invoke-Sql([string]$Sql, [string]$Database = 'postgres') {
    $env:PGPASSWORD = Get-DevPassword
    $output = & $psql -h 127.0.0.1 -p $port -U $role -d $Database -w -v ON_ERROR_STOP=1 -Atc $Sql 2>&1
    if ($LASTEXITCODE -ne 0) { throw "SQL 执行失败：$output" }
    return $output
}

function Initialize-Cluster {
    $bin = $pgBin
    $data = $dataDir
    $log = $logFile
    $pass = Get-DevPassword
    $dbs = $databases
    $p = $port
    if (-not (Test-Path -LiteralPath $data)) {
        if(Test-Ready){throw '目标端口已有服务，拒绝用新目录接管既有数据库'}
        if($pass -eq $defaultPassword -or $pass.Length -lt 20){throw '新集群必须先生成随机强口令.env；执行node scripts/setup-local-env.mjs，禁止使用默认开发口令。'}
        New-Item -ItemType Directory -Path (Split-Path -Parent $data) -Force | Out-Null
        $passFile=[IO.Path]::GetFullPath((Join-Path $repoRoot ('.data/initdb-pass-'+[Guid]::NewGuid().ToString('N')+'.tmp')))
        if(-not $passFile.StartsWith($repoRoot+[IO.Path]::DirectorySeparatorChar)){throw '临时路径越界'}
        New-Item -ItemType File -Path $passFile | Out-Null
        & icacls $passFile /inheritance:r /grant:r "$env:USERDOMAIN\$env:USERNAME`:F" 'SYSTEM:F' | Out-Null
        if($LASTEXITCODE){throw '临时口令ACL保护失败'}
        try {Set-Content -LiteralPath $passFile -Value $pass -Encoding ASCII
          & $initdb -D $data -U $role --auth-local=scram-sha-256 --auth-host=scram-sha-256 --pwfile=$passFile -E UTF8 --no-locale | Out-Null
          if ($LASTEXITCODE -ne 0) { throw 'initdb 失败' }
        }finally{Remove-Item -LiteralPath $passFile -Force}
        $config = @("`n# --- dev instance (scripts/dev-db.ps1) ---", "port = $p", "listen_addresses = '127.0.0.1'", "timezone = 'Asia/Shanghai'") -join "`n"
        Add-Content -LiteralPath (Join-Path $data 'postgresql.conf') -Value $config -Encoding ASCII
        Write-Output "已初始化数据目录：$data"
    }
    else {
        Write-Output "数据目录已存在：$data"
        if (-not (Test-Ready)) { throw '已有集群请执行start；init不修改既有认证配置。' }
        Invoke-Sql 'SELECT 1' | Out-Null
        Write-Output '既有集群认证通过；未改写口令或pg_hba。'
    }

    if (-not (Test-Ready)) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $log) -Force | Out-Null
        Start-Process -FilePath $pgCtl -ArgumentList @('-D', "`"$data`"", '-l', "`"$log`"", 'start') -WindowStyle Hidden | Out-Null
        if (-not (Wait-Ready)) { throw "数据库未能启动，查看 $log" }
    }
    Write-Output "数据库已启动：127.0.0.1:$p"

    Invoke-Sql 'SELECT 1' | Out-Null
    # Windows PG的GUC路径可能采用系统ACP字节；textsend避免将路径误当UTF8再转换。
    $directoryHex=[string](Invoke-Sql "SELECT encode(textsend(current_setting('data_directory')),'hex')")
    $pathBytes=[Convert]::FromHexString($directoryHex)
    $pathMatches=$false
    foreach($encoding in @([Text.Encoding]::UTF8,[Text.Encoding]::GetEncoding(936))){
      $actualData=[IO.Path]::GetFullPath($encoding.GetString($pathBytes)).TrimEnd('\','/')
      if($actualData.Equals($dataDir.TrimEnd('\','/'),[StringComparison]::OrdinalIgnoreCase)){$pathMatches=$true}
    }
    if(-not $pathMatches){throw '端口对应的数据目录不符，拒绝写入其他集群'}
    Write-Output '随机强口令SCRAM认证通过；未改写pg_hba认证模式。'

    foreach ($db in $dbs) {
        $exists = Invoke-Sql "SELECT 1 FROM pg_database WHERE datname = '$db'"
        if (-not $exists) {
            Invoke-Sql "CREATE DATABASE $db" | Out-Null
            Write-Output "已创建数据库：$db"
        }
        else {
            Write-Output "数据库已存在：$db"
        }
    }
    $masked = "postgresql://$role`:***@127.0.0.1:$p/aiwb_dev?schema=public"
    Write-Output "连接串（口令见 .env 或 AIWB_DB_PASSWORD，默认仅本地）：$masked"
}

switch ($Action) {
    'init' { Initialize-Cluster }
    'start' {
        if (Test-Ready) { Write-Output "数据库已在运行：127.0.0.1:$port"; break }
        if (-not (Test-Path -LiteralPath $dataDir)) { throw '数据目录不存在，请先运行 init' }
        Start-Process -FilePath $pgCtl -ArgumentList @('-D', "`"$dataDir`"", '-l', "`"$logFile`"", 'start') -WindowStyle Hidden | Out-Null
        if (-not (Wait-Ready)) { throw "数据库未能启动，查看 $logFile" }
        Write-Output "数据库已启动：127.0.0.1:$port"
    }
    'stop' {
        if (-not (Test-Ready)) { Write-Output '数据库未运行'; break }
        & $pgCtl -D $dataDir -m fast stop | Out-Null
        Write-Output '数据库已停止'
    }
    'status' {
        & $pgIsReady -h 127.0.0.1 -p $port
        if (Test-Ready) { Write-Output "数据目录：$dataDir" }
        exit ($(if (Test-Ready) { 0 } else { 1 }))
    }
    'reset' {
        throw 'reset已禁用：此集群现含本机正式数据。仅可通过独立测试库脚本重建测试库。'
    }
}


