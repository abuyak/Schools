Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Security | Out-Null

function Get-SchoolScannerConfigRoot {
    [CmdletBinding()]
    param()

    $override = [System.Environment]::GetEnvironmentVariable("SCHOOLSCANNER_CONFIG_ROOT", "Process")
    if ([string]::IsNullOrWhiteSpace($override)) {
        $override = [System.Environment]::GetEnvironmentVariable("SCHOOLSCANNER_CONFIG_ROOT", "User")
    }
    if ([string]::IsNullOrWhiteSpace($override)) {
        $override = [System.Environment]::GetEnvironmentVariable("SCHOOLSCANNER_CONFIG_ROOT", "Machine")
    }

    if (-not [string]::IsNullOrWhiteSpace($override)) {
        return $override
    }

    return (Join-Path (Join-Path $PSScriptRoot "..") ".local")
}

function Get-SchoolScannerConfigPath {
    [CmdletBinding()]
    param()

    return (Join-Path (Get-SchoolScannerConfigRoot) "research-settings.json")
}

function Get-SchoolScannerSecretsPath {
    [CmdletBinding()]
    param()

    return (Join-Path (Get-SchoolScannerConfigRoot) "research-secrets.clixml")
}

function Initialize-SchoolScannerConfigStore {
    [CmdletBinding()]
    param()

    $root = Get-SchoolScannerConfigRoot
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        New-Item -ItemType Directory -Path $root -Force | Out-Null
    }

    return $root
}

function Get-ResearchSettingsDefaults {
    [CmdletBinding()]
    param()

    return [ordered]@{
        provider = "openai_compatible"
        model = "gpt-5"
        baseUrl = "https://api.openai.com/v1"
        responsesPath = "/responses"
        apiKeyRequired = $true
    }
}

function ConvertTo-PlainTextFromSecureString {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [Security.SecureString]$SecureString
    )

    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    }
    finally {
        if ($bstr -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }
}

function Protect-SecretValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$PlainText,
        [ValidateSet("CurrentUser", "LocalMachine")]
        [string]$Scope = "LocalMachine"
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($PlainText)
    $protected = [System.Security.Cryptography.ProtectedData]::Protect(
        $bytes,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::$Scope
    )

    return [Convert]::ToBase64String($protected)
}

function Unprotect-SecretValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$CipherText,
        [ValidateSet("CurrentUser", "LocalMachine")]
        [string]$Scope = "LocalMachine"
    )

    $protected = [Convert]::FromBase64String($CipherText)
    $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protected,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::$Scope
    )

    return [System.Text.Encoding]::UTF8.GetString($bytes)
}

function ConvertTo-PlainHashtable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        $InputObject
    )

    if ($null -eq $InputObject) {
        return @{}
    }

    if ($InputObject -is [hashtable]) {
        return $InputObject
    }

    $result = @{}
    foreach ($property in $InputObject.PSObject.Properties) {
        $result[[string]$property.Name] = $property.Value
    }
    return $result
}

function Get-JsonFileHashtable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return @{}
    }

    $content = Get-Content -LiteralPath $Path -Raw
    if ([string]::IsNullOrWhiteSpace($content)) {
        return @{}
    }

    return ConvertTo-PlainHashtable -InputObject (ConvertFrom-Json -InputObject $content)
}

function Get-StoredResearchSecrets {
    [CmdletBinding()]
    param()

    $path = Get-SchoolScannerSecretsPath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return @{}
    }

    $content = Get-Content -LiteralPath $path -Raw
    if ([string]::IsNullOrWhiteSpace($content)) {
        return @{}
    }

    $result = @{}
    $trimmed = $content.Trim()
    if ($trimmed.StartsWith("{")) {
        $plain = ConvertTo-PlainHashtable -InputObject (ConvertFrom-Json -InputObject $content)
        if ($plain.ContainsKey("apiKeyCipher") -and -not [string]::IsNullOrWhiteSpace([string]$plain.apiKeyCipher)) {
            $scope = if ($plain.ContainsKey("scope") -and -not [string]::IsNullOrWhiteSpace([string]$plain.scope)) { [string]$plain.scope } else { "LocalMachine" }
            $result.apiKey = Unprotect-SecretValue -CipherText ([string]$plain.apiKeyCipher) -Scope $scope
        }
        return $result
    }

    $imported = Import-Clixml -LiteralPath $path
    $plain = ConvertTo-PlainHashtable -InputObject $imported
    if ($plain.ContainsKey("apiKey") -and $plain.apiKey -is [Security.SecureString]) {
        $result.apiKey = ConvertTo-PlainTextFromSecureString -SecureString $plain.apiKey
    }

    return $result
}

function Get-EnvValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    foreach ($scope in @("Process", "User", "Machine")) {
        $value = [System.Environment]::GetEnvironmentVariable($Name, $scope)
        if (-not [string]::IsNullOrWhiteSpace($value)) {
            return @{
                value = $value
                source = "env:$scope"
            }
        }
    }

    return @{
        value = $null
        source = $null
    }
}

