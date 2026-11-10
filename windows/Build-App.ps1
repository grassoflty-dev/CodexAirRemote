$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$shared = Split-Path $root -Parent
$staging = Join-Path $root 'build\pyinstaller'
$python = Join-Path $root '.venv\Scripts\python.exe'
$install = Join-Path $root 'app'
if (!(Test-Path -LiteralPath $python)) { throw 'Run windows\Setup-Dev.ps1 first.' }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Push-Location $root
try {
    $options = @(
        '--noconfirm', '--onedir', '--windowed', '--name', 'CodexAirRemote',
        '--distpath', "$staging\dist", '--workpath', "$staging\work", '--specpath', $staging,
        '--add-data', ((Join-Path $root 'host\hotspot.ps1') + ':.'), '--collect-all', 'esptool',
        '--add-data', ((Join-Path $root 'host\dictation.ps1') + ':.'), '--add-data', ((Join-Path $root 'host\dsh_dictation.ps1') + ':.'), '--add-data', ((Join-Path $root 'host\pair-mouse.ps1') + ':.'), 'host\desktop.py'
    )
    foreach ($notice in @('LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md')) {
        $options += @('--add-data', ((Join-Path $shared $notice) + ':licenses'))
    }
    $options += @('--add-data', ((Join-Path $shared 'LICENSES\GPL-3.0.txt') + ':licenses'))
    & $python -m PyInstaller @options
    if ($LASTEXITCODE -ne 0) { throw 'Windows app packaging failed.' }

    $bundle = (Resolve-Path -LiteralPath "$staging\dist\CodexAirRemote").Path
    $backup = Join-Path $staging ('previous-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss-ffff'))
    $rootPrefix = $root.TrimEnd('\') + '\'
    foreach ($target in @($bundle, $install, $backup)) {
        if (![IO.Path]::GetFullPath($target).StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "App deployment path is outside the Windows project: $target"
        }
    }
    if (Test-Path -LiteralPath $install) {
        Move-Item -LiteralPath $install -Destination $backup
    }
    try {
        Move-Item -LiteralPath $bundle -Destination $install
    } catch {
        if ((Test-Path -LiteralPath $backup) -and !(Test-Path -LiteralPath $install)) {
            Move-Item -LiteralPath $backup -Destination $install
        }
        throw
    }
} finally {
    Pop-Location
}
