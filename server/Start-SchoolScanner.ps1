param(
    [int]$Port = 8080,
    [string]$Root = (Join-Path $PSScriptRoot "..\web")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Import-Module (Join-Path $PSScriptRoot "SchoolScanner.Server.psm1") -Force
Import-Module (Join-Path $PSScriptRoot "SchoolScanner.Config.psm1") -Force
Import-Module (Join-Path $PSScriptRoot "SchoolScanner.LiveRetrieval.psm1") -Force
Import-Module (Join-Path $PSScriptRoot "SchoolScanner.Analytics.psm1") -Force

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()

$rateWindowSeconds = 60
$maxRequestsPerWindow = 30
$requestLog = @{}
# Use the config root env var directly — avoids module scope issues
$_configRoot = [System.Environment]::GetEnvironmentVariable("SCHOOLSCANNER_CONFIG_ROOT", "Process")
if ([string]::IsNullOrWhiteSpace($_configRoot)) {
    $_configRoot = [System.Environment]::GetEnvironmentVariable("SCHOOLSCANNER_CONFIG_ROOT", "User")
}
if ([string]::IsNullOrWhiteSpace($_configRoot)) {
    $_configRoot = [System.Environment]::GetEnvironmentVariable("SCHOOLSCANNER_CONFIG_ROOT", "Machine")
}
if ([string]::IsNullOrWhiteSpace($_configRoot)) {
    $_configRoot = Join-Path $PSScriptRoot "..\..\.local"
}
$errorLog     = Join-Path $_configRoot "server-error.log"
$analyticsLog = Join-Path $_configRoot "analytics.jsonl"
$maxHeaderBytes = 16384
$maxBodyBytes = 4096

Write-Host "School Scanner listening on http://localhost:$Port/"
Write-Host "Analytics: $analyticsLog"

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
                    $html = Build-AnalyticsDashboard -LogPath $analyticsLog
                    $htmlBytes = [System.Text.Encoding]::UTF8.GetBytes($html)
                    $adminCsp = @{ "Content-Security-Policy" = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'" }
                    Send-HttpResponse -Client $client -StatusCode 200 -ReasonPhrase "OK" -ContentType "text/html; charset=utf-8" -BodyBytes $htmlBytes -ExtraHeaders $adminCsp
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
                    $adminCsp = @{ "Content-Security-Policy" = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'" }
                    Send-HttpResponse -Client $client -StatusCode 200 -ReasonPhrase "OK" -ContentType "text/html; charset=utf-8" -BodyBytes $htmlBytes -ExtraHeaders $adminCsp
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

                $geo = Get-GeoLocation -IP $request.ClientAddress
                Write-AnalyticsEvent -Name "research_request" -LogPath $analyticsLog -Properties @{
                    branch  = [string]$body["branch"]
                    ms      = [int]$sw.ElapsedMilliseconds
                    status  = if ($result["status"] -eq "completed") { "ok" } else { "error" }
                    ip      = [string]$request.ClientAddress
                    country = [string]$geo.country
                    region  = [string]$geo.region
                    city    = [string]$geo.city
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

                $geo = Get-GeoLocation -IP $request.ClientAddress
                Write-AnalyticsEvent -Name "research_request" -LogPath $analyticsLog -Properties @{
                    branch  = [string]$body["branch"]
                    ms      = [int]$sw.ElapsedMilliseconds
                    status  = if ($result["status"] -eq "completed") { "ok" } else { "error" }
                    ip      = [string]$request.ClientAddress
                    country = [string]$geo.country
                    region  = [string]$geo.region
                    city    = [string]$geo.city
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

                Write-AnalyticsEvent -Name $event -LogPath $analyticsLog -Properties $props
                # sendBeacon closes the connection immediately — ignore disposed client errors
                try {
                    Send-HttpResponse -Client $client -StatusCode 204 -ReasonPhrase "No Content" -BodyBytes ([byte[]]::new(0)) -ContentType "text/plain; charset=utf-8"
                } catch { }
                continue
            }

            Send-JsonResponse -Client $client -StatusCode 404 -ReasonPhrase "Not Found" -Body @{ error = "Not found." }
        }
        catch {
            $message = [string]$_.Exception.Message

            # Silently ignore abrupt client disconnects (sendBeacon, keep-alive probes, etc.)
            if ($message -like "*disposed object*" -or $message -like "*transport connection*" -or $message -like "*forcibly closed*") {
                try { $client.Close() } catch { }
                continue
            }

            $stackTrace = [string]$_.ScriptStackTrace
            $logLine = "[{0}] {1}`n  at: {2}" -f (Get-Date).ToString("s"), $message, $stackTrace
            try { Add-Content -LiteralPath $errorLog -Value $logLine } catch {}
            Write-Host $logLine

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
