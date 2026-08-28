# ============================================================================
#  SMTC bridge - long-lived sidecar for the Vidget overlay.
#
#  stdout : one compact JSON object per line (state / art / error events)
#  stdin  : one compact JSON command per line, e.g. {"cmd":"next"}
#
#  Runs under Windows PowerShell 5.1, which still carries the WinRT projection.
# ============================================================================

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# --- WinRT async plumbing ---------------------------------------------------
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

$asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq ('IAsyncOperation' + [char]96 + '1')
})[0]

function Await($op, $type) {
    $task = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime] | Out-Null

$TMgr    = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$TProps  = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$TStream = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]

# --- volume (Core Audio) -----------------------------------------------------
# Two levels are available: the master endpoint and the per-application audio
# session. Yandex Music's own slider is independent of the system one, and the
# session volume is that same knob, so that is what we drive when we can find
# the player's process. If the interop fails, volume is reported unavailable.
$AudioOk = $false
try {
    Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int NotUsed1(); int NotUsed2(); int NotUsed3(); int NotUsed4();
  int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
  int NotUsed5();
  int GetMasterVolumeLevelScalar(out float level);
  int NotUsed6(); int NotUsed7(); int NotUsed8(); int NotUsed9();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
  int GetMute(out bool mute);
}

[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume {
  int SetMasterVolume(float level, ref Guid ctx);
  int GetMasterVolume(out float level);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
  int GetMute(out bool mute);
}

// Only GetState and GetProcessId are ever called; the rest hold vtable slots.
[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  int GetState(out int state);
  int Slot2(); int Slot3(); int Slot4(); int Slot5();
  int Slot6(); int Slot7(); int Slot8(); int Slot9();
  int Slot10(); int Slot11();
  int GetProcessId(out uint pid);
  int IsSystemSoundsSession();
  int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
}

[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator {
  int GetCount(out int count);
  int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
}

[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
  int Slot1(); int Slot2();
  int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  int Slot4(); int Slot5(); int Slot6(); int Slot7();
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object o);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int NotUsed1();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

public static class VidgetAudio {
  const int CLSCTX_ALL = 23;

  static IMMDevice Device() {
    IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    return dev;
  }

  static IAudioEndpointVolume Endpoint() {
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(Device().Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }

  static IAudioSessionEnumerator Sessions() {
    Guid iid = typeof(IAudioSessionManager2).GUID;
    object o;
    Marshal.ThrowExceptionForHR(Device().Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o));
    IAudioSessionEnumerator e;
    Marshal.ThrowExceptionForHR(((IAudioSessionManager2)o).GetSessionEnumerator(out e));
    return e;
  }

  public static uint[] Pids() {
    var found = new List<uint>();
    try {
      var e = Sessions();
      int n;
      if (e.GetCount(out n) != 0) return found.ToArray();
      for (int i = 0; i < n; i++) {
        object o;
        if (e.GetSession(i, out o) != 0 || o == null) continue;
        var c = o as IAudioSessionControl2;
        if (c == null) continue;
        uint pid;
        if (c.GetProcessId(out pid) == 0 && pid != 0) found.Add(pid);
      }
    } catch { }
    return found.ToArray();
  }

  static ISimpleAudioVolume Session(uint target) {
    var e = Sessions();
    int n;
    if (e.GetCount(out n) != 0) return null;
    for (int i = 0; i < n; i++) {
      object o;
      if (e.GetSession(i, out o) != 0 || o == null) continue;
      var c = o as IAudioSessionControl2;
      if (c == null) continue;
      uint pid;
      if (c.GetProcessId(out pid) != 0 || pid != target) continue;
      return o as ISimpleAudioVolume;
    }
    return null;
  }

  public static float Get() { float v; Endpoint().GetMasterVolumeLevelScalar(out v); return v; }
  public static void Set(float v) { Guid g = Guid.Empty; Endpoint().SetMasterVolumeLevelScalar(v, ref g); }
  public static bool GetMute() { bool m; Endpoint().GetMute(out m); return m; }
  public static void SetMute(bool m) { Guid g = Guid.Empty; Endpoint().SetMute(m, ref g); }

  // Volume of one process' session, or -1 when it has none.
  public static float GetApp(uint pid) {
    var v = Session(pid);
    if (v == null) return -1f;
    float f;
    return v.GetMasterVolume(out f) == 0 ? f : -1f;
  }
  public static void SetApp(uint pid, float f) {
    var v = Session(pid);
    if (v == null) return;
    Guid g = Guid.Empty;
    v.SetMasterVolume(f, ref g);
  }
  public static bool GetAppMute(uint pid) {
    var v = Session(pid);
    if (v == null) return false;
    bool m;
    return v.GetMute(out m) == 0 && m;
  }
  public static void SetAppMute(uint pid, bool m) {
    var v = Session(pid);
    if (v == null) return;
    Guid g = Guid.Empty;
    v.SetMute(m, ref g);
  }
}
"@
    [VidgetAudio]::Get() | Out-Null
    $AudioOk = $true
}
catch {
    $AudioOk = $false
}

# Words in an SMTC app id that say nothing about which process it is.
$IdNoise = @('desktop', 'application', 'windows', 'microsoft')

# Matches the SMTC app id against the paths of processes that own an audio
# session. "ru.yandex.desktop.music" finds ...\Programs\YandexMusic\....exe.
function Get-AudioPid($appId) {
    if (-not $AudioOk -or [string]::IsNullOrEmpty($appId)) { return 0 }

    $tokens = @()
    foreach ($t in ($appId -split '[^A-Za-z0-9]')) {
        $low = $t.ToLowerInvariant()
        if ($low.Length -ge 4 -and $IdNoise -notcontains $low) { $tokens += $low }
    }
    if ($tokens.Count -eq 0) { return 0 }

    $bestPid = 0
    $bestScore = 0
    foreach ($procId in [VidgetAudio]::Pids()) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        $hay = $proc.ProcessName
        try { if ($proc.Path) { $hay = $proc.Path + ' ' + $hay } } catch { }
        $hay = $hay.ToLowerInvariant()

        $score = 0
        foreach ($t in $tokens) { if ($hay.Contains($t)) { $score++ } }
        if ($score -gt $bestScore) {
            $bestScore = $score
            $bestPid = $procId
        }
    }
    return $bestPid
}

