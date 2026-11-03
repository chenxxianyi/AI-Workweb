# 本地开发数据库（项目内隔离实例）
#
# 用途：为开发与集成测试提供真实 PostgreSQL 17，不触碰本机 5432 上的既有服务。
# 数据目录：<repo>/.data/pgdata（.gitignore 已排除，不进快照）
# 端口：55432，仅监听 127.0.0.1
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dev-db.ps1 init
#   ... start | stop | status | reset
#
# 说明：本机执行策略为 Restricted，故统一用 -ExecutionPolicy Bypass 单次调用（不修改系统策略）。

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('init', 'start', 'stop', 'status', 'reset')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataDir = Join-Path $repoRoot '.data\pgdata'
$logFile = Join-Path $repoRoot '.data\pg.log'
$port = 55432
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
        if ($line -and $line -match '://[^:]+:([^@]+)@') { return $Matches[1] }
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
        New-Item -ItemType Directory -Path (Split-Path -Parent $data) -Force | Out-Null
        & $initdb -D $data -U $role --auth-local=trust --auth-host=scram-sha-256 -E UTF8 --no-locale | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'initdb 失败' }
        $config = @("`n# --- dev instance (scripts/dev-db.ps1) ---", "port = $p", "listen_addresses = '127.0.0.1'", "timezone = 'Asia/Shanghai'") -join "`n"
        Add-Content -LiteralPath (Join-Path $data 'postgresql.conf') -Value $config -Encoding ASCII
        Write-Output "已初始化数据目录：$data"
    }
    else {
        Write-Output "数据目录已存在：$data"
    }

    if (-not (Test-Ready)) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $log) -Force | Out-Null
        Start-Process -FilePath $pgCtl -ArgumentList @('-D', "`"$data`"", '-l', "`"$log`"", 'start') -WindowStyle Hidden | Out-Null
        if (-not (Wait-Ready)) { throw "数据库未能启动，查看 $log" }
    }
    Write-Output "数据库已启动：127.0.0.1:$p"

    # 设置本地开发口令（scram 认证，仅 127.0.0.1）
    $hba = Join-Path $data 'pg_hba.conf'
    $original = Get-Content -LiteralPath $hba
    $trusted = $original | ForEach-Object {
        if ($_ -match '^host\s+all\s+all\s+127\.0\.0\.1/32') { 'host    all             all             127.0.0.1/32            trust' } else { $_ }
    }
    Set-Content -LiteralPath $hba -Value $trusted -Encoding ASCII
    & $pgCtl -D $data reload | Out-Null
    Start-Sleep -Milliseconds 600
    Invoke-Sql "ALTER USER $role WITH PASSWORD '$pass'" | Out-Null
    Set-Content -LiteralPath $hba -Value $original -Encoding ASCII
    & $pgCtl -D $data reload | Out-Null
    Start-Sleep -Milliseconds 600
    Write-Output '已设置本地开发口令（仅 127.0.0.1，scram-sha-256）'

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
        if (Test-Ready) { & $pgCtl -D $dataDir -m fast stop | Out-Null }
        if (Test-Path -LiteralPath $dataDir) { Remove-Item -LiteralPath $dataDir -Recurse -Force }
        Initialize-Cluster
    }
}
