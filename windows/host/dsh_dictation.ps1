param(
    [Parameter(Mandatory)]
    [ValidateSet('Start', 'Stop', 'Cancel')]
    [string] $Operation,
    [long] $Window,
    [string] $Recording
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

# DeepSeek Harness's experimental voice input adds a microphone trigger to the
# composer and a recording toolbar with Cancel / Stop buttons. The labels come
# from @deepseek-ai/dsh-experimental-client-ui-voice-input (zh / en dictionaries).
$labels = @{
    Start  = @('开始录音', 'Start recording')
    Stop   = @('停止并识别', 'Stop and transcribe', 'Stop recording')
    Cancel = @('取消', 'Cancel')
    Setup  = @('打开语音输入引导', 'Open voice input setup', 'Set up voice input')
}

function Write-Result([hashtable] $Value) {
    $Value | ConvertTo-Json -Compress
    exit 0
}

function Find-DshWindow {
    $process = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
        Select-Object -First 1
    if (!$process) { return $null }
    [Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
}

function Find-Button($root, [string[]] $names) {
    $conditions = foreach ($name in $names) {
        [Windows.Automation.PropertyCondition]::new(
            [Windows.Automation.AutomationElement]::NameProperty, $name)
    }
    $byName = [Windows.Automation.OrCondition]::new([Windows.Automation.Condition[]] $conditions)
    $button = [Windows.Automation.PropertyCondition]::new(
        [Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
    $filter = [Windows.Automation.AndCondition]::new($byName, $button)
    $found = @($root.FindAll([Windows.Automation.TreeScope]::Descendants, $filter) |
        Where-Object { $_.Current.IsEnabled -and !$_.Current.IsOffscreen })
    if ($found.Count -eq 1) { $found[0] }
}

function Invoke-Button($button) {
    $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
}

$root = Find-DshWindow
if (!$root) { Write-Result @{ ok = $false; reason = 'window_not_found' } }

# Chromium enables its accessibility tree on demand when a UIA client starts
# querying, so the first query after a DSH launch can come back empty. Retry a
# few times so a freshly started DSH still becomes automatable.
$start = $stop = $cancel = $setup = $null
for ($attempt = 0; $attempt -lt 4; $attempt++) {
    $start = Find-Button $root $labels.Start
    $stop = Find-Button $root $labels.Stop
    $cancel = Find-Button $root $labels.Cancel
    $setup = Find-Button $root $labels.Setup
    if ($start -or $stop -or $cancel -or $setup) { break }
    Start-Sleep -Milliseconds 250
}

# When none of the voice controls appear the caller falls back to letting the
# user drive DSH's microphone by hand.
if (!$start -and !$stop -and !$cancel -and !$setup) {
    Write-Result @{ ok = $false; reason = 'automation_unavailable' }
}

if ($Operation -eq 'Start') {
    if ($setup -and !$start) { Write-Result @{ ok = $false; reason = 'setup_required' } }
    if ($stop -or $cancel) { Write-Result @{ ok = $false; reason = 'already_recording' } }
    $button = Find-Button $root $labels.Start
    if (!$button) { Write-Result @{ ok = $false; reason = 'start_button_missing' } }
    Invoke-Button $button

    $limit = [Diagnostics.Stopwatch]::StartNew()
    do {
        $cancel = Find-Button $root $labels.Cancel
        $stop = Find-Button $root $labels.Stop
        if ($cancel -and $stop) {
            $id = $cancel.GetRuntimeId() -join '.'
            if ($id) {
                Write-Result @{
                    ok = $true; manual = $false; window = $root.Current.NativeWindowHandle; recording = $id
                }
            }
        }
        Start-Sleep -Milliseconds 100
    } while ($limit.ElapsedMilliseconds -lt 2500)
    Write-Result @{ ok = $false; reason = 'recording_not_started' }
}

# Stop / Cancel: require the recording toolbar that Start produced.
$cancel = Find-Button $root $labels.Cancel
$stop = Find-Button $root $labels.Stop
if (!$cancel -or !$stop) { Write-Result @{ ok = $false; reason = 'not_recording' } }
if ($Recording) {
    $id = $cancel.GetRuntimeId() -join '.'
    if ($id -ne $Recording) { Write-Result @{ ok = $false; reason = 'stale_session' } }
}
$button = if ($Operation -eq 'Cancel') { Find-Button $root $labels.Cancel } else { Find-Button $root $labels.Stop }
if (!$button) { Write-Result @{ ok = $false; reason = 'button_missing' } }
Invoke-Button $button
Write-Result @{ ok = $true }
