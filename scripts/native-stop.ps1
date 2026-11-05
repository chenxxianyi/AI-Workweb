param([int]$TargetPid,[string]$ExpectedEntry,[string]$Started)
$ErrorActionPreference='Stop'
$proc=Get-CimInstance Win32_Process -Filter "ProcessId = $TargetPid"
if(-not $proc){exit 0}
if($proc.Name -ne 'node.exe' -or -not $proc.CommandLine.Contains($ExpectedEntry)){throw 'PID入口不匹配，拒绝停止'}
$native=Get-Process -Id $TargetPid
if([Math]::Abs(($native.StartTime.ToUniversalTime()-[DateTime]::Parse($Started).ToUniversalTime()).TotalSeconds) -gt 2){throw 'PID启动时间不匹配'}
Stop-Process -Id $TargetPid
