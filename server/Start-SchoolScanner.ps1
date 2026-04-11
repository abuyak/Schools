param(
    [int]$Port = 8080,
    [string]$Root = (Join-Path $PSScriptRoot "..\web")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Import-Module (Join-Path $PSScriptRoot "SchoolScanner.Server.psm1") -Force
Import-Module (Join-Path $PSScriptRoot "SchoolScanner.Config.psm1") -Force
Import-Module (Join-Path $PSScriptRoot "SchoolScanner.LiveRetrieval.psm1") -Force

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()

$rateWindowSeconds = 60
$maxRequestsPerWindow = 30
$requestLog = @{}
# Prefer config root for persistent logs; fall back to TEMP if module
# is unavailable or the root directory cannot be resolved.
try {
    $configRoot   = Get-SchoolScannerConfigRoot
    $errorLog     = Join-Path $configRoot "server-error.log"
    $analyticsLog = Join-Path $configRoot "analytics.jsonl"
} catch {
    $errorLog     = Join-Path $env:TEMP "schoolscanner-server-error.log"
    $analyticsLog = Join-Path $env:TEMP "schoolscanner-analytics.jsonl"
}
$maxHeaderBytes = 16384
$maxBodyBytes = 4096

Write-Host "School Scanner PoC listening on http://localhost:$Port/"

function Get-ResponseHeaderLines {
    param(
        [hashtable]$Headers
    )

    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($key in $Headers.Keys) {
        $lines.Add(("{0}: {1}" -f $key, $Headers[$key]))
    }
    return $lines
}

function Send-HttpResponse {
    param(
        [Parameter(Mandatory)]
        [System.Net.Sockets.TcpClient]$Client,
        [Parameter(Mandatory)]
        [int]$StatusCode,
        [Parameter(Mandatory)]
        [string]$ReasonPhrase,
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [byte[]]$BodyBytes,
        [Parameter(Mandatory)]
        [string]$ContentType,
        [hashtable]$ExtraHeaders = @{}
    )

    $stream = $Client.GetStream()
    $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::ASCII, 1024, $true)
    $writer.NewLine = "`r`n"

    $headers = Get-SecurityHeaders -ApiResponse:($ContentType -like "application/json*")
    foreach ($key in $ExtraHeaders.Keys) {
        $headers[$key] = $ExtraHeaders[$key]
    }
    $headers["Content-Type"] = $ContentType
    $headers["Content-Length"] = [string]$BodyBytes.Length
    $headers["Connection"] = "close"

    $writer.WriteLine("HTTP/1.1 $StatusCode $ReasonPhrase")
    foreach ($line in (Get-ResponseHeaderLines -Headers $headers)) {
        $writer.WriteLine($line)
    }
    $writer.WriteLine("")
    $writer.Flush()

    $stream.Write($BodyBytes, 0, $BodyBytes.Length)
    $stream.Flush()
    $writer.Dispose()
    $Client.Close()
}

function Send-JsonResponse {
    param(
        [System.Net.Sockets.TcpClient]$Client,
        [int]$StatusCode,
        [string]$ReasonPhrase,
        $Body
    )

    $json = $Body | ConvertTo-Json -Depth 6 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Send-HttpResponse -Client $Client -StatusCode $StatusCode -ReasonPhrase $ReasonPhrase -BodyBytes $bytes -ContentType "application/json; charset=utf-8"
}

function Send-FileResponse {
    param(
        [System.Net.Sockets.TcpClient]$Client,
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Send-JsonResponse -Client $Client -StatusCode 404 -ReasonPhrase "Not Found" -Body @{ error = "Not found." }
        return
    }

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $contentType = Get-MimeType -Path $Path
    Send-HttpResponse -Client $Client -StatusCode 200 -ReasonPhrase "OK" -BodyBytes $bytes -ContentType $contentType
}

