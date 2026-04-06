Set-StrictMode -Version Latest

class HomePage {
    [string]$Html

    HomePage([string]$html) {
        $this.Html = $html
    }

    [bool] HasTitle() {
        return $this.Html -match "<title>School Scanner</title>"
    }

    [bool] HasFourBranchCards() {
        return ([regex]::Matches($this.Html, 'class="branch-card').Count -eq 4)
    }

    [bool] HasSupportButton() {
        return $this.Html -match "Buy me a Coffee if you like the answer"
    }

    [bool] HasSecuritySection() {
        return $this.Html -match "OWASP-aware by design" -and $this.Html -match "Strict Content Security Policy"
    }
}
