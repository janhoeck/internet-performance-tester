# Long-lived PowerShell 5.1 RPC worker. Started with -EncodedCommand (no execution-policy issues).
# Protocol: Node writes one JSON request per line on stdin: {"id":<int>,"cmd":"<ps script>","depth":5,"array":false}
#           Worker writes one line per request on stdout: @@RPC@@{"id":..,"ok":true,"data":<json>} | {"id":..,"ok":false,"error":"..",...}
# Only lines starting with @@RPC@@ are protocol; anything else (stray host output) must be ignored by the client.
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'   # avoids CLIXML progress records on stderr (module autoload)
$WarningPreference     = 'SilentlyContinue'
$utf8   = New-Object System.Text.UTF8Encoding($false)
# Raw UTF-8 streams: do NOT touch [Console]::OutputEncoding (that would call SetConsoleOutputCP on a shared console).
$stdin  = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true
$stdout.NewLine   = "`n"
function Send-Rpc([string]$json) { $stdout.WriteLine('@@RPC@@' + $json) }

Send-Rpc ('{"id":0,"ok":true,"data":{"ready":true,"pid":' + $PID + ',"ps":"' + $PSVersionTable.PSVersion.ToString() + '"}}')

while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }          # stdin closed by parent -> exit cleanly
  if ($line.Trim().Length -eq 0) { continue }
  $id = 0
  try {
    $req   = ConvertFrom-Json -InputObject $line
    $id    = [int64]$req.id
    $depth = 5; if ($req.depth) { $depth = [int]$req.depth }
    $sb    = [ScriptBlock]::Create([string]$req.cmd)
    $res   = @(& $sb)
    if ($res.Count -eq 0)                      { $json = 'null' }
    elseif ($res.Count -eq 1 -and -not $req.array) { $json = ConvertTo-Json -InputObject $res[0] -Depth $depth -Compress }
    else                                       { $json = ConvertTo-Json -InputObject $res    -Depth $depth -Compress }
    if ([string]::IsNullOrEmpty($json)) { $json = 'null' }
    Send-Rpc ('{"id":' + $id + ',"ok":true,"data":' + $json + '}')
  } catch {
    $e = $_
    $msg  = ConvertTo-Json -InputObject ([string]$e.Exception.Message) -Compress
    $type = ConvertTo-Json -InputObject ([string]$e.Exception.GetType().FullName) -Compress
    $fq   = ConvertTo-Json -InputObject ([string]$e.FullyQualifiedErrorId) -Compress
    Send-Rpc ('{"id":' + $id + ',"ok":false,"error":' + $msg + ',"errorType":' + $type + ',"errorId":' + $fq + '}')
  }
}
