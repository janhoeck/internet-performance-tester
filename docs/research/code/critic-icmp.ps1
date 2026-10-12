$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

"=== NetworkProfile 4003 (unidentified network) events ==="
Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-NetworkProfile/Operational'; Id=4003; StartTime=[datetime]'2026-08-20'} -ErrorAction SilentlyContinue | Sort-Object TimeCreated | ForEach-Object {
  $m = ([string]$_.Message -replace '\s+',' '); $g = if ($m -match '\{([0-9a-f-]+)\}') { $Matches[1].Substring(0,8) } else { '?' }
  "{0} if={1}" -f $_.TimeCreated.ToString('MM-dd HH:mm:ss'), $g
}
"=== WLAN 8001 connection mode (latest) ==="
$e = Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-WLAN-AutoConfig/Operational'; Id=8001} -MaxEvents 1 -ErrorAction SilentlyContinue
if ($e) { (([string]$e.Message) -split "`n" | Where-Object { $_ -match 'Verbindungsmodus|Connection mode|PHY|Band|Kanal|Channel' }) -join ' | ' }

"=== .NET Ping (no admin, locale independent) ==="
$p = New-Object System.Net.NetworkInformation.Ping
foreach ($t in '192.168.0.1','1.1.1.1','8.8.8.8','2606:4700:4700::1111','2001:4860:4860::8888') {
  $sw = [Diagnostics.Stopwatch]::StartNew(); $r = $p.Send($t, 2000); $sw.Stop()
  "{0} status={1} rtt={2} sw={3:N2} addr={4} ttl={5}" -f $t, $r.Status, $r.RoundtripTime, $sw.Elapsed.TotalMilliseconds, $r.Address, $(if ($r.Options) { $r.Options.Ttl } else { '-' })
}
"=== TTL/hop-limit probes (MTR building block) ==="
$buf = New-Object byte[] 32
foreach ($dst in '1.1.1.1','2606:4700:4700::1111') {
  foreach ($ttl in 1..4) {
    $opt = New-Object System.Net.NetworkInformation.PingOptions($ttl, $false)
    $sw = [Diagnostics.Stopwatch]::StartNew(); $r = $p.Send($dst, 1500, $buf, $opt); $sw.Stop()
    "{0} hop={1} status={2} addr={3} rtt={4} sw={5:N2}" -f $dst, $ttl, $r.Status, $r.Address, $r.RoundtripTime, $sw.Elapsed.TotalMilliseconds
  }
}
"=== DF probes IPv4 (DS-Lite MTU) ==="
foreach ($size in 1432, 1433, 1472) {
  $opt = New-Object System.Net.NetworkInformation.PingOptions(64, $true)
  $r = $p.Send('1.1.1.1', 2000, (New-Object byte[] $size), $opt)
  "DF v4 payload=$size (packet $($size+28)) status=$($r.Status) rtt=$($r.RoundtripTime)"
}
"=== SendPingAsync parallel ==="
$tasks = [System.Threading.Tasks.Task[]]@(foreach ($t in '1.1.1.1','2606:4700:4700::1111','192.168.0.1') { (New-Object System.Net.NetworkInformation.Ping).SendPingAsync($t, 2000) })
[void][System.Threading.Tasks.Task]::WaitAll($tasks, 5000)
$tasks | ForEach-Object { "async {0} {1} {2}ms" -f $_.Result.Address, $_.Result.Status, $_.Result.RoundtripTime }
