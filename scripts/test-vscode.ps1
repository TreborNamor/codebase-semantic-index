[CmdletBinding()]
param([string]$CodeExecutable = (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('CodeConvergeTests-' + [guid]::NewGuid().ToString('N'))
$rootA = Join-Path $testRoot 'a'
$rootB = Join-Path $testRoot 'b'
New-Item -ItemType Directory -Path $rootA,$rootB -Force | Out-Null
[System.IO.File]::WriteAllText((Join-Path $rootA 'alpha.py'), "def alpha_beacon():`n    return 'alpha-only'`n")
[System.IO.File]::WriteAllText((Join-Path $rootB 'beta.py'), "def beta_beacon():`n    return 'beta-only'`n")
$evidenceRoot = Join-Path $repositoryRoot 'artifacts\integration'
New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
foreach ($scenario in @('folder','empty')) {
    $env:CODECONVERGE_TEST_EVIDENCE = Join-Path $evidenceRoot ("vscode-$scenario.json")
    $env:CODECONVERGE_TEST_SECOND_ROOT = $rootB
    $env:CODECONVERGE_TEST_STARTUP_DELAY_MS = '1000'
    $profile = Join-Path $testRoot ("profile-$scenario")
    $arguments = @('--new-window', '--skip-welcome', '--skip-release-notes', '--user-data-dir', ('"' + $profile + '"'), ('--extensionDevelopmentPath="' + (Join-Path $repositoryRoot 'extension') + '"'), ('--extensionTestsPath="' + (Join-Path $repositoryRoot 'extension\out\test\integration.js') + '"'))
    if ($scenario -eq 'folder') { $arguments += ('"' + $rootA + '"') }
    $process = Start-Process -FilePath $CodeExecutable -ArgumentList $arguments -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(60000)) { throw "VS Code test host is still running (PID $($process.Id)); inspect it before retrying." }
    if (-not (Test-Path -LiteralPath $env:CODECONVERGE_TEST_EVIDENCE)) { throw "No evidence was written by the $scenario extension host (exit $($process.ExitCode))." }
    $result = Get-Content -Raw -LiteralPath $env:CODECONVERGE_TEST_EVIDENCE | ConvertFrom-Json
    if (-not $result.passed) { throw "VS Code $scenario scenario failed: $($result.error)" }
    Write-Host "VS Code $scenario scenario passed: $($result.checks -join ', ')"
    if ($scenario -eq 'folder' -and -not $result.trustedSourceChecks) {
        Write-Warning 'Trusted source and multi-root scenarios remain unverified. The fixture was not trusted; the runner did not alter workspace trust.'
    }
}
Remove-Item Env:\CODECONVERGE_TEST_EVIDENCE,Env:\CODECONVERGE_TEST_SECOND_ROOT,Env:\CODECONVERGE_TEST_STARTUP_DELAY_MS
