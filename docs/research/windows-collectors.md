# Windows collectors: empirical research for the probe engine

Machine: Windows 11 Pro 10.0.26200, de-DE, Windows PowerShell 5.1.26100.9444, Node v22.16.0. Measured on 2026-10-09.
All scripts are in `scratchpad/research/windows/` (full path: `C:/Users/<user>/AppData/Local/Temp/claude/C--Development-Projects-internet-performance-tester/d8ef4cd1-5a1f-424b-96d0-127363bb3ab2/scratchpad/research/windows/`).
All raw captures are in `fixtures/` (122 files). No settings were changed, nothing needed admin, and the router only got the TCP connects and DNS queries listed in section 10.

Legend: **[measured]** = observed on this machine. **[resource]** = exact string taken from the Windows MUI/message tables on this machine. **[uncertain]** = inferred or untested; treat with care.

---

## 0. Decisions in brief

| Topic | Decision |
|---|---|
| Spawning | `child_process.spawn(fullPath, args, { windowsHide: true })`. Never `shell: true`, never `detached: true`. Use absolute paths built from `process.env.SystemRoot`. Children die with the engine because libuv puts them in a job object **[measured]**. |
| ICMP (primary) | One long-lived **PowerShell `.NET Ping` pinger** (`ps_pinger.ps1`). It pings all targets on a fixed 1 s grid, sends async so a timeout never shifts the schedule, and emits JSON lines with language-neutral `IPStatus` names. Cost: about 1.1 % of one core and 87 MB **[measured]**. |
| ICMP (fallback) | One `ping -t -w 1000 <ip>` per target, parsed line by line. Lines stream unbuffered. Output is **CP850**, and the classifier matches ASCII fragments only. During timeouts the cadence drops to one sample per 2 s, so loss must be weighted by time. |
| System queries | One long-lived **PowerShell RPC worker** (`ps_worker.ps1` plus `ps_worker_client.mjs`): JSON lines over stdin/stdout, a `@@RPC@@` prefix, and raw UTF-8 streams. Startup 210–220 ms; a warm call takes 0.5–35 ms. A one-shot `powershell -Command` costs 150–650 ms per call. |
| Timestamps | Use wall clock only: `Date.now()` in Node and `[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()` in PowerShell. Do not derive timestamps from Stopwatch or `performance.now()`, which may stop during standby. Convert every PowerShell DateTime explicitly to epoch ms. |
| Locale | Never parse localized text where a structured source exists: IPStatus names, event IDs plus EventData names, CIM property names, `warp-cli -j`. Where text must be parsed (ping.exe, tracert, netsh), use the de and en strings from the MUI tables in this document. |
| Encodings | ping.exe and tracert.exe write the **OEM codepage (850)** to pipes, whatever the console CP is (tested with `chcp 65001`). netsh writes **UTF-8**. warp-cli writes ASCII. The PowerShell worker writes UTF-8 because we write through a UTF-8 StreamWriter. Rule: valid UTF-8 → utf8, otherwise CP850 (`autoDecode`). |
| Events | Poll incrementally with one RecordId cursor per log, using an XPath `EventRecordID > N` filter: 22–31 ms per poll. Always pass `-ErrorAction SilentlyContinue`, because "no events" is an error in PowerShell 5.1. |
| WLAN | Run `netsh wlan show interfaces` (59 ms) and parse it with the tolerant de/en parser (`lib_netsh_wlan.mjs`). Also read WLAN-AutoConfig events 8000/8001/8002/8003/8011/11000/11001. |
| WARP | `warp-cli -j status` returns `{"status":"Connected","reason":"NetworkHealthy"}`; `warp-cli -j settings list` gives the mode and the split-tunnel lists. |
| Node-native | TCP connect RTT (`net.connect`), raw DNS over UDP (dgram), and SSDP with the socket **bound to 192.168.0.192** (required). |
| MTU | The IPv4 path MTU is **1460** (DS-Lite): the largest DF payload that passes is 1432. The router replies with ICMP "fragmentation needed". IPv6 path MTU is 1500; payload 1452 passes unfragmented, and host-fragmented sizes up to 8000 also pass. |

---

## 1. Process and encoding facts

### 1.1 Codepages [measured]
* Registry `HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage`: **ACP=1252, OEMCP=850**. The system-wide UTF-8 beta option is off.
* The Bash tool's console reports `chcp` = 850. The Claude PowerShell tool reports `[Console]::OutputEncoding` = 65001. The user's terminal is **unknown**, so do not depend on it.
* `ping.exe` piped output is CP850 in every variant tested (`t1c_codepage.mjs`): windowsHide true or false, and even `cmd /c "chcp 65001 & ping ..."`. ping uses CP_OEMCP for redirected output. Example bytes: `ü` = `0x81` (header "ausgeführt für", "Zeitüberschreitung"). This is not valid UTF-8. Decoded as latin1, `0x81` becomes a C1 control character.
* `tracert.exe` behaves the same (CP850). `netsh wlan show interfaces` and `show drivers` write **UTF-8** (`c3 a4` = ä). `netsh interface ipv4 show subinterfaces` is pure ASCII. `warp-cli` is ASCII.
* Node's `TextDecoder` (WHATWG) has **no ibm850**. Ship the 128-entry table in `lib_cp850.mjs`:

```js
// lib_cp850.mjs (excerpt)
const HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´\u00AD±‗¾¶§÷¸°¨·¹³²■\u00A0';
const T = [...HIGH];
export const decodeCp850 = buf => { let s = ''; for (const b of buf) s += b < 0x80 ? String.fromCharCode(b) : T[b - 0x80]; return s; };
const strict = new TextDecoder('utf-8', { fatal: true });
export function autoDecode(buf) {
  if (!buf.some(b => b >= 0x80)) return { enc: 'ascii', text: buf.toString('latin1') };
  try { return { enc: 'utf8', text: strict.decode(buf) }; } catch { return { enc: 'cp850', text: decodeCp850(buf) }; }
}
```
Decode **per complete line**: accumulate a Buffer and split on `0x0A` before decoding, so a multi-byte sequence is never split.

### 1.2 Spawning rules [measured]
* `spawn('ping', [...], { windowsHide: true })` with no shell works. windowsHide:false gave identical bytes. [uncertain: without windowsHide, a parent that has no console may flash a console window]
* **Children die with the engine.** If the parent Node process is hard-killed (`taskkill /F`), its non-detached `ping -t` and `powershell` children are gone 1.5 s later. A `detached: true` child survived and became an orphan (`t9_orphans.mjs`, `fixtures/process_lifecycle_and_cpu.json`). So **never use `detached`** for probe children.
* `child.kill()` calls TerminateProcess. The exit event is `code=null, signal='SIGTERM'`. **ping prints no statistics** when killed this way: no bytes arrive after the kill. Compute all statistics yourself.
* Recommended absolute paths:
  * `${SystemRoot}\System32\PING.EXE`
  * `${SystemRoot}\System32\TRACERT.EXE`
  * `${SystemRoot}\System32\netsh.exe`
  * `${SystemRoot}\System32\WindowsPowerShell\v1.0\powershell.exe`
  * `C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe` (optional; ENOENT means "WARP not installed").

### 1.3 Spawn overhead [measured] (`t2_spawn_overhead.mjs`, `fixtures/spawn_overhead.json`)
| Command | Average wall time |
|---|---|
| `ping -n 1 -w 1000 1.1.1.1` (10 runs) | **42.1 ms** wall, of which RTT 16–40 ms. **Overhead about 16.8 ms**; first stdout byte at 13–18 ms. |
| `powershell -NoLogo -NoProfile -NonInteractive -Command "1+1"` (3 runs) | **148 ms** |
| `powershell ... -Command "Get-NetAdapter ... ConvertTo-Json"` (3 runs) | **643 ms** (NetAdapter module autoload) |
| Same with `-EncodedCommand` | **653 ms**, and it writes `#< CLIXML <Obj S="progress">` to **stderr**. Set `$ProgressPreference='SilentlyContinue'`. |
| Long-lived worker, ready after spawn | **210–223 ms** (once) |
| Worker RPC `1+1` | first 55 ms, then **0.5 ms** |
| Worker `Get-NetAdapter` (selected properties) | first **495–608 ms** (module load), then **15–33 ms** |

