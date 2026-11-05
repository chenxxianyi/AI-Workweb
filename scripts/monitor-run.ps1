param([ValidateSet('stage','production')][string]$Profile,[ValidateSet('start','stop','status')][string]$Action='status')
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime=Join-Path $repo ".data/runtime/$Profile"
$pidFile=Join-Path $runtime 'monitor-process.json'
$entry=Join-Path $repo 'scripts/monitor.mjs'
if(Test-Path -LiteralPath $pidFile){$saved=Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json;$proc=Get-CimInstance Win32_Process -Filter "ProcessId = $($saved.pid)";if($proc -and (-not $proc.CommandLine.Contains($entry) -or -not $proc.CommandLine.Contains("watch $Profile"))){throw '巡检PID已被复用，拒绝操作'}}
if($Action -eq 'status'){@{running=[bool]$proc;profile=$Profile} | ConvertTo-Json;exit 0}
if($Action -eq 'stop'){if($proc){Stop-Process -Id $proc.ProcessId};Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue;$lock=Join-Path $runtime 'monitor.lock';if(Test-Path -LiteralPath $lock){Remove-Item -LiteralPath $lock};Write-Output '巡检已停止';exit 0}
if($proc){Write-Output '巡检已在运行';exit 0}
$lock=Join-Path $runtime 'monitor.lock';if(Test-Path -LiteralPath $lock){$lockPid=[int](Get-Content -LiteralPath $lock -Raw);if(Get-Process -Id $lockPid -ErrorAction SilentlyContinue){throw '旧锁PID仍存在，需先人工核对'};Remove-Item -LiteralPath $lock}
$node=(Get-Command node).Source
$launched=Start-Process -FilePath $node -ArgumentList @(('"'+$entry+'"'),'watch',$Profile) -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'monitor.log') -RedirectStandardError (Join-Path $runtime 'monitor.error.log') -PassThru
@{pid=$launched.Id;started=$launched.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding utf8
Write-Output '本机巡检已启动，每60秒采样，23小时后自动备份；24小时观察另行记录。'
