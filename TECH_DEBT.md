# Tech Debt

Tracked items that are known, intentional compromises. Each entry has a severity,
the file/function to change, and what "done" looks like.

---

## TD-001 · Crystal Roof (TEMP data source)
**Severity:** High — external dependency with no SLA, no auth contract  
**File:** `functions/research/govuk.js` → `fetchCrystalRoof()`  
**Integration test:** `functions/research/test-crystal-roof-api.mjs` (run on every master deploy)

**Problem:**  
Crystal Roof (`crystalroof.co.uk`) is currently unauthenticated at the API level —
no key, no token, no contract. The website requires login but the underlying JSON
endpoint does not. This is undocumented behaviour that can change silently at any time.

**Data provided (Census 2021, OA/MSOA grain):**
- Qualifications: % no qualifications, % level 4+, full breakdown
- Occupation / NS-SeC: % professional/managerial, % routine/manual, full breakdown
- Household income: mean gross annual income at MSOA level

**Production replacement (Nomis — free, stable, documented):**
- Qualifications → Nomis dataset `NM_2082_1` (TS067, Census 2021, OA level)
- Occupation → Nomis dataset `NM_2066_1` (NS-SeC, Census 2021, OA level)
- Pattern: resolve OA code from postcode → 2-step Nomis query (geography lookup then data fetch)
- Income: ONS income estimates by MSOA (`NM_2011_1` or MHCLG small area income estimates)

**Done when:** `fetchCrystalRoof()` is replaced by direct Nomis calls and the
integration test is removed (or repurposed as a Nomis smoke test).

---

## TD-002 · ONS Income CSV — fetched fresh per request
**Severity:** Medium — 680 KB download on every Lambda cold path  
**File:** `functions/research/govuk.js` → `fetchONSIncome()`

**Problem:**  
The ONS small-area income CSV (~680 KB) is downloaded from the ONS API on every
request that needs area data. The file is static — it updates once a year at most.

**Fix:**  
Pre-process at deploy time into a JSON lookup keyed by MSOA code, bundle it with
the Lambda (adds ~200 KB to the deployment package). Eliminates the network round-trip
and parsing cost entirely.

**Steps:**
1. Write a one-off script `scripts/build-ons-income-lookup.mjs` that fetches the CSV,
   parses it, and writes `functions/research/data/ons-income-by-msoa.json`
2. Add the script to the deploy pipeline (`deploy.ps1` or `samconfig.toml` build hook)
3. In `fetchONSIncome()`, import the bundled JSON instead of fetching

**Done when:** no outbound HTTP call to ONS is made at request time.

---

## TD-003 · Ofsted PDF — streamed but not cached
**Severity:** Low — PDFs are large (1–5 MB) and fetched on every detailed request  
**File:** `functions/research/govuk.js` → `fetchAndParseOfstedPdf()`

**Problem:**  
Ofsted inspection reports are large PDFs fetched and parsed in memory on every
`prompt_branch_1` request. They rarely change (a school is inspected every 4–5 years).

**Fix:**  
Cache parsed PDF sections (the extracted text blocks, not the raw PDF) in S3 keyed
by `{urn}-{reportDate}`. On cache hit, skip the fetch entirely.

**Approximate saving:** 2–4 seconds and 1–5 MB of network transfer per request.

**Done when:** parsed PDF sections are read from S3 on cache hit, written on miss.

---

## TD-004 · DfE performance CSV — no caching
**Severity:** Low — ZIP + CSV download on every request  
**File:** `functions/research/govuk.js` → `getPerformanceData()`

**Problem:**  
DfE performance data is downloaded as a ZIP (several MB) and parsed on every request.
The data is published annually and does not change mid-year.

**Fix:** Same S3 caching pattern as TD-003, keyed by `{urn}-{academicYear}`.

**Done when:** parsed performance rows are read from S3 on cache hit, written on miss.

---

## TD-005 · No structured logging or error telemetry
**Severity:** Low — silent failures are hard to diagnose in production  
**File:** `functions/research/govuk.js` → `safeFetchJson()` and all `getXxx()` functions

**Problem:**  
Failed fetches return `null` silently. In production, if Crystal Roof goes down or
a DfE endpoint changes, the slim block simply omits the section with no alert.

