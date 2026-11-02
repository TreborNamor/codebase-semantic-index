#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$Python = '',
    [string]$ApplicationHome = (Join-Path $env:LOCALAPPDATA 'CodeConverge'),
    [switch]$SkipExtension,
    [switch]$SkipUserIntegration,
    [switch]$Offline,
    [string]$Wheelhouse = '',
    [string]$AssetsDirectory = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$applicationRoot = [System.IO.Path]::GetFullPath($ApplicationHome)
if ($applicationRoot -eq $repositoryRoot -or $applicationRoot.StartsWith($repositoryRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The installed application must be outside the development repository.'
}
$wheel = Join-Path $repositoryRoot 'dist\codeconverge-0.2.0-py3-none-any.whl'
$vsix = Join-Path $repositoryRoot 'dist\codeconverge-0.2.0.vsix'
if (-not (Test-Path -LiteralPath $wheel)) { throw 'Build the Python wheel before installing.' }
if (-not $SkipExtension -and -not (Test-Path -LiteralPath $vsix)) { throw 'Package the VS Code extension before installing.' }
if (-not $Python) {
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        $Python = (& $launcher.Source -3.13 -c 'import sys; print(sys.executable)')
        if ($LASTEXITCODE -ne 0 -or -not $Python) { throw 'Install standard 64-bit CPython 3.13, or pass its executable with -Python.' }
        $Python = $Python.Trim()
    } else {
        $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
        if (-not $pythonCommand) { throw 'Python was not found. Install standard 64-bit CPython 3.13, or pass its executable with -Python.' }
        $Python = $pythonCommand.Source
    }
}
& $Python -c "import sys,struct,sysconfig; assert sys.version_info[:2] == (3,13) and struct.calcsize('P') == 8 and not sysconfig.get_config_var('Py_GIL_DISABLED'), 'Use standard 64-bit CPython 3.13'"
if ($LASTEXITCODE -ne 0) { throw 'Unsupported Python runtime.' }

New-Item -ItemType Directory -Path $applicationRoot -Force | Out-Null
$runtime = Join-Path $applicationRoot 'runtime'
$runtimePython = Join-Path $runtime 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $runtimePython)) {
    & $Python -m venv $runtime
    if ($LASTEXITCODE -ne 0) { throw 'Creating the user runtime failed.' }
}
$dependencyLock = Join-Path $repositoryRoot 'requirements.lock'
if (-not (Test-Path -LiteralPath $dependencyLock)) { throw 'Generate the runtime dependency lock before installing.' }
$pipOptions = @('--disable-pip-version-check', '--require-hashes', '--only-binary=:all:')
if ($Offline) {
    if (-not (Test-Path -LiteralPath $Wheelhouse -PathType Container)) { throw 'Offline installation requires a wheelhouse from scripts/bundle.ps1.' }
    $dependencyLock = Join-Path $repositoryRoot 'requirements-offline.lock'
    $pipOptions += @('--no-index', '--find-links', $Wheelhouse)
}
& $runtimePython -m pip install @pipOptions -r $dependencyLock
if ($LASTEXITCODE -ne 0) { throw 'Installing locked CodeConverge dependencies failed.' }
# Reinstall the application wheel even when a development milestone retains
# its package version; dependencies remain cached in the dedicated runtime.
& $runtimePython -m pip install --disable-pip-version-check --no-deps --force-reinstall $wheel
if ($LASTEXITCODE -ne 0) { throw 'Installing the application wheel failed.' }
$actualHome = (& $runtimePython -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' $applicationRoot).Trim()
$actualPython = Join-Path $actualHome 'runtime\Scripts\python.exe'
$installation = @{ product = 'CodeConverge'; version = '0.2.0'; home = $actualHome; python = $actualPython; wheelSha256 = (Get-FileHash -LiteralPath $wheel -Algorithm SHA256).Hash; managedFiles = @{} }
$previousManifest = Join-Path $applicationRoot 'installation.json'
$previous = if (Test-Path -LiteralPath $previousManifest) { Get-Content -Raw -LiteralPath $previousManifest | ConvertFrom-Json -AsHashtable } else { @{} }
$pointerDirectory = Join-Path $env:USERPROFILE '.codeconverge'
New-Item -ItemType Directory -Path $pointerDirectory -Force | Out-Null

if ($AssetsDirectory) {
    foreach ($name in @('models', 'parsers')) {
        $source = Join-Path $AssetsDirectory $name
        if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Asset bundle is missing $name." }
        New-Item -ItemType Directory -Path (Join-Path $actualHome $name) -Force | Out-Null
        Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination (Join-Path $actualHome $name) -Recurse -Force
    }
}
$savedApplicationHome = $env:CODECONVERGE_HOME
try {
    $env:CODECONVERGE_HOME = $actualHome
    if ($Offline) { & $actualPython -m codeconverge setup --offline }
    else { & $actualPython -m codeconverge setup }
    if ($LASTEXITCODE -ne 0) { throw 'Model or parser verification failed. The integration has not been activated.' }
} finally { $env:CODECONVERGE_HOME = $savedApplicationHome }

$copilotRoot = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE '.copilot' }
if (-not $SkipUserIntegration) { foreach ($entry in @(@{Folder='agents';Name='codeconverge-research.agent.md'}, @{Folder='instructions';Name='codeconverge.instructions.md'})) {
    $targetDirectory = Join-Path $copilotRoot $entry.Folder
    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    $source = Join-Path $repositoryRoot ('integration\' + $entry.Name)
    $target = Join-Path $targetDirectory $entry.Name
    $newHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    if (Test-Path -LiteralPath $target) {
        $oldHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
        $managedHash = if ($previous.ContainsKey('managedFiles')) { $previous.managedFiles[$target] } else { $null }
        if ($oldHash -ne $newHash -and $oldHash -ne $managedHash) {
            Write-Warning "Preserved customized $target. The bundled replacement is $source."
            continue
        }
    }
    Copy-Item -LiteralPath $source -Destination $target -Force
    $installation.managedFiles[$target] = $newHash
} }
$manifestJson = $installation | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $applicationRoot 'installation.json'), $manifestJson, [System.Text.UTF8Encoding]::new($false))
if (-not $SkipUserIntegration) { [System.IO.File]::WriteAllText((Join-Path $pointerDirectory 'installation.json'), $manifestJson, [System.Text.UTF8Encoding]::new($false)) }

if (-not $SkipExtension -and -not $SkipUserIntegration) {
    $codeCommand = Get-Command code.cmd -ErrorAction Stop
    & $codeCommand.Source --install-extension $vsix --force
    if ($LASTEXITCODE -ne 0) { throw 'Installing the VS Code extension failed.' }
}
Write-Host "CodeConverge 0.2.0 installed under $actualHome."
Write-Host 'Open a trusted local folder in VS Code. Indexing starts automatically; reload already-open windows after an upgrade.'