---

## 2. ICMP collector A (recommended): PowerShell .NET Ping pinger

**Why.** It is locale-free (IPStatus enum names). It keeps a fixed cadence even through timeouts, sends to every target in the same tick (one `seq`, so ticks can be compared directly), uses a single process for all targets, needs no admin rights, and supports DF, TTL and payload size.

**File:** `ps_pinger.ps1`. Node replaces the placeholders `__TARGETS__`, `__INTERVAL__`, `__TIMEOUT__` and `__SIZE__`, then starts it with `-EncodedCommand` (base64 of UTF-16LE). Use **IP literals only**: a hostname that does not resolve produces `status:"Error"` with a PingException.

```powershell
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$targets = @(__TARGETS__); $intervalMs = __INTERVAL__; $timeoutMs = __TIMEOUT__
$payload = New-Object byte[] __SIZE__
$opts = New-Object System.Net.NetworkInformation.PingOptions(128, $false)
$utf8 = New-Object System.Text.UTF8Encoding($false)
$out  = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8); $out.AutoFlush = $true; $out.NewLine = "`n"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$pending = New-Object System.Collections.ArrayList; $seq = 0; $next = 0
$out.WriteLine('{"type":"hello","pid":' + $PID + '}')
while ($true) {
  $now = $sw.ElapsedMilliseconds
  if ($now -ge $next) {
    $seq++
    foreach ($t in $targets) {
      $p = New-Object System.Net.NetworkInformation.Ping
      try { $task = $p.SendPingAsync($t, $timeoutMs, $payload, $opts) } catch { $task = $null }
      [void]$pending.Add(@{ target=$t; seq=$seq; sent=$now; wall=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); task=$task; ping=$p })
    }
    $next += $intervalMs; if ($next -lt $now) { $next = $now + $intervalMs }   # resync after standby, no burst
  }
  for ($i = $pending.Count - 1; $i -ge 0; $i--) {
    $e = $pending[$i]
    if ($null -eq $e.task -or $e.task.IsCompleted) {
      $doneAt = $sw.ElapsedMilliseconds; $status='Error'; $rtt='null'; $ttl='null'; $from='null'; $err='null'
      if ($null -eq $e.task) { $err = '"send failed"' }
      elseif ($e.task.IsFaulted) { $b = $e.task.Exception.GetBaseException()
        $code = if ($b -is [System.ComponentModel.Win32Exception]) { $b.NativeErrorCode } else { $b.HResult }
        $err = '{"code":' + $code + ',"type":"' + $b.GetType().Name + '","msg":' + (ConvertTo-Json -Compress -InputObject ([string]$b.Message)) + '}' }
      else { $r = $e.task.Result; $status = $r.Status.ToString()
        if ($r.Status -eq [System.Net.NetworkInformation.IPStatus]::Success) { $rtt = [string]$r.RoundtripTime }
        if ($null -ne $r.Options) { $ttl = [string]$r.Options.Ttl }
        if ($null -ne $r.Address) { $from = '"' + $r.Address.ToString() + '"' } }
      $out.WriteLine('{"type":"echo","target":"' + $e.target + '","seq":' + $e.seq + ',"tSend":' + $e.wall + ',"status":"' + $status +
        '","rtt":' + $rtt + ',"ttl":' + $ttl + ',"from":' + $from + ',"elapsed":' + ($doneAt - $e.sent) + ',"err":' + $err + '}')
      $e.ping.Dispose(); $pending.RemoveAt($i)
    }
  }
  $wait = [int]($next - $sw.ElapsedMilliseconds); if ($wait -lt 0) { $wait = 0 }
  $tasks = New-Object 'System.Collections.Generic.List[System.Threading.Tasks.Task]'
  foreach ($x in $pending) { if ($null -ne $x.task) { $tasks.Add($x.task) } }   # completed tasks included on purpose (no race)
  if ($tasks.Count -gt 0) { [void][System.Threading.Tasks.Task]::WaitAny($tasks.ToArray(), $wait) } elseif ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
}
```

**Output line** (fixtures: `dotnet_pinger_stream.json`, `dotnet_pinger_waitany.json`, `dotnet_pinger_error_cases.jsonl`):
```json
{"type":"echo","target":"1.1.1.1","seq":3,"tSend":1791550930689,"status":"Success","rtt":17,"ttl":57,"from":"1.1.1.1","elapsed":18,"err":null}
{"type":"echo","target":"192.0.2.1","seq":3,"tSend":1791550930689,"status":"TimedOut","rtt":null,"ttl":null,"from":"0.0.0.0","elapsed":1786,"err":null}
{"type":"echo","target":"nonexistent.invalid","seq":2,"tSend":...,"status":"Error","rtt":null,"ttl":null,"from":null,"elapsed":1,"err":{"code":-2146233079,"type":"PingException","msg":"Während einer Pinganforderung ist eine Ausnahme aufgetreten."}}
```

**Measured behaviour:**
* Startup to the hello line: 220 ms.
* Send grid: deltas are 991–1023 ms, i.e. ±10–20 ms of jitter, and all targets share a tick.
* CPU: about **1.1 % of one core** for 5 targets at 1 Hz with the WaitAny loop. Working set about **87 MB**. Two earlier variants were worse: a naive 10 ms polling loop cost 4 %, and a WaitAny variant that filtered out completed tasks raced and delayed emission by up to 1 s. Both are fixed in the code above.
* `rtt` is the ICMP API's integer milliseconds, the same resolution as ping.exe. LAN RTTs show as 0 or 1.
* IPv6 replies have `ttl:null` because Options is null for IPv6.
* Statuses seen:
  * `Success`, `TimedOut`
  * `DestinationHostUnreachable` (ARP failure on 192.168.0.2, alternating with TimedOut; one came back after 234 ms)
  * `PacketTooBig` (DF)
  * `TtlExpired` (TTL-limited probes)
* **Timeouts fire early.** With `timeoutMs=1000`, TimedOut arrived after **713–737 ms**. With `timeoutMs=2000`, it arrived after **1645–1790 ms**. Recommendation: **interval 1000, timeout 2000** (async requests may overlap), and record RTT > 1000 ms as "late".
* Interesting evidence in the captured data: RTT spikes appear **at the same tick on all internet targets** while the router stays at 0–1 ms. Examples: seq 6 gave 162/157/159 ms for 1.1.1.1, 2606:4700:4700::1111 and 8.8.8.8; seq 10 gave 112/109/112 ms; 192.168.0.1 stayed at 0–1 ms. So the delay is added **beyond the LAN**. The engine should store `seq` and compute per-tick LAN-versus-WAN deltas.

**Unified status mapping** (same enum for both ping sources):
| Stored status | .NET IPStatus | ping.exe classifier kind |
|---|---|---|
| `ok` | `Success` | `reply` |
| `timeout` | `TimedOut` | `timeout` |
| `host_unreachable` | `DestinationHostUnreachable`, `DestinationUnreachable` | `host_unreachable` |
| `net_unreachable` | `DestinationNetworkUnreachable` | `net_unreachable` |
| `packet_too_big` | `PacketTooBig` | `frag_needed` |
| `ttl_expired` | `TtlExpired`, `TimeExceeded` | `ttl_expired` |
| `local_failure` | `HardwareError`, `NoResources`, `BadRoute`, `Unknown` | `transmit_failed`, `general_failure`, `hardware_error`, `no_resources` |
| `error` | exception (`status:"Error"`) | `unknown` |

Every status except `ok` counts as **lost**. When `from` is our own IP (192.168.0.192), the failure is a local ARP failure.

---

## 3. ICMP collector B (fallback): `ping -t` streaming [measured]

Script: `t1_ping_stream.mjs`. Fixtures: `ping_t_*.{raw.bin,cp850.txt,timeline.json}`, captured from both the Bash and PowerShell contexts.

* **Not block-buffered.** Every echo result arrives as its own stdout chunk of 48 bytes for IPv4, right when it completes. The first chunk (56 B) holds the blank line and the header. Lines end in `\r\n`.
* **Success cadence.** Sends are about 1000–1010 ms apart (send time = arrival − RTT), *not* 1000 ms + RTT. Measured line-arrival deltas were 977–1045 ms; they vary by the RTT difference between consecutive echoes.
* **Timeout cadence.** After a timeout, ping sleeps about 1 s and then sends the next echo, which waits the full `-w`. The period is therefore `w + 1000` ms (`t1b_timeout_pacing.mjs`):

  | `-w` | First timeout after start | Then every |
  |---|---|---|
  | 500 | 84 ms | 1502 ms |
  | 1000 | **545–952 ms** (early) | **2000 ms** |
  | 2000 | 1578 ms | 3000 ms |
  | 3000 | 2582 ms | 4000 ms |

  So during an outage `ping -t -w 1000` delivers **one sample every 2 s**. Loss must be weighted by time (or counted against expected sends); a plain count of failed lines underweights outages.
* **ARP failure (192.168.0.2):** the lines alternate between `Zeitüberschreitung der Anforderung.` and `Antwort von 192.168.0.192: Zielhost nicht erreichbar.` at t = 557, 2557, 4556(U), 5549, 7561(U), 8557, 10545(U), 11556, 13560(U), 14553 ms. Windows counts the "U" lines as **received** in its statistics and returns exit code 0, so never trust ping's own numbers or its exit code.
* **IPv6 reply** has no TTL and a trailing space: `Antwort von 2606:4700:4700::1111: Zeit=15ms `.
* **Exit code** (`-n` mode) is 0 whenever any `Antwort von` line occurs, including unreachable or frag-needed replies from the router. Ignore it.

### 3.1 Complete ping.exe message table, de-DE / en-US [resource] (`fixtures/res_ping.*.json`)
```
"\r\nPing wird ausgeführt für %1 [%2] %0" / "Pinging %1 [%2] %0"      "mit %1!d! Bytes Daten:" / "with %1!d! bytes of data:"
"Antwort von %1: %0" / "Reply from %1: %0"
"Bytes=%1!d! %0" / "bytes=%1!d! %0"     "Zeit=%1!d!ms %0" / "time=%1!d!ms %0"     "Zeit<1ms %0" / "time<1ms %0"     "TTL=%1!d!" / "TTL=%1!d!"
"Zeitüberschreitung der Anforderung." / "Request timed out."
"Zielhost nicht erreichbar." / "Destination host unreachable."       "Zielnetz nicht erreichbar." / "Destination net unreachable."
"Zielport nicht erreichbar." / "Destination port unreachable."       "Zielprotokoll nicht erreichbar." / "Destination protocol unreachable."
"Paket müsste fragmentiert werden, DF-Flag ist jedoch gesetzt." / "Packet needs to be fragmented but DF set."
"Die Gültigkeitsdauer wurde bei der Übertragung überschritten." / "TTL expired in transit."
"PING: Fehler bei der Übertragung. %1" / "PING: transmit failed. %1"   (%1 = system message, typically "Allgemeiner Fehler." = link down/no route [uncertain: not reproducible without unplugging])
"Allgemeiner Fehler." / "General failure."    "Hardwarefehler." / "Hardware error."    "Keine Ressourcen." / "No resources."
"Ping-Anforderung konnte Host "%1" nicht finden. ..." / "Ping request could not find host %1. ..."
"Ping-Statistik für %1!s!:" / "Ping statistics for %1!s!:"
"    Pakete: Gesendet = %2!d!, Empfangen = %3!d!, Verloren = %4!d!" / "    Packets: Sent = ..., Received = ..., Lost = ..."
"    (%5!u!%% Verlust)," / " (%5!u!%% loss),"
"Ca. Zeitangaben in Millisek.:" / "Approximate round trip times in milli-seconds:"
"    Minimum = %1!d!ms, Maximum = %2!d!ms, Mittelwert = %3!d!ms" / "... Average = %3!d!ms"
```

### 3.2 Classifier (`lib_pingparse.mjs`), ASCII-only, tested on all 18 ping fixtures (0 unknown lines)
```js
export function classifyPingLine(line) {
  const s = line.trim(); if (!s) return { kind: 'blank' }; let m;
  if ((m = /(?:Zeit|time)([=<])(\d+)\s?ms/i.exec(s))) {
    const ttl = /TTL=(\d+)/i.exec(s), bytes = /bytes=(\d+)/i.exec(s);
    const from = /^(?:Antwort von|Reply from)\s+(.+?):\s/i.exec(s);          // IPv6 contains ':' -> address ends at ': '
    return { kind: 'reply', rttMs: m[1] === '<' ? 0 : +m[2], subMs: m[1] === '<', ttl: ttl ? +ttl[1] : null, bytes: bytes ? +bytes[1] : null, from: from?.[1] ?? null };
  }
  const from = /^(?:Antwort von|Reply from)\s+(.+?):\s/i.exec(s)?.[1] ?? null;
  if (/Zielhost nicht erreichbar|Destination host unreachable/i.test(s)) return { kind: 'host_unreachable', from };
  if (/Zielnetz nicht erreichbar|Destination net unreachable/i.test(s)) return { kind: 'net_unreachable', from };
  if (/Zielport nicht erreichbar|Destination port unreachable/i.test(s)) return { kind: 'port_unreachable', from };
  if (/Zielprotokoll nicht erreichbar|Destination protocol unreachable/i.test(s)) return { kind: 'proto_unreachable', from };
  if (/berschreitung der Anforderung|Request timed out/i.test(s)) return { kind: 'timeout' };        // no umlaut in pattern
  if (/fragmentiert werden|needs to be fragmented/i.test(s)) return { kind: 'frag_needed', from };
  if (/^PING: Fehler bei der|^PING: transmit failed/i.test(s)) return { kind: 'transmit_failed', detail: s.replace(/^PING:\s*(?:Fehler bei der \S+|transmit failed)\.?\s*/i, '') };
  if (/Allgemeiner Fehler|General failure/i.test(s)) return { kind: 'general_failure' };
  if (/Hardwarefehler|Hardware error/i.test(s)) return { kind: 'hardware_error' };
  if (/bei der .{1,2}bertragung .{1,2}berschritten|TTL expired in transit/i.test(s)) return { kind: 'ttl_expired', from };
  if (/Keine Ressourcen|No resources/i.test(s)) return { kind: 'no_resources' };
  if (/^Ping wird ausgef|^Pinging /i.test(s)) return { kind: 'header' };
  if (/^Ping-Statistik|^Ping statistics/i.test(s)) return { kind: 'stats_header' };
  if ((m = /(?:Gesendet|Sent) = (\d+), (?:Empfangen|Received) = (\d+), (?:Verloren|Lost) = (\d+)/i.exec(s))) return { kind: 'stats_packets', sent: +m[1], received: +m[2], lost: +m[3] };
  if ((m = /Minimum = (\d+)ms, Maximum = (\d+)ms, (?:Mittelwert|Average) = (\d+)ms/i.exec(s))) return { kind: 'stats_rtt', min: +m[1], max: +m[2], avg: +m[3] };
  if (/^\(\d+% (Verlust|loss)\)|^Ca\. Zeitangaben|^Approximate round trip/i.test(s)) return { kind: 'stats_other' };
  if (/konnte Host .* nicht finden|could not find host/i.test(s)) return { kind: 'resolve_failed' };
  return { kind: 'unknown', text: s };
}
```
Notes:
* `Zeit<1ms` means RTT < 1 ms. It is stored as 0 with `subMs=true`.
* "Zeitüberschreitung" contains "Zeit", but the reply regex requires `Zeit[=<]digit`, so the two are never confused.

---

## 4. Traceroute

### 4.1 tracert format [measured + resource] (`fixtures/tracert_v4_1.1.1.1.*`, `tracert_v6_cloudflare.*`)
```

