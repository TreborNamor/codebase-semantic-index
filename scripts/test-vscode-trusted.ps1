[CmdletBinding()]
param([string]$CodeExecutable = (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (Get-Process -Name Code -ErrorAction SilentlyContinue) {
    throw 'Close VS Code before running the trusted-profile test. It does not change workspace trust.'
}
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceFixture = Join-Path $repositoryRoot 'integration\fixtures\codeconverge-multiroot.code-workspace'
$rootB = Join-Path $repositoryRoot 'integration\fixtures\project-b'
$evidence = Join-Path $repositoryRoot 'artifacts\integration\vscode-trusted.json'
$env:CODECONVERGE_TEST_EVIDENCE = $evidence
$env:CODECONVERGE_TEST_SECOND_ROOT = $rootB
$env:CODECONVERGE_TEST_KNOWN_MULTI = '1'
$env:CODECONVERGE_TEST_STARTUP_DELAY_MS = '1000'
try {
    # Use the existing user profile and its already-granted parent-folder trust.
    # The extension host must report trusted=true; no trust API/storage is edited.
    $arguments = @('--new-window', '--skip-welcome', '--skip-release-notes',
        ('--extensionDevelopmentPath="' + (Join-Path $repositoryRoot 'extension') + '"'),
        ('--extensionTestsPath="' + (Join-Path $repositoryRoot 'extension\out\test\integration.js') + '"'),
        ('"' + $workspaceFixture + '"'))
    $process = Start-Process -FilePath $CodeExecutable -ArgumentList $arguments -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(60000)) { throw "Test host is still running (PID $($process.Id)); inspect it before retrying." }
    if (-not (Test-Path -LiteralPath $evidence)) { throw "Trusted test produced no evidence (exit $($process.ExitCode))." }
    $result = Get-Content -Raw -LiteralPath $evidence | ConvertFrom-Json
    if (-not $result.passed -or -not $result.trustedSourceChecks) {
        throw 'Trusted source checks did not pass. Existing parent trust must be granted by the user.'
    }
    Write-Host ('Trusted VS Code checks passed: ' + ($result.checks -join ', '))
} finally {
    Remove-Item Env:\CODECONVERGE_TEST_EVIDENCE,Env:\CODECONVERGE_TEST_SECOND_ROOT,Env:\CODECONVERGE_TEST_STARTUP_DELAY_MS,Env:\CODECONVERGE_TEST_KNOWN_MULTI
}
