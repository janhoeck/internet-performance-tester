# TTL probe runner for path discovery and MTR (E-path: engine/tasks/traceroute.ts, mtr.ts).
# Runs as a SEPARATE short-lived powershell.exe (-EncodedCommand) so the shared RPC worker is never
# blocked. Node substitutes the plan placeholder below with base64(UTF-8 JSON):
#   { dst, ttls:[ascending ints], rounds, timeoutMs, maxConc, intervalMs, stopAtDest, trimSilent, size }
# Probes: .NET Ping.SendPingAsync(dst, timeout, payload, PingOptions(ttl, dontFragment=false)), at most
# maxConc in flight. Each round probes every TTL once and waits for all replies (rounds never overlap,
# so all hops of one round can be correlated); rounds start intervalMs apart.
# Timing: Stopwatch per probe - RoundtripTime is 0 for TtlExpired replies in .NET Framework.
# Output, one JSON object per line on stdout (UTF-8, invariant culture):
#   {"k":"hello","pid":N}
#   {"k":"r","round":R,"ttl":T,"st":"<IPStatus>","from":"<ip>"|null,"ms":<elapsed>,"rtt":<api ms>|null,"err":null|"<type>"}
#   {"k":"done","ms":<total>}
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$out.AutoFlush = $true
$out.NewLine = "`n"
$inv = [System.Globalization.CultureInfo]::InvariantCulture

try {
  $cfg = ConvertFrom-Json ([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('__PLAN_B64__')))
} catch {
  $out.WriteLine('{"k":"fatal","err":"bad plan"}')
  exit 2
}
$dst = [string]$cfg.dst
$ttls = @($cfg.ttls | ForEach-Object { [int]$_ })
$rounds = [int]$cfg.rounds
$timeoutMs = [int]$cfg.timeoutMs
$maxConc = [math]::Max(1, [int]$cfg.maxConc)
$intervalMs = [int]$cfg.intervalMs
$stopAtDest = [bool]$cfg.stopAtDest
$trimSilent = [int]$cfg.trimSilent
$payload = New-Object byte[] ([int]$cfg.size)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$inflight = New-Object System.Collections.ArrayList
$script:limit = [int]::MaxValue     # smallest TTL with a terminal answer (destination reply / unreachable)
$script:cap = [int]::MaxValue       # TTL cap for later rounds when nothing answers beyond a hop
$script:lastResp = 0                # highest TTL that got any answer

$out.WriteLine('{"k":"hello","pid":' + $PID + '}')

function Format-Ms([double]$v) { return $v.ToString('0.##', $inv) }

function Complete-Done {
  # pass 1: stamp every finished probe first, so formatting output never delays later timestamps
  foreach ($e in $inflight) {
    if ($null -eq $e.t1 -and $e.task.IsCompleted) { $e.t1 = $sw.Elapsed.TotalMilliseconds }
  }
  for ($i = $inflight.Count - 1; $i -ge 0; $i--) {
    $e = $inflight[$i]
    if ($null -eq $e.t1) { continue }
    $ms = $e.t1 - $e.t0
    if ($e.quiet) { $e.ping.Dispose(); $inflight.RemoveAt($i); continue }
    $st = 'Error'; $from = 'null'; $rtt = 'null'; $err = 'null'
    if ($e.task.IsFaulted -or $e.task.IsCanceled) {
      if ($null -ne $e.task.Exception) { $err = '"' + $e.task.Exception.GetBaseException().GetType().Name + '"' } else { $err = '"Canceled"' }
    } else {
      $r = $e.task.Result
      $st = $r.Status.ToString()
      if ($null -ne $r.Address) { $from = '"' + $r.Address.ToString() + '"' }
      if ($r.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) { $rtt = [string]$r.RoundtripTime }
      $answered = ($null -ne $r.Address) -and ($st -eq 'Success' -or $st -eq 'TtlExpired' -or $st -eq 'TimeExceeded' -or $st -like 'Destination*Unreachable')
      if ($answered) {
        if ($e.ttl -gt $script:lastResp) { $script:lastResp = $e.ttl }
        if (($st -eq 'Success' -or $st -like 'Destination*Unreachable') -and $e.ttl -lt $script:limit) { $script:limit = $e.ttl }
      }
    }
    $out.WriteLine('{"k":"r","round":' + $e.round + ',"ttl":' + $e.ttl + ',"st":"' + $st + '","from":' + $from + ',"ms":' + (Format-Ms $ms) + ',"rtt":' + $rtt + ',"err":' + $err + '}')
    $e.ping.Dispose()
    $inflight.RemoveAt($i)
  }
}

