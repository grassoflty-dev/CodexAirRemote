param(
    [string]$Python = 'python',
    [switch]$SkipDependencyInstall
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $venvPython)) {
    if ($SkipDependencyInstall) { throw 'No .venv found. Run Setup-Dev.ps1 without -SkipDependencyInstall first.' }
    & $Python -c 'import sys; assert sys.version_info[:2] == (3, 12), "Python 3.12 is required"'
    if ($LASTEXITCODE -ne 0) { throw 'Select Python 3.12 with -Python <path-to-python.exe>.' }
    & $Python -m venv (Join-Path $root '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
}
& $venvPython -c 'import sys; assert sys.version_info[:2] == (3, 12), "Python 3.12 is required"'
if ($LASTEXITCODE -ne 0) { throw 'The existing .venv must use Python 3.12.' }
if (!$SkipDependencyInstall) {
    Write-Host 'Installing development dependencies. Downloads consume network data.'
    & $venvPython -m ensurepip --upgrade
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare pip.' }
    & $venvPython -m pip install -r (Join-Path $root 'host\requirements-dev.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Development dependency installation failed.' }
}
& $venvPython (Join-Path $root 'tools\init_pairing.py')
if ($LASTEXITCODE -ne 0) { throw 'Local pairing initialization failed.' }
Write-Host 'Development environment ready. Open CodexAirRemote.code-workspace in VS Code.'