function Read-Request {
    param(
        [System.Net.Sockets.TcpClient]$Client
    )

    $stream = $Client.GetStream()
    $stream.ReadTimeout = 5000
    $buffer = New-Object byte[] 1024
    $memory = New-Object System.IO.MemoryStream
    $headerEnd = -1

    while ($headerEnd -lt 0) {
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) {
            break
        }

        $memory.Write($buffer, 0, $read)
        if ($memory.Length -gt $maxHeaderBytes) {
            throw [System.InvalidOperationException]::new("BAD_REQUEST: Headers too large.")
        }
        $raw = [System.Text.Encoding]::ASCII.GetString($memory.ToArray())
        $headerEnd = $raw.IndexOf("`r`n`r`n")
    }

    if ($headerEnd -lt 0) {
        throw [System.InvalidOperationException]::new("BAD_REQUEST: Malformed request headers.")
    }

    $allBytes = $memory.ToArray()
    $headerBytes = $allBytes[0..($headerEnd - 1)]
    $headerText = [System.Text.Encoding]::ASCII.GetString($headerBytes)
    $headerLines = $headerText -split "`r`n"
    $requestLine = $headerLines[0]
    if ([string]::IsNullOrWhiteSpace($requestLine)) {
        throw [System.InvalidOperationException]::new("BAD_REQUEST: Missing request line.")
    }

    $headers = @{}
    if ($headerLines.Length -gt 1) {
        foreach ($line in $headerLines[1..($headerLines.Length - 1)]) {
            if ([string]::IsNullOrWhiteSpace($line)) {
                continue
            }

            $parts = $line.Split(":", 2)
            if ($parts.Count -eq 2) {
                $name = $parts[0].Trim().ToLowerInvariant()
                $headers[$name] = $parts[1].Trim()
            }
        }
    }

    if ($headers.ContainsKey("transfer-encoding") -and ([string]$headers["transfer-encoding"]).ToLowerInvariant().Contains("chunked")) {
        throw [System.InvalidOperationException]::new("BAD_REQUEST: Chunked transfer encoding is not supported.")
    }

    $contentLength = 0
    if ($headers.ContainsKey("content-length")) {
        [void][int]::TryParse([string]$headers["content-length"], [ref]$contentLength)
    }
    if ($contentLength -gt $maxBodyBytes) {
        throw [System.InvalidOperationException]::new("BAD_REQUEST: Payload too large.")
    }

    if ($headers.ContainsKey("expect") -and ([string]$headers["expect"]).ToLowerInvariant().Contains("100-continue")) {
        $continueBytes = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 100 Continue`r`n`r`n")
        $stream.Write($continueBytes, 0, $continueBytes.Length)
        $stream.Flush()
    }

    $bodyStart = $headerEnd + 4
    $bodyBytes = New-Object System.Collections.Generic.List[byte]
    if ($allBytes.Length -gt $bodyStart) {
        $initialBody = $allBytes[$bodyStart..($allBytes.Length - 1)]
        foreach ($byte in $initialBody) {
            $bodyBytes.Add($byte)
        }
    }

    while ($bodyBytes.Count -lt $contentLength) {
        $read = $stream.Read($buffer, 0, [Math]::Min($buffer.Length, $contentLength - $bodyBytes.Count))
        if ($read -le 0) {
            break
        }
        for ($i = 0; $i -lt $read; $i++) {
            $bodyBytes.Add($buffer[$i])
        }
    }

    if ($bodyBytes.Count -ne $contentLength) {
        throw [System.InvalidOperationException]::new("BAD_REQUEST: Incomplete request body.")
    }

    $bodyText = ""
    if ($contentLength -gt 0) {
        $bodyText = [System.Text.Encoding]::UTF8.GetString($bodyBytes.ToArray())
    }

    $parts = $requestLine.Split(" ")
    if ($parts.Length -lt 2) {
        throw [System.InvalidOperationException]::new("BAD_REQUEST: Malformed request line.")
    }
    if ($parts[0] -notin @("GET", "POST")) {
        throw [System.InvalidOperationException]::new("BAD_REQUEST: Method not supported.")
    }
    $rawTarget = $parts[1]
    if ([string]::IsNullOrWhiteSpace($rawTarget) -or -not $rawTarget.StartsWith("/")) {
        throw [System.InvalidOperationException]::new("BAD_REQUEST: Malformed request target.")
    }
    $uri = [System.Uri]::new("http://localhost$rawTarget")
    $queryParams = @{}
    foreach ($entry in $uri.Query.TrimStart("?").Split("&")) {
        if ([string]::IsNullOrWhiteSpace($entry)) {
            continue
        }

        $pair = $entry.Split("=", 2)
        $key = [System.Uri]::UnescapeDataString($pair[0])
        $value = if ($pair.Count -eq 2) { [System.Uri]::UnescapeDataString($pair[1]) } else { "" }
        $queryParams[$key] = $value
    }

    return @{
        Method = $parts[0]
        Path = $uri.AbsolutePath
        RawTarget = $rawTarget
        Query = $queryParams
        Headers = $headers
        Body = $bodyText
        ClientAddress = ([System.Net.IPEndPoint]$Client.Client.RemoteEndPoint).Address.ToString()
    }
}