function Wait-Some([int]$waitMs) {
  if ($inflight.Count -eq 0) { return }
  $tasks = New-Object 'System.Threading.Tasks.Task[]' $inflight.Count
  for ($j = 0; $j -lt $inflight.Count; $j++) { $tasks[$j] = $inflight[$j].task }
  try { [void][System.Threading.Tasks.Task]::WaitAny($tasks, $waitMs) } catch { }
  Complete-Done
}

# Warm-up: one loopback echo through the same code paths (JIT of Ping, Task, Complete-Done), not
# reported - otherwise the first round's RTTs are inflated by tens of milliseconds.
try {
  $loop = '127.0.0.1'
  if ($dst.Contains(':')) { $loop = '::1' }
  $wp = [System.Net.NetworkInformation.Ping]::new()
  $wt = $wp.SendPingAsync($loop, 1000, $payload, [System.Net.NetworkInformation.PingOptions]::new(64, $false))
  [void]$inflight.Add(@{ round = 0; ttl = 0; t0 = $sw.Elapsed.TotalMilliseconds; t1 = $null; task = $wt; ping = $wp; quiet = $true })
  while ($inflight.Count -gt 0) { Wait-Some 200 }
} catch { $inflight.Clear() }

for ($round = 1; $round -le $rounds; $round++) {
  $roundStart = $sw.Elapsed.TotalMilliseconds
  foreach ($ttl in $ttls) {
    if ($stopAtDest -and ($ttl -gt $script:limit -or $ttl -gt $script:cap)) { break }
    while ($inflight.Count -ge $maxConc) { Wait-Some 50 }
    if ($stopAtDest -and ($ttl -gt $script:limit -or $ttl -gt $script:cap)) { break }
    $p = [System.Net.NetworkInformation.Ping]::new()
    $o = [System.Net.NetworkInformation.PingOptions]::new($ttl, $false)
    $t0 = $sw.Elapsed.TotalMilliseconds
    try {
      $task = $p.SendPingAsync($dst, $timeoutMs, $payload, $o)
      [void]$inflight.Add(@{ round = $round; ttl = $ttl; t0 = $t0; t1 = $null; task = $task; ping = $p; quiet = $false })
    } catch {
      $name = $_.Exception.GetBaseException().GetType().Name
      $out.WriteLine('{"k":"r","round":' + $round + ',"ttl":' + $ttl + ',"st":"Error","from":null,"ms":0,"rtt":null,"err":"' + $name + '"}')
      $p.Dispose()
    }
    # pick up replies that arrived while this probe was prepared (keeps their timing honest)
    Complete-Done
  }
  while ($inflight.Count -gt 0) { Wait-Some 100 }
  if ($stopAtDest -and $trimSilent -gt 0 -and $script:limit -eq [int]::MaxValue) {
    $script:cap = $script:lastResp + $trimSilent
  }
  if ($round -lt $rounds) {
    $wait = [int]($intervalMs - ($sw.Elapsed.TotalMilliseconds - $roundStart))
    if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
  }
}
$out.WriteLine('{"k":"done","ms":' + (Format-Ms $sw.Elapsed.TotalMilliseconds) + '}')
