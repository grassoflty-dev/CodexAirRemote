param([string]$IdfActivate = $env:AIRREMOTE_IDF_ACTIVATE)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$windows = Join-Path (Split-Path $root -Parent) 'windows'

# 1) ESP-IDF 5.5.5 environment (EIM install, shared by both projects).
if ($IdfActivate) {
    . $IdfActivate
} elseif (!$env:IDF_PATH) {
    $activation = 'C:\Espressif\tools\Microsoft.v5.5.5.PowerShell_profile.ps1'
    if (!(Test-Path -LiteralPath $activation)) {
        throw 'Activate ESP-IDF 5.5.5 first, or set AIRREMOTE_IDF_ACTIVATE to its PowerShell activation script.'
    }
    . $activation
}

# 2) The firmware embeds the per-checkout TLS certificate, key and pairing
#    token that live in the Windows project. Create them if they are missing.
$python = Join-Path $windows '.venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $python)) { throw 'Run windows\Setup-Dev.ps1 first.' }
& $python (Join-Path $windows 'tools\init_pairing.py')
if ($LASTEXITCODE -ne 0) { throw 'Local pairing files could not be prepared.' }

New-Item -ItemType Directory -Force -Path (Join-Path $root 'build') | Out-Null
Push-Location $root
try {
    $log = Join-Path $root 'build\build.log'
    $savedErrorAction = $ErrorActionPreference
    try {
        # Windows PowerShell reports native stderr as ErrorRecords, including
        # harmless CMake warnings. Let the process exit code decide success.
        $ErrorActionPreference = 'Continue'
        & "$env:IDF_PYTHON_ENV_PATH\Scripts\python.exe" "$env:IDF_PATH\tools\idf.py" build 2>&1 |
            ForEach-Object { $_.ToString() } | Tee-Object -FilePath $log
        $buildExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorAction
    }
    if ($buildExitCode -ne 0) { throw 'Firmware build failed.' }

    # 3) Release manifest consumed by windows/host/flash.py.
    $files = (Get-Content -Raw 'build\flasher_args.json' | ConvertFrom-Json).flash_files
    $manifest = [ordered]@{}
    foreach ($file in $files.PSObject.Properties) {
        $image = Join-Path $PWD (Join-Path 'build' $file.Value)
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $hash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($image))).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha.Dispose()
        }
        $manifest[$file.Name] = @{ path = $file.Value; sha256 = $hash }
    }
    $json = $manifest | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText((Join-Path $PWD 'build\airremote-release.json'), $json, (New-Object Text.UTF8Encoding($false)))
} finally {
    Pop-Location
}
