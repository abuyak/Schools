Set-StrictMode -Version Latest

# In-memory geo cache: IP -> @{country; city; region}
$script:geoCache = @{}

function Get-GeoLocation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$IP
    )

    # Loopback / private RFC1918 ranges - skip external lookup
    if ($IP -eq "127.0.0.1" -or $IP -eq "::1" -or
        $IP -match "^10\." -or
        $IP -match "^192\.168\." -or
        $IP -match "^172\.(1[6-9]|2\d|3[01])\.") {
        return @{ country = "local"; city = ""; region = "" }
    }

    if ($script:geoCache.ContainsKey($IP)) {
        return $script:geoCache[$IP]
    }

    $geo = @{ country = ""; city = ""; region = "" }
    try {
        $resp = Invoke-RestMethod -Uri "http://ip-api.com/json/$IP`?fields=country,regionName,city,status" -TimeoutSec 3 -ErrorAction Stop
        $geo = @{
            country = if ($resp.status -eq "success") { [string]$resp.country } else { "" }
            region  = if ($resp.status -eq "success") { [string]$resp.regionName } else { "" }
            city    = if ($resp.status -eq "success") { [string]$resp.city } else { "" }
        }
    }
    catch { }

    $script:geoCache[$IP] = $geo
    return $geo
}

function Write-AnalyticsEvent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,
        [Parameter(Mandatory)]
        [string]$LogPath,
        [hashtable]$Properties = @{}
    )

    try {
        $record = [ordered]@{
            ts    = (Get-Date).ToUniversalTime().ToString("o")
            name  = $Name
            props = $Properties
        }
        Add-Content -LiteralPath $LogPath -Value ($record | ConvertTo-Json -Depth 4 -Compress) -Encoding UTF8
    }
    catch { }
}

function Get-EventProp {
    [CmdletBinding()]
    param(
        $Event,
        [Parameter(Mandatory)]
        [string]$Key,
        $Default = ""
    )

    try {
        if ($null -eq $Event) { return $Default }
        $props = $Event.props
        if ($null -eq $props) { return $Default }
        $val = $props.PSObject.Properties[$Key]
        if ($null -eq $val) { return $Default }
        return $val.Value
    }
    catch { return $Default }
}

function Test-AdminAuth {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Request
    )

    $configFile = @{}
    try {
        $settingsPath = Join-Path (Get-SchoolScannerConfigRoot) "research-settings.json"
        if (Test-Path -LiteralPath $settingsPath) {
            $configFile = ConvertTo-PlainHashtable -InputObject (
                ConvertFrom-Json -InputObject (Get-Content -LiteralPath $settingsPath -Raw)
            )
        }
    }
    catch { }

    $token = if ($configFile.ContainsKey("adminToken")) { [string]$configFile["adminToken"] } else { "" }

    # No token configured - open dev mode
    if ([string]::IsNullOrWhiteSpace($token)) { return $true }

    if ($Request.Headers.ContainsKey("authorization")) {
        if ([string]$Request.Headers["authorization"] -eq "Bearer $token") { return $true }
    }
    if ($Request.Query.ContainsKey("token") -and [string]$Request.Query["token"] -eq $token) {
        return $true
    }
    return $false
}

