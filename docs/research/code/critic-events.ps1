$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$since = (Get-Date).AddDays(-60)

"=== e2fexpress (System) ==="
$ev = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='e2fexpress'; StartTime=$since} | Sort-Object TimeCreated)
"total=$($ev.Count) first=$($ev[0].TimeCreated.ToString('s')) last=$($ev[-1].TimeCreated.ToString('s'))"
$ev | Group-Object Id | ForEach-Object { "id=$($_.Name) n=$($_.Count) sample='$(($_.Group[0].Message -replace '\s+',' '))'" }

$pairs = @()
for ($i=0; $i -lt $ev.Count; $i++) {
  if ($ev[$i].Id -eq 27) {
    $up = $null
    for ($j=$i+1; $j -lt $ev.Count; $j++) { if ($ev[$j].Id -in 32,33) { $up = $ev[$j]; break }; if ($ev[$j].Id -eq 27) { break } }
    $pairs += [pscustomobject]@{
      Down  = $ev[$i].TimeCreated
      Up    = $(if ($up) { $up.TimeCreated } else { $null })
      Dur   = $(if ($up) { [math]::Round(($up.TimeCreated - $ev[$i].TimeCreated).TotalSeconds,1) } else { $null })
      Speed = $(if ($up) { if ($up.Id -eq 32) { '1G' } else { '100M' } } else { '?' })
    }
  }
}
"--- per day: down / relink1G / relink100M / medianDur / maxDur ---"
$pairs | Group-Object { $_.Down.ToString('yyyy-MM-dd') } | ForEach-Object {
  $g = $_.Group; $d = @($g | Where-Object { $_.Dur -ne $null } | ForEach-Object { $_.Dur } | Sort-Object)
  $med = if ($d.Count) { $d[[int][math]::Floor(($d.Count-1)/2)] } else { '' }
  "{0} down={1} 1G={2} 100M={3} medDur={4} maxDur={5}" -f $_.Name, $g.Count, @($g | Where-Object Speed -eq '1G').Count, @($g | Where-Object Speed -eq '100M').Count, $med, ($d | Measure-Object -Maximum).Maximum
}
"--- duration histogram ---"
$pairs | Where-Object { $_.Dur -ne $null } | Group-Object { if ($_.Dur -lt 5) {'a <5s'} elseif ($_.Dur -lt 10) {'b 5-10s'} elseif ($_.Dur -lt 30) {'c 10-30s'} elseif ($_.Dur -lt 120) {'d 30-120s'} else {'e >=120s'} } | Sort-Object Name | ForEach-Object { "$($_.Name): $($_.Count)" }
"--- hour of day (downs) ---"
($pairs | Group-Object { $_.Down.Hour } | Sort-Object { [int]$_.Name } | ForEach-Object { "{0}h:{1}" -f $_.Name, $_.Count }) -join '  '
"--- weekday ---"
($pairs | Group-Object { $_.Down.DayOfWeek } | ForEach-Object { "$($_.Name):$($_.Count)" }) -join '  '
"--- relink speed sequence (chronological) ---"
($pairs | ForEach-Object { if ($_.Speed -eq '1G') { 'G' } elseif ($_.Speed -eq '100M') { 'h' } else { '?' } }) -join ''
"--- gaps between consecutive drops (min), last 25 ---"
$gaps = for ($k=1; $k -lt $pairs.Count; $k++) { [math]::Round(($pairs[$k].Down - $pairs[$k-1].Down).TotalMinutes,1) }
($gaps | Select-Object -Last 25) -join ' '
"--- last 15 drops ---"
$pairs | Select-Object -Last 15 | ForEach-Object { "{0} -> {1} ({2}s, {3})" -f $_.Down.ToString('yyyy-MM-dd HH:mm:ss.fff'), $(if ($_.Up) { $_.Up.ToString('HH:mm:ss.fff') }), $_.Dur, $_.Speed }

