Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot "..\server\SchoolScanner.Server.psm1") -Force
Import-Module (Join-Path $PSScriptRoot "..\server\SchoolScanner.LiveRetrieval.psm1") -Force
. (Join-Path $PSScriptRoot "PageObjects\HomePage.ps1")

$script:port = 8091
$script:serverProcess = $null
$script:stdoutLog = Join-Path $env:TEMP "schoolscanner-stdout.log"
$script:stderrLog = Join-Path $env:TEMP "schoolscanner-stderr.log"

function Invoke-PreviewRequest {
    param(
        [Parameter(Mandatory)]
        [string]$Uri
    )

    return Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 5
}

function Invoke-JsonApiRequest {
    param(
        [Parameter(Mandatory)]
        [string]$Uri,
        [Parameter(Mandatory)]
        [string]$JsonBody
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($JsonBody)
    $request = [System.Net.HttpWebRequest]::Create($Uri)
    $request.Method = "POST"
    $request.ContentType = "application/json"
    $request.ContentLength = $bytes.Length
    $request.Timeout = 5000

    $stream = $request.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()

    $response = $request.GetResponse()
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    $content = $reader.ReadToEnd()
    $reader.Close()
    $response.Close()

    return ConvertFrom-Json -InputObject $content
}

Describe "School Scanner server module" {
    It "returns secure headers expected by ZAP-style checks" {
        $headers = Get-SecurityHeaders -ApiResponse

        $headers["Content-Security-Policy"] | Should Match "default-src 'self'"
        $headers["X-Content-Type-Options"] | Should Be "nosniff"
        $headers["X-Frame-Options"] | Should Be "DENY"
        $headers["Cache-Control"] | Should Be "no-store"
    }

    It "accepts a valid preview payload" {
        $result = Test-QuestionPayload -Payload @{
            branch = "prompt_branch_2"
            question = "Which school is a better fit if commute matters?"
            email = "parent@example.com"
        }

        $result.IsValid | Should Be $true
        $result.Errors.Count | Should Be 0
    }

    It "rejects invalid payloads" {
        $result = Test-QuestionPayload -Payload @{
            branch = "invalid_branch"
            question = ""
            email = "bad-email"
        }

        $result.IsValid | Should Be $false
        $result.Errors.Count | Should BeGreaterThan 0
    }

    It "builds a preview response with monetisation-ready metadata" {
        $payload = Get-PreviewPayload -Payload @{
            branch = "prompt_branch_4"
            question = "What should we do if our first-choice school does not work out?"
        }

        $payload.gate.mode | Should Be "preview"
        $payload.premiumPoints.Count | Should BeGreaterThan 1
    }
}

Describe "School Scanner live retrieval module" {
    It "returns a branch-aware research contract" {
        $contract = New-LiveResearchContract -Payload @{
            branch = "prompt_branch_2"
            question = "Reigate Grammar School vs St Paul's Girls' School"
        }

        $contract.researchPlan.branch | Should Be "prompt_branch_2"
        $contract.researchPlan.searchTasks.Count | Should BeGreaterThan 1
        $contract.answerPolicy.mustFollowSelectedPromptStructure | Should Be $true
    }

    It "builds an OpenAI responses request for live web research" {
        $request = New-OpenAIResearchRequest -Payload @{
            branch = "prompt_branch_1"
            question = "Tell me about Highgate School"
        }

        $request.model | Should Not BeNullOrEmpty
        $request.tools[0].type | Should Be "web_search"
        $request.text.format.type | Should Be "json_schema"
    }
}

Describe "School Scanner page" {
    BeforeAll {
        $serverScript = Join-Path $PSScriptRoot "..\server\Start-SchoolScanner.ps1"
        Remove-Item -LiteralPath $script:stdoutLog, $script:stderrLog -Force -ErrorAction SilentlyContinue
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        $startInfo.Arguments = "-ExecutionPolicy Bypass -File `"$serverScript`" -Port $script:port"
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true

        $script:serverProcess = New-Object System.Diagnostics.Process
        $script:serverProcess.StartInfo = $startInfo
        [void]$script:serverProcess.Start()

        $started = $false
        for ($i = 0; $i -lt 20; $i++) {
            if ($script:serverProcess.HasExited) {
                break
            }

            try {
                $health = Invoke-RestMethod -Uri "http://127.0.0.1:$script:port/api/health" -Method Get -TimeoutSec 2
                if ($health.status -eq "ok") {
                    $started = $true
                    break
                }
            }
            catch {
                Start-Sleep -Milliseconds 500
            }
        }

        if (-not $started) {
            $stdout = $script:serverProcess.StandardOutput.ReadToEnd()
            $stderr = $script:serverProcess.StandardError.ReadToEnd()
            throw "Server did not start. STDOUT: $stdout STDERR: $stderr"
        }
    }

    AfterAll {
        if ($script:serverProcess -and -not $script:serverProcess.HasExited) {
            Stop-Process -Id $script:serverProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }

    It "serves the landing page with the expected flow and support button" {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$script:port/" -UseBasicParsing -TimeoutSec 5
        $page = [HomePage]::new($response.Content)

        $response.StatusCode | Should Be 200
        $page.HasTitle() | Should Be $true
        $page.HasFourBranchCards() | Should Be $true
        $page.HasSupportButton() | Should Be $true
        $page.HasSecuritySection() | Should Be $true
    }

    It "serves health information with allowed branches" {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$script:port/api/health" -Method Get -TimeoutSec 5

        $health.status | Should Be "ok"
        $health.allowedBranches.Count | Should Be 4
        $health.liveRetrieval.mode | Should Be "needs_api_key"
    }

    It "returns a server-only research response from the API" {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$script:port/api/research?branch=prompt_branch_1&question=Is%20Highgate%20a%20strong%20option%20for%20a%20shy%20child%3F&email=parent%40example.com" -UseBasicParsing -TimeoutSec 5
            throw "Expected 503 but request succeeded."
        }
        catch [System.Net.WebException] {
            $statusCode = [int]$_.Exception.Response.StatusCode
            $statusCode | Should Be 503
        }
    }
}
