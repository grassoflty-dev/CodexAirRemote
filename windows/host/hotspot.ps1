param([ValidateSet('Inspect','Start','Stop')][string]$Operation = 'Inspect')
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType=WindowsRuntime]
$null = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType=WindowsRuntime]
$null = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringSessionAccessPointConfiguration, Windows.Networking.NetworkOperators, ContentType=WindowsRuntime]
$null = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult, Windows.Networking.NetworkOperators, ContentType=WindowsRuntime]
$null = [Windows.Networking.NetworkOperators.TetheringWiFiBand, Windows.Networking.NetworkOperators, ContentType=WindowsRuntime]

$profile = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
if (!$profile) { throw 'Windows has no Internet uplink to share.' }
$tether = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($profile)
$band = [Windows.Networking.NetworkOperators.TetheringWiFiBand]::TwoPointFourGigahertz
$session = New-Object Windows.Networking.NetworkOperators.NetworkOperatorTetheringSessionAccessPointConfiguration
$capability = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::GetTetheringCapabilityFromConnectionProfile($profile)

if ($Operation -eq 'Inspect') {
    [PSCustomObject]@{
        state = [string]$tether.TetheringOperationalState
        capability = [string]$capability
        band24 = $session.IsBandSupported($band)
    } | ConvertTo-Json -Compress
    exit
}

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Length -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1'
} | Select-Object -First 1
if (!$asTask) { throw 'Windows Runtime async support unavailable.' }

if ($Operation -eq 'Start') {
    if ($tether.TetheringOperationalState -eq 'On') {
        Write-Output 'AlreadyOn'
        exit
    }
    if ($capability -ne 'Enabled' -or !$session.IsBandSupported($band)) {
        throw "2.4 GHz Windows hotspot unavailable ($capability)."
    }
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $session.Ssid = $request.ssid
    $session.Passphrase = $request.password
    $session.Band = $band
    $operationResult = $tether.StartTetheringAsync($session)
} else {
    if ($tether.TetheringOperationalState -eq 'Off') {
        Write-Output 'AlreadyOff'
        exit
    }
    $operationResult = $tether.StopTetheringAsync()
}

$resultType = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult]
$task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operationResult))
if (!$task.Wait(30000)) { throw 'Windows hotspot operation timed out.' }
$status = [string]$task.Result.Status
if ($status -ne 'Success') { throw "Windows hotspot operation returned $status." }
Write-Output $status