"=== other network-related System events (60 d) ==="
$sys = @(Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=$since} | Where-Object { $_.ProviderName -match 'Tcpip|NDIS|Dhcp|WLAN|Netwtw|NetAdapter|Kernel-PnP|UserPnp|Wcm|NCSI|DNS|Power-Troubleshooter' })
$sys | Group-Object ProviderName, Id | Sort-Object Count -Descending | Select-Object -First 40 | ForEach-Object {
  $m = [string]$_.Group[0].Message; $m = ($m -replace '\s+',' '); if ($m.Length -gt 150) { $m = $m.Substring(0,150) }
  "{0} n={1} last={2} msg='{3}'" -f $_.Name, $_.Count, ($_.Group | Sort-Object TimeCreated | Select-Object -Last 1).TimeCreated.ToString('MM-dd HH:mm'), $m
}

"=== WLAN-AutoConfig/Operational ==="
$Error.Clear()
$w = @(Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-WLAN-AutoConfig/Operational'; StartTime=$since})
if ($w.Count) { ($w | Group-Object Id | ForEach-Object { "id=$($_.Name):$($_.Count)" }) -join '  '; "first=$(($w | Sort-Object TimeCreated | Select-Object -First 1).TimeCreated.ToString('s')) last=$(($w | Sort-Object TimeCreated | Select-Object -Last 1).TimeCreated.ToString('s'))" } else { "none/no access: $($Error[0].Exception.Message)" }

"=== NetworkProfile/Operational ==="
$Error.Clear()
$np = @(Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-NetworkProfile/Operational'; StartTime=$since})
if ($np.Count) { ($np | Group-Object Id | ForEach-Object { "id=$($_.Name):$($_.Count)" }) -join '  ' } else { "none/no access: $($Error[0].Exception.Message)" }

"=== alignment: drops in last 14 d vs WLAN / NetworkProfile / Tcpip events (-10s..+120s) ==="
foreach ($p in ($pairs | Where-Object { $_.Down -gt (Get-Date).AddDays(-14) })) {
  $a = $p.Down.AddSeconds(-10); $b = $p.Down.AddSeconds(120)
  $nw = @($w | Where-Object { $_.TimeCreated -ge $a -and $_.TimeCreated -le $b })
  $nn = @($np | Where-Object { $_.TimeCreated -ge $a -and $_.TimeCreated -le $b })
  $ns = @($sys | Where-Object { $_.TimeCreated -ge $a -and $_.TimeCreated -le $b })
  "{0} dur={1}s {2} | wlan={3} [{4}] | netprof={5} [{6}] | sys=[{7}]" -f $p.Down.ToString('MM-dd HH:mm:ss'), $p.Dur, $p.Speed, $nw.Count, (($nw | ForEach-Object Id) -join ','), $nn.Count, (($nn | ForEach-Object Id) -join ','), (($ns | ForEach-Object { "$($_.ProviderName -replace 'Microsoft-Windows-',''):$($_.Id)" }) -join ',')
}

"=== NetworkProfile messages near the 2026-10-08 evening cluster ==="
$np | Where-Object { $_.TimeCreated -ge [datetime]'2026-10-08 18:25' -and $_.TimeCreated -le [datetime]'2026-10-08 18:50' } | Sort-Object TimeCreated | Select-Object -First 12 | ForEach-Object {
  $m = ([string]$_.Message -replace '\s+',' '); if ($m.Length -gt 160) { $m = $m.Substring(0,160) }
  "{0} id={1} {2}" -f $_.TimeCreated.ToString('HH:mm:ss'), $_.Id, $m
}

"=== Windows Update installs (35 d) ==="
Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-WindowsUpdateClient'; Id=19; StartTime=(Get-Date).AddDays(-35)} | Sort-Object TimeCreated | ForEach-Object { "{0} {1}" -f $_.TimeCreated.ToString('yyyy-MM-dd HH:mm'), $_.Properties[0].Value }
