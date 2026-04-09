param(
    [string]$ApiKey,
    [string]$Model,
    [string]$BaseUrl,
    [string]$ResponsesPath,
    [ValidateSet("low","medium","high")]
    [string]$ReasoningEffort,
    [int]$RequestTimeoutSeconds,
    [int]$MaxOutputTokens,
    [switch]$NoApiKeyRequired,
    [string]$Provider = "openai_compatible"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Import-Module (Join-Path $PSScriptRoot "..\server\SchoolScanner.Config.psm1") -Force

$apiKeyRequired = -not $NoApiKeyRequired.IsPresent
$configArgs = @{
    Provider = $Provider
    ApiKeyRequired = $apiKeyRequired
}
if ($PSBoundParameters.ContainsKey("Model")) {
    $configArgs.Model = $Model
}
if ($PSBoundParameters.ContainsKey("BaseUrl")) {
    $configArgs.BaseUrl = $BaseUrl
}
if ($PSBoundParameters.ContainsKey("ResponsesPath")) {
    $configArgs.ResponsesPath = $ResponsesPath
}
if ($PSBoundParameters.ContainsKey("ReasoningEffort")) {
    $configArgs.ReasoningEffort = $ReasoningEffort
}
if ($PSBoundParameters.ContainsKey("RequestTimeoutSeconds")) {
    $configArgs.RequestTimeoutSeconds = $RequestTimeoutSeconds
}
if ($PSBoundParameters.ContainsKey("MaxOutputTokens")) {
    $configArgs.MaxOutputTokens = $MaxOutputTokens
}

$configPath = Set-SchoolScannerResearchConfig @configArgs

$secretPath = $null
if ($PSBoundParameters.ContainsKey("ApiKey")) {
    $secretPath = Set-SchoolScannerApiKey -ApiKey $ApiKey
}

$settings = Get-SchoolScannerResearchSettings
[pscustomobject]@{
    ConfigPath = $configPath
    SecretPath = $secretPath
    Provider = $settings.provider
    Model = $settings.model
    BaseUrl = $settings.baseUrl
    ResponsesPath = $settings.responsesPath
    ReasoningEffort = $settings.reasoningEffort
    RequestTimeoutSeconds = $settings.requestTimeoutSeconds
    MaxOutputTokens = $settings.maxOutputTokens
    ApiKeyRequired = $settings.apiKeyRequired
    ApiKeyConfigured = -not [string]::IsNullOrWhiteSpace([string]$settings.apiKey)
} | Format-List
