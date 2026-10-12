$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

"=== .NET NetworkInterface (locale independent) ==="
$t = Measure-Command { $nics = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() }
"GetAllNetworkInterfaces ms=$([int]$t.TotalMilliseconds)"
foreach ($n in $nics) {
  if ($n.Name -in 'Ethernet','WLAN','CloudflareWARP') {
    $t2 = Measure-Command { $s = $n.GetIPStatistics() }
    "{0} status={1} speedMbps={2} type={3} rx={4} tx={5} inErr={6} inDisc={7} outErr={8} outDisc={9} statsMs={10:N1}" -f $n.Name, $n.OperationalStatus, ($n.Speed/1e6), $n.NetworkInterfaceType, $s.BytesReceived, $s.BytesSent, $s.IncomingPacketsWithErrors, $s.IncomingPacketsDiscarded, $s.OutgoingPacketsWithErrors, $s.OutgoingPacketsDiscarded, $t2.TotalMilliseconds
  }
}

"=== Get-NetAdapter / Statistics ==="
$t = Measure-Command { $a = Get-NetAdapter -Name Ethernet,WLAN }
"Get-NetAdapter ms=$([int]$t.TotalMilliseconds)"
$a | Select-Object Name, Status, LinkSpeed, MediaConnectionState, DriverVersion, DriverDate, ifIndex | Format-Table -AutoSize | Out-String -Width 200
Get-NetAdapterStatistics -Name Ethernet | Select-Object ReceivedBytes, SentBytes, ReceivedDiscardedPackets, ReceivedPacketErrors, OutboundDiscardedPackets, OutboundPacketErrors, ReceivedUnicastPackets | Format-List | Out-String

"=== Perf raw TCP/UDP via CIM (class names not localized) ==="
$t = Measure-Command { $tcp4 = Get-CimInstance Win32_PerfRawData_Tcpip_TCPv4 }
"cim TCPv4 ms=$([int]$t.TotalMilliseconds)"
$tcp4 | Select-Object SegmentsRetransmittedPersec, SegmentsSentPersec, SegmentsReceivedPersec, ConnectionFailures, ConnectionsReset, ConnectionsEstablished | Format-List | Out-String
Get-CimInstance Win32_PerfRawData_Tcpip_TCPv6 | Select-Object SegmentsRetransmittedPersec, SegmentsSentPersec | Format-List | Out-String
Get-CimInstance Win32_PerfRawData_Tcpip_UDPv4 | Select-Object DatagramsNoPortPersec, DatagramsReceivedErrors, DatagramsSentPersec, DatagramsReceivedPersec | Format-List | Out-String

"=== Interfaces / metrics / default routes ==="
Get-NetIPInterface | Where-Object InterfaceAlias -in 'Ethernet','WLAN','CloudflareWARP' | Select-Object ifIndex, InterfaceAlias, AddressFamily, InterfaceMetric, AutomaticMetric, ConnectionState, NlMtu | Format-Table -AutoSize | Out-String -Width 200
Get-NetRoute -DestinationPrefix '0.0.0.0/0','::/0' | Select-Object ifIndex, InterfaceAlias, DestinationPrefix, NextHop, RouteMetric, PolicyStore | Format-Table -AutoSize | Out-String -Width 200
$t = Measure-Command { $fr = Find-NetRoute -RemoteIPAddress 1.1.1.1 }
"Find-NetRoute ms=$([int]$t.TotalMilliseconds)"
$fr | Select-Object -Last 1 ifIndex, InterfaceAlias, NextHop, RouteMetric | Format-List | Out-String
Find-NetRoute -RemoteIPAddress '2606:4700:4700::1111' | Select-Object -Last 1 ifIndex, InterfaceAlias, NextHop, RouteMetric | Format-List | Out-String

"=== Neighbor (gateway v4 + v6 routers) ==="
Get-NetNeighbor -IPAddress 192.168.0.1 | Select-Object ifIndex, IPAddress, State | Format-Table -AutoSize | Out-String
Get-NetNeighbor -AddressFamily IPv6 -InterfaceIndex 4 | Where-Object { $_.IsRouter } | Select-Object IPAddress, State, IsRouter | Format-Table -AutoSize | Out-String

"=== Adapter advanced props (incl. hidden) ==="
Get-NetAdapterAdvancedProperty -Name Ethernet -AllProperties | Where-Object { $_.RegistryKeyword -notmatch 'NetworkAddress' } | Select-Object DisplayName, RegistryKeyword, DisplayValue, RegistryValue | Format-Table -AutoSize | Out-String -Width 250

"=== Power management ==="
Get-NetAdapterPowerManagement -Name Ethernet | Select-Object * -ExcludeProperty CimClass,CimInstanceProperties,CimSystemProperties | Format-List | Out-String

"=== WcmSvc policy (fMinimizeConnections) ==="
$pol = Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WcmSvc\GroupPolicy' -ErrorAction SilentlyContinue
if ($pol) { $pol | Format-List | Out-String } else { 'no policy key (Windows default behaviour)' }
