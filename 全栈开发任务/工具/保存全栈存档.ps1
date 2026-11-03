[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^FS\d{3}$')]
    [string]$Checkpoint,
    [string]$Note = ''
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$taskPrefix = $taskRoot + '\'
$checkpointRecord = Join-Path $taskRoot "全栈开发任务\存档\$Checkpoint\存档记录.md"
if (-not (Test-Path -LiteralPath $checkpointRecord -PathType Leaf)) {
    throw '存档点不存在；应先建立当前任务的FS记录。'
}
$createdUtc = [DateTime]::UtcNow
$createdShanghai = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId($createdUtc, 'China Standard Time')
$versionName = $createdShanghai.ToString('yyyyMMdd-HHmmss-fff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$snapshotPath = [IO.Path]::GetFullPath((Join-Path $taskRoot "全栈开发任务\存档\$Checkpoint\版本\$versionName"))
if (-not $snapshotPath.StartsWith($taskPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '快照路径超出工作区。' }
if (Test-Path -LiteralPath $snapshotPath) { throw '拒绝覆盖现有快照。' }
$filesRoot = Join-Path $snapshotPath 'files'
New-Item -ItemType Directory -Path $filesRoot | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$excluded = New-Object 'System.Collections.Generic.List[object]'
$copied = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$skipDirectories = @('node_modules','.git','dist','build','coverage','.cache','.next','playwright-report','test-results','.data','generated','.volumes','pgdata','postgres-data','backups','secrets','volumes','版本')

function Add-SafeFile {
    param([string]$Source)
    $fullSource = [IO.Path]::GetFullPath($Source)
    if (-not $fullSource.StartsWith($taskPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '文件超出工作区。' }
    $item = Get-Item -LiteralPath $fullSource -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "不跟随链接：$fullSource" }
    $relative = $fullSource.Substring($taskPrefix.Length)
    $sensitiveName = ($item.Name -like '.env*' -and $item.Name -ne '.env.example') -or
        ($item.Extension -match '^\.(pem|key|pfx|p12|crt|sqlite|sqlite3|db|dump|backup|bak|zip|gz|tar)$') -or
        ($item.Name -match '(?i)(dump|backup).*\.sql$') -or
        ($item.Name -match '(?i)^(storageState|auth-state|credentials|service-account)\.json$')
    if ($sensitiveName) {
        $excluded.Add([ordered]@{path=$relative;reason='敏感或运行数据文件名过滤'}) | Out-Null
        return
    }
    if ($item.Length -gt 50MB) { throw "文件超过50MiB，请在记录中使用受控引用：$relative" }
    if (-not $copied.Add($fullSource)) { return }
    $target = Join-Path $filesRoot $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $fullSource -Destination $target
    if ((Get-FileHash -LiteralPath $fullSource -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash) {
        throw "复制后hash不同：$relative"
    }
}
function Add-SafeTree {
    param([string]$Relative, [bool]$Required = $false)
    $source = [IO.Path]::GetFullPath((Join-Path $taskRoot $Relative))
    if (-not $source.StartsWith($taskPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '输入路径超出工作区。' }
    if (-not (Test-Path -LiteralPath $source)) {
        if ($Required) { throw "缺少必要文件：$Relative" }
        return
    }
    $item = Get-Item -LiteralPath $source -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "不跟随链接：$Relative" }
    if (-not $item.PSIsContainer) { Add-SafeFile $source; return }
    foreach ($child in @(Get-ChildItem -LiteralPath $source -Force)) {
        if ($child.PSIsContainer) {
            if ($skipDirectories -contains $child.Name -or ($Relative -eq '全栈开发任务' -and $child.Name -eq '存档')) {
                $excluded.Add([ordered]@{path=$child.FullName.Substring($taskPrefix.Length);reason='运行目录或旧快照过滤'}) | Out-Null
                continue
            }
            Add-SafeTree -Relative $child.FullName.Substring($taskPrefix.Length)
        } else { Add-SafeFile $child.FullName }
    }
}
try {
    foreach ($required in @('AI编程工作台-开发方案.md','AI编程工作台-全栈全流程开发方案.md','README.md','全栈开发任务')) {
        Add-SafeTree -Relative $required -Required $true
    }
    foreach ($optional in @('apps','packages','database','infra','tests','docs','.github\workflows')) {
        Add-SafeTree -Relative $optional
    }
    $rootConfigPattern = '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig.*\.json|eslint\.config\..+|vitest\.config\..+|playwright\.config\..+|\.gitignore|\.dockerignore|\.nvmrc|\.node-version|\.env\.example|compose.*\.ya?ml|Dockerfile.*|Makefile)$'
    foreach ($rootFile in @(Get-ChildItem -LiteralPath $taskRoot -File -Force)) {
        if ($rootFile.Name -match $rootConfigPattern) { Add-SafeFile $rootFile.FullName }
    }
    foreach ($directory in @(Get-ChildItem -LiteralPath (Join-Path $taskRoot '全栈开发任务\存档') -Directory)) {
        if ($directory.Name -match '^FS\d{3}$') {
            $record = Join-Path $directory.FullName '存档记录.md'
            if (Test-Path -LiteralPath $record -PathType Leaf) { Add-SafeFile $record }
        }
    }
    $gitCommit = $null
    $gitStatus = @()
    if ((Test-Path -LiteralPath (Join-Path $taskRoot '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
        $gitOutput = @(& git -C $taskRoot rev-parse HEAD 2>$null)
        if ($LASTEXITCODE -eq 0) { $gitCommit = ($gitOutput -join '').Trim() }
        $gitStatus = @(& git -C $taskRoot status --porcelain 2>$null)
    }
    $noteText = @(
        "# $Checkpoint 全栈快照",
        '',
        "- 时间（Asia/Shanghai）：$($createdShanghai.ToString('yyyy-MM-dd HH:mm:ss'))",
        "- 时间（UTC）：$($createdUtc.ToString('o'))",
        "- 说明：$Note",
        "- 快照路径：$snapshotPath",
        '- 保存文件不代表任务验收通过；实际结论见本步记录。',
        '- 不执行Git提交、数据库迁移、构建、下载、部署或外部上传。',
        '- DB备份、镜像与CI产物仅按记录中的受控引用恢复。',
        '- 过滤文件名不保证源码无内嵌密钥，执行者仍需秘密扫描。',
        '- manifest列出全部归档文件的hash，不包含manifest自身。'
    ) -join [Environment]::NewLine
    [IO.File]::WriteAllText((Join-Path $snapshotPath '快照说明.md'), $noteText, $utf8)
    $snapshotPrefix = $snapshotPath.TrimEnd('\') + '\'
    $fileEntries = @(
        Get-ChildItem -LiteralPath $snapshotPath -File -Recurse | Sort-Object FullName | ForEach-Object {
            [ordered]@{
                path=$_.FullName.Substring($snapshotPrefix.Length).Replace('\','/')
                bytes=$_.Length
                sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    )
    $manifest = [ordered]@{
        checkpoint=$Checkpoint;createdAtUtc=$createdUtc.ToString('o')
        createdAtShanghai=$createdShanghai.ToString('yyyy-MM-dd HH:mm:ss')
        note=$Note;gitCommit=$gitCommit;gitStatus=$gitStatus
        applicationSourcesIncluded=(Test-Path -LiteralPath (Join-Path $filesRoot 'apps'))
        taskStatusAutomaticallyChanged=$false
        excluded=@($excluded.ToArray())
        files=$fileEntries
    }
    $manifestPath = Join-Path $snapshotPath 'manifest.json'
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 9), $utf8)
    $saved = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($entry in $saved.files) {
        $path = Join-Path $snapshotPath $entry.path
        if ((Get-Item -LiteralPath $path).Length -ne $entry.bytes -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
            throw "快照自检失败：$($entry.path)"
        }
    }
    Write-Output ("快照生成完成，SHA-256自检通过；文件数：{0}" -f $saved.files.Count)
    Write-Output ("版本路径：{0}" -f $snapshotPath)
    Write-Output '请按实际验收填写记录和进度；不会自动标记通过。'
} catch {
    [IO.File]::WriteAllText((Join-Path $snapshotPath '生成失败.txt'), $_.Exception.Message, $utf8)
    throw
}

