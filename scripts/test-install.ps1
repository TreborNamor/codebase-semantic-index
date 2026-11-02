[CmdletBinding()]
param([string]$Python = 'C:\Program Files\Python313\python.exe')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testParent = [System.IO.Path]::GetTempPath()
$testRoot = [System.IO.Path]::GetFullPath((Join-Path $testParent ('CodeConvergeInstall-' + [guid]::NewGuid().ToString('N'))))
if ((Split-Path -Parent $testRoot).TrimEnd('\') -ne $testParent.TrimEnd('\')) { throw 'Unsafe installation-test directory.' }
$pointer = Join-Path $env:USERPROFILE '.codeconverge\installation.json'
$beforePointer = [System.IO.File]::ReadAllBytes($pointer)
$existing = Get-Content -Raw -LiteralPath $pointer | ConvertFrom-Json
$evidence = @{freshRuntime=$false; idempotent=$false; isolatedImport=$false; offline=$true; userPointerPreserved=$false}
try {
    & (Join-Path $PSScriptRoot 'install.ps1') -Python $Python -ApplicationHome $testRoot -SkipUserIntegration -SkipExtension -Offline -Wheelhouse (Join-Path $repositoryRoot 'dist\wheelhouse') -AssetsDirectory $existing.home
    $runtimePython = Join-Path $testRoot 'runtime\Scripts\python.exe'
    & $runtimePython -I -m pip check
    if ($LASTEXITCODE -ne 0) { throw 'Fresh dependency closure is invalid.' }
    $evidence.freshRuntime = $true
    # Run outside the source tree, with deliberate import shadows in cwd.
    $untrusted = Join-Path $testRoot 'shadow'
    New-Item -ItemType Directory -Path $untrusted -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $untrusted 'codeconverge.py'), "raise RuntimeError('workspace module executed')")
    Push-Location $untrusted
    try {
        & $runtimePython -I -c 'import codeconverge,llama_cpp,mcp,sys; from pathlib import Path; assert Path(codeconverge.__file__).is_relative_to(Path(sys.prefix)); print(codeconverge.__version__)'
        if ($LASTEXITCODE -ne 0) { throw 'Installed imports depend on cwd or the source checkout.' }
        $evidence.isolatedImport = $true
    } finally { Pop-Location }
    & (Join-Path $PSScriptRoot 'install.ps1') -Python $Python -ApplicationHome $testRoot -SkipUserIntegration -SkipExtension -Offline -Wheelhouse (Join-Path $repositoryRoot 'dist\wheelhouse')
    & $runtimePython -I -m pip check
    if ($LASTEXITCODE -ne 0) { throw 'Repeat installation is invalid.' }
    $evidence.idempotent = $true
    $evidence.userPointerPreserved = [System.Linq.Enumerable]::SequenceEqual([byte[]]$beforePointer,[byte[]][System.IO.File]::ReadAllBytes($pointer))
    if (-not $evidence.userPointerPreserved) { throw 'Staging installation altered the user installation pointer.' }
    $evidence | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $repositoryRoot 'artifacts\integration\installation.json') -Encoding utf8
} finally {
    # Only the explicitly created, verified temp directory is removed.
    if ((Split-Path -Parent ([System.IO.Path]::GetFullPath($testRoot))).TrimEnd('\') -ne $testParent.TrimEnd('\')) { throw 'Unsafe cleanup target.' }
    if (Test-Path -LiteralPath $testRoot) {
        if ((Get-Item -LiteralPath $testRoot).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Redirected installation-test cleanup target.' }
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
