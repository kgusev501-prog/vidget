# ============================================================================
#  Clipboard file list helper.
#
#  Windows keeps copied files on the clipboard as CF_HDROP, which Electron can
#  neither enumerate nor write: it only reports the format as "text/uri-list"
#  and hands back the first path. Two different selections that begin with the
#  same file look identical from there, so detection lives here as well.
#
#    -Mode watch                  -> one JSON line per change (long lived)
#    -Mode read                   -> {"paths":[...]}
#    -Mode write -ListFile x.json -> {"ok":true,"count":n}
# ============================================================================

param(
    [ValidateSet('watch', 'read', 'write')]
    [string]$Mode = 'read',
    [string]$ListFile
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

function Emit($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 3))
    [Console]::Out.Flush()
}

function Get-Paths {
    $paths = @()
    if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
        foreach ($p in [System.Windows.Forms.Clipboard]::GetFileDropList()) { $paths += [string]$p }
    }
    return $paths
}

try {
    if ($Mode -eq 'watch') {
        # GetClipboardSequenceNumber bumps on every clipboard write and, unlike
        # reading the contents, never opens the clipboard - so polling it costs
        # almost nothing and cannot block another app mid-copy.
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ClipSeq {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
}
"@
        $last = [ClipSeq]::GetClipboardSequenceNumber()
        Emit @{ type = 'ready' }

        while ($true) {
            Start-Sleep -Milliseconds 350
            $seq = [ClipSeq]::GetClipboardSequenceNumber()
            if ($seq -eq $last) { continue }
            $last = $seq

            try {
                $paths = Get-Paths
                if ($paths.Count -gt 0) { Emit @{ type = 'files'; paths = $paths } }
            }
            catch {
                # someone else held the clipboard; the next change will do
            }
        }
    }

    if ($Mode -eq 'read') {
        # ConvertTo-Json unwraps single-element arrays; the caller normalises.
        Emit @{ paths = Get-Paths }
        exit 0
    }

    $raw = Get-Content -Raw -LiteralPath $ListFile
    # ConvertFrom-Json emits the whole array as one object, so wrapping it in
    # @() would nest it; assign straight across and let foreach enumerate.
    $wanted = ConvertFrom-Json -InputObject $raw

    $col = New-Object System.Collections.Specialized.StringCollection
    $missing = 0
    foreach ($p in $wanted) {
        if (Test-Path -LiteralPath $p) { $col.Add([string]$p) | Out-Null }
        else { $missing++ }
    }

    if ($col.Count -eq 0) {
        Emit @{ ok = $false; reason = 'missing'; missing = $missing }
        exit 0
    }

    # Whoever holds the clipboard at this instant makes the first call fail;
    # every Windows app retries here, and so do we.
    $written = $false
    for ($try = 1; $try -le 5 -and -not $written; $try++) {
        try {
            [System.Windows.Forms.Clipboard]::SetFileDropList($col)
            $written = $true
        }
        catch {
            if ($try -eq 5) { throw }
            Start-Sleep -Milliseconds 150
        }
    }
    Emit @{ ok = $true; count = $col.Count; missing = $missing }
}
catch {
    Emit @{ ok = $false; reason = 'error'; message = $_.Exception.Message }
    exit 1
}
