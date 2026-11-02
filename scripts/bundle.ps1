[CmdletBinding()]
param([string]$Destination = '', [string]$Python = (Join-Path $PSScriptRoot '..\.venv\Scripts\python.exe'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Destination) { $Destination = Join-Path $repositoryRoot 'dist\offline-0.2.0' }
$bundle = [System.IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $bundle -Force | Out-Null
foreach ($folder in @('scripts','dist','integration','assets','wheelhouse','docs','artifacts\integration','artifacts\benchmarks')) {
    New-Item -ItemType Directory -Path (Join-Path $bundle $folder) -Force | Out-Null
}
& $Python (Join-Path $PSScriptRoot 'lock_dependencies.py')
if ($LASTEXITCODE -ne 0) { throw 'Preparing locked wheels failed.' }
$info = (& $Python -m codeconverge engine-info | ConvertFrom-Json)
& $Python -m codeconverge setup --offline
if ($LASTEXITCODE -ne 0) { throw 'Prepare verified assets before bundling.' }
foreach ($name in @('install.ps1','uninstall.ps1')) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot ('scripts\' + $name)) -Destination (Join-Path $bundle 'scripts') -Force
}
foreach ($name in @('requirements.lock','requirements-offline.lock','README.md','LICENSE')) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot $name) -Destination $bundle -Force
}
foreach ($name in @('codeconverge-0.2.0-py3-none-any.whl','codeconverge-0.2.0.vsix')) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot ('dist\' + $name)) -Destination (Join-Path $bundle 'dist') -Force
}
Get-ChildItem -LiteralPath (Join-Path $repositoryRoot 'integration') -File | Copy-Item -Destination (Join-Path $bundle 'integration') -Force
Get-ChildItem -LiteralPath (Join-Path $repositoryRoot 'docs') -File | Copy-Item -Destination (Join-Path $bundle 'docs') -Force
Get-ChildItem -LiteralPath (Join-Path $repositoryRoot 'artifacts\benchmarks') -File | Copy-Item -Destination (Join-Path $bundle 'artifacts\benchmarks') -Force
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'artifacts\integration\release-audit.json') -Destination (Join-Path $bundle 'artifacts\integration') -Force
Get-ChildItem -LiteralPath (Join-Path $repositoryRoot 'dist\wheelhouse') -Filter '*.whl' | Copy-Item -Destination (Join-Path $bundle 'wheelhouse') -Force
foreach ($name in @('models','parsers')) {
    Copy-Item -LiteralPath (Join-Path $info.home $name) -Destination (Join-Path $bundle 'assets') -Recurse -Force
}
$checksums = Get-ChildItem -LiteralPath $bundle -File -Recurse | Where-Object Name -ne 'SHA256SUMS.txt' | ForEach-Object {
    $relative = [System.IO.Path]::GetRelativePath($bundle, $_.FullName)
    (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $relative
}
[System.IO.File]::WriteAllLines((Join-Path $bundle 'SHA256SUMS.txt'), $checksums)
Write-Host "Offline bundle prepared: $bundle"
Write-Host '.\scripts\install.ps1 -Offline -Wheelhouse .\wheelhouse -AssetsDirectory .\assets'
