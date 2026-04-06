# School Scanner PoC Architecture

## Product direction taken from the business case

The business case argues for:

- trust before growth
- interpretation rather than raw school data dumps
- a freemium or pay-per-report model
- careful handling of credibility and legal risk

That leads to this PoC architecture:

- one landing flow for the 4 prompt branches
- one preview endpoint returning a free layer and a premium layer
- one server boundary where security controls and future auth/paywall checks can live

## Current components

### Frontend

- `web/index.html`
- `web/styles.css`
- `web/app.js`

Responsibilities:

- branch selection
- question intake
- preview rendering
- premium upsell presentation

### Server

- `server/SchoolScanner.Server.psm1`
- `server/Start-SchoolScanner.ps1`

Responsibilities:

- input validation
- strict response headers
- rate limiting
- preview payload shaping
- static asset serving

### Tests

- `tests/SchoolScanner.Tests.ps1`
- `tests/PageObjects/HomePage.ps1`

Responsibilities:

- unit coverage for validation and preview logic
- page-object-style checks for the landing page flow
- API smoke coverage

## Paywall-ready seam

The API already separates:

- `previewPoints`
- `premiumPoints`
- `gate`

That makes the next step straightforward:

1. Add authentication.
2. Add entitlements or purchase checks.
3. Swap the current teaser response for a real full-report response when access is granted.

The page flow does not need to change.

## OWASP and ZAP considerations

### Already implemented

- no inline scripts
- CSP set at the server
- frame denial
- content type sniffing disabled
- no-referrer policy
- permissions policy restricting browser features
- server-side request validation
- small payload cap
- basic in-memory rate limit
- text-only DOM insertion for user-controlled data

### Recommended next steps before production

- add real authentication and session management
- add CSRF protection once authenticated state exists
- centralize structured logging with sensitive-field redaction
- use TLS termination and HSTS in the reverse proxy
- move rate limiting to the edge
- add automated dynamic scanning in CI with ZAP
- store secrets outside the repo and rotate them

## Why not overbuild the PoC

This version is intentionally simple:

- low dependency count
- easy to inspect
- small attack surface
- stable enough to demo and test the value proposition

That is the right tradeoff for a proof of concept that still wants to grow into a paywalled product.