function Write-AnalyticsEvent {
    param(
        [Parameter(Mandatory)]
        [string]$Name,
        [hashtable]$Properties = @{}
    )

    $record = [ordered]@{
        ts = (Get-Date).ToUniversalTime().ToString("o")
        name = $Name
        props = $Properties
    }

    Add-Content -LiteralPath $script:analyticsLog -Value ($record | ConvertTo-Json -Depth 4 -Compress)
}

function Test-AdminAuth {
    param([hashtable]$Request)
    # Read token directly from settings file — avoids module export issues
    $configFile = @{}
    try {
        $settingsPath = Join-Path (Get-SchoolScannerConfigRoot) "research-settings.json"
        if (Test-Path -LiteralPath $settingsPath) {
            $configFile = ConvertTo-PlainHashtable -InputObject (ConvertFrom-Json -InputObject (Get-Content -LiteralPath $settingsPath -Raw))
        }
    } catch {}
    $token = if ($configFile.ContainsKey("adminToken")) { [string]$configFile["adminToken"] } else { "" }

    if ([string]::IsNullOrWhiteSpace($token)) { return $true }  # no token = open (dev mode)
    if ($Request.Headers.ContainsKey("authorization")) {
        if ([string]$Request.Headers["authorization"] -eq "Bearer $token") { return $true }
    }
    if ($Request.Query.ContainsKey("token") -and [string]$Request.Query["token"] -eq $token) {
        return $true
    }
    return $false
}

