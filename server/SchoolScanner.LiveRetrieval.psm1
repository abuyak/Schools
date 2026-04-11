Set-StrictMode -Version Latest

Import-Module (Join-Path $PSScriptRoot "SchoolScanner.Config.psm1") -Force

function Get-OpenAIApiKey {
    [CmdletBinding()]
    param()

    $settings = Get-SchoolScannerResearchSettings
    $value = [string]$settings.apiKey

    if (-not [string]::IsNullOrWhiteSpace($value)) {
        return $value
    }

    return $null
}

function Get-LiveRetrievalStatus {
    [CmdletBinding()]
    param()

    $settings = Get-SchoolScannerResearchSettings
    $apiKey = [string]$settings.apiKey
    $ready = (-not [bool]$settings.apiKeyRequired) -or (-not [string]::IsNullOrWhiteSpace($apiKey))
    return @{
        mode = if ($ready) { "configured" } else { "needs_api_key" }
        onlineSearchEnabled = [bool]$ready
        reason = if ($ready) { "Research settings detected. Live web research can be attempted." } else { "Set OPENAI_API_KEY or save an encrypted local key for live web research." }
        model = [string]$settings.model
        reasoningEffort = [string]$settings.reasoningEffort
        provider = [string]$settings.provider
        baseUrl = [string]$settings.baseUrl
        apiKeyRequired = [bool]$settings.apiKeyRequired
        requestTimeoutSeconds = [int]$settings.requestTimeoutSeconds
        maxOutputTokens = [int]$settings.maxOutputTokens
        configRoot = Get-SchoolScannerConfigRoot
    }
}

function Get-BranchResearchPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet("prompt_branch_1","prompt_branch_2","prompt_branch_3","prompt_branch_4")]
        [string]$Branch
    )

    switch ($Branch) {
        "prompt_branch_1" {
            return @{
                branch = $Branch
                objective = "Evaluate one named school with a decision brief."
                preferredSources = @(
                    "Official school website"
                    "Government school information"
                    "Ofsted or ISI"
                    "Official admissions policy"
                    "Official destination data"
                )
                searchTasks = @(
                    "Resolve the exact school identity"
                    "Find the latest inspection"
                    "Find admissions criteria and current fees or tuition costs from the official school website"
                    "Find official destination evidence"
                )
            }
        }
        "prompt_branch_2" {
            return @{
                branch = $Branch
                objective = "Compare two or more named schools and recommend."
                preferredSources = @(
                    "Official school websites"
                    "Government data"
                    "Ofsted or ISI"
                    "Official admissions policies"
                    "Official destination data"
                )
                searchTasks = @(
                    "Resolve the exact official identity of each school"
                    "Collect like-for-like inspection and admissions facts"
                    "Compare destination evidence where genuinely comparable"
                    "Return a decision-oriented answer, not two isolated profiles"
                )
            }
        }
        "prompt_branch_3" {
            return @{
                branch = $Branch
                objective = "Assess an area or postcode from a school-choice perspective."
                preferredSources = @(
                    "Government school data"
                    "Official school websites"
                    "Ofsted or ISI"
                    "Official admissions documents"
                )
                searchTasks = @(
                    "Identify schools within the relevant geography"
                    "Separate strong options from realistic options"
                    "Check catchment or selectivity constraints where possible"
                    "Explain area depth rather than just listing schools"
                )
            }
        }
        "prompt_branch_4" {
            return @{
                branch = $Branch
                objective = "Give practical admissions strategy and fallback planning advice."
                preferredSources = @(
                    "Official admissions policies"
                    "Government admissions guidance"
                    "Official school websites"
                    "Ofsted or ISI where quality context matters"
                    "Official destination or feeder information"
                )
                searchTasks = @(
                    "Clarify the live routes still available"
                    "Check deadlines and route mechanics"
                    "Compare fallback quality and realism"
                    "Recommend the safest practical next actions"
                )
            }
        }
    }
}

