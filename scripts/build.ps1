[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $repositoryRoot
try {
    $buildDirectory = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'build'))
    if ((Split-Path -Parent $buildDirectory) -ne $repositoryRoot) { throw 'Unsafe build directory.' }
    if (Test-Path -LiteralPath $buildDirectory) {
        $buildItem = Get-Item -LiteralPath $buildDirectory -Force
        if ($buildItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Refusing to clear a redirected build directory.' }
        Remove-Item -LiteralPath $buildDirectory -Recurse -Force
    }
    & (Join-Path $repositoryRoot '.venv\Scripts\python.exe') -m build --wheel
    if ($LASTEXITCODE -ne 0) { throw 'Python build failed.' }
    Push-Location (Join-Path $repositoryRoot 'extension')
    try {
        & npm.cmd ci --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw 'Extension dependencies failed.' }
        & npm.cmd run compile
        if ($LASTEXITCODE -ne 0) { throw 'Extension compilation failed.' }
        & npm.cmd run test
        if ($LASTEXITCODE -ne 0) { throw 'Extension tests failed.' }
        & npm.cmd run package
        if ($LASTEXITCODE -ne 0) { throw 'Extension packaging failed.' }
    } finally { Pop-Location }
} finally { Pop-Location }
