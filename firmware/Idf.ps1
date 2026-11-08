param(
    [switch]$ActivateOnly,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$IdfArgs
)
$ErrorActionPreference = 'Stop'

# Activate the EIM-managed ESP-IDF 5.5.5 environment. The activation script is
# a Windows-global component (see docs/components.md); set
# AIRREMOTE_IDF_ACTIVATE to point at another install.
$IdfActivate = $env:AIRREMOTE_IDF_ACTIVATE
if ($IdfActivate) {
    . $IdfActivate
} elseif (!$env:IDF_PATH) {
    $activation = 'C:\Espressif\tools\Microsoft.v5.5.5.PowerShell_profile.ps1'
    if (!(Test-Path -LiteralPath $activation)) {
        throw 'Activate ESP-IDF 5.5.5 first, or set AIRREMOTE_IDF_ACTIVATE to its PowerShell activation script.'
    }
    . $activation
}

if ($ActivateOnly) { return }
if (!$IdfArgs -or $IdfArgs.Count -eq 0) { $IdfArgs = @('--help') }

Push-Location $PSScriptRoot
try {
    & "$env:IDF_PYTHON_ENV_PATH\Scripts\python.exe" "$env:IDF_PATH\tools\idf.py" @IdfArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