function Emit($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
    [Console]::Out.Flush()
}

# --- stdin pump (own runspace so the poll loop never blocks) -----------------
$inbox = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
$rs = [runspacefactory]::CreateRunspace()
$rs.Open()
$rs.SessionStateProxy.SetVariable('inbox', $inbox)
$pump = [powershell]::Create()
$pump.Runspace = $rs
$pump.AddScript({
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { $inbox.Enqueue('__EOF__'); break }
        if ($line.Trim()) { $inbox.Enqueue($line) }
    }
}) | Out-Null
$pump.BeginInvoke() | Out-Null

# --- session selection ------------------------------------------------------
$mgr = Await ($TMgr::RequestAsync()) $TMgr
Emit @{ type = 'ready' }

# Whatever is actually playing wins - that is what the user hears and expects
# the buttons to affect. Yandex is the fallback when nothing is sounding.
function Get-Session {
    $sessions = @($mgr.GetSessions())
    if ($sessions.Count -eq 0) { return $null }

    $playing = $sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
    if ($playing) { return $playing }

    $ya = $sessions | Where-Object { $_.SourceAppUserModelId -match 'yandex' } | Select-Object -First 1
    if ($ya) { return $ya }

    $cur = $mgr.GetCurrentSession()
    if ($cur) { return $cur }
    return $sessions[0]
}

