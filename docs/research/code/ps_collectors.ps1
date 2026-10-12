# Global helper functions for the PS worker (send once as an "init" RPC; `global:` makes them survive the per-call scope).
function global:ConvertTo-EpochMs($dt) { if ($null -eq $dt) { return $null }; ([DateTimeOffset]$dt).ToUnixTimeMilliseconds() }

function global:ConvertTo-EvRow($e, [switch]$NoMessage) {
  $x = [xml]$e.ToXml()
  $data = [ordered]@{}
  $i = 0
  foreach ($d in @($x.Event.EventData.Data)) {
    if ($null -eq $d) { continue }
    $name = if ($d -is [System.Xml.XmlElement] -and $d.HasAttribute('Name')) { $d.GetAttribute('Name') } else { 'p' + $i }
    $data[$name] = if ($d -is [System.Xml.XmlElement]) { $d.InnerText } else { [string]$d }
    $i++
  }
  $msg = $null
  if (-not $NoMessage) { try { $msg = (($e.Message -replace '\s+', ' ').Trim()) } catch { $msg = $null } }
  [pscustomobject]@{
    log      = $e.LogName
    provider = $e.ProviderName
    id       = [int]$e.Id
    recordId = [int64]$e.RecordId
    t        = ConvertTo-EpochMs $e.TimeCreated
    level    = [int]$e.Level
    data     = $data
    msg      = $msg
  }
}

# Incremental query: everything newer than $AfterRecordId (per log!). XPath keeps filtering inside the event log service.
function global:Get-EvRows([string]$LogName, [string]$Provider, [int[]]$Ids, [int64]$AfterRecordId = 0, [int]$Max = 1000, [switch]$NoMessage) {
  $conds = @()
  if ($Provider) { $conds += "Provider[@Name='$Provider']" }
  if ($Ids -and $Ids.Count) { $conds += '(' + (($Ids | ForEach-Object { "EventID=$_" }) -join ' or ') + ')' }
  if ($AfterRecordId -gt 0) { $conds += "EventRecordID > $AfterRecordId" }
  $xp = if ($conds.Count) { '*[System[' + ($conds -join ' and ') + ']]' } else { '*' }
  @(Get-WinEvent -LogName $LogName -FilterXPath $xp -MaxEvents $Max -ErrorAction SilentlyContinue) |
    Sort-Object RecordId | ForEach-Object { ConvertTo-EvRow $_ -NoMessage:$NoMessage }
}

function global:Get-AdapterRows {
  Get-NetAdapter | ForEach-Object {
    [pscustomobject]@{
      name = $_.Name; ifIndex = [int]$_.ifIndex; description = $_.InterfaceDescription
      status = [string]$_.Status; mediaConnectionState = [string]$_.MediaConnectionState
      linkSpeedText = [string]$_.LinkSpeed; speedBps = $_.Speed
      rxLinkSpeedBps = $_.ReceiveLinkSpeed; txLinkSpeedBps = $_.TransmitLinkSpeed
      fullDuplex = $_.FullDuplex; mediaDuplexState = [int]$_.MediaDuplexState
      mac = $_.MacAddress; mtu = [int]$_.MtuSize
      driverVersion = $_.DriverVersion; driverDate = $_.DriverDate; driverProvider = $_.DriverProvider; driverFile = $_.DriverFileName
      componentId = $_.ComponentID; pnpDeviceId = $_.PnPDeviceID
      virtual = [bool]$_.Virtual; hardwareInterface = [bool]$_.HardwareInterface; hidden = [bool]$_.Hidden
      adminStatus = [string]$_.AdminStatus; ifOperStatus = [string]$_.ifOperStatus
      downMediaDisconnected = $_.OperationalStatusDownMediaDisconnected; downLowPower = $_.OperationalStatusDownLowPowerState
      t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
  }
}

function global:Get-AdapterStatRows([string]$Name = '*') {
  Get-NetAdapterStatistics -Name $Name | ForEach-Object {
    [pscustomobject]@{
      name = $_.Name
      rxBytes = $_.ReceivedBytes; rxUnicastPkts = $_.ReceivedUnicastPackets; rxMulticastPkts = $_.ReceivedMulticastPackets; rxBroadcastPkts = $_.ReceivedBroadcastPackets
      rxDiscarded = $_.ReceivedDiscardedPackets; rxErrors = $_.ReceivedPacketErrors
      txBytes = $_.SentBytes; txUnicastPkts = $_.SentUnicastPackets; txMulticastPkts = $_.SentMulticastPackets; txBroadcastPkts = $_.SentBroadcastPackets
      txDiscarded = $_.OutboundDiscardedPackets; txErrors = $_.OutboundPacketErrors
      t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
  }
}

function global:Get-RouteFor([string]$Remote) {
  $r = @(Find-NetRoute -RemoteIPAddress $Remote -ErrorAction SilentlyContinue)
  $a  = $r | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_NetIPAddress' } | Select-Object -First 1
  $rt = $r | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_NetRoute' } | Select-Object -First 1
  [pscustomobject]@{
    remote = $Remote; sourceAddress = $a.IPAddress; ifIndex = [int]$rt.ifIndex; interfaceAlias = $rt.InterfaceAlias
    nextHop = $rt.NextHop; destinationPrefix = $rt.DestinationPrefix; routeMetric = [int]$rt.RouteMetric; interfaceMetric = [int]$rt.InterfaceMetric
  }
}
