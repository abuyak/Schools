Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Import-Module Pester -MinimumVersion 3.4.0
Invoke-Pester -Script @(
    (Join-Path $PSScriptRoot "SchoolScanner.Tests.ps1"),
    (Join-Path $PSScriptRoot "SchoolScanner.ApiContract.Tests.ps1")
) -EnableExit