function Get-Art($session, $key) {
    try {
        $props = Await ($session.TryGetMediaPropertiesAsync()) $TProps
        if (-not $props.Thumbnail) { return $null }
        $stream = Await ($props.Thumbnail.OpenReadAsync()) $TStream
        $size = [uint32]$stream.Size
        if ($size -eq 0 -or $size -gt 8388608) { return $null }
        $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
        Await ($reader.LoadAsync($size)) ([uint32]) | Out-Null
        $bytes = New-Object byte[] $size
        $reader.ReadBytes($bytes)
        $reader.Dispose()
        $stream.Dispose()
        return @{ type = 'art'; key = $key; data = [Convert]::ToBase64String($bytes) }
    }
    catch { return $null }
}

function Invoke-MediaCommand($session, $cmd, $arg) {
    if ($null -eq $session) { return }
    switch ($cmd) {
        'playpause' { Await ($session.TryTogglePlayPauseAsync()) ([bool]) | Out-Null }
        'play'      { Await ($session.TryPlayAsync())            ([bool]) | Out-Null }
        'pause'     { Await ($session.TryPauseAsync())           ([bool]) | Out-Null }
        'next'      { Await ($session.TrySkipNextAsync())        ([bool]) | Out-Null }
        'prev'      { Await ($session.TrySkipPreviousAsync())    ([bool]) | Out-Null }
        'seek'      { Await ($session.TryChangePlaybackPositionAsync([int64]([double]$arg * 10000000))) ([bool]) | Out-Null }
        'shuffle'   { Await ($session.TryChangeShuffleActiveAsync([bool]$arg)) ([bool]) | Out-Null }
        'repeat'    { Await ($session.TryChangeAutoRepeatModeAsync([Windows.Media.MediaPlaybackAutoRepeatMode]$arg)) ([bool]) | Out-Null }
    }
}

# --- main loop --------------------------------------------------------------
$lastSig        = ''
$artSent        = ''
$lastVol        = ''
$currentApp     = ''
$audioPid       = 0
$audioPidFor    = ''
$audioPidAt     = -999
$audioPinSystem = $false
$tick           = 0

