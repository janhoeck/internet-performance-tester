# Long-running fixed-cadence ICMP pinger using .NET System.Net.NetworkInformation.Ping (IcmpSendEcho2, no admin).
# Locale-independent output: one JSON object per line on stdout. Config is injected by the Node side via the
# placeholders below (replace before -EncodedCommand). Every target is pinged every INTERVAL ms on a fixed grid;
# a slow/lost reply never delays the schedule (async SendPingAsync, one Ping object per in-flight request).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$targets    = @(__TARGETS__)          # e.g. '1.1.1.1','192.168.0.1','2606:4700:4700::1111'
$intervalMs = __INTERVAL__            # e.g. 1000
$timeoutMs  = __TIMEOUT__             # e.g. 1000 (keep <= interval * maxInFlight)
$payload    = New-Object byte[] __SIZE__   # 32 = ping.exe default
$opts       = New-Object System.Net.NetworkInformation.PingOptions(128, $false)
$utf8 = New-Object System.Text.UTF8Encoding($false)
$out  = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$out.AutoFlush = $true; $out.NewLine = "`n"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$epoch0 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()   # wall clock at sw=0
$pending = New-Object System.Collections.ArrayList
$seq = 0; $next = 0
$out.WriteLine('{"type":"hello","pid":' + $PID + ',"epoch0":' + $epoch0 + '}')
while ($true) {
  $now = $sw.ElapsedMilliseconds
  if ($now -ge $next) {
    $seq++
    foreach ($t in $targets) {
      $p = New-Object System.Net.NetworkInformation.Ping
      try { $task = $p.SendPingAsync($t, $timeoutMs, $payload, $opts) } catch { $task = $null }
      # wall clock for the record (Stopwatch/QPC may not advance during standby -> never derive timestamps from it)
      [void]$pending.Add(@{ target = $t; seq = $seq; sent = $now; wall = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); task = $task; ping = $p })
    }
    $next += $intervalMs
    if ($next -lt $now) { $next = $now + $intervalMs }   # we fell behind (e.g. system sleep) -> resync, don't burst
  }
  for ($i = $pending.Count - 1; $i -ge 0; $i--) {
    $e = $pending[$i]
    if ($null -eq $e.task -or $e.task.IsCompleted) {
      $doneAt = $sw.ElapsedMilliseconds
      $status = 'Error'; $rtt = 'null'; $ttl = 'null'; $from = 'null'; $err = 'null'
      if ($null -eq $e.task) { $err = '"send failed"' }
      elseif ($e.task.IsFaulted) {
        # language-neutral error: Win32/Socket error code + exception type (message text is localized)
        $b = $e.task.Exception.GetBaseException()
        $code = if ($b -is [System.ComponentModel.Win32Exception]) { $b.NativeErrorCode } else { $b.HResult }
        $err = '{"code":' + $code + ',"type":"' + $b.GetType().Name + '","msg":' + (ConvertTo-Json -Compress -InputObject ([string]$b.Message)) + '}'
      }
      else {
        $r = $e.task.Result
        $status = $r.Status.ToString()
        if ($r.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) { $rtt = [string]$r.RoundtripTime }
        if ($null -ne $r.Options) { $ttl = [string]$r.Options.Ttl }
        if ($null -ne $r.Address) { $from = '"' + $r.Address.ToString() + '"' }
      }
      $out.WriteLine('{"type":"echo","target":"' + $e.target + '","seq":' + $e.seq + ',"tSend":' + $e.wall +
        ',"status":"' + $status + '","rtt":' + $rtt + ',"ttl":' + $ttl + ',"from":' + $from + ',"elapsed":' + ($doneAt - $e.sent) + ',"err":' + $err + '}')
      $e.ping.Dispose()
      $pending.RemoveAt($i)
    }
  }
  # Block efficiently until a reply completes or the next tick is due (instead of a busy 10 ms poll loop).
  $wait = [int]($next - $sw.ElapsedMilliseconds); if ($wait -lt 0) { $wait = 0 }
  # Include already-completed tasks on purpose: WaitAny then returns immediately (no race between the scan above and the wait).
  $tasks = New-Object 'System.Collections.Generic.List[System.Threading.Tasks.Task]'
  foreach ($x in $pending) { if ($null -ne $x.task) { $tasks.Add($x.task) } }   # plain loop: much cheaper than a pipeline
  if ($tasks.Count -gt 0) { [void][System.Threading.Tasks.Task]::WaitAny($tasks.ToArray(), $wait) }
  elseif ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
}