function New-LiveResearchContract {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Payload
    )

    $plan = Get-BranchResearchPlan -Branch ([string]$Payload.branch)
    return @{
        branch = $Payload.branch
        question = $Payload.question
        researchPlan = $plan
        answerPolicy = @{
            mustUsePrimarySources = $true
            mustSeparateFactFromInterpretation = $true
            mustFollowSelectedPromptStructure = $true
            mustStateWhenEvidenceIsMissing = $true
        }
    }
}

function Get-BranchInstructions {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Branch
    )

    # Map branch ID to its .md file (one level up from server/, inside .md/)
    $mdRoot = Join-Path (Split-Path $PSScriptRoot -Parent) ".md"
    $branchFile = switch ($Branch) {
        "prompt_branch_1" { Join-Path $mdRoot "prompt_branch_1_specific_school.md" }
        "prompt_branch_2" { Join-Path $mdRoot "prompt_branch_2_compare_schools.md" }
        "prompt_branch_3" { Join-Path $mdRoot "prompt_branch_3_postcode_or_area.md" }
        "prompt_branch_4" { Join-Path $mdRoot "prompt_branch_4_admissions_strategy.md" }
        default           { $null }
    }

    if ($null -eq $branchFile -or -not (Test-Path $branchFile)) {
        throw "Branch instructions file not found for branch '$Branch'. Expected: $branchFile"
    }

    $branchPrompt = Get-Content -Path $branchFile -Raw -Encoding UTF8

    # Append code-level output constraints that must always apply regardless of
    # how the .md files are edited. Keep these minimal — content belongs in .md.
    $outputConstraints = @"

---
## Output Constraints (do not override)
- Never ask the user clarifying questions. The user has paid for this query. Instead, make the most reasonable assumptions given the question, state them briefly at the start of the Direct Answer section, and produce a complete answer based on those assumptions. If the question is genuinely unanswerable (e.g. no matching schools exist), say so clearly and redirect to the closest useful answer.
- Return valid JSON only. No markdown fences, no prose outside the JSON object.
- Populate the scorecard array with 4-6 key dimensions. Each item: dimension (label), rating (strong|good|mixed|weak|unknown), note (one short sentence). Do not repeat scorecard content verbatim in the sections.
- Cite each fact inline using markdown link format: [source name](url).
- For fee-paying schools always search for current fees. If not found on first search, try "[school name] fees" as a dedicated search.
- Within each section body, use \n to separate paragraphs. Use \n- item for bullet points and \n1. item for numbered lists. Never write a section body as one long unbroken paragraph.
- Use the section numbers from the prompt structure in every section heading field, e.g. "1. Direct Answer", "2. Quick Comparison Table". All branches must number their sections.
- Never repeat the section heading inside the body. The heading field is shown separately — the body should start with content immediately.
- Only use numbered lists (1. 2. 3.) for genuinely enumerable items such as ranked options or steps. Do not number every paragraph or every sentence. Use plain paragraphs for prose and bullet points (- ) for unordered items.
- For any comparison table section, write the body as a markdown table using | col | col | syntax with a separator row of |---|---|.
"@

    return $branchPrompt + $outputConstraints
}

function Get-ResearchJsonSchema {
    [CmdletBinding()]
    param()

    return @{
        type = "json_schema"
        name = "school_scanner_answer"
        strict = $true
        schema = @{
            type = "object"
            additionalProperties = $false
            properties = @{
                title = @{ type = "string" }
                summary = @{ type = "string" }
                scorecard = @{
                    type = "array"
                    items = @{
                        type = "object"
                        additionalProperties = $false
                        properties = @{
                            dimension = @{ type = "string" }
                            rating    = @{ type = "string"; enum = @("strong","good","mixed","weak","unknown") }
                            note      = @{ type = "string" }
                        }
                        required = @("dimension","rating","note")
                    }
                }
                sections = @{
                    type = "array"
                    items = @{
                        type = "object"
                        additionalProperties = $false
                        properties = @{
                            heading = @{ type = "string" }
                            body = @{ type = "string" }
                        }
                        required = @("heading","body")
                    }
                }
            }
            required = @("title","summary","scorecard","sections")
        }
    }
}

