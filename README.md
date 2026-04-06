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

## Required configuration

Set an OpenAI API key before expecting live answers:

```powershell
$env:OPENAI_API_KEY="your_api_key_here"
```

Optional:

```powershell
$env:OPENAI_MODEL="gpt-5"
```

Without `OPENAI_API_KEY`, the frontend will correctly wait for the backend and then return a configuration-required response instead of generating a local shortcut answer.

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
