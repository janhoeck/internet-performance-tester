param([string]$ConfigB64)
# Prototype of the persistent probe agent (PS 5.1, no admin): JSON lines on stdout.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ConfigB64)) | ConvertFrom-Json
$epoch = New-Object DateTime 1970,1,1,0,0,0,([DateTimeKind]::Utc)
function NowMs { [long](([DateTime]::UtcNow - $epoch).TotalMilliseconds) }
$pending = New-Object System.Collections.ArrayList
$next = @{}; foreach ($t in $cfg.targets) { $next[$t.id] = 0 }
$buf = New-Object byte[] 32
$lastNic = 0; $stopAt = (NowMs) + 1000 * $cfg.durationSec
while ((NowMs) -lt $stopAt) {
  $now = NowMs
  foreach ($t in $cfg.targets) {
    if ($now -ge $next[$t.id]) {
      $next[$t.id] = $now - ($now % $t.intervalMs) + $t.intervalMs
      $p = New-Object System.Net.NetworkInformation.Ping
      [void]$pending.Add(@{ id = $t.id; ts = $now; task = $p.SendPingAsync($t.host, $t.timeoutMs, $buf); ping = $p })
    }
  }
  for ($i = $pending.Count - 1; $i -ge 0; $i--) {
    $e = $pending[$i]
    if ($e.task.IsCompleted) {
      if ($e.task.IsFaulted) { $st = 'Error'; $rtt = $null } else { $r = $e.task.Result; $st = [string]$r.Status; $rtt = $(if ($st -eq 'Success') { $r.RoundtripTime } else { $null }) }
      [Console]::Out.WriteLine((@{ k = 'icmp'; id = $e.id; ts = $e.ts; st = $st; rtt = $rtt } | ConvertTo-Json -Compress))
      $e.ping.Dispose(); $pending.RemoveAt($i)
    }
  }
  if ($now - $lastNic -ge 1000) {
    $lastNic = $now - ($now % 1000)
    foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      if ($n.Name -eq $cfg.nicName -or $n.Name -eq $cfg.wlanName) {
        $s = $n.GetIPStatistics()
        [Console]::Out.WriteLine((@{ k = 'nic'; ts = $lastNic; name = $n.Name; up = ([string]$n.OperationalStatus -eq 'Up'); mbps = [long]($n.Speed / 1e6); rx = $s.BytesReceived; tx = $s.BytesSent; inErr = $s.IncomingPacketsWithErrors; inDisc = $s.IncomingPacketsDiscarded; outErr = $s.OutgoingPacketsWithErrors; outDisc = $s.OutgoingPacketsDiscarded } | ConvertTo-Json -Compress))
      }
    }
  }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 20
}
