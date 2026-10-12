$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$since = [datetime]'2026-08-20'

$ev = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='e2fexpress'; Id=27,32,33; StartTime=$since} | Sort-Object TimeCreated)
$pt = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Power-Troubleshooter'; Id=1; StartTime=$since} | Sort-Object TimeCreated)
$kp = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; StartTime=$since} | Sort-Object TimeCreated)
$kg = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-General'; Id=12,13; StartTime=$since} | Sort-Object TimeCreated)

"=== Kernel-Power ids ==="
$kp | Group-Object Id | ForEach-Object { $m = ([string]$_.Group[0].Message -replace '\s+',' '); if ($m.Length -gt 110) { $m = $m.Substring(0,110) }; "id=$($_.Name) n=$($_.Count) '$m'" }
"boots(KG12)=$(@($kg | Where-Object Id -eq 12).Count) shutdowns(KG13)=$(@($kg | Where-Object Id -eq 13).Count) resumes(PT1)=$($pt.Count)"

"=== Power-Troubleshooter sample properties ==="
if ($pt.Count) { $x = $pt[-1]; "created=$($x.TimeCreated.ToString('o'))"; for ($i=0; $i -lt [Math]::Min(16,$x.Properties.Count); $i++) { "  p[$i]=$($x.Properties[$i].Value)" } }

# wake moments: PT1 TimeCreated, KP 107 (resume), KP 507 (MS exit), KG 12 (boot)
$wakes = @()
$wakes += $pt | ForEach-Object { [pscustomobject]@{ T=$_.TimeCreated; K='PT1' } }
$wakes += $kp | Where-Object { $_.Id -in 107,507,1 } | ForEach-Object { [pscustomobject]@{ T=$_.TimeCreated; K="KP$($_.Id)" } }
$wakes += $kg | Where-Object Id -eq 12 | ForEach-Object { [pscustomobject]@{ T=$_.TimeCreated; K='BOOT' } }
$sleeps = @($kp | Where-Object { $_.Id -in 42,506,109 } | ForEach-Object { [pscustomobject]@{ T=$_.TimeCreated; K="KP$($_.Id)" } })

$rows = @()
for ($i=0; $i -lt $ev.Count; $i++) {
  if ($ev[$i].Id -ne 27) { continue }
  $d = $ev[$i].TimeCreated
  $up = $null; for ($j=$i+1; $j -lt $ev.Count; $j++) { if ($ev[$j].Id -in 32,33) { $up = $ev[$j]; break }; if ($ev[$j].Id -eq 27) { break } }
  $nw = $wakes | Sort-Object { [math]::Abs(($_.T - $d).TotalSeconds) } | Select-Object -First 1
  $ns = $sleeps | Sort-Object { [math]::Abs(($_.T - $d).TotalSeconds) } | Select-Object -First 1
  $dw = if ($nw) { [math]::Round(($d - $nw.T).TotalSeconds) } else { $null }
  $ds = if ($ns) { [math]::Round(($d - $ns.T).TotalSeconds) } else { $null }
  $cls = if ($dw -ne $null -and $dw -ge -60 -and $dw -le 300) { 'RESUME' } elseif ($ds -ne $null -and $ds -ge -120 -and $ds -le 60) { 'PRESLEEP' } else { 'RUNNING' }
  $rows += [pscustomobject]@{ Down=$d; Dur=$(if($up){[math]::Round(($up.TimeCreated-$d).TotalSeconds,1)}); Speed=$(if($up){ if($up.Id -eq 32){'1G'}else{'100M'} }else{'?'}); Class=$cls; dWake=$dw; WakeK=$nw.K; dSleep=$ds; SleepK=$ns.K }
}
"=== classification ==="
$rows | Group-Object Class | ForEach-Object { "{0}: n={1} relink1G={2} relink100M={3} medDur={4}" -f $_.Name, $_.Count, @($_.Group | Where-Object Speed -eq '1G').Count, @($_.Group | Where-Object Speed -eq '100M').Count, (($_.Group | ForEach-Object Dur | Sort-Object)[[int][math]::Floor(($_.Count-1)/2)]) }
"=== RUNNING drops per day ==="
($rows | Where-Object Class -eq 'RUNNING' | Group-Object { $_.Down.ToString('MM-dd') } | ForEach-Object { "$($_.Name):$($_.Count)" }) -join '  '
"=== all drops (time, class, dWake s, dSleep s, speed, dur) ==="
$rows | ForEach-Object { "{0} {1,-8} dWake={2,8} ({3}) dSleep={4,8} ({5}) {6,-4} {7}s" -f $_.Down.ToString('MM-dd HH:mm:ss'), $_.Class, $_.dWake, $_.WakeK, $_.dSleep, $_.SleepK, $_.Speed, $_.Dur }

"=== powercfg /a ==="
powercfg /a