**Fix:**  
Emit a structured CloudWatch log line (JSON) for every failed fetch with:
`{ source, url, status, error, urn }`. Add a CloudWatch metric filter + alarm on
error rate > 5% over 1 hour.

**Done when:** fetch failures are visible in CloudWatch and alert on sustained errors.

---

## ~~TD-006~~ · ✅ RESOLVED — Ofsted Parent View pre-fetch (PR d039165, 2026-04-24)
**Was:** Low — the AI was given the URL and must fetch it; the page is JS-rendered so the AI typically can't retrieve the data  
**File:** `functions/research/govuk.js` — new function needed

**Problem:**  
Parent View survey results (% would recommend, % child happy, % feels safe, etc.) are 
valuable for parent decision-making. The website (`parentview.ofsted.gov.uk`) is Drupal 11 
with JS-rendered data — a simple `fetch()` returns a bare HTML shell without any survey 
figures. Currently we pass the URL to the AI so it can attempt to retrieve it, but this 
usually fails silently since the AI's web search can't execute JavaScript.

**Fix:**  
Ofsted publishes the full Parent View MI dataset as a spreadsheet updated quarterly:  
`https://www.gov.uk/government/statistical-data-sets/ofsted-parent-view-management-information`

Pre-process at deploy time (same pattern as TD-002):
1. Download the latest `.ods` or `.xlsx` from that URL
2. Parse it into a JSON lookup keyed by URN: `{ urn: { recommend, happy, safe, wellBehaved, wellLed, totalResponses } }`
3. Bundle as `functions/research/data/parent-view-by-urn.json`
4. In `getOfstedData()`, replace the URL-only approach with a direct lookup
5. Add the % data to `fmtOfstedSlim` (the `fetchParentView` stub is already there, ready to wire up)

**Data available per school:**
- % would recommend this school
- % child is happy here  
- % child feels safe
- % pupils are well behaved
- % school is well led and managed
- % concerns are handled well
- Total number of responses

**Done when:** Parent View % data appears in the slim block without any AI web search needed.

---

## TD-007 · Ofsted inspection grades — scraped from HTML, not bundled
**Severity:** Medium — HTML scraping is fragile; Ofsted grades are static between inspections  
**File:** `functions/research/govuk.js` → `getOfstedData()`

**Problem:**  
Ofsted inspection grades (overall, sub-grades, date, safeguarding status) are scraped from
the Ofsted HTML page per request. This adds ~1–2 seconds of latency, fails silently when
the HTML structure changes, and does redundant work — a school's grade doesn't change until
it is re-inspected (typically every 4–5 years).

**Fix:**  
Ofsted publishes a complete monthly data download of all inspection outcomes:  
`https://www.gov.uk/government/statistical-data-sets/monthly-management-information-ofsteds-school-inspections-outcomes`

Pre-process at deploy time (same pattern as TD-002 / TD-006):
1. Write `scripts/build-ofsted-index.mjs` — downloads the latest XLSX/CSV, parses into
   `{ urn: { overall, qualityOfEducation, behaviour, personalDevelopment, leadership, date, reportUrl } }`
2. Bundle as `functions/research/sources/ofsted-outcomes-by-urn.json` (~3 MB)
3. Add lookup in `local-data.js`: `getOfstedGrades(urn)`
4. In `getOfstedData()`, replace the HTML scrape with the bundled lookup (keep the HTML
   scrape as a fallback for schools not in the index)
5. Add to the GitHub Actions annual (or monthly) reminder workflow

**Approximate saving:** 1–2 seconds of latency + eliminates the fragile HTML dependency.  
**Note:** The PDF narrative fetch (`fetchAndParseOfstedPdf`) is separate and still needed — this only replaces the grade scraping.

**Done when:** inspection grades are served from the bundled index with zero HTTP calls.

---

## TD-008 · GIAS school register — URN lookup via live HTTP search
**Severity:** Medium — live search occasionally mismatches school names and adds latency  
**File:** `functions/research/govuk.js` → `lookupSchoolURN()`

**Problem:**  
URN lookup does a live HTTP search against GIAS (`get-information-schools.service.gov.uk`)
on every request. This adds ~1 second, can time out, and occasionally returns the wrong
school when names are ambiguous (e.g. "St Mary's" matching 40+ schools).

