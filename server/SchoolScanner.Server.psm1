Set-StrictMode -Version Latest

$script:AllowedBranches = @(
    "prompt_branch_1",
    "prompt_branch_2",
    "prompt_branch_3",
    "prompt_branch_4"
)

function Get-AllowedBranches {
    [CmdletBinding()]
    param()

    return $script:AllowedBranches
}

function ConvertTo-PlainHashtable {
    [CmdletBinding()]
    param(
        $InputObject
    )

    if ($null -eq $InputObject) {
        return $null
    }

    if ($InputObject -is [System.Collections.IDictionary]) {
        $result = @{}
        foreach ($key in $InputObject.Keys) {
            $result[$key] = ConvertTo-PlainHashtable -InputObject $InputObject[$key]
        }
        return $result
    }

    if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
        $items = @()
        foreach ($item in $InputObject) {
            $items += ,(ConvertTo-PlainHashtable -InputObject $item)
        }
        return $items
    }

    $properties = $null
    try { $properties = $InputObject.PSObject.Properties } catch { $properties = $null }

    if ($properties -and @($properties).Length -gt 0 -and $InputObject -isnot [string]) {
        $result = @{}
        foreach ($property in $InputObject.PSObject.Properties) {
            $result[$property.Name] = ConvertTo-PlainHashtable -InputObject $property.Value
        }
        return $result
    }

    return $InputObject
}

function Get-SecurityHeaders {
    [CmdletBinding()]
    param(
        [switch]$ApiResponse,
        [switch]$AdminPage
    )

    # Admin pages use inline scripts/styles — relax CSP accordingly
    $csp = if ($AdminPage) {
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://*.lambda-url.eu-west-2.on.aws; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
    } else {
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.lambda-url.eu-west-2.on.aws; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests"
    }

    $headers = [ordered]@{
        "Content-Security-Policy"      = $csp
        "X-Content-Type-Options"       = "nosniff"
        "X-Frame-Options"              = "DENY"
        "Referrer-Policy"              = "no-referrer"
        "Permissions-Policy"           = "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
        "Cross-Origin-Opener-Policy"   = "same-origin"
        "Cross-Origin-Resource-Policy" = "same-origin"
    }

    if ($ApiResponse) {
        $headers["Cache-Control"] = "no-store"
    }

    return $headers
}

function Test-QuestionPayload {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Payload
    )

    $errors = New-Object System.Collections.Generic.List[string]

    if (-not $Payload.ContainsKey("branch")) {
        $errors.Add("Missing branch.")
    }
    elseif ($Payload.branch -notin $script:AllowedBranches) {
        $errors.Add("Branch is not supported.")
    }

    if (-not $Payload.ContainsKey("question")) {
        $errors.Add("Missing question.")
    }
    else {
        $question = [string]$Payload.question
        if ([string]::IsNullOrWhiteSpace($question)) {
            $errors.Add("Question is required.")
        }
        elseif ($question.Length -gt 600) {
            $errors.Add("Question must be 600 characters or fewer.")
        }
    }

    if ($Payload.ContainsKey("email")) {
        $email = [string]$Payload.email
        if ($email.Length -gt 0 -and $email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
            $errors.Add("Email format is invalid.")
        }
    }

    return @{
        IsValid = ($errors.Count -eq 0)
        Errors  = @($errors)
    }
}

function Get-PreviewPayload {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Payload
    )

    $branchTitles = @{
        "prompt_branch_1" = "Evaluate One School"
        "prompt_branch_2" = "Compare Named Schools"
        "prompt_branch_3" = "Check A Postcode Or Area"
        "prompt_branch_4" = "Plan Admissions Backup Routes"
    }

    $focusMap = @{
        "prompt_branch_1" = @(
            "School snapshot and fit summary"
            "Latest inspection and credibility signals"
            "Locked: full admissions and destination analysis"
        )
        "prompt_branch_2" = @(
            "Fast side-by-side decision framing"
            "Main tradeoffs to test on visits"
            "Locked: full category winner matrix"
        )
        "prompt_branch_3" = @(
            "Area suitability for family decision-making"
            "Nearby school search framing"
            "Locked: full postcode shortlist and commute lens"
        )
        "prompt_branch_4" = @(
            "Practical fallback paths to keep alive"
            "Timing and risk framing"
            "Locked: full contingency playbook"
        )
    }

    $branch = [string]$Payload.branch
    $question = ([string]$Payload.question).Trim()
    $title = $branchTitles[$branch]
    $focus = $focusMap[$branch]

    return @{
        branch = $branch
        title = $title
        summary = "This free preview shows how School Scanner would handle '$question' with an evidence-first parent brief. The complete report would unlock deeper source-backed analysis, comparisons, and next-step recommendations."
        previewPoints = $focus[0..1]
        premiumPoints = @(
            $focus[2]
            "Open-day and deadline checklist"
            "Saved report history and future paywalled account access"
        )
        gate = @{
            mode = "preview"
            cta = "Unlock the full report"
            note = "The paywall seam is already designed so one-off report purchases or subscriptions can be added without rebuilding the page flow."
        }
    }
}

function Get-MimeType {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        ".html" { return "text/html; charset=utf-8" }
        ".css"  { return "text/css; charset=utf-8" }
        ".js"   { return "application/javascript; charset=utf-8" }
        ".json" { return "application/json; charset=utf-8" }
        ".svg"  { return "image/svg+xml" }
        default { return "application/octet-stream" }
    }
}

Export-ModuleMember -Function Get-AllowedBranches, ConvertTo-PlainHashtable, Get-SecurityHeaders, Test-QuestionPayload, Get-PreviewPayload, Get-MimeType
