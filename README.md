# School Scanner PoC

This project turns the four prompt branches into a single mobile-first web flow:

- evaluate one school
- compare named schools
- check a postcode or area
- plan admissions backup routes

## Why this shape

The business case emphasizes trust, interpretation, and a future freemium model. The current build therefore uses:

- secure-by-default server behavior
- a server-only research flow
- OpenAI Responses API integration for live web research
- no browser-side question parsing

## Run locally

Start the local server:

```powershell
powershell -ExecutionPolicy Bypass -File .\server\Start-SchoolScanner.ps1 -Port 8080
```

Then open [http://localhost:8080](http://localhost:8080).

## Research configuration

You now have two ways to configure the backend:

1. Environment variables for quick one-off runs
2. An untracked local config store in [.local](/C:/Users/Skye/Documents/Codex/Schools/.local) for safer day-to-day use

Quick run with environment variables:

```powershell
$env:OPENAI_API_KEY="your_api_key_here"
$env:OPENAI_MODEL="gpt-5-mini"
$env:OPENAI_BASE_URL="https://api.openai.com/v1"
```

Safer local setup with an encrypted key file:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Set-LocalResearchConfig.ps1 -ApiKey "your_api_key_here" -Model "gpt-5-mini" -ReasoningEffort "low" -RequestTimeoutSeconds 45 -MaxOutputTokens 1200
```

That writes:

- config to `.local/research-settings.json`
- the API key to `.local/research-secrets.clixml`

The secret file is encrypted with Windows DPAPI for the current user account, so it is not stored in plaintext and is ignored by git.

For a local OpenAI-compatible backend, you can point the app elsewhere:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Set-LocalResearchConfig.ps1 -Model "llama3.1" -BaseUrl "http://127.0.0.1:11434/v1" -NoApiKeyRequired
```

Resolution order is:

1. Process/User/Machine environment variables
2. Local encrypted config in `.local`
3. Built-in defaults

The built-in defaults now bias toward lower-cost live research:

- model: `gpt-5-mini`
- reasoning effort: `low`
- request timeout: `45s`
- max output tokens: `1200`

Without a required API key, the frontend will correctly wait for the backend and then return a configuration-required response instead of generating a local shortcut answer.

## Test suite

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\tests\Run-Tests.ps1
```

The test suite covers:

- server-side validation logic
- security headers
- live-retrieval request shaping
- page-object-style checks against the served landing page

## Security notes

This PoC bakes in common OWASP/ZAP concerns early:

- strict CSP with external scripts only
- `nosniff`, frame denial, and tight referrer policy
- request size limits
- input validation
- basic rate limiting
- safe DOM updates using text-only rendering

## Live research architecture

The frontend now sends the selected branch and question to a server research endpoint.

The backend is responsible for:

1. building the branch-specific research instructions
2. calling the OpenAI Responses API with the web search tool
3. returning a structured answer

The browser does not generate local answers.
