[CmdletBinding(SupportsShouldProcess, ConfirmImpact='High')]
param([switch]$RemoveCachedData)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$pointer = Join-Path $env:USERPROFILE '.codeconverge\installation.json'
if (-not (Test-Path -LiteralPath $pointer)) { throw 'No registered CodeConverge installation.' }
$installation = Get-Content -Raw -LiteralPath $pointer | ConvertFrom-Json -AsHashtable
if ($installation.product -ne 'CodeConverge') { throw 'Unexpected installation identity.' }
$applicationRoot = [System.IO.Path]::GetFullPath($installation.home)
if ($applicationRoot -eq [System.IO.Path]::GetPathRoot($applicationRoot) -or $applicationRoot -eq $env:USERPROFILE) { throw 'Unsafe application root.' }
if ((Get-Item -LiteralPath $applicationRoot).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Redirected application root.' }
$runtime = [System.IO.Path]::GetFullPath((Join-Path $applicationRoot 'runtime'))
if ((Split-Path -Parent $runtime) -ne $applicationRoot -or $installation.python -ne (Join-Path $runtime 'Scripts\python.exe')) { throw 'Unexpected runtime path.' }
if (-not $PSCmdlet.ShouldProcess($applicationRoot, $(if ($RemoveCachedData) { 'Uninstall CodeConverge and delete model/index caches' } else { 'Uninstall CodeConverge, preserving model/index caches' }))) { return }
$saved = $env:CODECONVERGE_HOME
try {
    $env:CODECONVERGE_HOME = $applicationRoot
    & $installation.python -I -m codeconverge stop-engine
    if ($LASTEXITCODE -ne 0) { throw 'Close CodeConverge editor windows before uninstalling.' }
    Start-Sleep -Milliseconds 750
} finally { $env:CODECONVERGE_HOME = $saved }
$code = Get-Command code.cmd -ErrorAction Stop
& $code.Source --uninstall-extension codeconverge.codeconverge
if ($LASTEXITCODE -ne 0) { throw 'VS Code extension removal failed.' }
if ($installation.ContainsKey('managedFiles')) {
    foreach ($file in $installation.managedFiles.Keys) {
        if ((Test-Path -LiteralPath $file) -and (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -eq $installation.managedFiles[$file]) {
            Remove-Item -LiteralPath $file -Force
        }
    }
}
$target = if ($RemoveCachedData) { $applicationRoot } else { $runtime }
# Targets are exact paths from the checked installation, never project metadata.
if ($target -ne $applicationRoot -and (Split-Path -Parent $target) -ne $applicationRoot) { throw 'Unsafe removal target.' }
if (Test-Path -LiteralPath $target) {
    if (@(Get-ChildItem -LiteralPath $target -Recurse -Force | Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint }).Count) { throw 'Refusing recursive removal through redirected entries.' }
    Remove-Item -LiteralPath $target -Recurse -Force
}
Remove-Item -LiteralPath $pointer -Force
if (-not $RemoveCachedData) { Remove-Item -LiteralPath (Join-Path $applicationRoot 'installation.json') -Force }
Write-Host 'CodeConverge removed. Customized guidance files were preserved.'
