$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$targets = '192.168.0.1','2a02:8101:3ff:ff89::3','1.1.1.1','2606:4700:4700::1111'
$nic = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object Name -eq 'Ethernet'
$s0 = $nic.GetIPStatistics(); $t0 = [Diagnostics.Stopwatch]::StartNew(); $lastMs = 0
"sec  rxMbps txMbps | max RTT ms per 4 probes: GW / CMTS6 / CF4 / CF6 (L=lost)"
for ($sec = 1; $sec -le 20; $sec++) {
  $mx = @{}; foreach ($t in $targets) { $mx[$t] = 0 }
  for ($k = 0; $k -lt 4; $k++) {
    $tasks = [System.Threading.Tasks.Task[]]@(foreach ($t in $targets) { (New-Object System.Net.NetworkInformation.Ping).SendPingAsync($t, 1500) })
    [void][System.Threading.Tasks.Task]::WaitAll($tasks, 2000)
    for ($i = 0; $i -lt $targets.Count; $i++) {
      $r = $tasks[$i].Result
      if ($r.Status -eq 'Success') { if ($mx[$targets[$i]] -ne 'L' -and $r.RoundtripTime -gt $mx[$targets[$i]]) { $mx[$targets[$i]] = $r.RoundtripTime } } else { $mx[$targets[$i]] = 'L' }
    }
    $wait = 250 - ($t0.ElapsedMilliseconds % 250); Start-Sleep -Milliseconds $wait
  }
  $s1 = $nic.GetIPStatistics(); $ms = $t0.ElapsedMilliseconds; $dt = ($ms - $lastMs) / 1000.0; $lastMs = $ms
  $rx = ($s1.BytesReceived - $s0.BytesReceived) * 8 / 1e6 / $dt; $tx = ($s1.BytesSent - $s0.BytesSent) * 8 / 1e6 / $dt; $s0 = $s1
  "{0,3}  {1,6:N2} {2,6:N2} | {3,4} / {4,4} / {5,4} / {6,4}" -f $sec, $rx, $tx, $mx[$targets[0]], $mx[$targets[1]], $mx[$targets[2]], $mx[$targets[3]]
}