**Fix:**  
GIAS publishes a full register download of all open establishments:  
`https://get-information-schools.service.gov.uk/Downloads` → "All establishment data" CSV

Pre-process at deploy time:
1. Write `scripts/build-gias-index.mjs` — downloads the GIAS CSV (~5 MB, ~50,000 rows),
   indexes by URN and by normalised name
2. Bundle as `functions/research/sources/gias-schools-by-urn.json` (~4 MB estimated)
3. Add lookup in `local-data.js`: `findSchoolByName(name)` and `getSchoolByUrn(urn)`
4. Replace the GIAS HTTP search with the bundled lookup; fall back to live search only
   if name match confidence is below a threshold
5. Add to the GitHub Actions annual reminder workflow

**Approximate saving:** 1 second of latency + eliminates live-search mismatches.  
**Note:** The bundled register goes stale for newly opened/closed schools. Monthly rebuild
recommended. Newly opened schools (rare) would fall back to live search.

**Done when:** URN resolution is served from the bundled index for >95% of queries.

---

## TD-009 · Parent View — no fallback to historical years when latest is unavailable
**Severity:** Medium — schools inspected under old frameworks may have no Parent View data for the current year  
**File:** `functions/research/govuk.js` → `fetchParentView()`

**Problem:**  
`fetchParentView()` fetches the Ofsted Parent View print page for a single academic year (currently hardcoded to `2024/2025`). If a school was last inspected under an older framework or the current year's data isn't published yet, the function returns `null` and the slim block shows `_Not retrieved_`. The AI then has to search for Parent View data itself — which usually fails because the Parent View site is JS-rendered.

Parent View data is cumulative — Ofsted publishes MI spreadsheets with all historical responses per school going back to 2017/18. A school that hasn't been inspected recently still has valid historical responses.

**Fix:**
1. `fetchParentView(urn)` already parses the parentview.ofsted.gov.uk print page. When the latest year returns no data:
   - Try the previous academic year (e.g. `2023/2024` → `2022/2023` etc.)
   - Parse each year's print page until data is found
   - Stop after 3 years of no data (older data has limited signal value)
2. Alternatively, pre-process the full Parent View MI dataset at deploy time (same pattern as TD-006/TD-007) and serve from bundled JSON, keyed by `{urn}-{academicYear}`.

**Done when:** `fetchParentView()` returns data for schools with historical (not just current-year) Parent View responses.

---

## TD-010 · Ofsted PDF — A9 pupil experience parsing sometimes too short or generic
**Severity:** Medium — parent users primarily care about the pupil experience narrative  
**File:** `functions/research/govuk.js` → `fetchAndParseOfstedPdf()` and `extractSection()`

**Problem:**  
`fetchAndParseOfstedPdf()` downloads the Ofsted PDF and extracts structured sections (pupil experience, quality of education, behaviour, etc.) via `extractSection()`, which uses heading-pattern matching. For some report formats:
- The "pupil experience" section is captured as only 1–2 sentences when the PDF's actual pupil-experience narrative spans several pages
- Older-format Ofsted reports (pre-2019) use different section headings that the patterns don't match, causing the entire section to be missed
- The 3,000-char cap per narrative section can cut off important content mid-sentence for unusually detailed reports

The A9 section ("What it's like to be a pupil") is the most-read section by parents — thin or missing content here disproportionately impacts perceived answer quality.

**Fix:**
1. Add fallback heading patterns for older Ofsted framework reports (pre-2019: "Quality of teaching, learning and assessment", "Outcomes for pupils", "Personal development, behaviour and welfare")
2. When the extracted pupil-experience section is under 300 chars but the PDF is large (>200 KB), attempt a broader extraction: grab all text between the inspection findings heading and the next major section heading
3. Raise the per-section cap from 3,000 to 5,000 chars for the pupil-experience section specifically (other sections stay at 3,000)
4. Add an `extractAllNarrative()` fallback that extracts the full inspection findings text when per-section extraction yields too little content

**Done when:** A9 section consistently contains 500+ chars of pupil-experience narrative for Ofsted reports that include it, and pre-2019 reports are parsed correctly.
