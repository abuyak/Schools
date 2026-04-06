Set-StrictMode -Version Latest

function Get-OpenAIApiKey {
    [CmdletBinding()]
    param()

    $value = [System.Environment]::GetEnvironmentVariable("OPENAI_API_KEY", "Process")
    if ([string]::IsNullOrWhiteSpace($value)) {
        $value = [System.Environment]::GetEnvironmentVariable("OPENAI_API_KEY", "User")
    }
    if ([string]::IsNullOrWhiteSpace($value)) {
        $value = [System.Environment]::GetEnvironmentVariable("OPENAI_API_KEY", "Machine")
    }

    if (-not [string]::IsNullOrWhiteSpace($value)) {
        return $value
    }

    return $null
}

function Get-LiveRetrievalStatus {
    [CmdletBinding()]
    param()

    $apiKey = Get-OpenAIApiKey
    return @{
        mode = if ($apiKey) { "configured" } else { "needs_api_key" }
        onlineSearchEnabled = [bool]$apiKey
        reason = if ($apiKey) { "OpenAI API key detected. Live web research can be attempted." } else { "Set OPENAI_API_KEY for live web research." }
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
                    "Find admissions and fees if relevant"
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

    $common = @"
You are School Scanner, an AI school advisor.
Use live web research and prefer primary sources: official school websites, government school information, Ofsted, ISI, official admissions documents, and official destination data.
Follow the selected prompt structure strictly.
Separate fact from interpretation.
If a point cannot be verified, say so directly.
Keep the tone calm, practical, parent-friendly, and non-promotional.
Return valid JSON only.
"@

    switch ($Branch) {
        "prompt_branch_1" {
            return $common + @"

This is branch 1: Specific School Due Diligence.
Answer the parent's real question: what is this school actually like, and is it worth pursuing?
Structure the answer around:
1. Direct Answer
2. School Snapshot
3. Inspection And Review Takeaways
4. Academic Position
5. Admissions And Assessment
6. Fees
7. Destinations
8. Tradeoffs And Risks
9. Sources
10. Best Next Moves
"@
        }
        "prompt_branch_2" {
            return $common + @"

This is branch 2: Compare Schools.
Help the parent decide, not just describe each school separately.
Structure the answer around:
1. Direct Answer
2. Quick Comparison Table
3. What Matters Most For This Decision
4. Admissions And Assessment
5. Fees And Cost
6. Destinations
7. Tradeoffs And Risks
8. Sources
9. Best Next Moves
"@
        }
        "prompt_branch_3" {
            return $common + @"

This is branch 3: Postcode Or Area Search.
Answer the real question: is this area a good place to target if we care about school options?
Structure the answer around:
1. Direct Answer
2. Top Recommendations
3. Quick Comparison Table
4. Area View
5. Tradeoffs And Risks
6. Sources
7. Best Next Moves
"@
        }
        "prompt_branch_4" {
            return $common + @"

This is branch 4: Admissions Strategy And Fallback Planning.
Answer the practical question: given this situation, what should we do next?
Structure the answer around:
1. Direct Answer
2. Main Routes Or Fallback Options
3. Admissions And Assessment
4. What Matters Most For This Decision
5. Tradeoffs And Risks
6. Sources
7. Best Next Moves
"@
        }
    }
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
                keyPoints = @{
                    type = "array"
                    items = @{ type = "string" }
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
            required = @("title","summary","keyPoints","sections")
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

    $modelName = [System.Environment]::GetEnvironmentVariable("OPENAI_MODEL", "Process")
    if ([string]::IsNullOrWhiteSpace($modelName)) {
        $modelName = [System.Environment]::GetEnvironmentVariable("OPENAI_MODEL", "User")
    }
    if ([string]::IsNullOrWhiteSpace($modelName)) {
        $modelName = [System.Environment]::GetEnvironmentVariable("OPENAI_MODEL", "Machine")
    }
    if ([string]::IsNullOrWhiteSpace($modelName)) {
        $modelName = "gpt-5"
    }

    return @{
        model = $modelName
        reasoning = @{
            effort = "medium"
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

    $outputText = [string]$ApiResponse.output_text
    $parsed = ConvertFrom-Json -InputObject $outputText -ErrorAction Stop
    $sources = @()

    foreach ($item in @($ApiResponse.output)) {
        if ($item.type -eq "web_search_call" -and $item.action -and $item.action.sources) {
            foreach ($source in @($item.action.sources)) {
                if ($source.url) {
                    $sources += [ordered]@{
                        heading = if ($source.title) { [string]$source.title } else { [string]$source.url }
                        body = [string]$source.url
                    }
                }
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

    if ($sources.Count -gt 0) {
        $sectionList += @{
            heading = "Live Sources"
            body = (($sources | Select-Object -First 6 | ForEach-Object { $_.body }) -join "; ")
        }
    }

    return @{
        status = "completed"
        title = [string]$parsed.title
        summary = [string]$parsed.summary
        keyPoints = @($parsed.keyPoints)
        sections = $sectionList
    }
}

function Invoke-OpenAIResearch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Payload
    )

    $apiKey = Get-OpenAIApiKey
    if (-not $apiKey) {
        return @{
            status = "configuration_required"
            title = "OpenAI API key required"
            summary = "Set OPENAI_API_KEY on the server to enable live online research through the OpenAI Responses API."
            keyPoints = @(
                "The frontend no longer generates local answers."
                "The backend is ready to call OpenAI's Responses API with live web search."
                "No answer is generated until OPENAI_API_KEY is configured."
            )
            sections = @(
                @{
                    heading = "Next step"
                    body = "Set OPENAI_API_KEY and optionally OPENAI_MODEL, then restart the backend."
                }
            )
        }
    }

    $requestBody = New-OpenAIResearchRequest -Payload $Payload | ConvertTo-Json -Depth 20
    $headers = @{
        "Authorization" = "Bearer $apiKey"
        "Content-Type" = "application/json"
    }

    $response = Invoke-RestMethod -Uri "https://api.openai.com/v1/responses" -Method Post -Headers $headers -Body $requestBody -TimeoutSec 120
    $plain = ConvertTo-PlainHashtable -InputObject $response
    return Convert-OpenAIResponseToResult -ApiResponse $plain
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
