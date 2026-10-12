# Global helper functions for the Netzdiagnose PowerShell RPC worker (engine/collectors/powershell-host.ts).
# Sent once after every (re)start of the worker; `function global:` makes them survive the per-request
# child scope. Keep this file ASCII-only and free of secrets. All timestamps are epoch ms (UTC), all
# enums are string-cast (ConvertTo-Json would emit ints), arrays are re-wrapped with @() because
# PowerShell unrolls single-element arrays.

function global:Get-NdNow { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function global:ConvertTo-NdEpochMs($dt) {
  if ($null -eq $dt) { return $null }
  ([DateTimeOffset]$dt).ToUnixTimeMilliseconds()
}

# ---- adapters ---------------------------------------------------------------------------------------

function global:Get-NdAdapters {
  @(Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{
      name              = [string]$_.Name
      ifIndex           = [int]$_.ifIndex
      guid              = [string]$_.InterfaceGuid
      description       = [string]$_.InterfaceDescription
      status            = [string]$_.Status
      mediaConnectState = [int]$_.MediaConnectState
      mediaType         = [string]$_.MediaType
      physicalMedium    = [int]$_.NdisPhysicalMedium
      rxBps             = [double]$_.ReceiveLinkSpeed
      txBps             = [double]$_.TransmitLinkSpeed
      mac               = [string]$_.MacAddress
      driverVersion     = [string]$_.DriverVersion
      driverDate        = [string]$_.DriverDate
      virtual           = [bool]$_.Virtual
      hardware          = [bool]$_.HardwareInterface
    }
  })
}

function global:Get-NdAdapterStats {
  @(Get-NetAdapterStatistics -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{
      name       = [string]$_.Name
      rxBytes    = [double]$_.ReceivedBytes
      txBytes    = [double]$_.SentBytes
      rxErrors   = [double]$_.ReceivedPacketErrors
      rxDiscards = [double]$_.ReceivedDiscardedPackets
      txErrors   = [double]$_.OutboundPacketErrors
      txDiscards = [double]$_.OutboundDiscardedPackets
    }
  })
}

function global:Get-NdAddresses {
  @(Get-NetIPAddress -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{
      ifIndex      = [int]$_.InterfaceIndex
      ip           = [string]$_.IPAddress
      prefixLength = [int]$_.PrefixLength
      family       = [string]$_.AddressFamily
      prefixOrigin = [string]$_.PrefixOrigin
      suffixOrigin = [string]$_.SuffixOrigin
      state        = [string]$_.AddressState
    }
  })
}

# Route Windows uses for a remote address. Find-NetRoute returns MSFT_NetIPAddress + MSFT_NetRoute.
function global:Get-NdRouteFor([string]$Remote) {
  $r = @(Find-NetRoute -RemoteIPAddress $Remote -ErrorAction SilentlyContinue)
  $a = $r | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_NetIPAddress' } | Select-Object -First 1
  $rt = $r | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_NetRoute' } | Select-Object -First 1
  if ($null -eq $rt) { return [pscustomobject]@{ remote = $Remote; found = $false } }
  [pscustomobject]@{
    remote        = $Remote
    found         = $true
    sourceAddress = $(if ($null -ne $a) { [string]$a.IPAddress } else { $null })
    ifIndex       = [int]$rt.InterfaceIndex
    ifAlias       = [string]$rt.InterfaceAlias
    nextHop       = [string]$rt.NextHop
    prefix        = [string]$rt.DestinationPrefix
    routeMetric   = [int]$rt.RouteMetric
    ifMetric      = [int]$rt.InterfaceMetric
  }
}

# All default routes joined with the interface connection state (a stale WLAN route stays "Alive").
function global:Get-NdDefaultRoutes {
  $state = @{}
  foreach ($i in @(Get-NetIPInterface -ErrorAction SilentlyContinue)) {
    $state[([string]$i.InterfaceIndex) + '/' + ([string]$i.AddressFamily)] = [string]$i.ConnectionState
  }
  @(Get-NetRoute -DestinationPrefix '0.0.0.0/0', '::/0' -ErrorAction SilentlyContinue | ForEach-Object {
    $fam = [string]$_.AddressFamily
    [pscustomobject]@{
      ifIndex     = [int]$_.InterfaceIndex
      ifAlias     = [string]$_.InterfaceAlias
      family      = $fam
      nextHop     = [string]$_.NextHop
      routeMetric = [int]$_.RouteMetric
      ifMetric    = [int]$_.InterfaceMetric
      state       = [string]$_.State
      ifState     = $state[([string]$_.InterfaceIndex) + '/' + $fam]
    }
  })
}

