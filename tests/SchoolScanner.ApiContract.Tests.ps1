Set-StrictMode -Version Latest

$script:contractPort = 8092
$script:contractBase  = "http://127.0.0.1:" + $script:contractPort
$script:contractServerProcess   = $null
$script:contractConfigRoot = $null

# ---------------------------------------------------------------------------
# Helper – makes an HTTP request using HttpWebRequest directly so we have
# reliable access to response bodies for both 2xx and 4xx/5xx status codes,
# and so GET requests never accidentally send a body.
# ---------------------------------------------------------------------------
function Invoke-ApiRequest {
    param(
        [string]$Method      = "GET",
        [string]$Path,
        $Body                = $null,      # no [string] type so $null stays $null
        [string]$ContentType = "application/json"
    )

    $uri = $script:contractBase + $Path

    $parseJson = {
        param($text)
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            try { return ConvertFrom-Json -InputObject $text } catch { }
        }
        return $null
    }

    $readResponse = {
        param($resp)
        $stream  = $resp.GetResponseStream()
        $reader  = New-Object System.IO.StreamReader($stream)
        $content = $reader.ReadToEnd()
        $reader.Close()
        $resp.Close()
        $hdrs = @{}
        foreach ($k in $resp.Headers.AllKeys) { $hdrs[$k] = $resp.Headers[$k] }
        return @{
            StatusCode = [int]$resp.StatusCode
            Content    = $content
            Json       = (& $parseJson $content)
            Headers    = $hdrs
        }
    }

    [System.Net.ServicePointManager]::Expect100Continue = $false

    $req         = [System.Net.HttpWebRequest]::Create($uri)
    $req.Method  = $Method
    $req.Timeout = 10000

    if ($null -ne $Body) {
        $bytes              = [System.Text.Encoding]::UTF8.GetBytes([string]$Body)
        $req.ContentType    = $ContentType
        $req.ContentLength  = $bytes.Length
        $bodyStream         = $req.GetRequestStream()
        $bodyStream.Write($bytes, 0, $bytes.Length)
        $bodyStream.Close()
    }

    try {
        $resp = $req.GetResponse()
        return & $readResponse $resp
    }
    catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { throw }
        return & $readResponse $resp
    }
}

