# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development rules

**Don't break the build:**
- Run `npm test` in `functions/research` before every deploy. Never ship failing tests.
- Verify with `curl` against the Lambda URL after deploy.

**Don't repeat yourself:**
- If you're writing the same logic in two places, extract a shared function at module level.
- Before adding a new helper, check if one already exists in the file.

**Commit often:**
- Commit working changes at least every few hours. Don't let uncommitted fixes pile up — a single bad revert can wipe everything.

**Keep it simple:**
- govuk.js is large. Make surgical edits; don't rewrite functions unless necessary.
- Prompt files are short — edit directly.

## Project overview

School Scanner is a mobile-first web app that answers UK school-choice questions across four decision paths: evaluate a school, compare schools, check an area, and plan admissions backup routes. It pre-fetches UK government school data (Ofsted, DfE performance, GIAS, financial benchmarking, census) and then calls an OpenAI-compatible API (Responses API with web search tool) to produce structured, cited answers.

## Commands

**Local server:**
```powershell
powershell -ExecutionPolicy Bypass -File .\server\Start-SchoolScanner.ps1 -Port 8080
```

**Lambda (research function) tests — Jest (Node.js):**
```bash
cd functions/research
npm test                                    # all unit tests
npm test -- --testPathPatterns='handler'    # handler tests only
npm run test:smoke                          # deployed Lambda smoke tests (needs LAMBDA_URL env var)
```