# Driver service names (= event log provider for Intel NICs, e.g. e2fexpress / e2fnexpress).
function global:Get-NdServices {
  @(Get-CimInstance -ClassName Win32_NetworkAdapter -Property GUID, ServiceName -ErrorAction SilentlyContinue |
    Where-Object { $_.GUID } | ForEach-Object {
      [pscustomobject]@{ guid = [string]$_.GUID; serviceName = [string]$_.ServiceName }
    })
}

# Advanced driver properties; RegistryKeyword/RegistryValue are language independent.
function global:Get-NdAdvanced([string]$Name) {
  @(Get-NetAdapterAdvancedProperty -Name $Name -AllProperties -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{
      keyword      = [string]$_.RegistryKeyword
      value        = (@($_.RegistryValue) -join ',')
      displayName  = [string]$_.DisplayName
      displayValue = [string]$_.DisplayValue
    }
  })
}

# One round trip for the adapter module.
function global:Get-NdNetSnapshot([switch]$Routes, [switch]$Services, [string]$AdvancedFor = '') {
  $o = [ordered]@{
    t         = (Get-NdNow)
    adapters  = @(Get-NdAdapters)
    stats     = @(Get-NdAdapterStats)
    addresses = @(Get-NdAddresses)
  }
  if ($Routes) {
    $o['routes'] = @((Get-NdRouteFor '1.1.1.1'), (Get-NdRouteFor '2606:4700:4700::1111'))
    $o['defaultRoutes'] = @(Get-NdDefaultRoutes)
  }
  if ($Services) { $o['services'] = @(Get-NdServices) }
  if ($AdvancedFor) { $o['advanced'] = @(Get-NdAdvanced $AdvancedFor) }
  [pscustomobject]$o
}

# ---- system -----------------------------------------------------------------------------------------

# Cumulative TCP segment counters (raw counters despite the "Persec" names).
function global:Get-NdTcpCounters {
  $v4 = Get-CimInstance -ClassName Win32_PerfRawData_Tcpip_TCPv4 -ErrorAction SilentlyContinue | Select-Object -First 1
  $v6 = Get-CimInstance -ClassName Win32_PerfRawData_Tcpip_TCPv6 -ErrorAction SilentlyContinue | Select-Object -First 1
  [pscustomobject]@{
    t  = (Get-NdNow)
    v4 = $(if ($null -ne $v4) { [pscustomobject]@{ retrans = [double]$v4.SegmentsRetransmittedPersec; sent = [double]$v4.SegmentsSentPersec } } else { $null })
    v6 = $(if ($null -ne $v6) { [pscustomobject]@{ retrans = [double]$v6.SegmentsRetransmittedPersec; sent = [double]$v6.SegmentsSentPersec } } else { $null })
  }
}

# ---- identity ---------------------------------------------------------------------------------------

# Interface towards the router, router MAC (neighbor cache), DHCP server, DNS servers, IPv6 RA addresses.
function global:Get-NdIdentity([string]$RouterIp) {
  $route = @(Find-NetRoute -RemoteIPAddress $RouterIp -ErrorAction SilentlyContinue) |
    Where-Object { $_.CimClass.CimClassName -eq 'MSFT_NetRoute' } | Select-Object -First 1
  if ($null -eq $route) { return [pscustomobject]@{ t = (Get-NdNow); found = $false } }
  $idx = [int]$route.InterfaceIndex
  $nb = @(Get-NetNeighbor -IPAddress $RouterIp -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{ ifIndex = [int]$_.InterfaceIndex; mac = [string]$_.LinkLayerAddress; state = [string]$_.State }
  })
  $cfg = Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration -Filter ('InterfaceIndex=' + $idx) -ErrorAction SilentlyContinue |
    Select-Object -First 1
  $dns = @(Get-DnsClientServerAddress -InterfaceIndex $idx -ErrorAction SilentlyContinue | ForEach-Object { @($_.ServerAddresses) })
  $v6 = @(Get-NetIPAddress -InterfaceIndex $idx -AddressFamily IPv6 -ErrorAction SilentlyContinue |
    Where-Object { [string]$_.PrefixOrigin -eq 'RouterAdvertisement' } | ForEach-Object {
      [pscustomobject]@{ ip = [string]$_.IPAddress; prefixLength = [int]$_.PrefixLength; suffixOrigin = [string]$_.SuffixOrigin }
    })
  [pscustomobject]@{
    t           = (Get-NdNow)
    found       = $true
    ifIndex     = $idx
    ifAlias     = [string]$route.InterfaceAlias
    neighbors   = $nb
    dhcpEnabled = $(if ($null -ne $cfg) { [bool]$cfg.DHCPEnabled } else { $null })
    dhcpServer  = $(if ($null -ne $cfg -and $cfg.DHCPServer) { [string]$cfg.DHCPServer } else { $null })
    dns         = @($dns | ForEach-Object { [string]$_ })
    v6          = $v6
  }
}
