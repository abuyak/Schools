#!/usr/bin/env pwsh
# deploy.ps1 — Deploy School Scanner to AWS
# Usage: .\deploy.ps1

param(
    [switch]$LambdaOnly,   # only deploy Lambda (skip S3/CloudFront)
    [switch]$FrontendOnly  # only deploy frontend (skip Lambda)
)

$ErrorActionPreference = "Stop"
$S3Bucket = "school-scanner-web"
$CloudFrontDistId = (aws cloudfront list-distributions --query "DistributionList.Items[0].Id" --output text)

Write-Host ""
Write-Host "School Scanner — Deploy" -ForegroundColor Cyan
Write-Host "======================" -ForegroundColor Cyan

# ── Lambda ──────────────────────────────────────────────────────────────────
if (-not $FrontendOnly) {
    Write-Host ""
    Write-Host "Deploying Lambda..." -ForegroundColor Yellow
    sam deploy
    if ($LASTEXITCODE -ne 0) { Write-Host "Lambda deploy failed." -ForegroundColor Red; exit 1 }
    Write-Host "Lambda deployed." -ForegroundColor Green
}

# ── Frontend ─────────────────────────────────────────────────────────────────
if (-not $LambdaOnly) {
    Write-Host ""
    Write-Host "Uploading frontend to S3..." -ForegroundColor Yellow
    aws s3 sync "$PSScriptRoot\web" "s3://$S3Bucket" --delete
    if ($LASTEXITCODE -ne 0) { Write-Host "S3 upload failed." -ForegroundColor Red; exit 1 }
    Write-Host "Frontend uploaded." -ForegroundColor Green

    Write-Host ""
    Write-Host "Invalidating CloudFront cache..." -ForegroundColor Yellow
    aws cloudfront create-invalidation --distribution-id $CloudFrontDistId --paths "/*" | Out-Null
    Write-Host "Cache invalidated." -ForegroundColor Green
}

Write-Host ""
Write-Host "Deploy complete." -ForegroundColor Cyan
Write-Host "https://d3jaoys6w4aver.cloudfront.net" -ForegroundColor Cyan
Write-Host ""