Routenverfolgung zu 1.1.1.1 über maximal 30 Hops

  1     2 ms    <1 ms     1 ms  192.168.0.1 
  2     *        *        *     Zeitüberschreitung der Anforderung.
  3    18 ms    15 ms     *     92.79.214.92 
  4    15 ms     *       18 ms  145.254.2.199 
  5    18 ms     *        *     198.41.240.18 
  6    54 ms    40 ms    36 ms  198.41.240.9 
  7    42 ms    40 ms    40 ms  1.1.1.1 

Ablaufverfolgung beendet.
```
IPv6 run:
* hop 1: `3fff:8071:7ca0:c980:de73:6ff:fe12:34df` (router GUA)
* hop 2: `2a02:8101:3ff:ff89::3`
* hop 3: `2a02:908:0:4d4::1`
* hop 4: `*`
* hop 5: `2400:cb00:48:2::c629:f012`
* hop 6: `2400:cb00:48:3::`
* hop 7: `2606:4700:4700::1111`

**Format strings** [resource], identical in de and en apart from the words:
* Hop number: `"%1!3lu!  "`, i.e. 3 characters right-aligned plus 2 spaces.
* RTT column: `"%1!4lu! ms  "` or `"  <1 ms  "` or `"   *     "`. Each column is 9 characters wide.
* After the columns comes the address followed by a space, or the timeout text.
* Hop error: `"%1 meldet: %0"` / `"%1 reports: %0"` (e.g. `... meldet: Zielnetz nicht erreichbar.`).
* Header with `-d` and an IP target: `"Routenverfolgung zu %1 über maximal %2!u! Hops"` / `"Tracing route to %1 over a maximum of %2!u! hops"`.
* End: `"Ablaufverfolgung beendet."` / `"Trace complete."`.
* Local failure: `"Übertragungsfehler: Fehlercode %1!lu!."` / `"Transmit error: code %1!lu!."`.

Line regex: `^\s*(\d+)\s+(\*|<?\d+ ms)\s+(\*|<?\d+ ms)\s+(\*|<?\d+ ms)\s+(.*?)\s*$`. The last group is either an IP or a localized timeout or error text; test it with `net.isIP()`.

Timing:
* tracert streams **partial lines**: each column is printed as its probe finishes (see `timeline.json`), so buffer until `\n`.
* Wall time: about 1 s per hop plus about 1 s per `*`. The run above took 9.9 s for v4 and 7.9 s for v6. The first `*` of a hop again fired early (666 ms).
* An intermediate `*` with a clean final hop means ICMP rate limiting, not loss. IPv4 hop 2 (the AFTR/CGN of DS-Lite) **never answers**, so don't flag it.

### 4.2 Structured alternative: .NET Ping with TTL (via the RPC worker) [measured] (`fixtures/dotnet_ping_df_trace.json`)
```powershell
$dst='1.1.1.1'; for ($ttl=1; $ttl -le 30; $ttl++) {
  $p = New-Object System.Net.NetworkInformation.Ping; $o = New-Object System.Net.NetworkInformation.PingOptions($ttl, $true)
  $sw = [Diagnostics.Stopwatch]::StartNew(); $r = $p.Send($dst, 1000, (New-Object byte[] 32), $o)
  [pscustomobject]@{ ttl=$ttl; status=$r.Status.ToString(); from=$(if ($r.Address) { $r.Address.ToString() } else { $null }); rttApi=$r.RoundtripTime; elapsedMs=[math]::Round($sw.Elapsed.TotalMilliseconds,2) }
  $p.Dispose(); if ($r.Status -eq 'Success') { break } }