# ---------------------------------------------------------------------------
# Describe block – starts its own server on port 8092
# ---------------------------------------------------------------------------
Describe "School Scanner API contract" {

    BeforeAll {
        $serverScript = Join-Path $PSScriptRoot "..\server\Start-SchoolScanner.ps1"
        $script:contractConfigRoot = Join-Path $env:TEMP ("schoolscanner-contract-" + [guid]::NewGuid().ToString("N"))
        [System.Environment]::SetEnvironmentVariable("SCHOOLSCANNER_CONFIG_ROOT", $script:contractConfigRoot, "Process")

        $startInfo                        = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName               = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        $startInfo.Arguments              = "-ExecutionPolicy Bypass -File `"$serverScript`" -Port $script:contractPort"
        $startInfo.UseShellExecute        = $false
        $startInfo.CreateNoWindow         = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError  = $true

        $script:contractServerProcess           = New-Object System.Diagnostics.Process
        $script:contractServerProcess.StartInfo = $startInfo
        [void]$script:contractServerProcess.Start()

        $started = $false
        for ($i = 0; $i -lt 20; $i++) {
            if ($script:contractServerProcess.HasExited) { break }
            try {
                $h = Invoke-RestMethod -Uri ($script:contractBase + "/api/health") -Method Get -TimeoutSec 2
                if ($h.status -eq "ok") { $started = $true; break }
            }
            catch { Start-Sleep -Milliseconds 500 }
        }

        if (-not $started) {
            throw "API contract test server did not start on port $script:contractPort."
        }
    }

    AfterAll {
        if ($script:contractServerProcess -and -not $script:contractServerProcess.HasExited) {
            Stop-Process -Id $script:contractServerProcess.Id -Force -ErrorAction SilentlyContinue
        }
        [System.Environment]::SetEnvironmentVariable("SCHOOLSCANNER_CONFIG_ROOT", $null, "Process")
        if ($script:contractConfigRoot) {
            Remove-Item -LiteralPath $script:contractConfigRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # -----------------------------------------------------------------------
    # GET /api/health
    # -----------------------------------------------------------------------

    It "GET /api/health returns 200" {
        $r = Invoke-ApiRequest -Method GET -Path "/api/health"
        $r.StatusCode | Should Be 200
    }

    It "GET /api/health body has status ok" {
        $r = Invoke-ApiRequest -Method GET -Path "/api/health"
        $r.Json.status | Should Be "ok"
    }

    It "GET /api/health body has all four allowedBranches" {
        $r = Invoke-ApiRequest -Method GET -Path "/api/health"
        $branches = @($r.Json.allowedBranches)
        $branches.Count | Should Be 4
        $branches -contains "prompt_branch_1" | Should Be $true
        $branches -contains "prompt_branch_2" | Should Be $true
        $branches -contains "prompt_branch_3" | Should Be $true
        $branches -contains "prompt_branch_4" | Should Be $true
    }

    It "GET /api/health liveRetrieval object is present and has a mode field" {
        $r = Invoke-ApiRequest -Method GET -Path "/api/health"
        $r.Json.liveRetrieval | Should Not BeNullOrEmpty
        $modePresent = ($r.Json.liveRetrieval | Get-Member -MemberType NoteProperty).Name -contains "mode"
        $modePresent | Should Be $true
    }

    It "GET /api/health response carries required security headers" {
        $r = Invoke-ApiRequest -Method GET -Path "/api/health"
        $r.Headers["X-Content-Type-Options"] | Should Be "nosniff"
        $r.Headers["X-Frame-Options"]         | Should Be "DENY"
        $r.Headers["Cache-Control"]           | Should Be "no-store"
    }

    It "GET /api/health Content-Type is application/json" {
        $r = Invoke-ApiRequest -Method GET -Path "/api/health"
        $r.Headers["Content-Type"] | Should Match "application/json"
    }

    # -----------------------------------------------------------------------
    # POST /api/research – validation (400)
    # -----------------------------------------------------------------------

    It "POST /api/research returns 400 when branch is absent" {
        $r = Invoke-ApiRequest -Method POST -Path "/api/research" -Body '{"question":"Tell me about Highgate"}'
        $r.StatusCode | Should Be 400
        $r.Json.error | Should Not BeNullOrEmpty
    }

    It "POST /api/research returns 400 when question is absent" {
        $r = Invoke-ApiRequest -Method POST -Path "/api/research" -Body '{"branch":"prompt_branch_1"}'
        $r.StatusCode | Should Be 400
        $r.Json.error | Should Not BeNullOrEmpty
    }

    It "POST /api/research returns 400 when question is empty" {
        $r = Invoke-ApiRequest -Method POST -Path "/api/research" -Body '{"branch":"prompt_branch_1","question":""}'
        $r.StatusCode | Should Be 400
    }

    It "POST /api/research returns 400 when question is whitespace only" {
        $r = Invoke-ApiRequest -Method POST -Path "/api/research" -Body '{"branch":"prompt_branch_1","question":"   "}'
        $r.StatusCode | Should Be 400
    }

    It "POST /api/research returns 400 for an unknown branch value" {
        $r = Invoke-ApiRequest -Method POST -Path "/api/research" -Body '{"branch":"not_a_branch","question":"Test question"}'
        $r.StatusCode | Should Be 400
    }

    It "POST /api/research returns 400 when question exceeds 600 characters" {
        $longQ   = "x" * 601
        $payload = @{ branch = "prompt_branch_1"; question = $longQ } | ConvertTo-Json -Compress
        $r = Invoke-ApiRequest -Method POST -Path "/api/research" -Body $payload
        $r.StatusCode | Should Be 400
    }

    It "POST /api/research returns 400 for an invalid email format" {
        $r = Invoke-ApiRequest -Method POST -Path "/api/research" -Body '{"branch":"prompt_branch_1","question":"Tell me about Eton","email":"not-an-email"}'
        $r.StatusCode | Should Be 400
    }

    It "POST /api/research returns 400 for malformed JSON" {
        $r = Invoke-ApiRequest -Method POST -Path "/api/research" -Body '{"branch":"prompt_branch_1", bad json'
        $r.StatusCode | Should Be 400
    }

    It "POST /api/research 400 responses carry security headers" {
        $r = Invoke-ApiRequest -Method POST -Path "/api/research" -Body '{"question":"missing branch"}'
        $r.Headers["X-Content-Type-Options"] | Should Be "nosniff"
        $r.Headers["X-Frame-Options"]         | Should Be "DENY"
    }

    # -----------------------------------------------------------------------
    # POST /api/research – valid payload reaches the research layer (503 when
    # no API key is configured, but the response shape must still conform)
    # -----------------------------------------------------------------------

    It "POST /api/research returns 503 with a structured body when the backend is unconfigured" {
        $r = Invoke-ApiRequest -Method POST -Path "/api/research" -Body '{"branch":"prompt_branch_1","question":"Tell me about Highgate School"}'
        $r.StatusCode | Should Be 503
        # The body must carry ResearchResponse shape fields even for error states
        $r.Json.status  | Should Not BeNullOrEmpty
        $r.Json.title   | Should Not BeNullOrEmpty
        $r.Json.summary | Should Not BeNullOrEmpty
        @($r.Json.keyPoints).Count | Should BeGreaterThan 0
        @($r.Json.sections).Count  | Should BeGreaterThan 0
    }

    It "POST /api/research accepts a valid optional email and does not return 400" {
        $r = Invoke-ApiRequest -Method POST -Path "/api/research" -Body '{"branch":"prompt_branch_2","question":"Compare Eton and Harrow","email":"parent@example.com"}'
        $r.StatusCode | Should Not Be 400
    }

    It "POST /api/research each valid branch value passes validation" {
        $branches = @("prompt_branch_1","prompt_branch_2","prompt_branch_3","prompt_branch_4")
        foreach ($branch in $branches) {
            $payload = @{ branch = $branch; question = "School question" } | ConvertTo-Json -Compress
            $r = Invoke-ApiRequest -Method POST -Path "/api/research" -Body $payload
            $r.StatusCode | Should Not Be 400
        }
    }

    # -----------------------------------------------------------------------
    # GET /api/research – validation (400) via query string
    # -----------------------------------------------------------------------

    It "GET /api/research returns 400 when branch param is missing" {
        $r = Invoke-ApiRequest -Method GET -Path "/api/research?question=Tell+me+about+Highgate"
        $r.StatusCode | Should Be 400
    }

    It "GET /api/research returns 400 when question param is missing" {
        $r = Invoke-ApiRequest -Method GET -Path "/api/research?branch=prompt_branch_1"
        $r.StatusCode | Should Be 400
    }

    It "GET /api/research returns 400 for an invalid branch param" {
        $r = Invoke-ApiRequest -Method GET -Path "/api/research?branch=bad_branch&question=Test"
        $r.StatusCode | Should Be 400
    }

    It "GET /api/research returns 400 for a question exceeding 600 characters" {
        $longQ = [uri]::EscapeDataString(("y" * 601))
        $r = Invoke-ApiRequest -Method GET -Path ("/api/research?branch=prompt_branch_1&question=" + $longQ)
        $r.StatusCode | Should Be 400
    }

    It "GET /api/research returns 503 with a structured body when the backend is unconfigured" {
        $r = Invoke-ApiRequest -Method GET -Path "/api/research?branch=prompt_branch_1&question=Is+Highgate+good%3F"
        $r.StatusCode | Should Be 503
        $r.Json.status | Should Not BeNullOrEmpty
    }

}

# ---------------------------------------------------------------------------
# Second describe block — analytics and general HTTP behaviour.
# Uses port 8093 so it gets its own fresh rate-limit counter and does not
# share the 30-request window with the health/research tests above.
# ---------------------------------------------------------------------------

$script:analyticsPort = 8093
$script:analyticsBase = "http://127.0.0.1:" + $script:analyticsPort
$script:analyticsServerProcess = $null
$script:analyticsConfigRoot    = $null

function Invoke-AnalyticsRequest {
    param(
        [string]$Method      = "GET",
        [string]$Path,
        $Body                = $null,
        [string]$ContentType = "application/json"
    )

    $uri = $script:analyticsBase + $Path

    $parseJson = {
        param($text)
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            try { return ConvertFrom-Json -InputObject $text } catch { }
        }
        return $null
    }

    $readResponse = {
        param($resp)
        $stream  = $resp.GetResponseStream()
        $reader  = New-Object System.IO.StreamReader($stream)
        $content = $reader.ReadToEnd()
        $reader.Close()
        $resp.Close()
        $hdrs = @{}
        foreach ($k in $resp.Headers.AllKeys) { $hdrs[$k] = $resp.Headers[$k] }
        return @{
            StatusCode = [int]$resp.StatusCode
            Content    = $content
            Json       = (& $parseJson $content)
            Headers    = $hdrs
        }
    }

    [System.Net.ServicePointManager]::Expect100Continue = $false

    $req        = [System.Net.HttpWebRequest]::Create($uri)
    $req.Method = $Method
    $req.Timeout = 10000

    if ($null -ne $Body) {
        $bytes             = [System.Text.Encoding]::UTF8.GetBytes([string]$Body)
        $req.ContentType   = $ContentType
        $req.ContentLength = $bytes.Length
        $bodyStream        = $req.GetRequestStream()
        $bodyStream.Write($bytes, 0, $bytes.Length)
        $bodyStream.Close()
    }

    try {
        $resp = $req.GetResponse()
        return & $readResponse $resp
    }
    catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { throw }
        return & $readResponse $resp
    }
}

Describe "School Scanner API contract - analytics and HTTP" {

    BeforeAll {
        $serverScript = Join-Path $PSScriptRoot "..\server\Start-SchoolScanner.ps1"
        $script:analyticsConfigRoot = Join-Path $env:TEMP ("schoolscanner-analytics-cfg-" + [guid]::NewGuid().ToString("N"))
        [System.Environment]::SetEnvironmentVariable("SCHOOLSCANNER_CONFIG_ROOT", $script:analyticsConfigRoot, "Process")

        $startInfo                        = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName               = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        $startInfo.Arguments              = "-ExecutionPolicy Bypass -File `"$serverScript`" -Port $script:analyticsPort"
        $startInfo.UseShellExecute        = $false
        $startInfo.CreateNoWindow         = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError  = $true

        $script:analyticsServerProcess           = New-Object System.Diagnostics.Process
        $script:analyticsServerProcess.StartInfo = $startInfo
        [void]$script:analyticsServerProcess.Start()

        $started = $false
        for ($i = 0; $i -lt 20; $i++) {
            if ($script:analyticsServerProcess.HasExited) { break }
            try {
                $h = Invoke-RestMethod -Uri ($script:analyticsBase + "/api/health") -Method Get -TimeoutSec 2
                if ($h.status -eq "ok") { $started = $true; break }
            }
            catch { Start-Sleep -Milliseconds 500 }
        }

        if (-not $started) {
            throw "Analytics test server did not start on port $script:analyticsPort."
        }
    }

    AfterAll {
        if ($script:analyticsServerProcess -and -not $script:analyticsServerProcess.HasExited) {
            Stop-Process -Id $script:analyticsServerProcess.Id -Force -ErrorAction SilentlyContinue
        }
        [System.Environment]::SetEnvironmentVariable("SCHOOLSCANNER_CONFIG_ROOT", $null, "Process")
        if ($script:analyticsConfigRoot) {
            Remove-Item -LiteralPath $script:analyticsConfigRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # -----------------------------------------------------------------------
    # POST /api/analytics/click
    # -----------------------------------------------------------------------

    It "POST /api/analytics/click returns 204 for a minimal valid event" {
        $r = Invoke-AnalyticsRequest -Method POST -Path "/api/analytics/click" -Body '{"event":"branch_selected"}'
        $r.StatusCode | Should Be 204
    }

    It "POST /api/analytics/click returns 204 with all optional fields present" {
        $payload = @{
            event        = "donate_click"
            branch       = "prompt_branch_2"
            placement    = "header"
            utm_campaign = "spring2025"
            utm_content  = "banner_a"
        } | ConvertTo-Json -Compress
        $r = Invoke-AnalyticsRequest -Method POST -Path "/api/analytics/click" -Body $payload
        $r.StatusCode | Should Be 204
    }

    It "POST /api/analytics/click returns 400 when event field is absent" {
        $r = Invoke-AnalyticsRequest -Method POST -Path "/api/analytics/click" -Body '{"branch":"prompt_branch_1"}'
        $r.StatusCode | Should Be 400
    }

    It "POST /api/analytics/click returns 400 when event is an empty string" {
        $r = Invoke-AnalyticsRequest -Method POST -Path "/api/analytics/click" -Body '{"event":""}'
        $r.StatusCode | Should Be 400
    }

    It "POST /api/analytics/click returns 400 when event exceeds 64 characters" {
        $longEvent = "e" * 65
        $payload   = @{ event = $longEvent } | ConvertTo-Json -Compress
        $r = Invoke-AnalyticsRequest -Method POST -Path "/api/analytics/click" -Body $payload
        $r.StatusCode | Should Be 400
    }

    It "POST /api/analytics/click returns 400 for malformed JSON" {
        $r = Invoke-AnalyticsRequest -Method POST -Path "/api/analytics/click" -Body '{bad json}'
        $r.StatusCode | Should Be 400
    }

    # -----------------------------------------------------------------------
    # General HTTP behaviour
    # -----------------------------------------------------------------------

    It "Returns 404 for an unknown API route" {
        $r = Invoke-AnalyticsRequest -Method GET -Path "/api/nonexistent"
        $r.StatusCode | Should Be 404
    }

    It "Static page response does not expose a Server header" {
        $r = Invoke-AnalyticsRequest -Method GET -Path "/"
        $r.StatusCode | Should Be 200
        ($r.Headers.Keys -contains "Server") | Should Be $false
    }

    It "CSP header is present on JSON API responses" {
        $r = Invoke-AnalyticsRequest -Method GET -Path "/api/health"
        $r.Headers["Content-Security-Policy"] | Should Match "default-src 'self'"
    }

    It "Served index.html contains the feedback panel" {
        $r = Invoke-AnalyticsRequest -Method GET -Path "/"
        $r.StatusCode | Should Be 200
        $r.Content | Should Match 'class="feedback-panel"'
        $r.Content | Should Match "Leave feedback"
    }

    It "POST /api/analytics/click accepts an event with an ms field" {
        $payload = @{ event = "result_rendered"; branch = "prompt_branch_1"; ms = 4200 } | ConvertTo-Json -Compress
        $r = Invoke-AnalyticsRequest -Method POST -Path "/api/analytics/click" -Body $payload
        $r.StatusCode | Should Be 204
    }
}

# ---------------------------------------------------------------------------
# Admin auth tests - port 8094 with an adminToken written to config root.
# Tests that /analytics and /config correctly enforce token-based protection.
# ---------------------------------------------------------------------------

$script:adminAuthPort       = 8094
$script:adminAuthBase       = "http://127.0.0.1:" + $script:adminAuthPort
$script:adminAuthProcess    = $null
$script:adminAuthConfigRoot = $null
$script:adminAuthToken      = "test-admin-token-$(([guid]::NewGuid()).ToString('N').Substring(0,8))"

function Invoke-AdminAuthRequest {
    param(
        [string]$Method      = "GET",
        [string]$Path,
        $Body                = $null,
        [string]$ContentType = "application/json",
        [string]$AuthHeader  = ""
    )

    $uri = $script:adminAuthBase + $Path

    $parseJson = {
        param($text)
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            try { return ConvertFrom-Json -InputObject $text } catch { }
        }
        return $null
    }

    $readResponse = {
        param($resp)
        $stream  = $resp.GetResponseStream()
        $reader  = New-Object System.IO.StreamReader($stream)
        $content = $reader.ReadToEnd()
        $reader.Close()
        $resp.Close()
        $hdrs = @{}
        foreach ($k in $resp.Headers.AllKeys) { $hdrs[$k] = $resp.Headers[$k] }
        return @{
            StatusCode = [int]$resp.StatusCode
            Content    = $content
            Json       = (& $parseJson $content)
            Headers    = $hdrs
        }
    }

    [System.Net.ServicePointManager]::Expect100Continue = $false
    $req        = [System.Net.HttpWebRequest]::Create($uri)
    $req.Method = $Method
    $req.Timeout = 10000
    if ($AuthHeader -ne "") { $req.Headers["Authorization"] = $AuthHeader }

    if ($null -ne $Body) {
        $bytes             = [System.Text.Encoding]::UTF8.GetBytes([string]$Body)
        $req.ContentType   = $ContentType
        $req.ContentLength = $bytes.Length
        $bodyStream        = $req.GetRequestStream()
        $bodyStream.Write($bytes, 0, $bytes.Length)
        $bodyStream.Close()
    }

    try {
        $resp = $req.GetResponse()
        return & $readResponse $resp
    }
    catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($null -eq $resp) { throw }
        return & $readResponse $resp
    }
}