function Send-AdminChallenge {
    param([System.Net.Sockets.TcpClient]$Client, [string]$ReturnPath = "/analytics")
    $html = @"
<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Admin Login</title>
<style>
  *{box-sizing:border-box}body{font-family:"Segoe UI",sans-serif;background:#f3ede2;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
  form{background:#fff;border:1px solid #d5c7af;border-radius:16px;padding:2rem;width:320px;box-shadow:0 8px 32px rgba(0,0,0,.08)}
  h1{font-size:1.1rem;margin:0 0 1rem;color:#11203b}
  input{width:100%;padding:.7rem .9rem;border:1px solid #baa889;border-radius:10px;font:inherit;margin-bottom:.75rem}
  button{width:100%;padding:.75rem;background:#8f3b16;color:#fff;border:none;border-radius:10px;font:inherit;font-weight:700;cursor:pointer}
</style></head>
<body><form method="get" action="$ReturnPath">
  <h1>Admin access required</h1>
  <input type="password" name="token" placeholder="Admin token" autofocus required>
  <button type="submit">Enter</button>
</form></body></html>
"@
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($html)
    Send-HttpResponse -Client $Client -StatusCode 401 -ReasonPhrase "Unauthorized" -ContentType "text/html; charset=utf-8" -BodyBytes $bytes
}

function Get-EventProp {
    param($Event, [string]$Key, $Default = "")
    try {
        if ($null -eq $Event) { return $Default }
        $props = $Event.props
        if ($null -eq $props) { return $Default }
        $val = $props.PSObject.Properties[$Key]
        if ($null -eq $val) { return $Default }
        return $val.Value
    } catch { return $Default }
}

function Build-AnalyticsDashboard {
    $logPath = $script:analyticsLog
    $events = @()
    if (Test-Path -LiteralPath $logPath) {
        $events = @(Get-Content -LiteralPath $logPath -Tail 5000 | ForEach-Object {
            try { ConvertFrom-Json $_ } catch { $null }
        } | Where-Object { $null -ne $_ })
    }

    $requests = @($events | Where-Object { [string]$_.name -eq "research_request" })
    $total    = $requests.Count
    $okReqs   = @($requests | Where-Object { (Get-EventProp $_ "status") -eq "ok" })
    $ok       = $okReqs.Count
    $errors   = $total - $ok
    $successRate = if ($total -gt 0) { [Math]::Round($ok * 100.0 / $total, 1) } else { 0 }
    $avgMs = if ($ok -gt 0) {
        [Math]::Round(($okReqs | ForEach-Object { [int](Get-EventProp $_ "ms" 0) } | Measure-Object -Sum).Sum / $ok)
    } else { 0 }

    $cutoff7d = (Get-Date).ToUniversalTime().AddDays(-7)
    $last7d = @($requests | Where-Object { try { ([datetime]$_.ts) -ge $cutoff7d } catch { $false } }).Count

    $branchMap = @{
        "prompt_branch_1" = "01 Evaluate"
        "prompt_branch_2" = "02 Compare"
        "prompt_branch_3" = "03 Area"
        "prompt_branch_4" = "04 Backup"
    }
    $byBranch = foreach ($key in @("prompt_branch_1","prompt_branch_2","prompt_branch_3","prompt_branch_4")) {
        $br   = @($requests | Where-Object { (Get-EventProp $_ "branch") -eq $key })
        $brOk = @($br | Where-Object { (Get-EventProp $_ "status") -eq "ok" })
        $brAvg = if ($brOk.Count -gt 0) {
            [Math]::Round(($brOk | ForEach-Object { [int](Get-EventProp $_ "ms" 0) } | Measure-Object -Sum).Sum / $brOk.Count)
        } else { 0 }
        [ordered]@{ label=$branchMap[$key]; total=$br.Count; ok=$brOk.Count; errors=($br.Count-$brOk.Count); avgMs=$brAvg }
    }

    $daily = [ordered]@{}
    for ($i = 13; $i -ge 0; $i--) {
        $d = (Get-Date).AddDays(-$i).ToString("yyyy-MM-dd")
        $daily[$d] = 0
    }
    foreach ($r in $requests) {
        try { $d = ([datetime]$r.ts).ToLocalTime().ToString("yyyy-MM-dd"); if ($daily.ContainsKey($d)) { $daily[$d]++ } } catch {}
    }

    $fe = @($events | Where-Object { [string]$_.name -ne "research_request" })
    $feStats = [ordered]@{
        branchSelects   = @($fe | Where-Object { [string]$_.name -eq "branch_selected" }).Count
        submits         = @($fe | Where-Object { [string]$_.name -eq "question_submitted" }).Count
        resultsRendered = @($fe | Where-Object { [string]$_.name -eq "result_rendered" }).Count
        ctaClicks       = @($fe | Where-Object { [string]$_.name -eq "cta_click" }).Count
        feedbackClicks  = @($fe | Where-Object { [string]$_.name -eq "feedback_click" }).Count
    }

    $recentRows = @()
    if ($events.Count -gt 0) {
        $recentRows = @($events | Select-Object -Last 30) | Sort-Object { try { [datetime]$_.ts } catch { [datetime]::MinValue } } -Descending | ForEach-Object {
            $ts   = try { ([datetime]$_.ts).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss") } catch { [string]$_.ts }
            $name = [string]$_.name
            $detail = try { switch ($name) {
                "research_request"   { "$((Get-EventProp $_ 'branch') -replace 'prompt_branch_','p'), $(Get-EventProp $_ 'status'), $([Math]::Round([int](Get-EventProp $_ 'ms' 0)/1000,1))s" }
                "branch_selected"    { (Get-EventProp $_ "branch") -replace "prompt_branch_","p" }
                "question_submitted" { (Get-EventProp $_ "branch") -replace "prompt_branch_","p" }
                "result_rendered"    { "$((Get-EventProp $_ 'branch') -replace 'prompt_branch_','p'), $([Math]::Round([int](Get-EventProp $_ 'ms' 0)/1000,1))s" }
                "cta_click"          { Get-EventProp $_ "placement" }
                "feedback_click"     { Get-EventProp $_ "placement" }
                default              { "" }
            } } catch { "" }
            [ordered]@{ ts=$ts; name=$name; detail=$detail }
        }
    }

    $statsJson = [ordered]@{
        total=$total; ok=$ok; errors=$errors; successRate=$successRate
        avgMs=$avgMs; last7d=$last7d
        byBranch=@($byBranch); daily=$daily; fe=$feStats
        recentRows=@($recentRows)
        generatedAt=(Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
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

<h2>Daily Requests - last 14 days</h2>
<div class="chart-wrap"><div class="chart" id="chart"></div></div>

<h2>Frontend Events</h2>
<div class="grid4 grid5" id="fe-grid"></div>

<h2>Recent Events</h2>
<table><thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead><tbody id="recent-body"></tbody></table>

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
  var tr=document.createElement('tr');tr.innerHTML='<td colspan="3" style="color:#55637d;text-align:center;padding:1.5rem">No events yet</td>';rb.appendChild(tr);
}else{
  rows.forEach(function(r){
    var cls = r.name==='research_request' ? (r.detail&&r.detail.indexOf(',ok,')>=0?'b-ok':'b-err') : 'b-fe';
    var tr=document.createElement('tr');
    tr.innerHTML='<td class="mono">'+(r.ts||'')+'</td>'
      +'<td><span class="badge '+cls+'">'+(r.name||'')+'</span></td>'
      +'<td class="mono">'+(r.detail||'')+'</td>';
    rb.appendChild(tr);
  });
}
</script>
</body></html>
"@
}

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()

        try {
            $request = Read-Request -Client $client

            $clientKey = $request.ClientAddress
            $now = Get-Date
            if (-not $requestLog.ContainsKey($clientKey)) {
                $requestLog[$clientKey] = New-Object System.Collections.Generic.List[datetime]
            }

            $recent = New-Object System.Collections.Generic.List[datetime]
            foreach ($item in $requestLog[$clientKey]) {
                if (($now - $item).TotalSeconds -le $rateWindowSeconds) {
                    $recent.Add($item)
                }
            }
            $requestLog[$clientKey] = $recent
            $requestLog[$clientKey].Add($now)

            if ($requestLog[$clientKey].Count -gt $maxRequestsPerWindow) {
                Send-JsonResponse -Client $client -StatusCode 429 -ReasonPhrase "Too Many Requests" -Body @{ error = "Rate limit exceeded." }
                continue
            }

            switch ("{0} {1}" -f $request.Method, $request.Path) {
                "GET /" {
                    Send-FileResponse -Client $client -Path (Join-Path $Root "index.html")
                    continue
                }
                "GET /index.html" {
                    Send-FileResponse -Client $client -Path (Join-Path $Root "index.html")
                    continue
                }
                "GET /styles.css" {
                    Send-FileResponse -Client $client -Path (Join-Path $Root "styles.css")
                    continue
                }
                "GET /api-docs" {
                    Send-FileResponse -Client $client -Path (Join-Path $Root "api-docs.html")
                    continue
                }
                "GET /api-docs.html" {
                    Send-FileResponse -Client $client -Path (Join-Path $Root "api-docs.html")
                    continue
                }
                "GET /app.js" {
                    Send-FileResponse -Client $client -Path (Join-Path $Root "app.js")
                    continue
                }
                "GET /api-docs.js" {
                    Send-FileResponse -Client $client -Path (Join-Path $Root "api-docs.js")
                    continue
                }
                "GET /openapi.json" {
                    Send-FileResponse -Client $client -Path (Join-Path (Join-Path $PSScriptRoot "..") "openapi.json")
                    continue
                }
                "GET /api/health" {
                    Send-JsonResponse -Client $client -StatusCode 200 -ReasonPhrase "OK" -Body @{
                        status = "ok"
                        allowedBranches = @(Get-AllowedBranches)
                        liveRetrieval = Get-LiveRetrievalStatus
                    }
                    continue
                }
                "GET /analytics" {
                    if (-not (Test-AdminAuth -Request $request)) {
                        Send-AdminChallenge -Client $client -ReturnPath "/analytics"
                        continue
                    }
                    $html = Build-AnalyticsDashboard
                    $htmlBytes = [System.Text.Encoding]::UTF8.GetBytes($html)
                    Send-HttpResponse -Client $client -StatusCode 200 -ReasonPhrase "OK" -ContentType "text/html; charset=utf-8" -BodyBytes $htmlBytes
                    continue
                }
                "GET /config" {
                    if (-not (Test-AdminAuth -Request $request)) {
                        Send-AdminChallenge -Client $client -ReturnPath "/config"
                        continue
                    }
                    $rs = Get-LiveRetrievalStatus
                    $html = @"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>School Scanner - Config</title>
<style>
  body { font-family: "Segoe UI", sans-serif; background: #f3ede2; color: #11203b; margin: 0; padding: 2rem; }
  h1 { font-size: 1.4rem; margin: 0 0 1.5rem; }
  table { border-collapse: collapse; width: 100%; max-width: 640px; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
  th, td { padding: 0.7rem 1rem; text-align: left; border-bottom: 1px solid #e5e7eb; font-size: 0.9rem; }
  th { background: #f8f2e7; font-weight: 700; width: 45%; color: #8f3b16; }
  tr:last-child th, tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 0.15em 0.6em; border-radius: 999px; font-size: 0.78rem; font-weight: 700; }
  .ok { background: #d1fae5; color: #065f46; }
  .warn { background: #fef9c3; color: #854d0e; }
  p.note { font-size: 0.82rem; color: #55637d; margin-top: 1rem; max-width: 640px; }
</style>
</head>
<body>
<h1>School Scanner - Runtime Config</h1>
<table>
  <tr><th>Model</th><td>$($rs.model)</td></tr>
  <tr><th>Provider</th><td>$($rs.provider)</td></tr>
  <tr><th>Base URL</th><td>$($rs.baseUrl)</td></tr>
  <tr><th>Online search</th><td>$(if ($rs.onlineSearchEnabled) { '<span class="badge ok">Enabled</span>' } else { '<span class="badge warn">Disabled - API key missing</span>' })</td></tr>
  <tr><th>API key required</th><td>$(if ($rs.apiKeyRequired) { 'Yes' } else { 'No' })</td></tr>
  <tr><th>Reasoning effort</th><td>$($rs.reasoningEffort)</td></tr>
  <tr><th>Request timeout</th><td>$($rs.requestTimeoutSeconds) seconds</td></tr>
  <tr><th>Max output tokens</th><td>$($rs.maxOutputTokens)</td></tr>
  <tr><th>Config root</th><td>$($rs.configRoot)</td></tr>
</table>
<p class="note">Settings are stored in <code>$($rs.configRoot)\research-settings.json</code>. Changes take effect on the next request without a server restart.</p>
</body>
</html>
"@
                    $htmlBytes = [System.Text.Encoding]::UTF8.GetBytes($html)
                    Send-HttpResponse -Client $client -StatusCode 200 -ReasonPhrase "OK" -ContentType "text/html; charset=utf-8" -BodyBytes $htmlBytes
                    continue
                }
            }

            if ($request.Method -eq "GET" -and $request.Path -eq "/api/research") {
                $body = @{
                    branch = $request.Query["branch"]
                    question = $request.Query["question"]
                    email = $request.Query["email"]
                }

                $validation = Test-QuestionPayload -Payload $body
                if (-not $validation.IsValid) {
                    Send-JsonResponse -Client $client -StatusCode 400 -ReasonPhrase "Bad Request" -Body @{ error = "Validation failed."; details = $validation.Errors }
                    continue
                }

                $sw = [System.Diagnostics.Stopwatch]::StartNew()
                $result = Invoke-OpenAIResearch -Payload $body
                $sw.Stop()

                $statusCode = if ($result["status"] -eq "completed") { 200 } else { 503 }
                $reason = if ($statusCode -eq 200) { "OK" } else { "Service Unavailable" }

                Write-AnalyticsEvent -Name "research_request" -Properties @{
                    branch = [string]$body["branch"]
                    ms     = [int]$sw.ElapsedMilliseconds
                    status = if ($result["status"] -eq "completed") { "ok" } else { "error" }
                }

                Send-JsonResponse -Client $client -StatusCode $statusCode -ReasonPhrase $reason -Body $result
                continue
            }

            if ($request.Method -eq "POST" -and $request.Path -eq "/api/research") {
                try {
                    $rawBody = [string]$request.Body
                    $rawBody = $rawBody.Trim([char]0, [char]0xFEFF)
                    $body = ConvertTo-PlainHashtable -InputObject (ConvertFrom-Json -InputObject $rawBody)
                }
                catch {
                    Send-JsonResponse -Client $client -StatusCode 400 -ReasonPhrase "Bad Request" -Body @{ error = "Invalid JSON payload." }
                    continue
                }

                $validation = Test-QuestionPayload -Payload $body
                if (-not $validation.IsValid) {
                    Send-JsonResponse -Client $client -StatusCode 400 -ReasonPhrase "Bad Request" -Body @{ error = "Validation failed."; details = $validation.Errors }
                    continue
                }

                $sw = [System.Diagnostics.Stopwatch]::StartNew()
                $result = Invoke-OpenAIResearch -Payload $body
                $sw.Stop()

                $statusCode = if ($result.ContainsKey("httpStatus") -and $result["httpStatus"]) { [int]$result["httpStatus"] } elseif ($result["status"] -eq "completed") { 200 } else { 503 }
                $reason = if ($statusCode -eq 200) { "OK" } elseif ($statusCode -eq 400) { "Bad Request" } elseif ($statusCode -eq 401) { "Unauthorized" } elseif ($statusCode -eq 429) { "Too Many Requests" } elseif ($statusCode -eq 502) { "Bad Gateway" } elseif ($statusCode -eq 504) { "Gateway Timeout" } else { "Service Unavailable" }

                Write-AnalyticsEvent -Name "research_request" -Properties @{
                    branch = [string]$body["branch"]
                    ms     = [int]$sw.ElapsedMilliseconds
                    status = if ($result["status"] -eq "completed") { "ok" } else { "error" }
                }

                Send-JsonResponse -Client $client -StatusCode $statusCode -ReasonPhrase $reason -Body $result
                continue
            }

            if ($request.Method -eq "POST" -and $request.Path -eq "/api/analytics/click") {
                try {
                    $rawBody = [string]$request.Body
                    $rawBody = $rawBody.Trim([char]0, [char]0xFEFF)
                    $body = ConvertTo-PlainHashtable -InputObject (ConvertFrom-Json -InputObject $rawBody)
                }
                catch {
                    Send-JsonResponse -Client $client -StatusCode 400 -ReasonPhrase "Bad Request" -Body @{ error = "Invalid JSON payload." }
                    continue
                }

                $event = if ($body.ContainsKey("event")) { [string]$body["event"] } else { "" }
                if ([string]::IsNullOrWhiteSpace($event) -or $event.Length -gt 64) {
                    Send-JsonResponse -Client $client -StatusCode 400 -ReasonPhrase "Bad Request" -Body @{ error = "Invalid event." }
                    continue
                }

                $props = @{}
                foreach ($key in @("branch", "placement", "ms", "utm_campaign", "utm_content")) {
                    if ($body.ContainsKey($key)) {
                        $value = [string]$body[$key]
                        if ($value.Length -le 128) {
                            $props[$key] = $value
                        }
                    }
                }

                Write-AnalyticsEvent -Name $event -Properties $props
                Send-HttpResponse -Client $client -StatusCode 204 -ReasonPhrase "No Content" -BodyBytes ([byte[]]::new(0)) -ContentType "text/plain; charset=utf-8"
                continue
            }

            Send-JsonResponse -Client $client -StatusCode 404 -ReasonPhrase "Not Found" -Body @{ error = "Not found." }
        }
        catch {
            $message = [string]$_.Exception.Message
            $stackTrace = [string]$_.ScriptStackTrace
            $logLine = "[{0}] {1}`n  at: {2}" -f (Get-Date).ToString("s"), $message, $stackTrace
            try { Add-Content -LiteralPath $script:errorLog -Value $logLine } catch {}
            Write-Host $logLine  # also echo to console so we can see it

            if ($client.Connected) {
                try {
                    if ($message.StartsWith("BAD_REQUEST:")) {
                        Send-JsonResponse -Client $client -StatusCode 400 -ReasonPhrase "Bad Request" -Body @{ error = "Bad request." }
                    }
                    else {
                        Send-JsonResponse -Client $client -StatusCode 500 -ReasonPhrase "Internal Server Error" -Body @{ error = "Server error." }
                    }
                }
                catch {
                    try { $client.Close() } catch { }
                }
            }
        }
    }
}
finally {
    $listener.Stop()
}