```
Result:
* ttl 1: TtlExpired from 192.168.0.1, 3.3 ms
* ttl 2: TimedOut, 538 ms
* ttl 3: TtlExpired from 92.79.214.92, 14.9 ms
* ttl 4: TimedOut
* ttl 5: TimedOut
* ttl 6: TtlExpired from 198.41.240.9
* ttl 7: Success, rtt 23

Gotchas:
* **`RoundtripTime` is 0 for every non-Success status** in .NET Framework, so use the Stopwatch `elapsed` (about 1–2 ms of overhead) as the hop RTT.
* Always write an explicit `else { $null }`. `$(if(...){...})` without an else gives AutomationNull, which ConvertTo-Json renders as `{}`.

---

## 5. MTU / DF probes [measured] (`t4_mtu.mjs`, `fixtures/mtu_probe_*`, `ping_DF_*`, `ping_v6_*`)

* `ping -f -l 1472 -n 1 8.8.8.8` with no cached PMTU (first time) prints `Antwort von 192.168.0.1: Paket müsste fragmentiert werden, DF-Flag ist jedoch gesetzt.` and exits with **code 0**. The router sends ICMP 3/4.
* After that, Windows caches the PMTU, and further oversized probes fail locally **without** the `Antwort von` prefix: `Paket müsste fragmentiert werden, DF-Flag ist jedoch gesetzt.` (exit code 1). This was already the case for 1.1.1.1 on the very first probe.
* Binary search (DF, IPv4):
  * 1336 ok
  * 1404 ok
  * 1438 frag
  * 1421 ok
  * 1429 ok
  * 1433 frag
  * 1431 ok
  * **1432 ok → maximum payload 1432, path MTU 1460** (1500 − 40-byte IPv6 header for DS-Lite).
* .NET: `PingOptions(128,$true)` with a 1432-byte payload returns `Success`; 1433 or 1472 returns **`PacketTooBig`**. This is the locale-free way to probe.
* The learned PMTU is visible without sending anything: `netsh interface ipv4 show destinationcache` shows `1460 1.1.1.1 192.168.0.1` under "Schnittstelle 4: Ethernet". The headers are German, but the data rows are `^\s*(\d+)\s+(\S+)\s+(\S+)`. Fixture: `netsh_ipv4_destinationcache.txt`.
* IPv6 (`ping -6 -l N`, no DF option in IPv6): 1452 replies, which is the unfragmented maximum for MTU 1500. **1453, 1480, 2000, 4000 and 8000 also reply** because Windows fragments at the source and the fragments pass. The IPv6 path MTU is 1500 (native).
* Interface MTUs (`netsh interface ipv4 show subinterfaces`, ASCII): Ethernet 1500, WLAN 1500, CloudflareWARP 1280.

---

## 6. PowerShell RPC worker [measured] (`ps_worker.ps1`, `ps_worker_client.mjs`, `t2b_ps_worker_test.mjs`)

**Protocol:**
* Request, one line on stdin: `{"id":N,"cmd":"<ps script>","depth":5,"array":false}`.
* Response, one line on stdout: `@@RPC@@{"id":N,"ok":true,"data":<json>}` or `@@RPC@@{"id":N,"ok":false,"error":"<localized msg>","errorType":"<.NET type>","errorId":"<FullyQualifiedErrorId>"}`.
* `id 0` is the ready message: `{"ready":true,"pid":..,"ps":"5.1..."}`.
* Ignore lines without the prefix: `Write-Host` output appears there **and** as CLIXML on stderr.

```powershell
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $WarningPreference = 'SilentlyContinue'
$utf8   = New-Object System.Text.UTF8Encoding($false)
$stdin  = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8); $stdout.AutoFlush = $true; $stdout.NewLine = "`n"
function Send-Rpc([string]$json) { $stdout.WriteLine('@@RPC@@' + $json) }
Send-Rpc ('{"id":0,"ok":true,"data":{"ready":true,"pid":' + $PID + ',"ps":"' + $PSVersionTable.PSVersion.ToString() + '"}}')
while ($true) {
  $line = $stdin.ReadLine(); if ($null -eq $line) { break }; if ($line.Trim().Length -eq 0) { continue }
  $id = 0
  try {
    $req = ConvertFrom-Json -InputObject $line; $id = [int64]$req.id
    $depth = 5; if ($req.depth) { $depth = [int]$req.depth }
    $res = @(& ([ScriptBlock]::Create([string]$req.cmd)))
    if ($res.Count -eq 0) { $json = 'null' }
    elseif ($res.Count -eq 1 -and -not $req.array) { $json = ConvertTo-Json -InputObject $res[0] -Depth $depth -Compress }
    else { $json = ConvertTo-Json -InputObject $res -Depth $depth -Compress }
    if ([string]::IsNullOrEmpty($json)) { $json = 'null' }
    Send-Rpc ('{"id":' + $id + ',"ok":true,"data":' + $json + '}')
  } catch {
    $e = $_
    Send-Rpc ('{"id":' + $id + ',"ok":false,"error":' + (ConvertTo-Json -InputObject ([string]$e.Exception.Message) -Compress) +
      ',"errorType":' + (ConvertTo-Json -InputObject ([string]$e.Exception.GetType().FullName) -Compress) +
      ',"errorId":' + (ConvertTo-Json -InputObject ([string]$e.FullyQualifiedErrorId) -Compress) + '}')
  }
}
```

**Spawn:** `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64(utf16le(script))>` with `{ windowsHide: true }`. On the Node side, call `stdout.setEncoding('utf8')` (the StringDecoder keeps multi-byte characters intact), split on `\n`, keep a pending map keyed by id, set a per-call timer (kill and respawn on timeout), and send the init script again after a respawn. Full client: `ps_worker_client.mjs`. Close stdin to make it exit (exit code 0 after 21 ms).

**Gotchas verified:**
* Do **not** set `[Console]::OutputEncoding` (it calls SetConsoleOutputCP on a shared console). Use the raw UTF-8 streams shown above.
* Each request runs in a **child scope**. Helper functions must be declared `function global:Name {...}`; send them once after ready (`ps_collectors.ps1`). `Add-Type` types persist across calls anyway.
* PowerShell 5.1 **ConvertTo-Json**:
  * A DateTime becomes `"\/Date(1791547200000)\/"` (epoch ms, UTC; correct for Local and Unspecified kinds).
  * A `Get-Date` result becomes **an object** `{"value":"\/Date(..)\/","DisplayHint":2,"DateTime":"Freitag, 9. Oktober 2026 14:00:00"}`.
  * **Fix:** `([DateTimeOffset]$dt).ToUnixTimeMilliseconds()` (verified 1791547200000 for 2026-10-09T14:00 CEST).
  * Enums become **ints** (`IPStatus.TimedOut` → 11010, `MediaConnectionState` → 1). Cast with `[string]$x` to get `"TimedOut"` or `"Connected"`.
  * TimeSpans become objects with Ticks, Days, … Use `[int64]$ts.TotalSeconds`.
  * The default `-Depth` is 2. Always select scalar properties, or pass `-Depth`.
  * A single-element array is unwrapped unless you use `-InputObject @(...)`; the worker's `array:true` flag handles this.
  * `<`, `&`, `>` are escaped as `\u003c` and so on, which is valid JSON. Umlauts are emitted raw, so the stream must be UTF-8.
* Errors: `error` is German (e.g. "Es wurden keine MSFT_NetAdapter-Objekte gefunden…"). Branch on `errorId`, e.g. `CmdletizationQuery_NotFound_Name,Get-NetAdapter`, `NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand`, `ParseException`.
* The worker is single-threaded, so requests are queued in order (5 × 50 ms sleeps took 390 ms). Keep the 1 Hz pinger in its **own** process.

---

## 7. PowerShell collectors: commands, fields, timings [measured]

Helpers live in `ps_collectors.ps1` (send it once as the init RPC). Fixtures are `fixtures/pscol_*.json`; timings are in `pscol__timings.json` (first call / warm call).

| Collector | Command | Time | Notes |
|---|---|---|---|
| Adapters | `Get-AdapterRows` → `Get-NetAdapter` mapped to: `name, ifIndex, description, status, mediaConnectionState, linkSpeedText, speedBps, rxLinkSpeedBps, txLinkSpeedBps, fullDuplex, mediaDuplexState, mac, mtu, driverVersion, driverDate, driverProvider, driverFile, componentId, pnpDeviceId, virtual, hardwareInterface, hidden, adminStatus, ifOperStatus, downMediaDisconnected, downLowPower, t` | 608 / **33 ms** | Ethernet: `Up/Connected`, `LinkSpeed "100 Mbps"` (an English string even on de-DE), `Receive/TransmitLinkSpeed 100000000`, `FullDuplex true`, DriverVersion `1.1.4.43`, DriverDate `"2024-02-15"` (string), ComponentID `PCI\VEN_8086&DEV_15F3&REV_03`. **WLAN disconnected still reports 961 Mbps**, so check `status` first. |
| Adapter counters | `Get-AdapterStatRows -Name 'Ethernet'`: `rxBytes, rxUnicastPkts, rxMulticastPkts, rxBroadcastPkts, rxDiscarded, rxErrors, txBytes, txUnicastPkts, txMulticastPkts, txBroadcastPkts, txDiscarded, txErrors, t` | 63 / **14–31 ms** | All 0 errors right now. Poll every 1–2 s and compute throughput from Δbytes. Handle negative deltas as a counter reset. [uncertain whether counters reset on link loss] |
| Advanced props | `Get-NetAdapterAdvancedProperty -Name Ethernet -AllProperties` → `displayName, displayValue, keyword, value, defaultDisplayValue, validDisplayValues, validRegistryValues` | 87 ms | Use **`RegistryKeyword`/`RegistryValue`**; DisplayName is localizable. Present: `*FlowControl=3`, `*InterruptModeration=1`, `ITR=64` (Low), `*SelectiveSuspend=1`, `*SSIdleTimeout=5`, `IdleTimeoutMs=5000`, `*SpeedDuplex=0` (auto), `WaitAutoNegComplete=2`, `*DeviceSleepOnDisconnect=0`, `DMACoalescing=0`, `EnableModernStandby=1`, `WakeOnLink=2` (Forced), `LogLinkStateEvent=51`, `*JumboPacket=1514`, `*NumRssQueues=4`. **No EEE keyword at all** (no `*EEE` or `EEELinkAdvertisement`, even with `-AllProperties`). |
| Route used | `Get-RouteFor '1.1.1.1'` (Find-NetRoute → `remote, sourceAddress, ifIndex, interfaceAlias, nextHop, destinationPrefix, routeMetric, interfaceMetric`) | 450 / **16–48 ms** | v4: source 192.168.0.192 via Ethernet, nextHop 192.168.0.1, 0.0.0.0/0, ifMetric 35. v6: source `3fff:8071:7ca0:c980:d8de:c10f:adb:ac10` (temporary address), nextHop `fe80::de73:6ff:fe12:34df`, ::/0, metric 256. 100.96.0.1 goes via CloudflareWARP (src 100.96.0.7, ifMetric 5). Find-NetRoute returns 2 objects (MSFT_NetIPAddress + MSFT_NetRoute); split them by `CimClass.CimClassName`. |
| Default routes | `Get-NetRoute -DestinationPrefix '0.0.0.0/0','::/0'` + interface ConnectionState | 67 ms | The **stale WLAN default route is still "Alive"** (ifIndex 6) but its interface is `Disconnected`, so Find-NetRoute correctly picks Ethernet. Always join with `Get-NetIPInterface` ConnectionState. |
| IP interfaces | `Get-NetIPInterface` → `ifIndex, alias, family, connectionState, nlMtu, interfaceMetric, automaticMetric, dhcp, forwarding` | 69 ms | Ethernet and WLAN NlMtu 1500, WARP 1280. |
| IP addresses | `Get-NetIPAddress` → `ip, prefixLength, prefixOrigin, suffixOrigin, state, validLifetimeSec, preferredLifetimeSec, skipAsSource` | 52 ms | WLAN addresses (incl. 192.168.0.35) are `Deprecated`. |
| DNS servers | `Get-DnsClientServerAddress` (AddressFamily 2 = IPv4, 23 = IPv6) | 351 ms first | Ethernet: v4 1.1.1.1, 8.8.8.8; v6 `3fff:8071:7ca0:c980:de73:6ff:fe12:34df` (router GUA). WARP iface: the same. WLAN: 192.168.0.1. |
| IP config | `Get-NetIPConfiguration` | **703 ms** | Slow. Prefer the specific cmdlets above. |
| Profiles | `Get-NetConnectionProfile` | 56 ms | Ethernet "Vodafone-43FE", Public, IPv4/IPv6 Internet. |
| TCP/UDP/NIC health | `Get-CimInstance Win32_PerfRawData_Tcpip_TCPv4` (and `_TCPv6`, `_UDPv4`, `_NetworkInterface`) | 311 first / **15–30 ms** | Locale-free cumulative counters: `SegmentsRetransmittedPersec` (a raw count despite the name), `SegmentsSentPersec`, `ConnectionFailures`, `ConnectionsReset`; NIC: `PacketsReceivedErrors`, `PacketsReceivedDiscarded`, `PacketsOutboundErrors`, `OutputQueueLength`, `CurrentBandwidth`, `BytesReceivedPersec`. **Retransmit rate = Δretrans/Δsent** (0.78 % v4 since boot right now). Instance Name uses `[ ]` for `( )`: `Intel[R] Ethernet Controller [3] I225-V`. `Win32_PerfFormattedData_*` takes about 280–300 ms per call, so avoid it. |

### 7.1 Events: language-neutral queries + incremental cursors
```powershell
function global:ConvertTo-EvRow($e, [switch]$NoMessage) {
  $x = [xml]$e.ToXml(); $data = [ordered]@{}; $i = 0
  foreach ($d in @($x.Event.EventData.Data)) { if ($null -eq $d) { continue }
    $name = if ($d -is [System.Xml.XmlElement] -and $d.HasAttribute('Name')) { $d.GetAttribute('Name') } else { 'p' + $i }
    $data[$name] = if ($d -is [System.Xml.XmlElement]) { $d.InnerText } else { [string]$d }; $i++ }
  $msg = $null; if (-not $NoMessage) { try { $msg = (($e.Message -replace '\s+', ' ').Trim()) } catch {} }
  [pscustomobject]@{ log=$e.LogName; provider=$e.ProviderName; id=[int]$e.Id; recordId=[int64]$e.RecordId;
    t=([DateTimeOffset]$e.TimeCreated).ToUnixTimeMilliseconds(); level=[int]$e.Level; data=$data; msg=$msg }
}
function global:Get-EvRows([string]$LogName, [string]$Provider, [int[]]$Ids, [int64]$AfterRecordId = 0, [int]$Max = 1000, [switch]$NoMessage) {
  $c = @(); if ($Provider) { $c += "Provider[@Name='$Provider']" }
  if ($Ids) { $c += '(' + (($Ids | ForEach-Object { "EventID=$_" }) -join ' or ') + ')' }
  if ($AfterRecordId -gt 0) { $c += "EventRecordID > $AfterRecordId" }
  $xp = if ($c.Count) { '*[System[' + ($c -join ' and ') + ']]' } else { '*' }
  @(Get-WinEvent -LogName $LogName -FilterXPath $xp -MaxEvents $Max -ErrorAction SilentlyContinue) | Sort-Object RecordId | ForEach-Object { ConvertTo-EvRow $_ -NoMessage:$NoMessage }
}
```

Calls and timings:
* `Get-EvRows -LogName System -Provider e2fexpress`: 154 rows in 334 ms, with messages.
* `... -AfterRecordId 7698 -NoMessage` returned `[7703,7706,7707,7730,7751]` in **31 ms**.
* When nothing is new, the call returns `null` in **22 ms**.
* The StartTime variant also works: `Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='e2fexpress'; StartTime=(Get-Date).AddHours(-24)}`, 61 ms.

Cursor handling:
* Keep **one cursor per log**, because RecordIds are per log: System is at about 7751, WLAN Operational at 459.
* If the newest RecordId (`(Get-WinEvent -LogName X -MaxEvents 1).RecordId`) is lower than the cursor, the log was cleared; reset the cursor to 0.
* Without `-ErrorAction SilentlyContinue`, an empty result throws `NoMatchingEventsFound,...` ("Es wurden keine Ereignisse gefunden, die den angegebenen Auswahlkriterien entsprechen.").
* Logs: System has a 20 MB maximum and holds 7780 records starting 2026-08-24. WLAN-AutoConfig/Operational has a 1 MB maximum and holds 459 records starting 2026-08-24 18:38. Its FileSize is already at the maximum, but record #1 is still present, so it has not wrapped yet and will start overwriting soon.

**`e2fexpress` (Intel I225-V driver, message file `...\e2f.inf_amd64_d0d0d2073f0fc12f\e2fmsg.dll`), full ID map [resource]:**

| ID | Meaning | Speed (Mbit/s) |
|---|---|---|
| 27 | link down ("Netzwerkverbindung wurde unterbrochen.", Level 3) | |
| 28 / 29 | entering / leaving low-power state | |
| 30 | link partner not auto-negotiating, duplex mismatch possible | |
| 31 | link up | 10000 FD |
| **32** | link up | **1000 FD** |
| **33** | link up | **100 FD** |
| 34 | link up | 100 HD |
| 35 | link up | 10 FD |
| 36 | link up | 10 HD |
| **40** | **Intel SmartSpeed downshifted the link speed** | |
| 41 / 42 | driver stopped / started | |
| 51 | speed reduced due to overheating | |
| 56 | adapter removed | |
| 57 | link up | 2500 FD |
| 62 | link up | 5000 FD |
| 37 / 65 / 66 | PCIe bandwidth insufficient | |

EventData is `p0=""`, `p1="Intel(R) Ethernet Controller (3) I225-V"`. Store `id` and `t`. Histogram since 2026-08-24: 27×77, 32×47, 33×30, no other IDs. Outage (27 → next 32 or 33): min 2.3 s, median 5.4 s, max 21.9 s.

**Microsoft-Windows-Kernel-Power:**
* 42: entering sleep. EventData `TargetState, EffectiveState, Reason, Flags, ...`.
* 107: resume. EventData `TargetState, EffectiveState, WakeFromState, ProgrammedWakeTimeAc/Dc, WakeRequesterTypeAc/Dc`.
* 34 of each exist. Also seen in the System log: 566 (session transition), 187, 172, 109, 125, 577.
* For Modern Standby, use 506/507, and 41 for an unexpected reboot.

**Microsoft-Windows-WLAN-AutoConfig/Operational:** EventData field names are language-neutral; the *values* of `ConnectionMode`, `Reason` and `FailureReason` are German.
| ID | Meaning | Key data | Count here |
|---|---|---|---|
| 8000 | connection start | SSID, ProfileName, ConnectionMode | 58 |
| 8001 | connected | SSID, PHYType (802.11ax), AuthenticationAlgorithm (WPA2-Personal), CipherAlgorithm (AES-CCMP), ConnectionId | 54 |
| 8002 | connect failed | FailureReason, ReasonCode, **RSSI** | 4 |
| 8003 | disconnected | Reason, **ReasonCode** (5 = "Richtlinie … automatische Verbindungsherstellung … deaktiviert", i.e. wired came back) | 51 |
| 8011 | connecting to last known good network | | 3 |
| 11000 / 11001 / 11002 | association start / ok / fail (11002 has RSSI, Dot11 status) | | 58 / 54 / 0 |
| 11004 / 11005 / 11010 | security stop / ok / start | | 59 each |

* No dedicated **roam** event is defined in this channel (48 IDs inspected). [uncertain: a roam probably shows as 11000→11001 within the same ConnectionId without an 8003/8001 pair.]
* The `Netwtw14` (Intel Wi-Fi driver) events 6062, 7021, 7003 and others in the System log coincide with WLAN connects, but their message texts are empty (`MessageFilePath %13%\Netwtw14.sys` cannot be resolved).

---

## 8. WLAN: `netsh wlan show interfaces`

Current (disconnected) output [measured, UTF-8] (`fixtures/netsh_wlan_show_interfaces_disconnected.*`):
```