Describe "School Scanner - admin auth and rate limiting" {

    BeforeAll {
        $serverScript = Join-Path $PSScriptRoot "..\server\Start-SchoolScanner.ps1"
        $script:adminAuthConfigRoot = Join-Path $env:TEMP ("schoolscanner-adminauth-" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $script:adminAuthConfigRoot -Force | Out-Null

        # Write the admin token to the settings file BEFORE the server starts
        $settingsPath = Join-Path $script:adminAuthConfigRoot "research-settings.json"
        '{"adminToken":"' + $script:adminAuthToken + '"}' | Set-Content -LiteralPath $settingsPath -Encoding UTF8

        [System.Environment]::SetEnvironmentVariable("SCHOOLSCANNER_CONFIG_ROOT", $script:adminAuthConfigRoot, "Process")

        $startInfo                        = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName               = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        $startInfo.Arguments              = "-ExecutionPolicy Bypass -File `"$serverScript`" -Port $script:adminAuthPort"
        $startInfo.UseShellExecute        = $false
        $startInfo.CreateNoWindow         = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError  = $true
        $startInfo.EnvironmentVariables["SCHOOLSCANNER_CONFIG_ROOT"] = $script:adminAuthConfigRoot

        $script:adminAuthProcess           = New-Object System.Diagnostics.Process
        $script:adminAuthProcess.StartInfo = $startInfo
        [void]$script:adminAuthProcess.Start()

        $started = $false
        for ($i = 0; $i -lt 20; $i++) {
            if ($script:adminAuthProcess.HasExited) { break }
            try {
                $h = Invoke-RestMethod -Uri ($script:adminAuthBase + "/api/health") -Method Get -TimeoutSec 2
                if ($h.status -eq "ok") { $started = $true; break }
            }
            catch { Start-Sleep -Milliseconds 500 }
        }

        if (-not $started) {
            throw "Admin auth test server did not start on port $script:adminAuthPort."
        }
    }

    AfterAll {
        if ($script:adminAuthProcess -and -not $script:adminAuthProcess.HasExited) {
            Stop-Process -Id $script:adminAuthProcess.Id -Force -ErrorAction SilentlyContinue
        }
        [System.Environment]::SetEnvironmentVariable("SCHOOLSCANNER_CONFIG_ROOT", $null, "Process")
        if ($script:adminAuthConfigRoot) {
            Remove-Item -LiteralPath $script:adminAuthConfigRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # -----------------------------------------------------------------------
    # GET /analytics auth
    # -----------------------------------------------------------------------

    It "GET /analytics returns 401 when no token is provided" {
        $r = Invoke-AdminAuthRequest -Method GET -Path "/analytics"
        $r.StatusCode | Should Be 401
    }

    It "GET /analytics returns 401 when a wrong query token is provided" {
        $r = Invoke-AdminAuthRequest -Method GET -Path "/analytics?token=wrong-token"
        $r.StatusCode | Should Be 401
    }

    It "GET /analytics returns 401 HTML with a login form" {
        $r = Invoke-AdminAuthRequest -Method GET -Path "/analytics"
        $r.StatusCode | Should Be 401
        $r.Content | Should Match "Admin access required"
        $r.Headers["Content-Type"] | Should Match "text/html"
    }

    It "GET /analytics returns 200 with the correct query-string token" {
        $r = Invoke-AdminAuthRequest -Method GET -Path ("/analytics?token=" + $script:adminAuthToken)
        $r.StatusCode | Should Be 200
        $r.Content | Should Match "School Scanner - Analytics"
    }

    It "GET /analytics 200 response has a relaxed CSP allowing unsafe-inline scripts" {
        $r = Invoke-AdminAuthRequest -Method GET -Path ("/analytics?token=" + $script:adminAuthToken)
        $r.StatusCode | Should Be 200
        $r.Headers["Content-Security-Policy"] | Should Match "unsafe-inline"
    }

    It "GET /analytics returns 200 with the correct Bearer token" {
        $r = Invoke-AdminAuthRequest -Method GET -Path "/analytics" -AuthHeader ("Bearer " + $script:adminAuthToken)
        $r.StatusCode | Should Be 200
        $r.Content | Should Match "School Scanner - Analytics"
    }

    # -----------------------------------------------------------------------
    # GET /config auth
    # -----------------------------------------------------------------------

    It "GET /config returns 401 when no token is provided" {
        $r = Invoke-AdminAuthRequest -Method GET -Path "/config"
        $r.StatusCode | Should Be 401
    }

    It "GET /config returns 200 HTML with the correct query-string token" {
        $r = Invoke-AdminAuthRequest -Method GET -Path ("/config?token=" + $script:adminAuthToken)
        $r.StatusCode | Should Be 200
        $r.Headers["Content-Type"] | Should Match "text/html"
    }

    # -----------------------------------------------------------------------
    # Rate limiting
    # -----------------------------------------------------------------------

    It "Rate limiter returns 429 after the request window is exhausted" {
        # Send 31 lightweight GET /api/health requests; the 31st should be rate-limited.
        # The window is 30 requests per 60s per IP. The server counts from request 1.
        $last = $null
        for ($i = 1; $i -le 31; $i++) {
            $last = Invoke-AdminAuthRequest -Method GET -Path "/api/health"
        }
        $last.StatusCode | Should Be 429
        $last.Json.error | Should Match "Rate limit"
    }
}
