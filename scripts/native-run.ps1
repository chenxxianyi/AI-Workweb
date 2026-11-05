param([ValidateSet('stage','production')][string]$Profile)
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime=Join-Path $repo ".data/runtime/$Profile"
$cfg=Get-Content -LiteralPath (Join-Path $runtime 'config.json') -Raw | ConvertFrom-Json
$launch=Get-Content -LiteralPath (Join-Path $runtime 'launch.json') -Raw | ConvertFrom-Json
if($launch.release -notmatch '^[a-zA-Z0-9_-]+$'){throw '版本名称非法'}
$release=Join-Path $repo ".data/releases/$($launch.release)"
$env:NODE_ENV='production'; $env:DATABASE_URL=$cfg.databaseUrl
$env:API_PORT=[string]$cfg.port; $env:API_HOST='127.0.0.1'; $env:PUBLIC_ORIGIN=$cfg.origin
$env:SESSION_COOKIE_NAME="aiwb_$Profile"; $env:COOKIE_SECURE='false'
$env:CSRF_COOKIE_NAME="aiwb_$($Profile)_csrf"
$env:BACKUP_STATUS_FILE=Join-Path $runtime 'backup-status.json'
$env:LOG_FILE=Join-Path $runtime 'api-events.log'
$env:WEB_DIST_DIR=Join-Path $release 'web'; $env:TRANSFER_STORAGE_DIR=Join-Path $runtime 'transfers'
$env:TRANSFER_WORKER_ENABLED='true'; $env:MAINTENANCE_WORKER_ENABLED='true'; $env:LOG_LEVEL='info'
$node=(Get-Command node).Source
$log=Join-Path $runtime ('api-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$proc=Start-Process -FilePath $node -ArgumentList @(('"'+(Join-Path $release 'dist/main.js')+'"')) -WorkingDirectory $runtime -WindowStyle Hidden -RedirectStandardOutput "$log.log" -RedirectStandardError "$log.error.log" -PassThru
@{pid=$proc.Id;release=$launch.release;started=$proc.StartTime.ToUniversalTime().ToString('o');log=$log} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'state.json') -Encoding utf8