while ($true) {
    # 1. drain pending commands
    $line = $null
    while ($inbox.TryDequeue([ref]$line)) {
        if ($line -eq '__EOF__') { exit 0 }
        try {
            $msg = $line | ConvertFrom-Json
            if ($msg.cmd -eq 'quit') { exit 0 }
            if ($msg.cmd -eq 'art')  { $artSent = '' ; continue }
            if ($msg.cmd -eq 'volset') {
                if ($AudioOk) {
                    $level = [float][math]::Max(0.0, [math]::Min(1.0, [double]$msg.arg))
                    if ($audioPid -ne 0) { [VidgetAudio]::SetApp($audioPid, $level) }
                    else { [VidgetAudio]::Set($level) }
                }
                $lastVol = ''
                continue
            }
            if ($msg.cmd -eq 'mute') {
                if ($AudioOk) {
                    if ($audioPid -ne 0) { [VidgetAudio]::SetAppMute($audioPid, [bool]$msg.arg) }
                    else { [VidgetAudio]::SetMute([bool]$msg.arg) }
                }
                $lastVol = ''
                continue
            }
            if ($msg.cmd -eq 'volscope') {
                # 'system' pins the slider to the master endpoint until the
                # player changes; anything else re-resolves the app session.
                $audioPinSystem = ($msg.arg -eq 'system')
                $audioPid = 0
                $audioPidFor = ''
                $lastVol = ''
                continue
            }
            Invoke-MediaCommand (Get-Session) $msg.cmd $msg.arg
        }
        catch {
            Emit @{ type = 'error'; where = 'cmd'; message = $_.Exception.Message }
        }
    }

    # 2. poll state
    try {
        $s = Get-Session
        if ($null -eq $s) {
            if ($lastSig -ne 'none') {
                $lastSig = 'none'
                $artSent = ''
                $currentApp = ''
                Emit @{ type = 'state'; active = $false }
            }
        }
        else {
            $props = Await ($s.TryGetMediaPropertiesAsync()) $TProps
            $info  = $s.GetPlaybackInfo()
            $tl    = $s.GetTimelineProperties()

            $title  = [string]$props.Title
            $artist = [string]$props.Artist
            $key    = ($artist + '|' + $title)

            $pos = 0.0
            $dur = 0.0
            if ($tl) {
                $pos = [math]::Round(($tl.Position - $tl.StartTime).TotalSeconds, 1)
                $dur = [math]::Round(($tl.EndTime - $tl.StartTime).TotalSeconds, 1)
            }
            if ($dur -lt 0) { $dur = 0 }
            if ($pos -lt 0) { $pos = 0 }

            $ctl = $info.Controls
            $state = @{
                type     = 'state'
                active   = $true
                app      = [string]$s.SourceAppUserModelId
                title    = $title
                artist   = $artist
                album    = [string]$props.AlbumTitle
                status   = [string]$info.PlaybackStatus
                position = $pos
                duration = $dur
                key      = $key
                shuffle  = [bool]$info.IsShuffleActive
                repeat   = [string]$info.AutoRepeatMode
                can      = @{
                    shuffle = [bool]$ctl.IsShuffleEnabled
                    repeat  = [bool]$ctl.IsRepeatEnabled
                    next  = [bool]$ctl.IsNextEnabled
                    prev  = [bool]$ctl.IsPreviousEnabled
                    play  = [bool]$ctl.IsPlayEnabled
                    pause = [bool]$ctl.IsPauseEnabled
                    seek  = [bool]$ctl.IsPlaybackPositionEnabled
                }
            }

            Emit $state
            $currentApp = $state.app
            $lastSig = ($key + '|' + $state.status)

            if ($key -ne $artSent -and $key -ne '|') {
                $artSent = $key
                $art = Get-Art $s $key
                if ($art) { Emit $art }
                else { Emit @{ type = 'art'; key = $key; data = $null } }
            }
        }
    }
    catch {
        Emit @{ type = 'error'; where = 'poll'; message = $_.Exception.Message }
        Start-Sleep -Milliseconds 1000
        try { $mgr = Await ($TMgr::RequestAsync()) $TMgr } catch { }
    }

    # 3. volume - the player's own session when we can find it, else the system
    if ($AudioOk) {
        try {
            # Re-resolve when the player changes, or every 20s while unresolved.
            if (-not $audioPinSystem -and
                ($currentApp -ne $audioPidFor -or ($audioPid -eq 0 -and ($tick - $audioPidAt) -ge 40))) {
                $audioPidFor = $currentApp
                $audioPidAt = $tick
                $audioPid = Get-AudioPid $currentApp
            }

            $scope = 'system'
            $name = ''
            $v = -1.0
            if ($audioPid -ne 0) {
                $v = [VidgetAudio]::GetApp($audioPid)
                if ($v -lt 0) {
                    $audioPid = 0   # session went away; master takes over
                }
                else {
                    $scope = 'app'
                    $m = [VidgetAudio]::GetAppMute($audioPid)
                    $proc = Get-Process -Id $audioPid -ErrorAction SilentlyContinue
                    if ($proc) { $name = $proc.ProcessName }
                }
            }
            if ($scope -eq 'system') {
                $v = [VidgetAudio]::Get()
                $m = [VidgetAudio]::GetMute()
            }
            $v = [math]::Round($v, 3)

            $sig = "$scope|$v|$m"
            if ($sig -ne $lastVol) {
                $lastVol = $sig
                Emit @{ type = 'vol'; value = $v; muted = $m; available = $true; scope = $scope; app = $name }
            }
        }
        catch { $AudioOk = $false }
    }
    elseif ($lastVol -ne 'off') {
        $lastVol = 'off'
        Emit @{ type = 'vol'; available = $false }
    }

    $tick++
    Start-Sleep -Milliseconds 500
}
