param([ValidateSet('start','stop','status','backup')][string]$Action='start')
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $repo
try {
 function Invoke-Node([string[]]$NodeArgs){& node @NodeArgs;if($LASTEXITCODE -ne 0){throw '工作台操作失败；请检查本机runtime日志。'}}
 switch($Action){
  'start' {
   & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'dev-db.ps1') start;if($LASTEXITCODE){throw '数据库启动失败'}
   $current=& node scripts/native.mjs status production | ConvertFrom-Json
   if($current.status -ne 'ready'){$launch=Get-Content -LiteralPath (Join-Path $repo '.data/runtime/production/launch.json') -Raw | ConvertFrom-Json;Invoke-Node @('scripts/native.mjs','start','production',$launch.release)}
   & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'monitor-run.ps1') production start;if($LASTEXITCODE){throw '巡检启动失败'}
   Write-Output '工作台：http://127.0.0.1:3000；24小时观察结果由本机巡检另行记录。'
  }
  'stop' {& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'monitor-run.ps1') production stop;if($LASTEXITCODE){throw '巡检停止失败'};Invoke-Node @('scripts/native.mjs','stop','production');Write-Output '应用与巡检已停止；共享PostgreSQL保持运行。'}
  'status' {Invoke-Node @('scripts/native.mjs','status','production');& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'monitor-run.ps1') production status;$file=Join-Path $repo '.data/runtime/production/observation.json';if(Test-Path -LiteralPath $file){Get-Content -LiteralPath $file}}
  'backup' {Invoke-Node @('scripts/backup.mjs','create','production')}
 }
}finally{Pop-Location}