function Build-AnalyticsDashboard {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$LogPath
    )

    $events = @()
    if (Test-Path -LiteralPath $LogPath) {
        $events = @(Get-Content -LiteralPath $LogPath -Tail 5000 | ForEach-Object {
            try { ConvertFrom-Json $_ } catch { $null }
        } | Where-Object { $null -ne $_ })
    }

    $requests    = @($events | Where-Object { [string]$_.name -eq "research_request" })
    $total       = $requests.Count
    $okReqs      = @($requests | Where-Object { (Get-EventProp -Event $_ -Key "status") -eq "ok" })
    $ok          = $okReqs.Count
    $errors      = $total - $ok
    $successRate = if ($total -gt 0) { [Math]::Round($ok * 100.0 / $total, 1) } else { 0 }
    $avgMs       = if ($ok -gt 0) {
        [Math]::Round(($okReqs | ForEach-Object { [int](Get-EventProp -Event $_ -Key "ms" -Default 0) } | Measure-Object -Sum).Sum / $ok)
    } else { 0 }

    $cutoff7d = (Get-Date).ToUniversalTime().AddDays(-7)
    $last7d   = @($requests | Where-Object { try { ([datetime]$_.ts) -ge $cutoff7d } catch { $false } }).Count

    $branchMap = @{
        "prompt_branch_1" = "01 Evaluate"
        "prompt_branch_2" = "02 Compare"
        "prompt_branch_3" = "03 Area"
        "prompt_branch_4" = "04 Backup"
    }

    $byBranch = foreach ($key in @("prompt_branch_1","prompt_branch_2","prompt_branch_3","prompt_branch_4")) {
        $br    = @($requests | Where-Object { (Get-EventProp -Event $_ -Key "branch") -eq $key })
        $brOk  = @($br | Where-Object { (Get-EventProp -Event $_ -Key "status") -eq "ok" })
        $brAvg = if ($brOk.Count -gt 0) {
            [Math]::Round(($brOk | ForEach-Object { [int](Get-EventProp -Event $_ -Key "ms" -Default 0) } | Measure-Object -Sum).Sum / $brOk.Count)
        } else { 0 }
        [ordered]@{ label = $branchMap[$key]; total = $br.Count; ok = $brOk.Count; errors = ($br.Count - $brOk.Count); avgMs = $brAvg }
    }

    $daily = [ordered]@{}
    for ($i = 13; $i -ge 0; $i--) {
        $d = (Get-Date).AddDays(-$i).ToString("yyyy-MM-dd")
        $daily[$d] = 0
    }
    foreach ($r in $requests) {
        try {
            $d = ([datetime]$r.ts).ToLocalTime().ToString("yyyy-MM-dd")
            if ($daily.ContainsKey($d)) { $daily[$d]++ }
        }
        catch { }
    }

    $fe      = @($events | Where-Object { [string]$_.name -ne "research_request" })
    $feStats = [ordered]@{
        branchSelects   = @($fe | Where-Object { [string]$_.name -eq "branch_selected" }).Count
        submits         = @($fe | Where-Object { [string]$_.name -eq "question_submitted" }).Count
        resultsRendered = @($fe | Where-Object { [string]$_.name -eq "result_rendered" }).Count
        ctaClicks       = @($fe | Where-Object { [string]$_.name -eq "cta_click" }).Count
        feedbackClicks  = @($fe | Where-Object { [string]$_.name -eq "feedback_click" }).Count
    }

    $recentRows = @()
    if ($events.Count -gt 0) {
        $recentRows = @($events | Select-Object -Last 30) |
            Sort-Object { try { [datetime]$_.ts } catch { [datetime]::MinValue } } -Descending |
            ForEach-Object {
                $ev     = $_
                $ts     = try { ([datetime]$ev.ts).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") } catch { [string]$ev.ts }
                $name   = [string]$ev.name
                $detail = switch ($name) {
                    "research_request"   { "$((Get-EventProp -Event $ev -Key 'branch') -replace 'prompt_branch_','p'), $(Get-EventProp -Event $ev -Key 'status'), $([Math]::Round([int](Get-EventProp -Event $ev -Key 'ms' -Default 0)/1000,1))s" }
                    "branch_selected"    { (Get-EventProp -Event $ev -Key "branch") -replace "prompt_branch_","p" }
                    "question_submitted" { (Get-EventProp -Event $ev -Key "branch") -replace "prompt_branch_","p" }
                    "result_rendered"    { "$((Get-EventProp -Event $ev -Key 'branch') -replace 'prompt_branch_','p'), $([Math]::Round([int](Get-EventProp -Event $ev -Key 'ms' -Default 0)/1000,1))s" }
                    "cta_click"          { Get-EventProp -Event $ev -Key "placement" }
                    "feedback_click"     { Get-EventProp -Event $ev -Key "placement" }
                    default              { "" }
                }
                $city    = Get-EventProp -Event $ev -Key "city"
                $country = Get-EventProp -Event $ev -Key "country"
                $loc     = if ($city -and $country -and $city -ne $country) { "$city, $country" } elseif ($country -and $country -ne "local") { $country } else { "" }
                [ordered]@{ ts = $ts; name = $name; detail = $detail; loc = $loc }
            }
    }

    # Top countries
    $countryCounts = @{}
    foreach ($r in $requests) {
        $c = Get-EventProp -Event $r -Key "country"
        if ([string]::IsNullOrWhiteSpace($c) -or $c -eq "local") { $c = "Unknown" }
        $prev = if ($countryCounts.ContainsKey($c)) { $countryCounts[$c] } else { 0 }
        $countryCounts[$c] = $prev + 1
    }
    $topCountries = @($countryCounts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 8 | ForEach-Object {
        [ordered]@{ country = $_.Key; count = $_.Value }
    })

    $statsJson = [ordered]@{
        total        = $total
        ok           = $ok
        errors       = $errors
        successRate  = $successRate
        avgMs        = $avgMs
        last7d       = $last7d
        byBranch     = @($byBranch)
        daily        = $daily
        fe           = $feStats
        topCountries = @($topCountries)
        recentRows   = @($recentRows)
        generatedAt  = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    } | ConvertTo-Json -Depth 6 -Compress

    return @"
<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>School Scanner - Analytics</title>
<style>
  *{box-sizing:border-box}
  body{font-family:"Segoe UI",sans-serif;background:#f3ede2;color:#11203b;margin:0;padding:2rem}
  h1{font-size:1.3rem;margin:0 0 .2rem}
  .sub{color:#55637d;font-size:.82rem;margin:0 0 2rem}
  h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:#8f3b16;margin:2rem 0 .6rem;border-bottom:1px solid #d5c7af;padding-bottom:.3rem}
  .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:1rem}
  .grid5{grid-template-columns:repeat(5,1fr)}
  @media(max-width:800px){.grid5{grid-template-columns:repeat(3,1fr)}}
  @media(max-width:640px){.grid4,.grid5{grid-template-columns:repeat(2,1fr)}}
  .card{background:#fff;border:1px solid #d5c7af;border-radius:12px;padding:1rem 1.25rem}
  .val{font-size:1.8rem;font-weight:700;line-height:1;margin-bottom:.25rem}
  .lbl{font-size:.75rem;color:#55637d}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.05);font-size:.875rem}
  th{background:#f8f2e7;font-weight:700;color:#8f3b16;text-align:left;padding:.55rem 1rem;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
  td{padding:.5rem 1rem;border-bottom:1px solid #f0ebe0}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#fffdf9}
  .ok{color:#065f46;font-weight:600}
  .err{color:#991b1b;font-weight:600}
  .badge{display:inline-block;padding:.1em .55em;border-radius:999px;font-size:.7rem;font-weight:700}
  .b-ok{background:#d1fae5;color:#065f46}
  .b-err{background:#fee2e2;color:#991b1b}
  .b-fe{background:#dbeafe;color:#1e40af}
  .chart-wrap{background:#fff;border:1px solid #d5c7af;border-radius:12px;padding:1.25rem 1.25rem .75rem}
  .chart{display:flex;align-items:flex-end;height:100px;gap:3px}
  .bcol{display:flex;flex-direction:column;align-items:center;flex:1;min-width:0}
  .bfill{background:#d26a32;border-radius:3px 3px 0 0;width:100%;min-height:2px}
  .bfill.zero{background:#e8dfd0}
  .bcnt{font-size:.58rem;color:#55637d;margin-top:2px;min-height:.8em}
  .blbl{font-size:.55rem;color:#55637d;transform:rotate(-40deg) translateX(-2px);white-space:nowrap;margin-top:6px;transform-origin:top left}
  .mono{font-family:Consolas,monospace;font-size:.8rem}
</style></head>
<body>
<h1>School Scanner - Analytics</h1>
<p class="sub" id="sub"></p>

<h2>Overview</h2>
<div class="grid4" id="overview"></div>

<h2>By Branch</h2>
<table><thead><tr><th>Branch</th><th>Total</th><th>OK</th><th>Errors</th><th>Avg time</th></tr></thead><tbody id="branch-body"></tbody></table>

<h2>By Country</h2>
<table><thead><tr><th>Country</th><th>Requests</th></tr></thead><tbody id="country-body"></tbody></table>

<h2>Daily Requests - last 14 days</h2>
<div class="chart-wrap"><div class="chart" id="chart"></div></div>

<h2>Frontend Events</h2>
<div class="grid4 grid5" id="fe-grid"></div>

<h2>Recent Events</h2>
<table><thead><tr><th>Time</th><th>Event</th><th>Detail</th><th>Location</th></tr></thead><tbody id="recent-body"></tbody></table>

<script>
var S = $statsJson;
document.getElementById('sub').textContent = 'Generated ' + S.generatedAt + ' - refresh to update';

// Overview
var ov = [
  {v: S.total,                      l: 'Total requests'},
  {v: S.successRate + '%',          l: 'Success rate'},
  {v: (S.avgMs/1000).toFixed(1)+'s',l: 'Avg response (ok)'},
  {v: S.last7d,                     l: 'Last 7 days'}
];
var ovEl = document.getElementById('overview');
ov.forEach(function(o){
  var d = document.createElement('div'); d.className='card';
  d.innerHTML='<div class="val">'+o.v+'</div><div class="lbl">'+o.l+'</div>';
  ovEl.appendChild(d);
});

// Branch table
var bb = document.getElementById('branch-body');
(S.byBranch||[]).forEach(function(b){
  var avg = b.avgMs > 0 ? (b.avgMs/1000).toFixed(1)+'s' : '-';
  var tr = document.createElement('tr');
  tr.innerHTML='<td>'+b.label+'</td><td>'+b.total+'</td><td class="ok">'+b.ok+'</td><td class="err">'+(b.errors||0)+'</td><td>'+avg+'</td>';
  bb.appendChild(tr);
});
if(!(S.byBranch||[]).some(function(b){return b.total>0;})){
  var tr=document.createElement('tr');tr.innerHTML='<td colspan="5" style="color:#55637d;text-align:center;padding:1.5rem">No requests yet</td>';bb.appendChild(tr);
}

// Country table
var cb=document.getElementById('country-body');
var countries=S.topCountries||[];
if(countries.length===0){
  var tr=document.createElement('tr');tr.innerHTML='<td colspan="2" style="color:#55637d;text-align:center;padding:1.5rem">No data yet</td>';cb.appendChild(tr);
}else{
  countries.forEach(function(c){
    var tr=document.createElement('tr');
    tr.innerHTML='<td>'+c.country+'</td><td>'+c.count+'</td>';
    cb.appendChild(tr);
  });
}

// Daily chart
var daily=S.daily||{};var dates=Object.keys(daily);
var mx=Math.max.apply(null,dates.map(function(d){return daily[d];}).concat([1]));
var ch=document.getElementById('chart');
dates.forEach(function(d){
  var cnt=daily[d];var pct=Math.max(Math.round(cnt/mx*100),cnt>0?3:0);
  var col=document.createElement('div');col.className='bcol';
  col.innerHTML='<div class="bfill'+(cnt===0?' zero':'')+'" style="height:'+pct+'%"></div>'
    +'<div class="bcnt">'+(cnt||'')+'</div>'
    +'<div class="blbl">'+d.slice(5)+'</div>';
  ch.appendChild(col);
});

// Frontend events
var fe=S.fe||{};
var feItems=[
  {v:fe.branchSelects||0,   l:'Branch selections'},
  {v:fe.submits||0,          l:'Questions submitted'},
  {v:fe.resultsRendered||0,  l:'Results rendered'},
  {v:fe.ctaClicks||0,        l:'Coffee CTA clicks'},
  {v:fe.feedbackClicks||0,   l:'Feedback clicks'}
];
var feEl=document.getElementById('fe-grid');
feItems.forEach(function(o){
  var d=document.createElement('div');d.className='card';
  d.innerHTML='<div class="val">'+o.v+'</div><div class="lbl">'+o.l+'</div>';
  feEl.appendChild(d);
});

// Recent events
var rb=document.getElementById('recent-body');
var rows=S.recentRows||[];
if(rows.length===0){
  var tr=document.createElement('tr');tr.innerHTML='<td colspan="4" style="color:#55637d;text-align:center;padding:1.5rem">No events yet</td>';rb.appendChild(tr);
}else{
  rows.forEach(function(r){
    var cls = r.name==='research_request' ? (r.detail&&r.detail.indexOf(',ok,')>=0?'b-ok':'b-err') : 'b-fe';
    var tr=document.createElement('tr');
    tr.innerHTML='<td class="mono">'+(r.ts||'')+'</td>'
      +'<td><span class="badge '+cls+'">'+(r.name||'')+'</span></td>'
      +'<td class="mono">'+(r.detail||'')+'</td>'
      +'<td>'+(r.loc||'')+'</td>';
    rb.appendChild(tr);
  });
}
</script>
</body></html>
"@
}

Export-ModuleMember -Function Get-GeoLocation, Write-AnalyticsEvent, Get-EventProp, Test-AdminAuth, Build-AnalyticsDashboard
