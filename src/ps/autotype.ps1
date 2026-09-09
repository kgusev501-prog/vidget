# ============================================================================
#  Auto-type sidecar.
#
#  Runs only while a password database is set up, and does two things: it keeps
#  the widget informed of which window the user is working in, and it types
#  into that window when asked.
#
#  Both belong together. Asking "what is in front?" at the moment the user
#  presses the hotkey is already too late - by then the panel itself is in
#  front. So the answer is kept up to date beforehand, and windows belonging to
#  the widget are ignored, which is what -ParentPid is for.
#
#  Nothing secret is ever passed on the command line: an argument list is
#  readable by every process on the machine, for as long as the process runs.
#  The steps arrive as one JSON line on standard input instead.
#
#    stdout : {"type":"window",...} whenever the front window changes
#             {"type":"typed","ok":...} after an auto-type
#    stdin  : {"cmd":"type","expect":"...","steps":[...],"rate":12}
#             {"cmd":"window"}   report the front window again
#             {"cmd":"quit"}
# ============================================================================

param(
    # The widget. Its own windows are not "the window the user was working in",
    # and when it goes away there is nothing left to type for.
    [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class VidgetType {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint n, INPUT[] inputs, int size);

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public KEYBDINPUT ki; public long padding; }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra;
  }

  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 2;
  const uint KEYEVENTF_UNICODE = 4;

  public static string TitleOf(IntPtr h) {
    if (h == IntPtr.Zero) return "";
    var sb = new StringBuilder(1024);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  public static uint PidOf(IntPtr h) {
    uint pid = 0;
    if (h != IntPtr.Zero) GetWindowThreadProcessId(h, out pid);
    return pid;
  }

  static INPUT Make(ushort vk, ushort scan, uint flags) {
    var i = new INPUT();
    i.type = INPUT_KEYBOARD;
    i.ki.vk = vk; i.ki.scan = scan; i.ki.flags = flags; i.ki.time = 0; i.ki.extra = IntPtr.Zero;
    return i;
  }

  static void Send(INPUT[] batch) {
    SendInput((uint)batch.Length, batch, Marshal.SizeOf(typeof(INPUT)));
  }

  // Characters go in as Unicode rather than as key codes: a password full of
  // punctuation must arrive the same whatever keyboard layout is switched on.
  public static void Text(string s, int rate) {
    foreach (char c in s) {
      Send(new INPUT[] {
        Make(0, c, KEYEVENTF_UNICODE),
        Make(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
      });
      if (rate > 0) System.Threading.Thread.Sleep(rate);
    }
  }

  public static void Key(ushort vk, ushort[] mods, int rate) {
    var down = new System.Collections.Generic.List<INPUT>();
    foreach (ushort m in mods) down.Add(Make(m, 0, 0));
    down.Add(Make(vk, 0, 0));
    down.Add(Make(vk, 0, KEYEVENTF_KEYUP));
    for (int i = mods.Length - 1; i >= 0; i--) down.Add(Make(mods[i], 0, KEYEVENTF_KEYUP));
    Send(down.ToArray());
    if (rate > 0) System.Threading.Thread.Sleep(rate + 10);
  }

  // A modified character (Ctrl+V and friends): the character itself still goes
  // in as Unicode, but with the modifier held around it.
  public static void ModifiedChar(char c, ushort[] mods, int rate) {
    var batch = new System.Collections.Generic.List<INPUT>();
    foreach (ushort m in mods) batch.Add(Make(m, 0, 0));
    batch.Add(Make(0, c, KEYEVENTF_UNICODE));
    batch.Add(Make(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    for (int i = mods.Length - 1; i >= 0; i--) batch.Add(Make(mods[i], 0, KEYEVENTF_KEYUP));
    Send(batch.ToArray());
    if (rate > 0) System.Threading.Thread.Sleep(rate + 10);
  }
}
"@

$VK = @{
  TAB = 0x09; ENTER = 0x0D; SPACE = 0x20; BACKSPACE = 0x08; DELETE = 0x2E; INSERT = 0x2D
  HOME = 0x24; END = 0x23; PGUP = 0x21; PGDN = 0x22; UP = 0x26; DOWN = 0x28; LEFT = 0x25
  RIGHT = 0x27; ESC = 0x1B; CAPSLOCK = 0x14; NUMLOCK = 0x90; PRTSC = 0x2C; BREAK = 0x03
  APPS = 0x5D; LWIN = 0x5B; RWIN = 0x5C; ADD = 0x6B; SUBTRACT = 0x6D; MULTIPLY = 0x6A; DIVIDE = 0x6F
  A = 0x41
}
for ($i = 1; $i -le 16; $i++) { $VK["F$i"] = 0x6F + $i }
for ($i = 0; $i -le 9; $i++) { $VK["NUMPAD$i"] = 0x60 + $i }

$MODS = @{ shift = [uint16]0x10; ctrl = [uint16]0x11; alt = [uint16]0x12 }

function Emit($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5))
    [Console]::Out.Flush()
}

function Get-WindowInfo {
    $h = [VidgetType]::GetForegroundWindow()
    $procId = [VidgetType]::PidOf($h)
    $name = ''
    if ($procId -ne 0) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) { $name = $proc.ProcessName }
    }
    return @{ type = 'window'; title = [VidgetType]::TitleOf($h); process = $name; pid = [int]$procId }
}