function New-OpenAIResearchRequest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Payload
    )

    $instructions = Get-BranchInstructions -Branch ([string]$Payload.branch)
    $userLocation = @{
        type = "approximate"
        country = "GB"
        city = "London"
        region = "London"
        timezone = "Europe/London"
    }

    $settings = Get-SchoolScannerResearchSettings

    return @{
        model = [string]$settings.model
        reasoning = @{
            effort = [string]$settings.reasoningEffort
        }
        tools = @(
            @{
                type = "web_search"
                user_location = $userLocation
                external_web_access = $true
            }
        )
        tool_choice = "auto"
        include = @("web_search_call.action.sources")
        instructions = $instructions
        input = $Payload.question
        max_output_tokens = [int]$settings.maxOutputTokens
        text = @{
            format = Get-ResearchJsonSchema
        }
    }
}

function Convert-OpenAIResponseToResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable]$ApiResponse
    )

    $outputText = $null
    if ($ApiResponse -is [hashtable] -and $ApiResponse.ContainsKey("output_text") -and $null -ne $ApiResponse["output_text"]) {
        $outputText = [string]$ApiResponse["output_text"]
    }

    if ([string]::IsNullOrWhiteSpace($outputText) -and $ApiResponse -is [hashtable] -and $ApiResponse.ContainsKey("output")) {
        $fragments = New-Object System.Collections.Generic.List[string]
        foreach ($item in @($ApiResponse["output"])) {
            if ($item -is [hashtable] -and $item.ContainsKey("content")) {
                foreach ($contentItem in @($item["content"])) {
                    if ($contentItem -is [hashtable]) {
                        if ($contentItem.ContainsKey("text") -and -not [string]::IsNullOrWhiteSpace([string]$contentItem["text"])) {
                            $fragments.Add([string]$contentItem["text"])
                        } elseif ($contentItem.ContainsKey("output_text") -and -not [string]::IsNullOrWhiteSpace([string]$contentItem["output_text"])) {
                            $fragments.Add([string]$contentItem["output_text"])
                        }
                    }
                }
            }
        }

        if ($fragments.Count -gt 0) {
            $outputText = ($fragments -join "`n")
        }
    }

    if ([string]::IsNullOrWhiteSpace($outputText)) {
        return @{
            status = "upstream_invalid_format"
            httpStatus = 502
            title = "Unexpected upstream response"
            summary = "The research provider returned an empty response where structured JSON was expected."
            keyPoints = @("No answer was generated.", "Try again in a moment.")
            sections = @(
                @{
                    heading = "What happened"
                    body = "The upstream response did not include a parseable answer payload."
                }
            )
        }
    }

    # Strip markdown code fences the model sometimes adds despite json_schema enforcement.
    $cleanText = $outputText.Trim()
    if ($cleanText -match "^``````(?:json)?\s*`r?`n") {
        $cleanText = $cleanText -replace "^``````(?:json)?\s*`r?`n", ""
        $cleanText = $cleanText -replace "`r?`n``````\s*$", ""
        $cleanText = $cleanText.Trim()
    }
    # If the text still doesn't start with { try to locate the first JSON object boundary.
    if (-not $cleanText.StartsWith("{")) {
        $brace = $cleanText.IndexOf("{")
        if ($brace -ge 0) {
            $cleanText = $cleanText.Substring($brace)
        }
    }

    try {
        $parsed = ConvertFrom-Json -InputObject $cleanText -ErrorAction Stop
    }
    catch {
        return @{
            status = "upstream_invalid_format"
            httpStatus = 502
            title = "Unexpected upstream response"
            summary = "The research provider returned a response that did not match the expected JSON format."
            keyPoints = @("No answer was generated.", "Try again, or adjust the question to be more specific.")
            sections = @(
                @{
                    heading = "Raw output (first 400 chars)"
                    body = if ($outputText.Length -gt 400) { $outputText.Substring(0, 400) } else { $outputText }
                }
                @{
                    heading = "Next step"
                    body = "Retry the request. If this repeats, the backend schema enforcement may need tightening."
                }
            )
        }
    }
    $sources = @()

    foreach ($item in @($ApiResponse["output"])) {
        if ($item -is [hashtable] -and $item.ContainsKey("type") -and [string]$item["type"] -eq "web_search_call" -and $item.ContainsKey("action") -and $item["action"]) {
            $action = $item["action"]
            if ($action -is [hashtable] -and $action.ContainsKey("sources") -and $action["sources"]) {
                foreach ($source in @($action["sources"])) {
                    if ($source -is [hashtable] -and $source.ContainsKey("url") -and $source["url"]) {
                        $sources += [ordered]@{
                            heading = if ($source.ContainsKey("title") -and $source["title"]) { [string]$source["title"] } else { [string]$source["url"] }
                            body = [string]$source["url"]
                        }
                    }
                }
            }
        }
    }

    $scorecardList = @()
    if ($parsed.PSObject.Properties["scorecard"]) {
        foreach ($item in @($parsed.scorecard)) {
            $scorecardList += @{
                dimension = [string]$item.dimension
                rating    = [string]$item.rating
                note      = [string]$item.note
            }
        }
    }

    $sectionList = @()
    foreach ($section in @($parsed.sections)) {
        $sectionList += @{
            heading = [string]$section.heading
            body = [string]$section.body
        }
    }

    # Rename the model's Sources section to "Primary Sources".
    # Append any fetched URLs not already cited there as a separate "Secondary Sources" section.
    $primarySourcesBody = $null
    for ($i = 0; $i -lt $sectionList.Count; $i++) {
        if ([string]$sectionList[$i].heading -match "(?i)^sources?$") {
            $primarySourcesBody = [string]$sectionList[$i].body
            $sectionList[$i] = @{
                heading = "Primary Sources"
                body    = $primarySourcesBody
            }
            break
        }
    }

    if ($sources.Count -gt 0) {
        $secondaryLinks = $sources | Where-Object {
            $url = [string]$_.body
            $null -eq $primarySourcesBody -or -not $primarySourcesBody.Contains($url)
        } | ForEach-Object { "[$($_.heading)]($($_.body))" }

        if ($secondaryLinks.Count -gt 0) {
            $sectionList += @{
                heading = "Secondary Sources"
                body    = ($secondaryLinks -join "`n")
            }
        }
    }

    return @{
        status = "completed"
        httpStatus = 200
        title = [string]$parsed.title
        summary = [string]$parsed.summary
        scorecard = $scorecardList
        sections = $sectionList
    }
}

