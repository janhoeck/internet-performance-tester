# Netzdiagnose - ICMP pinger agent (Windows PowerShell 5.1, no admin rights needed).
# Started by engine/probes/pinger.ts as ONE long-running powershell.exe -EncodedCommand.
# Config: environment variable NETDIAG_PINGER_CFG = base64(UTF-8 JSON)
#   {targets:[{id, ip, every?, to?}], intervalMs, timeoutMs, size, nics:[...], preventSleep, ppid?}
#   every = ping on every n-th tick (target interval / intervalMs), to = per-target timeout (ms).
#   (PowerShell 5.1 accepts no arguments after -EncodedCommand, and embedding the config in the
#   script would exceed the 32767-char command line with many targets - hence the variable.)
# Output on stdout (UTF-8, one JSON object per line, flushed once per loop iteration):
#   {"k":"hello","pid":123,"sleep":true,"targets":5}
#   {"k":"icmp","id":"cf4","ts":<scheduled tick ms>,"st":"<IPStatus name>|Error","rtt":<int|null>,"from":"<ip>"|null,"err":"<type:code>"|null}
#   {"k":"nic","ts":<tick>,"name":"Ethernet","up":true,"mbps":1000,"rx":<bytes>,"tx":<bytes>,"inErr":0,"inDisc":0,"wifi":false}
#   {"k":"hb","ts":<tick>}
#   {"k":"warn","msg":"..."}
# Schedule: fixed grid, t0 = ceil(now/interval)*interval, tick k at t0 + k*interval (wall clock).
# All targets of a tick are sent back to back with SendPingAsync; requests may overlap
# (timeout > interval). After a stall/standby the agent skips missed ticks instead of bursting.
# Status names are language neutral (IPStatus enum); the Node side maps them to SampleStatus.
# Style rules (the Node side strips comment lines and indentation before encoding):
# no here-strings, no block comments, no trailing comments.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$cfgB64 = [Environment]::GetEnvironmentVariable('NETDIAG_PINGER_CFG')
if ([string]::IsNullOrEmpty($cfgB64)) {
  [Console]::Error.WriteLine('NETDIAG_PINGER_CFG fehlt')
  exit 2
}
$cfg = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($cfgB64)) | ConvertFrom-Json
$utf8 = New-Object System.Text.UTF8Encoding($false)
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$out.NewLine = "`n"
function JStr([string]$s) { return (ConvertTo-Json -Compress -InputObject $s) }
function Warn([string]$m) { $out.WriteLine('{"k":"warn","msg":' + (JStr $m) + '}') }
function NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
$interval = [long]$cfg.intervalMs
if ($interval -lt 250) { $interval = 1000 }
$defTimeout = [int]$cfg.timeoutMs
if ($defTimeout -lt 100) { $defTimeout = 2000 }
$size = [int]$cfg.size
if ($size -lt 0 -or $size -gt 65500) { $size = 32 }
$payload = New-Object byte[] $size
$opts = New-Object System.Net.NetworkInformation.PingOptions(128, $false)
# Targets: parse IP literals once (incl. IPv6 zone ids like fe80::1%4) - never a DNS lookup per ping.
$targets = New-Object System.Collections.ArrayList
foreach ($t in @($cfg.targets)) {
  if ($null -eq $t) { continue }
  $addr = $null
  if (-not [System.Net.IPAddress]::TryParse([string]$t.ip, [ref]$addr)) {
    $addr = $null
    Warn ('invalid address for target ' + [string]$t.id)
  }
  $every = 1
  if ($null -ne $t.every -and [int]$t.every -gt 1) { $every = [int]$t.every }
  $to = $defTimeout
  if ($null -ne $t.to -and [int]$t.to -ge 100) { $to = [int]$t.to }
  [void]$targets.Add(@{ id = [string]$t.id; addr = $addr; period = [long]$every * $interval; to = $to })
}
# NICs to report every tick; counters keep their last known value while an adapter is missing.
$nics = New-Object System.Collections.ArrayList
foreach ($name in @($cfg.nics)) {
  if ([string]::IsNullOrWhiteSpace([string]$name)) { continue }
  [void]$nics.Add(@{ name = [string]$name; j = (JStr ([string]$name)); rx = 0; tx = 0; ie = 0; dc = 0; wifi = $false })
}
# Keep Windows from idle sleep while the agent runs (cleared automatically when the process exits).
$sleep = $false
if ($cfg.preventSleep -eq $true) {
  try {
    Add-Type -Namespace NetDiag -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
    # ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)
    $sleep = ([NetDiag.Power]::SetThreadExecutionState([uint32]2147483649) -ne 0)
  } catch {
    Warn ('SetThreadExecutionState failed: ' + $_.Exception.Message)
  }
}
$parentPid = 0
if ($null -ne $cfg.ppid) { $parentPid = [int]$cfg.ppid }
$sleepJson = 'false'
if ($sleep) { $sleepJson = 'true' }
$out.WriteLine('{"k":"hello","pid":' + $PID + ',"sleep":' + $sleepJson + ',"targets":' + $targets.Count + '}')
$out.Flush()
$pending = New-Object System.Collections.ArrayList
$next = [long]([Math]::Ceiling((NowMs) / $interval)) * $interval
$lastParentCheck = $next
while ($true) {
  $now = NowMs
  # wall clock jumped backwards (time sync): re-align instead of waiting
  if ($next - $now -gt 2 * $interval) { $next = [long]([Math]::Ceiling($now / $interval)) * $interval }
  if ($now -ge $next) {
    # skip ticks we missed (stall, standby) - never send a burst of stale ticks
    $slot = [long]([Math]::Floor($now / $interval)) * $interval
    if ($slot -gt $next) { $next = $slot }
    $tick = $next
    $next = $tick + $interval
    foreach ($t in $targets) {
      if (($tick % $t.period) -ne 0) { continue }
      $p = $null
      $task = $null
      $err = '"no address"'
      if ($null -ne $t.addr) {
        try {
          $p = New-Object System.Net.NetworkInformation.Ping
          $task = $p.SendPingAsync($t.addr, $t.to, $payload, $opts)
        } catch {
          $b = $_.Exception.GetBaseException()
          $err = JStr ($b.GetType().Name + ':' + $b.HResult)
        }
      }
      [void]$pending.Add(@{ id = $t.id; ts = $tick; task = $task; ping = $p; err = $err })
    }
    if ($nics.Count -gt 0) {
      $map = @{}
      try {
        foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) { $map[$n.Name] = $n }
      } catch {
        $map = @{}
      }
      foreach ($c in $nics) {
        $n = $map[$c.name]
        $up = 'false'
        $mbps = 'null'
        if ($null -ne $n) {
          if ($n.OperationalStatus -eq [System.Net.NetworkInformation.OperationalStatus]::Up) { $up = 'true' }
          $c.wifi = ($n.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Wireless80211)
          if ($up -eq 'true' -and $n.Speed -gt 0) { $mbps = [string][long]($n.Speed / 1000000) }
          try {
            $s = $n.GetIPStatistics()
            $c.rx = $s.BytesReceived
            $c.tx = $s.BytesSent
            $c.ie = $s.IncomingPacketsWithErrors
            $c.dc = $s.IncomingPacketsDiscarded
          } catch {
            $s = $null
          }
        }
        $wifi = 'false'
        if ($c.wifi) { $wifi = 'true' }
        $out.WriteLine('{"k":"nic","ts":' + $tick + ',"name":' + $c.j + ',"up":' + $up + ',"mbps":' + $mbps + ',"rx":' + $c.rx + ',"tx":' + $c.tx + ',"inErr":' + $c.ie + ',"inDisc":' + $c.dc + ',"wifi":' + $wifi + '}')
      }
    }
    $out.WriteLine('{"k":"hb","ts":' + $tick + '}')
    # exit when the engine is gone (children normally die with it - this is a second safety net)
    if ($parentPid -gt 0 -and ($tick - $lastParentCheck) -ge 5000) {
      $lastParentCheck = $tick
      $alive = $true
      try {
        $pp = [System.Diagnostics.Process]::GetProcessById($parentPid)
        $pp.Dispose()
      } catch {
        $alive = $false
      }
      if (-not $alive) { break }
    }
  }
  for ($i = $pending.Count - 1; $i -ge 0; $i--) {
    $e = $pending[$i]
    $task = $e.task
    if ($null -ne $task -and -not $task.IsCompleted) { continue }
    $st = 'Error'
    $rtt = 'null'
    $from = 'null'
    $err = $e.err
    if ($null -ne $task) {
      $err = 'null'
      if ($task.IsFaulted) {
        $b = $task.Exception.GetBaseException()
        $code = $b.HResult
        if ($b -is [System.ComponentModel.Win32Exception]) { $code = $b.NativeErrorCode }
        $err = JStr ($b.GetType().Name + ':' + $code)
      } elseif ($task.IsCanceled) {
        $err = '"canceled"'
      } else {
        $r = $task.Result
        $st = [string]$r.Status
        if ($r.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) { $rtt = [string]$r.RoundtripTime }
        if ($null -ne $r.Address) { $from = '"' + $r.Address.ToString() + '"' }
      }
    }
    $out.WriteLine('{"k":"icmp","id":"' + $e.id + '","ts":' + $e.ts + ',"st":"' + $st + '","rtt":' + $rtt + ',"from":' + $from + ',"err":' + $err + '}')
    if ($null -ne $e.ping) { $e.ping.Dispose() }
    $pending.RemoveAt($i)
  }
  $out.Flush()
  # Block until a reply completes or the next tick is due. Completed tasks are included on
  # purpose (WaitAny returns at once) - no race between the scan above and the wait.
  $wait = [int]($next - (NowMs))
  if ($wait -lt 0) { $wait = 0 }
  if ($wait -gt $interval) { $wait = [int]$interval }
  $count = $pending.Count
  if ($count -gt 0) {
    $arr = New-Object 'System.Threading.Tasks.Task[]' $count
    for ($j = 0; $j -lt $count; $j++) { $arr[$j] = $pending[$j].task }
    [void][System.Threading.Tasks.Task]::WaitAny($arr, $wait)
  } elseif ($wait -gt 0) {
    Start-Sleep -Milliseconds $wait
  }
}
$out.Flush()