function Get-SchoolScannerResearchSettings {
    [CmdletBinding()]
    param()

    $defaults = Get-ResearchSettingsDefaults
    $configFile = Get-JsonFileHashtable -Path (Get-SchoolScannerConfigPath)
    $secrets = Get-StoredResearchSecrets

    $settings = [ordered]@{
        provider = [string]$defaults.provider
        model = [string]$defaults.model
        baseUrl = [string]$defaults.baseUrl
        responsesPath = [string]$defaults.responsesPath
        apiKeyRequired = [bool]$defaults.apiKeyRequired
        apiKey = $null
        sources = [ordered]@{
            provider = "default"
            model = "default"
            baseUrl = "default"
            responsesPath = "default"
            apiKeyRequired = "default"
            apiKey = $null
        }
    }

    foreach ($key in @("provider", "model", "baseUrl", "responsesPath", "apiKeyRequired")) {
        if ($configFile.ContainsKey($key) -and $null -ne $configFile[$key] -and "$($configFile[$key])" -ne "") {
            $settings[$key] = if ($key -eq "apiKeyRequired") { [bool]$configFile[$key] } else { [string]$configFile[$key] }
            $settings.sources[$key] = "config"
        }
    }

    if ($secrets.ContainsKey("apiKey") -and -not [string]::IsNullOrWhiteSpace([string]$secrets.apiKey)) {
        $settings.apiKey = [string]$secrets.apiKey
        $settings.sources.apiKey = "encrypted_file"
    }

    $envModel = Get-EnvValue -Name "OPENAI_MODEL"
    if (-not [string]::IsNullOrWhiteSpace([string]$envModel.value)) {
        $settings.model = [string]$envModel.value
        $settings.sources.model = [string]$envModel.source
    }

    $envBaseUrl = Get-EnvValue -Name "OPENAI_BASE_URL"
    if (-not [string]::IsNullOrWhiteSpace([string]$envBaseUrl.value)) {
        $settings.baseUrl = [string]$envBaseUrl.value
        $settings.sources.baseUrl = [string]$envBaseUrl.source
    }

    $envResponsesPath = Get-EnvValue -Name "OPENAI_RESPONSES_PATH"
    if (-not [string]::IsNullOrWhiteSpace([string]$envResponsesPath.value)) {
        $settings.responsesPath = [string]$envResponsesPath.value
        $settings.sources.responsesPath = [string]$envResponsesPath.source
    }

    $envApiKeyRequired = Get-EnvValue -Name "SCHOOLSCANNER_API_KEY_REQUIRED"
    if (-not [string]::IsNullOrWhiteSpace([string]$envApiKeyRequired.value)) {
        $settings.apiKeyRequired = [System.Convert]::ToBoolean($envApiKeyRequired.value)
        $settings.sources.apiKeyRequired = [string]$envApiKeyRequired.source
    }

    $envApiKey = Get-EnvValue -Name "OPENAI_API_KEY"
    if (-not [string]::IsNullOrWhiteSpace([string]$envApiKey.value)) {
        $settings.apiKey = [string]$envApiKey.value
        $settings.sources.apiKey = [string]$envApiKey.source
    }

    return $settings
}

function Set-SchoolScannerResearchConfig {
    [CmdletBinding()]
    param(
        [string]$Provider,
        [string]$Model,
        [string]$BaseUrl,
        [string]$ResponsesPath,
        [Nullable[bool]]$ApiKeyRequired
    )

    $current = Get-JsonFileHashtable -Path (Get-SchoolScannerConfigPath)
    $updated = [ordered]@{}

    foreach ($key in @("provider", "model", "baseUrl", "responsesPath", "apiKeyRequired")) {
        if ($current.ContainsKey($key)) {
            $updated[$key] = $current[$key]
        }
    }

    if ($PSBoundParameters.ContainsKey("Provider")) {
        $updated.provider = $Provider
    }
    if ($PSBoundParameters.ContainsKey("Model")) {
        $updated.model = $Model
    }
    if ($PSBoundParameters.ContainsKey("BaseUrl")) {
        $updated.baseUrl = $BaseUrl
    }
    if ($PSBoundParameters.ContainsKey("ResponsesPath")) {
        $updated.responsesPath = $ResponsesPath
    }
    if ($PSBoundParameters.ContainsKey("ApiKeyRequired")) {
        $updated.apiKeyRequired = [bool]$ApiKeyRequired
    }

    Initialize-SchoolScannerConfigStore | Out-Null
    $path = Get-SchoolScannerConfigPath
    Set-Content -LiteralPath $path -Value ($updated | ConvertTo-Json -Depth 4) -Encoding UTF8
    return $path
}

function Set-SchoolScannerApiKey {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ApiKey
    )

    if ([string]::IsNullOrWhiteSpace($ApiKey)) {
        throw "ApiKey cannot be empty."
    }

    Initialize-SchoolScannerConfigStore | Out-Null
    $path = Get-SchoolScannerSecretsPath
    $payload = [ordered]@{
        version = 2
        scope = "LocalMachine"
        apiKeyCipher = (Protect-SecretValue -PlainText $ApiKey -Scope "LocalMachine")
    }
    Set-Content -LiteralPath $path -Value ($payload | ConvertTo-Json -Depth 4) -Encoding UTF8
    return $path
}

function Clear-SchoolScannerApiKey {
    [CmdletBinding()]
    param()

    $path = Get-SchoolScannerSecretsPath
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Remove-Item -LiteralPath $path -Force
    }
}

Export-ModuleMember -Function Get-SchoolScannerConfigRoot, Get-SchoolScannerConfigPath, Get-SchoolScannerSecretsPath, Get-SchoolScannerResearchSettings, Set-SchoolScannerResearchConfig, Set-SchoolScannerApiKey, Clear-SchoolScannerApiKey