function Get-ExceptionResponseBody {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [System.Exception]$Exception
    )

    try {
        if ($Exception.Response -and $Exception.Response.GetResponseStream()) {
            $reader = New-Object System.IO.StreamReader($Exception.Response.GetResponseStream())
            try {
                return $reader.ReadToEnd()
            }
            finally {
                $reader.Dispose()
            }
        }
    }
    catch {
        return $null
    }

    return $null
}

function Invoke-OpenAIResearch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Payload
    )

    $settings = Get-SchoolScannerResearchSettings
    $apiKey = [string]$settings.apiKey
    if ([bool]$settings.apiKeyRequired -and [string]::IsNullOrWhiteSpace($apiKey)) {
        return @{
            status = "configuration_required"
            title = "OpenAI API key required"
            summary = "Configure the research backend with an API key to enable live online research."
            keyPoints = @(
                "The frontend no longer generates local answers."
                "The backend is ready to call an OpenAI-compatible Responses API with live web search."
                "No answer is generated until a required API key is configured."
            )
            sections = @(
                @{
                    heading = "Next step"
                    body = "Save an encrypted local API key or set OPENAI_API_KEY, then restart the backend."
                }
            )
        }
    }

    $requestBody = New-OpenAIResearchRequest -Payload $Payload | ConvertTo-Json -Depth 20
    $headers = @{
        "Content-Type" = "application/json"
    }
    if (-not [string]::IsNullOrWhiteSpace($apiKey)) {
        $headers["Authorization"] = "Bearer $apiKey"
    }
    $baseUrl = ([string]$settings.baseUrl).TrimEnd("/")
    $responsesPath = [string]$settings.responsesPath
    if ([string]::IsNullOrWhiteSpace($responsesPath)) {
        $responsesPath = "/responses"
    }
    if (-not $responsesPath.StartsWith("/")) {
        $responsesPath = "/$responsesPath"
    }
    $requestUri = "$baseUrl$responsesPath"

    try {
        $response = Invoke-RestMethod -Uri $requestUri -Method Post -Headers $headers -Body $requestBody -TimeoutSec ([int]$settings.requestTimeoutSeconds)
        if ($null -eq $response) {
            return @{
                status = "upstream_empty_response"
                httpStatus = 502
                title = "Research provider error"
                summary = "The research provider returned an empty response."
                keyPoints = @(
                    "No answer was generated."
                    "The upstream service did not return a parseable body."
                )
                sections = @(
                    @{
                        heading = "Suggested next step"
                        body = "Retry once. If this repeats, reduce request complexity or inspect the upstream provider response body."
                    }
                )
            }
        }
        $plain = ConvertTo-PlainHashtable -InputObject $response
        return Convert-OpenAIResponseToResult -ApiResponse $plain
    }
    catch {
        $statusCode = $null
        $detail = $_.Exception.Message
        $responseBody = Get-ExceptionResponseBody -Exception $_.Exception

        if ($_.Exception -is [System.Net.WebException] -and $_.Exception.Response) {
            try {
                $statusCode = [int]$_.Exception.Response.StatusCode
            }
            catch {
                $statusCode = $null
            }
        }

        if (-not $statusCode) {
            $statusCode = 502
        }

        $safeStatus = if ($statusCode -in @(400,401,403,404,409,422,429,500,502,503,504)) { $statusCode } else { 502 }
        $summary = if ($safeStatus -eq 401 -or $safeStatus -eq 403) {
            "The research provider rejected the API key. Check OPENAI_API_KEY."
        } elseif ($safeStatus -eq 429) {
            "The research provider is rate-limiting requests. Try again shortly."
        } elseif ($safeStatus -eq 504 -or $detail -match "timed out") {
            "The research provider timed out while retrieving sources. Try again."
        } else {
            "The research provider could not complete the request. Try again."
        }

        if ($detail -match "timed out") {
            $safeStatus = 504
        }

        return @{
            status = "upstream_error"
            httpStatus = $safeStatus
            title = "Research provider error"
            summary = $summary
            keyPoints = @(
                "No answer was generated."
                "The browser is waiting for the server-side research workflow."
            )
            sections = @(
                @{
                    heading = "What happened"
                    body = $detail
                }
                @{
                    heading = "Upstream response body"
                    body = if ([string]::IsNullOrWhiteSpace($responseBody)) { "No response body was returned by the provider." } else { $responseBody }
                }
                @{
                    heading = "Suggested next step"
                    body = "Retry once with a more specific school question, or lower the configured model and token budget if cost and latency are too high."
                }
            )
        }
    }
}