# True while the widget is still running. Nothing here closes this window on
# its own otherwise: standard input stays open as long as the pipe exists.
function Test-Parent {
    if ($ParentPid -le 0) { return $true }
    return $null -ne (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)
}

# Carries out one plan. Refuses outright if the window in front is not the one
# the entry was chosen for: typing a password into whatever happens to have the
# focus is the one failure this whole feature must never have.
function Invoke-Plan($msg) {
    $expect = [string]$msg.expect
    $rate = 12
    if ($msg.rate) { $rate = [int]$msg.rate }

    $title = ''
    if ($expect) {
        # The widget is stepping out of the way; the window underneath needs a
        # moment to come forward.
        $waited = 0
        while ($waited -lt 4000) {
            $title = [VidgetType]::TitleOf([VidgetType]::GetForegroundWindow())
            if ($title -eq $expect) { break }
            Start-Sleep -Milliseconds 100
            $waited += 100
        }
        if ($title -ne $expect) {
            Emit @{ type = 'typed'; ok = $false; reason = 'wrong-window'; got = $title }
            return
        }
    }

    Start-Sleep -Milliseconds 60  # let the focused field settle

    foreach ($step in $msg.steps) {
        switch ($step.type) {
            'text' {
                [VidgetType]::Text([string]$step.value, $rate)
            }
            'delay' {
                Start-Sleep -Milliseconds ([int]$step.ms)
            }
            'rate' {
                $rate = [int]$step.ms
            }
            'clear' {
                # Select everything in the field and delete it, the way KeePass
                # empties a box that already has something in it.
                [VidgetType]::Key([uint16]$VK['A'], @([uint16]$MODS['ctrl']), $rate)
                [VidgetType]::Key([uint16]$VK['DELETE'], @(), $rate)
            }
            'key' {
                $mods = @()
                if ($step.mods) { foreach ($m in $step.mods) { if ($MODS.ContainsKey([string]$m)) { $mods += $MODS[[string]$m] } } }
                $name = [string]$step.key
                if ($name.StartsWith('CHAR:')) {
                    [VidgetType]::ModifiedChar($name.Substring(5)[0], [uint16[]]$mods, $rate)
                }
                elseif ($VK.ContainsKey($name)) {
                    [VidgetType]::Key([uint16]$VK[$name], [uint16[]]$mods, $rate)
                }
                else {
                    Emit @{ type = 'typed'; ok = $false; reason = 'unknown-key'; key = $name }
                    return
                }
            }
            default {
                Emit @{ type = 'typed'; ok = $false; reason = 'unknown-step' }
                return
            }
        }
    }

    Emit @{ type = 'typed'; ok = $true; window = $title }
}

# --- stdin pump (own runspace, so watching windows never blocks on input) ----
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

# --- main loop ---------------------------------------------------------------
$lastWindow = ''
$beat = 0

while ($true) {
    $line = $null
    while ($inbox.TryDequeue([ref]$line)) {
        if ($line -eq '__EOF__') { exit 0 }
        try {
            $msg = $line | ConvertFrom-Json
            switch ([string]$msg.cmd) {
                'window' { $lastWindow = ''; }
                'type' { Invoke-Plan $msg }
                'quit' { exit 0 }
                default { Emit @{ type = 'error'; message = 'unknown command' } }
            }
        }
        catch {
            Emit @{ type = 'error'; message = $_.Exception.Message }
        }
    }

    # Which window the user is working in. Two calls into user32 and no
    # allocation, so this is cheap enough to ask several times a second - and
    # it has to be, because by the time the panel is open the answer has
    # already changed.
    $info = Get-WindowInfo
    if ($info.pid -ne $ParentPid) {
        $signature = $info.title + '|' + $info.process
        if ($signature -ne $lastWindow) {
            $lastWindow = $signature
            Emit $info
        }
    }

    $beat++
    if (($beat % 12) -eq 0 -and -not (Test-Parent)) { exit 0 }
    Start-Sleep -Milliseconds 400
}