**Server tests — Pester (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File .\tests\Run-Tests.ps1
```

**Manual CLI test tools:**
```bash
node test-govuk.mjs "Fortismere School"              # test gov.uk data fetching
node test-handler.mjs "Tell me about Redriff..."      # test full pipeline
node test-handler.mjs --branch 2 "Reigate vs..."      # test specific branch
```

**Deploy:**
```bash
sam build && sam deploy --no-confirm-changeset  # Lambda only
./deploy.ps1                                     # Lambda + S3 + CloudFront
```

**Data maintenance:**
```bash
node scripts/build-ethnicity-index.mjs          # rebuild DfE ethnicity index (run annually ~June)
node scripts/build-subject-entries-index.mjs    # rebuild KS4 subject entries lookup (run annually ~April)
node scripts/build-ks5-subject-entries-index.mjs # rebuild KS5 subject entries lookup (run annually ~April)
```

**Encrypted local config:**
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Set-LocalResearchConfig.ps1 -ApiKey "sk-..." -Model "gpt-5-mini" -ReasoningEffort "low"
```

## Architecture

### Two parallel server implementations

The local dev server and the production Lambda share the same contract but use different implementations:

- **Local dev server** (`server/`): PowerShell HTTP server using `TcpListener`. Modules: `SchoolScanner.Server.psm1` (HTTP + security headers + routing), `SchoolScanner.Config.psm1` (API key encryption via Windows DPAPI, config resolution), `SchoolScanner.LiveRetrieval.psm1` (OpenAI API call), `SchoolScanner.Analytics.psm1` (geo-lookup + JSONL analytics).

- **Production Lambda** (`functions/research/`): Node.js 22, handler at `index.js` → `handler`. Called via Lambda Function URL (no API Gateway for research endpoint). Health endpoint uses API Gateway.

### Research pipeline (branch 1 — the hot path)

Branch 1 uses a **three-part architecture**:

1. **Pre-fetch + Part A** (server-side, deterministic): `govuk.js` fetches structured government data (GIAS, Ofsted, DfE performance, financial benchmarking, census/CrystalRoof, ONS income). Key function: `fetchGovDataForPrompt()` gathers all data per school. `renderPartA()` outputs Part A (Official Record) as a deterministic section — no AI involved.

2. **Call 1 — Quick Take** (AI, cached, no web search): Title + summary + scorecard. Uses only the pre-fetched data block. Cheap, fast, cached.

3. **Call 2 — Parts B+C** (AI, full model + web search): Independent research and community/character sections. Uses the `prompt_branch_1_bc_v1.md` prompt.

Branches 2–4 use a single-call flow: full prompt (from the `.md` files) + pre-fetched data + web search in one call.

### Key files

| File | Role |
|---|---|
| `functions/research/index.js` | Lambda handler — validation, prompt loading, OpenAI call, response parsing |
| `functions/research/govuk.js` | All UK government data fetching (~3,300 lines) — GIAS, Ofsted, DfE performance, financial, area/census |
| `functions/research/local-data.js` | Zero-latency bundled data lookups (DfE ethnicity index) |
| `functions/research/.md/` | Branch-specific AI prompts as markdown files |
| `web/app.js` | Single-page frontend — branch selector, markdown renderer, analytics |
| `template.yaml` | AWS SAM template — Lambda, CloudFront security headers, CloudWatch dashboard |

### Data flow

```
Browser question → POST /api/research { branch, question }
  → govuk.js pre-fetches structured data from UK gov APIs
  → AI prompt assembled (branch instructions + pre-fetched data block + output constraints)
  → OpenAI Responses API (web search tool enabled)
  → JSON response parsed, web sources extracted → { title, summary, scorecard, sections[] }
```

### Caching strategy

Local dev server caches Quick Take results in memory by `branch + question`. The Lambda is stateless. No persistent cache in production (by design — answers include live web research).

### Bundled data (deploy-time preprocessing)

Several data sources are pre-processed into JSON lookups bundled with the Lambda, following the pattern: **download official CSV → build script → bundled JSON in `functions/research/sources/` → local import at runtime**. This eliminates HTTP latency and API code-mapping fragility at request time.

| Data | Script | Output | Refresh |
|---|---|---|---|
| DfE ethnicity index | `scripts/build-ethnicity-index.mjs` | `sources/dfe-school-ethnicity.json` | Annual (~June) |
| KS4 subject entries | `scripts/build-subject-entries-index.mjs` | `sources/subject-entries-by-urn.json` | Annual (~April) |
| KS5 subject entries | `scripts/build-ks5-subject-entries-index.mjs` | `sources/ks5-subject-entries-by-urn.json` | Annual (~April) |
| Parent View (TD-006) | `scripts/build-parent-view-index.mjs` | `sources/parent-view-by-urn.json` | Not yet built |
| Ofsted grades (TD-007) | `scripts/build-ofsted-index.mjs` | `sources/ofsted-outcomes-by-urn.json` | Not yet built |
| GIAS school register (TD-008) | `scripts/build-gias-index.mjs` | `sources/gias-schools-by-urn.json` | Not yet built |
| ONS income (TD-002) | `scripts/build-ons-income-lookup.mjs` | `data/ons-income-by-msoa.json` | Not yet built |

National averages are hardcoded in `NATIONAL_AVG` in `govuk.js`, updated annually.

### Reference data & requirements

- **EES CSVs** (`docs/EES/KS4/data/`, `docs/EES/KS5/data/`): Downloaded from [explore-education-statistics.service.gov.uk](https://explore-education-statistics.service.gov.uk). The definitive source for subject names, qualification types, and entry counts. Used by build scripts to produce bundled JSON. The CSV has human-readable labels — always prefer it over the EES API when you need subject/qualification names.
- **Wiremock templates** (`docs/mocks/`): Per-school-type CSV templates showing every DfE variable we handle and its expected LA/England comparator. These freeze the contract — when the DfE changes variable names or the CSV format, diff against these templates.
- **Data source inventory** (`docs/mocks/data-source-inventory.md`): Every external API/data source we hit, what we extract from each, and what's left behind. Read this before adding new data points.
- **AI prompts** (`functions/research/.md/`): Branch-specific prompts as markdown files. The prompt determines which sections the AI produces; the pre-fetched data block determines what evidence it has.
- **Tech debt** (`TECH_DEBT.md`): Tracked compromises with severity, fix plan, and "done when" criteria.

### Configuration resolution order

1. Process/User/Machine environment variables
2. `.local/research-settings.json` + `.local/research-secrets.clixml` (Windows DPAPI encrypted)
3. Built-in defaults (gpt-5-mini, low reasoning, 45s timeout, 1200 max tokens)

### CI/CD

GitHub Actions (`.github/workflows/deploy.yml`): Jest unit tests (Ubuntu) → Pester tests (Windows) → SAM build/deploy → S3/CloudFront deploy → smoke tests. Only deploys on push to `master`. OIDC auth to AWS.

Annual data refresh reminder opens a GitHub Issue each 1 June to update bundled DfE datasets and national averages.

## Tech debt

See `TECH_DEBT.md` for tracked items. Key themes: several live HTTP data fetches should be pre-processed at deploy time into bundled JSON lookups (ONS income CSV, Ofsted grades, GIAS school register, DfE performance data). No structured logging or CloudWatch alarms on fetch failures.