function Get-LiveResearchUnavailableResponse {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Payload
    )

    $contract = New-LiveResearchContract -Payload $Payload

    return @{
        status = "live_search_not_configured"
        title = "Research backend not configured"
        summary = "This page no longer generates answers locally. It now expects a server-side research workflow that searches online for sources and then returns a prompt-structured answer."
        keyPoints = @(
            "Local parsing and instant browser-side answer generation are disabled."
            "The selected branch still determines the research plan and answer structure."
            "A live search provider must be wired into the backend before answers can be generated here."
        )
        sections = @(
            @{
                heading = "Selected Branch"
                body = "Branch: $($Payload.branch). Objective: $($contract.researchPlan.objective)"
            }
            @{
                heading = "Required Search Tasks"
                body = ($contract.researchPlan.searchTasks -join "; ")
            }
            @{
                heading = "Why no answer was generated"
                body = "The site has been changed to avoid client-side question parsing. Until the backend can search official sources online, it should wait and fail clearly rather than fabricate or shortcut the workflow."
            }
        )
    }
}

Export-ModuleMember -Function Get-OpenAIApiKey, Get-LiveRetrievalStatus, Get-BranchResearchPlan, New-LiveResearchContract, Get-BranchInstructions, Get-ResearchJsonSchema, New-OpenAIResearchRequest, Convert-OpenAIResponseToResult, Invoke-OpenAIResearch, Get-LiveResearchUnavailableResponse
