param(
    [Parameter(Mandatory)]
    [ValidateSet('Start', 'Send', 'Draft', 'Cancel')]
    [string] $Operation,
    [long] $Window,
    [string] $Recording
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AirRemoteWindow {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

$labels = @{
    Start = @('听写', '聽寫', 'Dictate')
    Send = @('转录并发送', '轉錄並傳送', '轉錄並發送', 'Transcribe and send')
    Draft = @('停止听写', '停止聽寫', 'Stop dictation')
    Cancel = @('取消听写', '取消聽寫', 'Cancel dictation')
}
$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1
if (!$package) { throw 'The installed Codex desktop package was not found.' }
$desktopExe = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
$desktopIds = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $desktopExe } | ForEach-Object Id)
if (!$desktopIds.Count) { throw 'Open Codex and select the target chat.' }

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

function Get-WindowRoot([long] $handle) {
    if (!$handle) { throw 'Bring the Codex chat window to the foreground.' }
    $root = [Windows.Automation.AutomationElement]::FromHandle([IntPtr] $handle)
    if (!$root -or $root.Current.ProcessId -notin $desktopIds) {
        throw 'The target window is not the installed Codex desktop app.'
    }
    $root
}

$foreground = [AirRemoteWindow]::GetForegroundWindow().ToInt64()
if ($Operation -eq 'Start') {
    $Window = $foreground
    $root = Get-WindowRoot $Window
    if ((Find-Button $root $labels.Cancel) -or (Find-Button $root $labels.Draft)) {
        throw 'A dictation session is already open.'
    }
    $button = Find-Button $root $labels.Start
    if (!$button) { throw 'A unique Dictate button is not available in the foreground Codex composer.' }
    Invoke-Button $button

    $limit = [Diagnostics.Stopwatch]::StartNew()
    do {
        $cancel = Find-Button $root $labels.Cancel
        if ($cancel -and (Find-Button $root $labels.Draft)) {
            $Recording = $cancel.GetRuntimeId() -join '.'
            if ($Recording) {
                @{ window = $Window; recording = $Recording } | ConvertTo-Json -Compress
                exit
            }
        }
        Start-Sleep -Milliseconds 100
    } while ($limit.ElapsedMilliseconds -lt 2200)
    throw 'The desktop did not expose an identifiable recording session.'
}

$root = Get-WindowRoot $Window
$cancel = Find-Button $root $labels.Cancel
if (!$cancel -or ($cancel.GetRuntimeId() -join '.') -ne $Recording) {
    throw 'The original dictation session is no longer active.'
}
$button = Find-Button $root $labels[$Operation]
if (!$button) { throw 'The requested dictation button is not available.' }
if ($Operation -eq 'Send' -and [AirRemoteWindow]::GetForegroundWindow().ToInt64() -ne $Window) {
    throw 'Codex is no longer the foreground window; sending was stopped.'
}
Invoke-Button $button
@{ ok = $true } | ConvertTo-Json -Compress
