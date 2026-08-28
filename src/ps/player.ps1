# ============================================================================
#  Yandex Music launcher - one-shot helper.
#
#  Windows only reports a media session while the player is running, so after a
#  reboot there is nothing for the widget to talk to until the app is open.
#  This finds the installed player and starts it if it is not already up.
#
#    -Mode status         -> {"path":"...","running":true}
#    -Mode launch         -> {"ok":true,"started":true,"path":"..."}
#    -Mode play -Url ...  -> hands a yandexmusic:// link to the player and puts
#                            its window back the way it was found
# ============================================================================

param(
    [ValidateSet('status', 'launch', 'play')]
    [string]$Mode = 'status',
    [string]$Url,
    [switch]$Minimized
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 3))
}

# The registered protocol handler is the most reliable pointer; the uninstall
# entry and the default install folder are fallbacks.
function Find-Player {
    foreach ($root in 'HKCU:\SOFTWARE\Classes\yandexmusic', 'HKLM:\SOFTWARE\Classes\yandexmusic') {
        $cmdKey = Join-Path $root 'shell\open\command'
        if (Test-Path $cmdKey) {
            $cmd = (Get-ItemProperty -Path $cmdKey -ErrorAction SilentlyContinue).'(default)'
            if ($cmd -match '^"([^"]+\.exe)"') {
                if (Test-Path -LiteralPath $Matches[1]) { return $Matches[1] }
            }
        }
    }

    foreach ($hive in 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
                      'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall') {
        if (-not (Test-Path $hive)) { continue }
        $hit = Get-ChildItem $hive -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
            Where-Object { $_.DisplayIcon -and $_.DisplayIcon -match 'YandexMusic' } |
            Select-Object -First 1
        if ($hit) {
            $exe = ($hit.DisplayIcon -split ',')[0].Trim('"')
            if (Test-Path -LiteralPath $exe) { return $exe }
        }
    }

    $guess = Join-Path $env:LOCALAPPDATA 'Programs\YandexMusic'
    if (Test-Path -LiteralPath $guess) {
        $exe = Get-ChildItem -LiteralPath $guess -Filter '*.exe' -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notmatch 'Uninstall|elevate' } |
            Select-Object -First 1
        if ($exe) { return $exe.FullName }
    }

    return $null
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public const int MINIMIZE = 6;
}
"@

# The main window of the player, or zero when it has none on screen.
function Get-PlayerWindow($exe) {
    foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
        try {
            if ($p.Path -eq $exe -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
                return $p.MainWindowHandle
            }
        }
        catch { }
    }
    return [IntPtr]::Zero
}

function Test-Running($exe) {
    if (-not $exe) { return $false }
    foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
        try {
            if ($p.Path -and $p.Path -eq $exe) { return $true }
        }
        catch {
            # protected process; not ours anyway
        }
    }
    return $false
}

try {
    $exe = Find-Player
    $running = Test-Running $exe

    if ($Mode -eq 'play') {
        if ([string]::IsNullOrEmpty($Url)) {
            Emit @{ ok = $false; reason = 'no-url' }
            exit 0
        }

        # Opening the link makes the player surface its window. Note how it sat
        # before, and put it back that way afterwards so the desktop does not
        # jump around just because a track was picked in the widget.
        $before = Get-PlayerWindow $exe
        $wasHidden = ($before -eq [IntPtr]::Zero) -or [Win]::IsIconic($before)

        Start-Process $Url
        Start-Sleep -Milliseconds 1400

        if ($wasHidden) {
            $after = Get-PlayerWindow $exe
            if ($after -ne [IntPtr]::Zero) { [Win]::ShowWindow($after, [Win]::MINIMIZE) | Out-Null }
        }

        Emit @{ ok = $true; restored = $wasHidden }
        exit 0
    }

    if ($Mode -eq 'status') {
        Emit @{ path = $exe; running = $running }
        exit 0
    }

    if (-not $exe) {
        Emit @{ ok = $false; reason = 'not-found' }
        exit 0
    }
    if ($running) {
        Emit @{ ok = $true; started = $false; path = $exe }
        exit 0
    }

    $style = if ($Minimized) { 'Minimized' } else { 'Normal' }
    Start-Process -FilePath $exe -WindowStyle $style
    Emit @{ ok = $true; started = $true; path = $exe }
}
catch {
    Emit @{ ok = $false; reason = 'error'; message = $_.Exception.Message }
    exit 1
}
