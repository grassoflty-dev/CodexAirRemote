param([Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{12}$')][string]$Address)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType=WindowsRuntime]
$null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType=WindowsRuntime]
$null = [Windows.Devices.Enumeration.DeviceInformationCollection, Windows.Devices.Enumeration, ContentType=WindowsRuntime]
$null = [Windows.Devices.Enumeration.DevicePairingResult, Windows.Devices.Enumeration, ContentType=WindowsRuntime]
$null = [Windows.Devices.Enumeration.DeviceInformationKind, Windows.Devices.Enumeration, ContentType=WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Length -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1'
} | Select-Object -First 1

$selector = [Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromBluetoothAddress(
    [Convert]::ToUInt64($Address,16)
)
$scan = [Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync(
    $selector, [string[]]@(), [Windows.Devices.Enumeration.DeviceInformationKind]::AssociationEndpoint
)
$task = $asTask.MakeGenericMethod([Windows.Devices.Enumeration.DeviceInformationCollection]).Invoke($null, @($scan))
if (!$task.Wait(20000)) { Write-Output 'ScanTimeout'; exit }
$found = @($task.Result | Where-Object { $_ -and $_.Id })
if ($found.Count -ne 1) { Write-Output 'DeviceNotFound'; exit }
if ($found[0].Pairing.IsPaired) { Write-Output 'AlreadyPaired'; exit }
$pair = $found[0].Pairing.PairAsync()
$task = $asTask.MakeGenericMethod([Windows.Devices.Enumeration.DevicePairingResult]).Invoke($null, @($pair))
if (!$task.Wait(25000)) { Write-Output 'PairingTimeout'; exit }
Write-Output ([string]$task.Result.Status)
