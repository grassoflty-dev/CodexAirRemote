param([string]$IdfActivate = $env:AIRREMOTE_IDF_ACTIVATE)
$ErrorActionPreference = 'Stop'
if ($IdfActivate) {
    . $IdfActivate
} elseif (!$env:IDF_PATH) {
    $activation = 'C:\Espressif\tools\Microsoft.v5.5.5.PowerShell_profile.ps1'
    if (!(Test-Path -LiteralPath $activation)) {
        throw 'Activate ESP-IDF 5.5.5 first, or set AIRREMOTE_IDF_ACTIVATE to its PowerShell activation script.'
    }
    . $activation
}
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $python)) { throw 'Run Setup-Dev.ps1 first.' }
& $python (Join-Path $PSScriptRoot 'tools\init_pairing.py')
if ($LASTEXITCODE -ne 0) { throw 'Local pairing files could not be prepared.' }
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot '.tools') | Out-Null
Push-Location (Join-Path $PSScriptRoot 'firmware')
try {
    $log = Join-Path $PSScriptRoot '.tools\build.log'
    & "$env:IDF_PYTHON_ENV_PATH\Scripts\python.exe" "$env:IDF_PATH\tools\idf.py" build 2>&1 | Tee-Object -FilePath $log
    if ($LASTEXITCODE -ne 0) { throw 'Firmware build failed.' }
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