Es ist 1 Schnittstelle auf dem System vorhanden:

    Name                   : WLAN
    Beschreibung            : Intel(R) Wi-Fi 6E AX211 160MHz
    GUID                   : 1cdb0ef5-cb64-4b03-9b8d-3de53ab40921
    Physische Adresse       : e4:60:17:12:34:01
    Benutzeroberflächentyp         : Primär
    Status                  : getrennt
    Funkstatus           : Hardware Aktiviert
                             Software Aktiviert
```

**Connected-state label set: exact strings from `de-DE\wlancfg.dll.mui` / `en-US\wlancfg.dll.mui` [resource]** (string IDs in brackets). Label padding is irregular in German, so never rely on column positions.

| Canonical | de-DE label | en-US label |
|---|---|---|
| name, description, guid, mac | Name, Beschreibung, GUID, Physische Adresse [60003] | Name, Description, GUID, Physical address |
| interfaceType | **Benutzeroberflächentyp** (sic) = Primär or Sekundär; "Primäre Benutzeroberfläche" [60016] | Interface type = Primary or Secondary; "Primary interface" |
| state | Status (German secondary-iface block uses **"State"**, untranslated) | State |
| ssid, bssid | SSID, AP BSSID [60006]; MLO: "MLD-AP-BSSID" [62181] | SSID, AP BSSID; "MLD AP BSSID" |
| band, channel | **Bereich** (sic, not "Band"), Kanal [62178] | Band, Channel |
| akmCipher | "VerbundeneS Akm-Verschlüsselungsverfahren" (sic) [62869] | Connected Akm-cipher |
| networkType, radioType, authentication | Netzwerktyp, Funktyp, Authentifizierung [60007] | Network type, Radio type, Authentication |
| cipher, connectionMode | **Verschlüsselungsverfahren**, Verbindungsmodus [60008] | Cipher, Connection mode |
| rxRateMbps, txRateMbps, signalPct | **Empfangsrate (MBit/s)**, **Übertragungsrate (MBit/s)**, Signal ("96% ") [60009] | Receive rate (Mbps), Transmit rate (Mbps), Signal |
| rssiDbm | **RSSI** [62866] | **Rssi** [62866] |
| profile | Profil [60005] | Profile |
| qos* | QoS MSCS konfiguriert, QoS-Zuordnung konfiguriert, Durch Richtlinie zugelassene QoS-Zuordnung [60019] | QoS MSCS Configured, QoS Map Configured, QoS Map Allowed by Policy |
| radioStatus | Funkstatus: Hardware/Software **Aktiviert/Deaktiviert** [62737–62739] (multi-line) | Radio status: Hardware/Software On/Off |
| hostedNetworkStatus | Status des gehosteten Netzwerks: "Nicht verfügbar" [60035/62152] | Hosted network status: Not available |

* **State values** [56001–56008]:

  | de-DE | en-US |
  |---|---|
  | Verbunden | connected |
  | getrennt | disconnected |
  | Verbindung wird getrennt | disconnecting |
  | Wird zugeordnet. | associating |
  | Wird gesucht. | discovering |
  | wird authentifiziert | authenticating |
  | nicht bereit | not ready |
  | Das Ad-hoc-Netzwerk wurde gebildet. | ad hoc network formed |

* Other values:
  * Connection mode: "Profil" / "Profile", or "Automat. Verbindung" / "Auto Connect".
  * Network type: "Infrastruktur" / "Infrastructure".
* Rates are `%s` strings and may carry a decimal separator: "866.7" in en sources, and possibly "866,7" in de [uncertain]. The parser accepts both.
* **Rssi line**: the label exists in the 26200 MUI and is documented as new in Win11 builds (mrncciew.com, Aug 2025). It probably appears when connected [uncertain until a connected capture exists]. Otherwise estimate it from Signal: `dBm ≈ signal/2 − 100`.

**Parser:** `lib_netsh_wlan.mjs`, tested on the real capture, on synthetic connected de and en outputs rendered from those resource strings (`fixtures/netsh_wlan_show_interfaces_CONNECTED_synthetic.{de-DE,en-US}.txt`), and on a codepage-mangled German variant:
* Split each indented line at the **first `:`**. Labels never contain `:`, while values (BSSID, MAC) do.
* Lines without a colon continue the previous key (Funkstatus).
* Normalize the key: NFKD, strip diacritics, lowercase, keep only `[a-z0-9]`. Look it up in a de+en alias table. As a fallback, accept a Levenshtein distance ≤ 2 for keys of 8 or more characters, to survive mangled umlauts.
* A new interface starts at `name`.
* Unknown labels are kept in `unknown`.
* Output fields: `{ name, description, guid, mac, state(canonical), stateText, ssid, bssid, bandGHz, channel, networkType, radioType, authentication, cipher, connectionMode, rxRateMbps, txRateMbps, signalPct, rssiDbm, rssiEstimatedDbm, akmCipher, profile, radioStatus, hostedNetworkStatus }`.

`netsh wlan show interfaces` takes **59 ms**; `show drivers` takes 114 ms (fixture saved; useful once for the driver version: Intel AX211, 23.40.0.4, 10.03.2024).

Web check: German guides confirm the field list and the "Signal" label (windows-faq.de). An HP community post shows "866.7" rates. RSSI-in-netsh is described at https://mrncciew.com/2025/08/06/rssi-in-windows-just-got-easier/ (Insider build 27913). No German page shows the full connected output, so the MUI strings above are the authoritative source.

---

## 9. Cloudflare WARP [measured] (`fixtures/warp-cli_*`)

`warp-cli status` (20 ms, ASCII):
```
Status update: Connected
Network: healthy
```
`warp-cli -j status`: `{"status":"Connected","reason":"NetworkHealthy"}`. **Use this form.**

`warp-cli -j settings list` gives JSON (the fixture has the organization redacted):
* `operation_mode: "tunnel_only"`
* `split_tunnel_mode: "include"`
* `split_tunnel_ips[]`, `split_tunnel_hosts[]` (each with `value` and `description`)
* `warp_tunnel_protocol: "wireguard"`
* `always_on`, `disable_for_wifi` / `disable_for_ethernet`
* `anycast_split_ips`, `fallback_domains`, …

With include mode, the engine can mark a target as *tunneled* only if it falls inside an included CIDR (100.96.0.0/12, 100.80.0.0/16, 10.0.0.0/12, 172.64.128.0/20, 2606:4700:cf1::/48, 2606:4700:cf1:4000::/64). Game traffic is not tunneled.

Read-only subcommands that are safe to call: `status`, `settings list`, `tunnel stats`, `debug network`. **Never** call `settings reset`, `connect`, `disconnect`, `mode`, or `registration *`.

---

## 10. Node-native probes [measured] (`lib_netprobes.mjs`, `t8_node_probes.mjs`, `fixtures/node_probes_results.json`)

**TCP connect RTT:** `net.connect({host, port, noDelay:true})`; time to the `'connect'` event with `process.hrtime.bigint()`; then `destroy()`. Results over 5 samples:

| Target | Median (ms) | Range (ms) | Local address |
|---|---|---|---|
| 1.1.1.1:443 | 30.9 | 23.5–178 | 192.168.0.192 |
| 8.8.8.8:443 | 38.7 | 23.9–95.8 | |
| **192.168.0.1:80** | **1.5** | 0.87–1.8 | |
| [2606:4700:4700::1111]:443 | 55.5 | 31.7–107 | 2a02:8071:…:ac10 |
| 192.0.2.1:443 | ETIMEDOUT at the 2 s socket timeout | | `localAddress` undefined/0.0.0.0 |

Jitter was clearly visible during the test.

**DNS over UDP** (raw dgram; validated by ID, QR bit and the echoed question section):
```js
export function buildDnsQuery(id, name, qtype = 1) {
  const parts = [];
  for (const l of name.split('.').filter(Boolean)) { const b = Buffer.from(l, 'ascii'); parts.push(Buffer.from([b.length]), b); }
  parts.push(Buffer.from([0]));
  const h = Buffer.alloc(12); h.writeUInt16BE(id, 0); h.writeUInt16BE(0x0100, 2); h.writeUInt16BE(1, 4);   // RD=1, QDCOUNT=1
  const t = Buffer.alloc(4); t.writeUInt16BE(qtype, 0); t.writeUInt16BE(1, 2);                            // QTYPE, CLASS IN
  return Buffer.concat([h, ...parts, t]);
}
export function parseDnsResponse(buf, expectId, expectQuestion) {
  if (buf.length < 12) return { valid: false, reason: 'short' };
  const id = buf.readUInt16BE(0), flags = buf.readUInt16BE(2);
  if (id !== expectId) return { valid: false, reason: 'id-mismatch' };
  if (!(flags & 0x8000)) return { valid: false, reason: 'not-a-response' };
  if (expectQuestion && buf.readUInt16BE(4) >= 1 && !buf.subarray(12, 12 + expectQuestion.length).equals(expectQuestion)) return { valid: false, reason: 'question-mismatch' };
  return { valid: true, rcode: flags & 0x0f, tc: !!(flags & 0x0200), ra: !!(flags & 0x0080), answerCount: buf.readUInt16BE(6) /* + answers, see lib */ };
}
// dnsQuery(server): dgram.createSocket(net.isIPv6(server) ? 'udp6' : 'udp4'); id = crypto.randomInt(0, 65536);
// bind(0) -> t0 = hrtime -> send(query, 53, server); on 'message' ignore rinfo != server:53 and invalid parses; timeout 2000 ms.
```

DNS results (5 × `example.com A`; median and range in ms):

| Resolver | Median | Range | Note |
|---|---|---|---|
| 1.1.1.1 | 59.4 | 20.8–96.9 | |
| 8.8.8.8 | 31.7 | 26.3–59.0 | |
| **192.168.0.1** (IPv4 DNS proxy on the DS-Lite router) | **1.2** | 1.0–53.1 | The 53 ms first query was the cache miss. AAAA via the router works too. |
| 2606:4700:4700::1111 | 49.4 | 21.0–70.3 | |
| **router IPv6 3fff:8071:7ca0:c980:de73:6ff:fe12:34df** | **1.6** | 1.4–2.1 | |

* NXDOMAIN gives rcode 3.
* An unresponsive server gives ETIMEDOUT.
* `example.com` is usually cached, so this measures resolver reachability and RTT. A random label under a domain you own would measure the recursion, but it creates upstream traffic, so don't do it by default.

**SSDP:** an M-SEARCH from an unbound socket found **nothing**. With the socket **bound to 192.168.0.192** plus `setMulticastInterface('192.168.0.192')`, 192.168.0.228 answered (`Linux/3.18.71+ UPnP/1.0 GUPnP/1.0.5`). The router (192.168.0.1) does not answer SSDP. Confirmed: **binding is required** on this multi-homed host (Ethernet + WARP + stale WLAN).

**os.networkInterfaces()** lists only `CloudflareWARP, Ethernet, Loopback Pseudo-Interface 1`; the disconnected WLAN is omitted because libuv skips non-up adapters. Polling it every 1 s is a zero-cost Ethernet presence indicator. [uncertain: not verified during an actual link drop; confirm against e2fexpress events 27/32/33.]

---

## 11. Side findings relevant to the root cause (from collector validation)

1. **Ethernet link instability is real and frequent.**
   * 77 link drops (e2fexpress 27) since 2026-08-24; the latest today at **13:37:52**, re-link 13:38:00 at **100 Mbit/s** (ID 33).
   * 30 of 77 re-links came up at 100 Mbit/s. No SmartSpeed event (40) was logged.
   * The adapter is still at 100 Mbit/s now.
2. **Windows fails over to WLAN during Ethernet outages.**
   * 50 of 54 WLAN connects (8001, SSID Vodafone-43FE, 802.11ax) occur within 120 s after an Ethernet link-down.
   * 47 WLAN disconnects (8003) carry ReasonCode 5, the policy disconnect once wired is back.
   * Each outage therefore switches interfaces twice. Games lose their connection and NAT mappings even if the outage is only about 5 s. The engine should correlate e2fexpress 27/32/33 with WLAN 8001/8003.
3. **WAN-side latency spikes.** In the 1 Hz multi-target pings, all internet targets spiked at the same tick (up to 160 ms) while the router stayed at 0–1 ms. TCP connect and DNS also showed 100–180 ms outliers. These spikes are *in addition to* the LAN link problem.
4. **DS-Lite specifics.**
   * IPv4 path MTU is 1460.
   * IPv4 traceroute hop 2 (AFTR) never answers.
   * The router answers DNS on both IPv4 and IPv6 in about 1–2 ms.
   * The router is 192.168.0.1. 192.168.0.2 produces local ARP failures ("Zielhost nicht erreichbar" from 192.168.0.192, or `DestinationHostUnreachable`).
5. **I225-V properties.** There is no EEE property exposed. Selective Suspend is enabled (idle timeout 5 s, IdleTimeoutMs 5000). LogLinkStateEvent is on. This only records the facts; any tuning is the user's decision.

---

## 12. Uncertain / untested items

* The exact ping.exe output while the Ethernet link is down. The expected line is `PING: Fehler bei der Übertragung. Allgemeiner Fehler.`, from the message table. The .NET behaviour (an exception, or `DestinationNetworkUnreachable`) is unknown. Both sources map to `local_failure` or `error`.
* Whether `os.networkInterfaces()` drops "Ethernet" immediately on link loss.
* Whether NIC statistics counters reset on link loss.
* The real connected `netsh wlan show interfaces` output on build 26200: field order, whether the RSSI line is present, and the decimal separator.
* WLAN roam detection (no dedicated event ID).
* Why IcmpSendEcho2 timeouts fire early: observed 545–952 ms for w=1000 on the first ping.exe echo, and 713–737 ms (1000) or 1645–1790 ms (2000) in .NET. The cause is unknown; possibly timer quantization.
* `EventLogWatcher` push subscriptions were not tested. Writing a test event would need a registered source (admin). Incremental polling at 22–31 ms per call is cheap enough.

---

## 13. Fixture index (`fixtures/`)

| Pattern | Content |
|---|---|
| `ping_t_<case>.<fromBash\|fromPwsh65001>.{raw.bin,cp850.txt,timeline.json}` | `ping -t` streams with per-chunk and per-line timestamps. Cases: `ipv4_1.1.1.1`, `ipv6_cloudflare`, `unresponsive_192.0.2.1`, `arpfail_192.168.0.2`. |
| `ping_n_timeout_w{500,1000,2000,3000}.cp850.txt`, `ping_n1_success_1.1.1.1.cp850.txt` | Timeout pacing and a one-shot success run, including the statistics block. |
| `codepage_{A,B,C}_*.raw.bin` | ping output under windowsHide true/false and with `chcp 65001`; all CP850. |
| `ping_DF_*.txt`, `ping_v6_*.txt`, `mtu_probe_log.txt`, `mtu_probe_results.json`, `netsh_ipv4_destinationcache.txt`, `netsh_ipv6_destinationcache_if4.txt` | MTU and DF probes. |
| `tracert_v4_1.1.1.1.*`, `tracert_v6_cloudflare.*` | tracert raw output, decoded text, and partial-line timeline. |
| `res_ping.{de-DE,en-US}.json`, `res_tracert.*.json`, `res_wlancfg.*.json`, `res_e2fmsg.json` | Complete localized message and string tables (made with `resdump.ps1`). |
| `spawn_overhead.json`, `ps_worker_test_results.json`, `process_lifecycle_and_cpu.json` | Overheads, worker behaviour, and the job-object test. |
| `dotnet_pinger_stream.json`, `dotnet_pinger_waitany.json`, `dotnet_pinger_error_cases.jsonl`, `dotnet_ping_df_trace.json` | .NET pinger, DF, and TTL trace. |
| `ps_raw_*.json` | Raw property dumps (Get-NetAdapter, Statistics, Find-NetRoute). |
| `ps_*histogram*.json`, `ps_provider_*.json`, `ps_*sample*.json`, `ps_netwtw14_recent.json`, `ps_*log_info.json` | Event-log exploration. |
| `pscol_*.json`, `pscol__timings.json`, `pscol_perfcounters.json` | Production-shaped collector outputs and timings. |
| `netsh_wlan_show_interfaces_disconnected.{raw.bin,txt}`, `netsh_wlan_show_interfaces_CONNECTED_synthetic.{de-DE,en-US}.txt`, `netsh_wlan_show_drivers.*`, `netsh_interface_ipv{4,6}_show_subinterfaces.*` | netsh captures (the CONNECTED files are synthetic). |
| `warp-cli_status.*`, `warp-cli_json_status.json`, `warp-cli_json_settings_list.json`, `warp-cli_settings_list.txt`, `warp-cli_--help.txt`, `warp-cli_--version.txt` | WARP captures; the organization is redacted. |
| `node_probes_results.json` | TCP, DNS, SSDP and `os.networkInterfaces` results. |

Reusable code:
* `lib_cp850.mjs`
* `lib_pingparse.mjs`
* `lib_netprobes.mjs`
* `lib_netsh_wlan.mjs`
* `ps_worker.ps1` + `ps_worker_client.mjs`
* `ps_collectors.ps1`
* `ps_pinger.ps1`
* `resdump.ps1` (research only)
