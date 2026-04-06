Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$oxfordPath = Join-Path $root "sources\Oxford\oxford_admissions_merged.csv"
$cambridgePath = Join-Path $root "sources\Cambridge\cambridge_admissions_merged.csv"
$outputPath = Join-Path $root "web\evidence-data.js"

function Normalize-Name {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    $normalized = $Value.ToLowerInvariant()
    $normalized = [regex]::Replace($normalized, "[^a-z0-9]+", " ")
    $normalized = [regex]::Replace($normalized, "\s+", " ").Trim()
    return $normalized
}

function Parse-Count {
    param($Value)

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return @{
            exact = $null
            lower = 0
            upper = 0
            suppressed = $false
        }
    }

    if ($text -eq "<3") {
        return @{
            exact = $null
            lower = 0
            upper = 2
            suppressed = $true
        }
    }

    $number = 0
    if ([int]::TryParse($text, [ref]$number)) {
        return @{
            exact = $number
            lower = $number
            upper = $number
            suppressed = $false
        }
    }

    return @{
        exact = $null
        lower = 0
        upper = 0
        suppressed = $false
    }
}

function Add-Range {
    param(
        [hashtable]$Target,
        [hashtable]$Parsed
    )

    $Target.lower += $Parsed.lower
    $Target.upper += $Parsed.upper
    if ($Parsed.suppressed) {
        $Target.suppressed = $true
    }
}

function New-MetricBucket {
    return @{
        lower = 0
        upper = 0
        suppressed = $false
    }
}

function Ensure-SchoolRecord {
    param(
        [hashtable]$Index,
        [string]$Key,
        [string]$SchoolName
    )

    if (-not $Index.ContainsKey($Key)) {
        $Index[$Key] = @{
            key = $Key
            displayName = $SchoolName
            postcode = ""
            sector = ""
            sources = @{
                oxford = @{
                    years = New-Object System.Collections.Generic.HashSet[int]
                    applications = New-MetricBucket
                    offers = New-MetricBucket
                    accepts = New-MetricBucket
                }
                cambridge = @{
                    years = New-Object System.Collections.Generic.HashSet[int]
                    applications = New-MetricBucket
                    offers = New-MetricBucket
                    accepts = New-MetricBucket
                }
            }
        }
    }

    return $Index[$Key]
}

$schoolIndex = @{}

foreach ($row in Import-Csv $oxfordPath) {
    $schoolName = [string]$row.SchoolName
    $key = Normalize-Name $schoolName
    if ([string]::IsNullOrWhiteSpace($key)) {
        continue
    }

    $record = Ensure-SchoolRecord -Index $schoolIndex -Key $key -SchoolName $schoolName
    if ([string]::IsNullOrWhiteSpace($record.postcode) -and -not [string]::IsNullOrWhiteSpace([string]$row.SchoolPostalCode)) {
        $record.postcode = [string]$row.SchoolPostalCode
    }
    if ([string]::IsNullOrWhiteSpace($record.sector) -and -not [string]::IsNullOrWhiteSpace([string]$row.SchoolGroup)) {
        $record.sector = [string]$row.SchoolGroup
    }

    [void]$record.sources.oxford.years.Add([int]$row.AdmissionYear)
    Add-Range -Target $record.sources.oxford.applications -Parsed (Parse-Count $row.Applications)
    Add-Range -Target $record.sources.oxford.offers -Parsed (Parse-Count $row.Offers)
    Add-Range -Target $record.sources.oxford.accepts -Parsed (Parse-Count $row.Accepts)
}

foreach ($row in Import-Csv $cambridgePath) {
    $schoolName = [string]$row.SchoolName
    $key = Normalize-Name $schoolName
    if ([string]::IsNullOrWhiteSpace($key)) {
        continue
    }

    $record = Ensure-SchoolRecord -Index $schoolIndex -Key $key -SchoolName $schoolName
    if ([string]::IsNullOrWhiteSpace($record.postcode) -and -not [string]::IsNullOrWhiteSpace([string]$row.Postcode)) {
        $record.postcode = [string]$row.Postcode
    }
    if ([string]::IsNullOrWhiteSpace($record.sector) -and -not [string]::IsNullOrWhiteSpace([string]$row.SchoolSector)) {
        $record.sector = [string]$row.SchoolSector
    }

    [void]$record.sources.cambridge.years.Add([int]$row.AdmissionYear)
    Add-Range -Target $record.sources.cambridge.applications -Parsed (Parse-Count $row.Applications)
    Add-Range -Target $record.sources.cambridge.offers -Parsed (Parse-Count $row.Offers)
    Add-Range -Target $record.sources.cambridge.accepts -Parsed (Parse-Count $row.Acceptances)
}

$schools = @()
foreach ($entry in $schoolIndex.GetEnumerator()) {
    $record = $entry.Value
    $oxYears = @($record.sources.oxford.years | Sort-Object)
    $camYears = @($record.sources.cambridge.years | Sort-Object)

    $combinedLower = $record.sources.oxford.accepts.lower + $record.sources.cambridge.accepts.lower
    $combinedUpper = $record.sources.oxford.accepts.upper + $record.sources.cambridge.accepts.upper

    $schools += [ordered]@{
        key = $record.key
        displayName = $record.displayName
        postcode = $record.postcode
        sector = $record.sector
        combined = @{
            lowerAccepts = $combinedLower
            upperAccepts = $combinedUpper
        }
        oxford = @{
            years = $oxYears
            applications = $record.sources.oxford.applications
            offers = $record.sources.oxford.offers
            accepts = $record.sources.oxford.accepts
        }
        cambridge = @{
            years = $camYears
            applications = $record.sources.cambridge.applications
            offers = $record.sources.cambridge.offers
            accepts = $record.sources.cambridge.accepts
        }
    }
}

$payload = [ordered]@{
    sourceMeta = @{
        generatedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
        oxfordSource = "sources/Oxford/oxford_admissions_merged.csv"
        cambridgeSource = "sources/Cambridge/cambridge_admissions_merged.csv"
        notes = @(
            "Oxford counts aggregate the local admissions dataset in this workspace.",
            "Cambridge counts aggregate the local admissions dataset in this workspace.",
            "Suppressed '<3' values are preserved as lower and upper bounds instead of being invented."
        )
    }
    schools = ($schools | Sort-Object { $_.displayName })
}

$json = $payload | ConvertTo-Json -Depth 8 -Compress
$content = "window.SCHOOL_SCANNER_EVIDENCE = $json;"
[System.IO.File]::WriteAllText($outputPath, $content, [System.Text.Encoding]::UTF8)

Write-Host "Wrote evidence bundle to $outputPath"
