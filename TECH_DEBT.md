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

---

## TD-011 · Area dynamics — Prompt 3 should surface multi-year deprivation trends
**Severity:** Medium — parents relocating to an area benefit from knowing whether it's improving or declining  
**File:** `functions/research/govuk.js` → `getAreaData()` and branch 3 prompt

**Problem:**  
`getAreaData()` fetches the latest IMD year (2025 preferred, 2019 fallback) and returns a single decile snapshot. But `findthatpostcode.uk` returns IMD data for 2015, 2019, and 2025 — all three years are available. For SE16 7LP, the area shifted from decile 9 (2015/2019) to decile 10 (2025), with crime improving from decile 5 to 7 and housing from 5 to 7. This trajectory is valuable context for a parent considering a move.

Prompt 3 (area/postcode search) currently has no concept of area dynamics. A parent asking "should we move to SE16?" gets a static snapshot when the trend is the more useful signal.

**Fix:**
1. `getAreaData()` should return `imdHistory`: an array of `{ year, decile, score, rank, subDomains }` for all available years
2. `fmtAreaDataSlim()` should include a one-line trend summary: "IMD trajectory: improving (decile 9 → 10 since 2015)" or "stable at decile 10"
3. Branch 3 prompt should include a section on area trajectory — is the area improving, stable, or declining across deprivation, crime, and housing sub-domains?
4. Consider adding house-price trajectory too (Land Registry data already has 5 years of transactions — could show median price trend)

**Done when:** Prompt 3 output includes an area trajectory section with multi-year IMD comparison, and the slim block shows the trend direction.

---

## TD-012 · University admissions data by school — Oxford source unclear, no automated refresh

**Severity:** Medium — data will stale without periodic refresh, Oxford source URL unknown  
**Files:** `sources/Oxford/oxford_admissions_merged.csv`, `sources/Cambridge/cambridge_admissions_merged.csv`  
**Used by:** `web/evidence-data.js` (bundled inline), branch prompts (referenced as local file)

**Problem:**
School Scanner has per-school Oxford and Cambridge admissions data (applications, offers,
accepts) covering 2006–2023. Cambridge publishes this data publicly at
`undergraduate.study.cam.ac.uk/apply/statistics`. The Oxford source URL is unknown —
the data format (UCAS School IDs, not DfE URNs) suggests it came from a FOI request or
a UCAS data feed rather than Oxford's public spreadsheets. Oxford's public spreadsheets
use DfE URNs and are at `ox.ac.uk/about/facts-and-figures/admissions-statistics` but
the old `sites/files/oxford/` URLs are dead and the new site blocks automated requests
(403).

**Other universities:**
| University | Source |
|---|---|
| Imperial | imperial.ac.uk/study/undergraduate/apply/admissions-statistics |
| LSE | info.lse.ac.uk/staff/divisions/planning-division/undergraduate-admissions-statistics |
| UCL | ucl.ac.uk/srs/governance-and-reporting/student-statistics |
| Durham | durham.ac.uk/about/student-facts/undergraduate-admissions-statistics |
| Warwick | warwick.ac.uk/services/aro/statistics/admissions |

**Done when:**
1. Oxford data source is identified and a URL/FOI reference is documented
2. A `scripts/build-admissions-index.mjs` script fetches/converts the latest data from
   each university and produces a bundled JSON file (like `build-isi-index.mjs` does for ISI)
3. The bundled file replaces the CSV+inline-JS approach in `evidence-data.js`
4. Annual refresh reminder is added to the June GitHub Issue (alongside DfE ethnicity update)

---

## TD-015 · Async Call 2 + queue-mediated inference

**Severity:** High — synchronous Call 2 blocks Lambda, burns wait-time cost, and will fail under concurrent load  
**File:** `functions/research/index.js` → Branch 1 & 2 handler  
**Ref:** `docs/requirements/Model Pricing and Architecture.md`

**Problem:**  
Both branches run Call 1 and Call 2 synchronously inside a single Lambda invocation.
Call 2 takes 15–32 seconds — the Lambda is billed for that entire wait. Under concurrent
beta load (10–20 testers), this creates:

- Lambda wait-time cost on every request
- OpenAI rate-limit bursts (all Call 2s hit simultaneously)
- p95 tail latency that makes the app feel broken
- No retry — a single 429 or timeout loses the full analysis

The architecture document prescribes: *"Queue everything. Do not let frontend traffic
hit the model directly. Without this, concurrency will crush you."*

**Fix:**

**Phase 1 — Lightweight async (beta-ready, no new infra):**
1. Return Call 1 (Quick Take) immediately — user sees title/summary/scorecard in ~3s
2. Fire Call 2 in the background within the same Lambda
3. Add a polling endpoint: `GET /api/research/{jobId}` returns `{ status, result }`
4. In-memory job store (Map) with 60s TTL — sufficient for single-Lambda dev/beta
5. UI polls every 2s; shows Call 1 data as final answer if Call 2 exceeds 60s

**Phase 2 — Queue-mediated (post-beta, production):**
1. SQS queue receives Call 2 jobs (school data pre-fetched, serialised in message)
2. Separate Call 2 worker Lambda reads from SQS, calls OpenAI, writes to DynamoDB
3. DynamoDB table keyed by job ID, TTL for auto-cleanup
4. Polling endpoint reads from DynamoDB
5. Token-aware scheduler: Lambda reserved concurrency gates throughput, smooths bursts
6. Dead-letter queue + auto-retry for failed Call 2s

**Done when:**  
- Phase 1: User gets Quick Take response in <5s; full sections arrive via polling
- Phase 2: System survives 100+ concurrent users without throttling or dropped requests

---
## TD-016 · No retry logic on OpenAI API calls

**Severity:** Medium — transient 429s and network errors fail the entire request  
**File:** `functions/research/index.js` → all `fetch()` calls to OpenAI

**Problem:**  
OpenAI API calls have zero retry logic. A single 429 (rate limit), 5xx, or network
blip propagates as a fatal error to the user. Under concurrent load, transient
failures become common — even a 99.9% success rate means 1 in 1,000 requests fails.

**Fix:**  
Add exponential backoff around every OpenAI `fetch()` call: initial delay 1s, max 3
retries, jitter to avoid thundering herd. Only retry on 429, 5xx, and network errors
(not 4xx).

**Done when:** transient OpenAI errors are retried transparently without user-visible failure.

---
## TD-013 · Ingest EES subject-level exam data for per-subject entry tables

**Severity:** Medium — adds per-subject entry lists to A5, currently missing  
**File:** `functions/research/govuk.js` — new `getSubjectEntries(urn)` function  
**Dataset:** `1ae39901-b462-df76-b108-640a078d7944` (Subject school level exam data)  
**Publication:** Key stage 4 performance (`c8756008-ed50-4632-9b96-01b5ca002a43`)

**Problem:**
The DfE compare-school-performance website shows a "Subjects entered at key stage 4" table
listing every subject and qualification type with entry counts. This data is in the EES
dataset above but we don't fetch it. The dataset is at school level (SCH), not LA level —
so it provides per-subject entry counts without LA/England comparators. Applies to ALL
schools (state and independent).

**EES dataset details:**
- Dataset: `1ae39901-b462-df76-b108-640a078d7944`
- Allowed location levels: EDA, INST, LA, LAD, LEP, LSIP, MAT, MCA, NAT, OA, PA, PCON, PFA, PROV, REG, RSC, SCH, SPON, WARD
- Includes per-subject entry counts by qualification type (GCSE, other)
- School identified by SCH code (not URN directly — needs mapping)

**Done when:**
1. School location code is mapped from URN
2. Per-subject entry counts are rendered as a table in the A5 KS4 section
3. Table shows: Subject | Qualification | Total entries

---

## TD-014 · KS5 LA comparisons from EES API

**Severity:** Medium — KS5 tables show England but not LA comparisons  
**File:** `functions/research/govuk.js` — new `getLAPerformanceKS5(laCode)` function  
**Dataset:** `019d913a-eae0-7043-b196-875639ce5402` (A level by region and subject)  
**Publication:** A level and other 16 to 18 results (`3f3a66ec-...`)

**Problem:**
The DfE compare-school-performance website shows LA comparisons for KS5 metrics
(average grade, average points, progress VA, AAB facilitating, retention).
The EES dataset returns LA-level data but uses opaque, unlabelled filter codes:
- `52udi`: subject/characteristic dimension (9 unique values)
- `mMa9K`: grade band/metric type (6 unique values)
- `41LUZ`: institution type (6 unique values)
- Value fields: `5TOPd` (count), `TuBeP` (count), `cZPZ3` (%), `tjcGE` (%)

Each result is per-subject × per-grade, requiring aggregation to get school-level
averages. Filter codes need mapping to human-readable dimensions.

**Approach options:**
1. Find EES metadata endpoint that labels filter/value codes (check /v1/meta or similar)
2. Cross-reference values against known DfE website data to reverse-engineer mappings
3. Scrape compare-school-performance website directly for LA figures

**Done when:**
1. KS5 LA data is fetched for the school's LA and displayed alongside England values
2. Minimum: average grade, average points, progress VA, AAB, retention LA values
3. Multi-year support (like KS4 results over time)

---

## TD-017 · Branch 2 table headers — first column has no title

**Severity:** Low — visual inconsistency with branch 1  
**File:** `functions/research/govuk.js` → `renderPartAComparison()`

**Problem:**
Branch 2 side-by-side comparison tables have no title for the first column (the category/label column). Branch 1 tables use "Category" as the first column header. The comparison tables leave it blank, which looks inconsistent.

Example — branch 1:
```
| Category | Value | National |
|---|---|---|
| Attainment 8 | 55.6 | 46.2 |
```

Branch 2 (current):
```
|  | School A | School B | National |
|---|---|---|---|
| Attainment 8 | 55.6 | 48.1 | 46.2 |
```

**Fix:** Add a first-column label (e.g. "Category" or "Metric") to all `buildTable3` and `buildTable4` calls in `renderPartAComparison()`.

**Done when:** Every branch 2 comparison table has a non-empty first-column header.

---

## TD-018 · Branch 1 — add A8 Parent View section

**Severity:** Medium — valuable parent data missing from single-school reports  
**File:** `functions/research/govuk.js` → `renderPartA()`

**Problem:**
Branch 2 (comparison) has a server-rendered A8 Parent View section with table data (% would recommend, % child happy, etc.). Branch 1 (single school) does not — the Parent View data is fetched but not rendered as Part A. The AI is expected to incorporate it into B1, but this is inconsistent: we pre-fetch the data and have it available, yet don't show it server-side.

Branch 1 should render A8 Parent View after A7, following the same pattern as branch 2:
- Single-school table (not side-by-side)
- Include national average if available
- ⚠️ threshold markers
- Footer explaining thresholds

**Done when:** Branch 1 Part A includes an A8 Parent View section with the same table format as branch 2 (single-column instead of side-by-side).

---

## TD-019 · Branch 1 — "What the School Needs to Improve" should be A2-prefixed

**Severity:** Low — breaks A-section numbering convention  
**File:** `functions/research/govuk.js` → `renderPartA()` → section ordering

**Problem:**
Branch 1 Part A sections follow a clean A1–A7 numbering scheme. But the Ofsted "What the school needs to improve" section sits between A2 (Inspection Outcomes) and A3 (Academic Performance) without an A-prefix — it's just a plain heading. This breaks the A-section structure and makes the section ordering logic (`interleaveVerdicts`, `enforceObservations`) blind to it.

Currently the section order is:
```
A1. School Identity
A2. Inspection Outcomes
What the School Needs to Improve    ← no prefix
A3. Academic Performance
...
```

**Fix:** Rename to `A2.1 What the School Needs to Improve` or `A2. Areas for Improvement` — something that nests under A2. Update `PART_A` constant and any section-matching code. The wiremock should define the exact heading.

**Done when:** The Ofsted improvement section has an A-prefix consistent with the A2 parent.

---

## TD-020 · Branch 1 — Part B delimiter missing for KS5-only schools

**Severity:** Medium — inconsistent section structure across school types  
**File:** `functions/research/index.js` → `tagPartLabels()`

**Problem:**
`tagPartLabels()` tags the first section of each part (A1 → Part A, B1 → Part B, C1 → Part C) with a `_partLabel` that the UI renders as a divider row. For KS2 and KS4 schools this works correctly. But for KS5-only schools (e.g. Reigate College), the B1 section heading may not be "B1. Pupil Experience" — or the AI may omit B1 entirely, causing no Part B divider to render.

Need to verify: is the AI not outputting B1, or is `tagPartLabels` failing to match it? The fix depends on root cause:
- If AI omits B1: prompt needs to require it for KS5 schools too
- If heading mismatch: `tagPartLabels` needs to be more flexible

**Done when:** KS5-only school reports show the "Part B — Independent Research" divider consistently.

---

## TD-021 · Branch 2 — per-school colour coding instead of red/green flags

**Severity:** Medium — current red/green conflates "winner" with "warning"  
**File:** `functions/research/govuk.js` → `computeFlags()`, `renderPartAComparison()`, branch 2 prompt

**Problem:**
Branch 2 currently uses the same red/green flag system as branch 1. But in a comparison context, red/green is misleading:
- Green means "one school wins this dimension" — but the parent can't tell WHICH school
- Red means "red flag for this school" — but in comparison, both might have red flags
- There's no way to see at a glance which school leads overall

The user wants a two-colour per-school system:
- **Blue dot** — School A wins this section
- **Yellow dot** — School B wins this section
- **Neutral/grey** — too close to call

Plus a colour-coding legend/explanation above A1:
> The Latymer School (🔵 blue dot) vs Fortismere School (🟡 yellow dot)

This affects:
1. `computeFlags()` — needs `schoolNames` parameter, returns school-specific flags
2. `renderPartAComparison()` — sections need per-school flag markers
3. Branch 2 prompt — AI observation flags need to name the winning school
4. UI — needs to render blue/yellow dots and the legend

**Done when:** Branch 2 output uses blue/yellow per-school indicators, a colour legend appears above A1, and the flag system clearly attributes wins to the correct school.

---

## TD-022 · Branch 1 — A7 median property price needs flats vs houses breakdown

**Severity:** Medium — blended median hides important catchment signal  
**File:** `functions/research/govuk.js` → `getAreaData()` / `fmtAreaDataSlim()`

**Problem:**
The A7 Area Context section currently shows a single median property price for the school's postcode area. This blended figure mixes flats, terraced houses, semi-detached, and detached — obscuring the real affordability signal. A parent deciding whether they can afford to live in a school's catchment needs to see:

- Median flat price (entry-level affordability)
- Median house price (family-home affordability)
- Ideally: terraced vs semi-detached vs detached breakdown

The ONS/Land Registry price data already breaks down by property type. We're just not surfacing it.

**Fix:**
1. In `getAreaData()`, fetch or extract property-type breakdown from the price data source
2. In `fmtAreaDataSlim()`, render a mini sub-table under A7:
   ```
   | Property type | Median price |
   |---|---:|
   | Flat | £320,000 |
   | Terraced | £485,000 |
   | Semi-detached | £610,000 |
   | Detached | £890,000 |
   | Overall | £525,000 |
   ```
3. If only overall median is available, note this in the slim block so the AI doesn't fabricate breakdowns

**Done when:** A7 shows property-type price breakdown (at minimum: flats vs houses) alongside the blended median.

---

## TD-023 · Branch 3 — B2 Crime & Safety: wire up Police UK API

**Severity:** Medium — area safety is a top-3 parent concern  
**File:** `functions/research/govuk.js` → `renderPartBArea()` → B2 section

**Problem:**
Branch 3's B2 Crime & Safety section currently renders a placeholder: "_Crime data is not yet available for this area._" But parents consistently ask about area safety — it's one of the most important non-school factors in a relocation decision. The Police UK API (`data.police.uk/api`) provides street-level crime data by latitude/longitude, broken down by category, with multi-year history.

**Data available from Police UK API:**
- `crimes-street/all-crime?lat=X&lng=Y` — all crimes within 1 mile, last month
- `crimes-at-location?location_id=X` — crimes at a specific location
- `crime-last-updated` — data freshness timestamp
- Categories: violent-crime, burglary, anti-social-behaviour, vehicle-crime, etc.

**Fix:**
1. Write `fetchPoliceUKCrime(lat, lon)` — calls Police UK API for crimes within 1 mile radius, aggregates by category
2. Compute rates per 1,000 residents (need population from LSOA/IMD data which is already available)
3. For multi-year trend: use the API's historical data or compare with previous year snapshots
4. Render B2 table: `| Crime type | Rate per 1,000 | England avg | Trend |`
5. Fall back to placeholder only if the API is unreachable

**Done when:** B2 shows real crime statistics with 5-year trend arrows for any UK postcode.

---

## TD-024 · Branch 3 — B4 Connectivity: transport link lookup

**Severity:** Medium — commute practicality is a key area-assessment dimension  
**File:** `functions/research/govuk.js` → `renderPartBArea()` → B4 section

**Problem:**
Branch 3's B4 Connectivity section currently renders: "_Transport links and connectivity are assessed in the AI-written sections above._" This pushes a deterministic data point to the AI, which may fabricate distances or miss stations. A server-side transport lookup would provide reliable nearest-station/walking-time data.

**Data sources:**
- **London**: TfL Unified API — nearest tube/rail/bus stops, walking time
- **Rest of UK**: Google Maps Distance Matrix API or OpenStreetMap Overpass API
- The postcode lat/lon is already resolved by `getAreaData()`

**Fix:**
1. Write `fetchTransportLinks(lat, lon)` — queries TfL API for London postcodes, falls back to OSM Overpass for rest of UK
2. Determine nearest: tube/metro station, national rail station, bus stop, major road
3. Compute walking distance/time (Haversine for distance, ~3mph walking pace for time)
4. Compute drive time to nearest airport (Google Maps Distance Matrix or fixed estimate)
5. Render B4 table: `| Transport | Nearest | Distance | Travel time |`

**Done when:** B4 shows a populated transport table for London postcodes (TfL API); other regions show at minimum nearest rail station from OSM.

---

## TD-025 · Branch 3 — B3 Housing: rental price data

**Severity:** Low — buy prices from Land Registry already shown; rental data would complete the picture  
**File:** `functions/research/govuk.js` → `renderPartBArea()` → B3 section

**Problem:**
Branch 3's B3 Housing table shows median buy prices by property type (from Land Registry Price Paid data, already pre-fetched). But it does not include rental costs. For parents deciding whether to move to an area, both buy AND rent prices matter — especially for families who plan to rent first, buy later.

**Fix:**
1. Evaluate data sources: Rightmove API (commercial, may not be free), Zoopla API (commercial), ONS rental price index (free, but MSOA-level and quarterly)
2. If a free/affordable API is found, write `fetchRentalPrices(postcode)` or extract from area-level ONS data
3. Add a "Median rent (pcm)" column to the B3 table alongside buy prices
4. If no API is available, note this in the prompt so the AI knows to web-search for rental prices

**Done when:** B3 table has a rental price column, OR the prompt explicitly instructs the AI to fill rental costs via web search.

---

## Product Backlog (from SchoolScanner-Backlog.docx v1.0, May 2026)

Items imported from `docs/requirements/SchoolScanner-Backlog.docx`. Priority/Effort/Phase as defined in that document. Items already covered by TD entries above are cross-referenced.

### Core Product — Branches

| ID | Title | Priority | Effort | Phase | Notes |
|---|---|---|---|---|---|
| B-01 | Branch 2: Compare Schools — side-by-side, delta analysis, ranked verdict | High | M | Phase 1 | In progress (feat/wiremock-part-a-spec) |
| B-02 | Branch 3: Check an Area — postcode → top schools ranked by distance + fit | High | L | Phase 1 | |
| B-03 | Branch 4: Plan Backup Options — reserve list, admissions deadlines, Plan B | Medium | M | Phase 1 | |
| B-04 | Update Branch 2–4 prompts to match Branch 1 quality | Critical | S | Phase 1 | Branch 2 prompt v2 done; 3 & 4 remain |

### Context & Personalisation

| ID | Title | Priority | Effort | Phase | Notes |
|---|---|---|---|---|---|
| C-01 | Context text boxes — child age, personality, postcode, preferences (free-text) | High | S | Phase 1 | |
| C-02 | Context persistence across branch switches within session (no accounts) | Medium | S | Phase 1 | |
| C-03 | Structured onboarding form — multi-step, requires accounts | Low | L | Phase 4 | |
| C-04 | Multi-child profiles — save/switch profiles, requires accounts | Low | L | Phase 4 | |
| C-05 | Commute calculator — work postcode + TfL/Google Maps API integration | Medium | M | Phase 3 | |

### UX & Interface

| ID | Title | Priority | Effort | Phase | Notes |
|---|---|---|---|---|---|
| U-01 | Feedback widget — thumbs up/down + optional text, anonymous, no account | ✅ **Done** | — | — | Inline widget in `web/app.js`. Tied to analytics: `trackEvent("feedback_submit")` → `POST /api/analytics/click` (local server → JSONL) and `POST /api/feedback` (Lambda → CloudWatch). Dashboard counts `feedbackSubmits`. |
| U-02 | Loading state with progress — show what tool is doing during generation | High | S | Phase 1 | |
| U-03 | Blurred paywall gate — Part B/C blurred, not hidden, clear unlock CTA | High | M | Phase 2 | |
| U-04 | Source list cleanup — curate 6–8 links, hide secondary behind toggle | High | S | Phase 1 | |
| U-05 | Remove Buy Me a Coffee — replace with B2B-aligned CTA | ✅ **Done** | — | — | Removed alongside U-01. Support panel replaced by inline feedback widget. |
| U-06 | Input hint placement — move guidance above/inside input box | Medium | XS | Phase 1 | |
| U-07 | Mobile responsiveness audit — tables, traffic lights on breakpoints | Medium | S | Phase 2 | |
| U-08 | Email capture widget — Tally.so embed on homepage, no auth needed | High | XS | Phase 1 | |

### Monetisation & Auth

| ID | Title | Priority | Effort | Phase | Notes |
|---|---|---|---|---|---|
| M-01 | Stripe bundle payments — Taster (£1), Starter (£9), Family (£24) | High | L | Phase 2 | |
| M-02 | Agency subscription billing — Starter (£99), Pro (£249), monthly cap | High | L | Phase 2 | |
| M-03 | Search credit system — track, deduct, display remaining credits | High | M | Phase 2 | |
| M-04 | Credit rollover — unused agency credits roll over up to 1 month | Medium | S | Phase 2 | |
| M-05 | User accounts — email/password auth, credit persistence, profiles | High | L | Phase 2 | |
| M-06 | GDPR compliance — privacy policy, cookie consent, data retention | Critical | M | Phase 2 | |

### B2B & White-Label

| ID | Title | Priority | Effort | Phase | Notes |
|---|---|---|---|---|---|
| W-01 | PDF export — branded school report PDF, essential B2B deliverable | High | M | Phase 3 | |
| W-02 | White-label branding (basic) — Agency Pro logo + brand colour on PDF/report | High | M | Phase 3 | |
| W-03 | White-label domain — agencies serve reports on own subdomain | Medium | L | Phase 4 | |
| W-04 | Bulk report mode — upload CSV of school names, get combined PDF | Medium | L | Phase 4 | |
| W-05 | Agency dashboard — usage stats, credits, team seats, report history | Medium | L | Phase 3 | |
| W-06 | API access — programmatic querying + embed in agency tools | Low | XL | Phase 4 | |

### Internationalisation

| ID | Title | Priority | Effort | Phase | Notes |
|---|---|---|---|---|---|
| I-01 | Mandarin language support — UI + report output in Simplified Chinese | High | L | Phase 4 | |
| I-02 | Mandarin input handling — Chinese-character school names → UK records | Medium | M | Phase 4 | |
| I-03 | WeChat sharing/integration — report sharing, mini-programme if traction | Low | XL | Phase 4 | |
| I-04 | Russian language support — UI + report output in Russian | Low | L | Phase 4 | |

### SEO & Marketing Infrastructure

| ID | Title | Priority | Effort | Phase | Notes |
|---|---|---|---|---|---|
| S-01 | School landing page pipeline — /schools/[slug], lite public report + CTA | High | M | Phase 2 | |
| S-02 | Area landing page pipeline — /area/[postcode], "Best schools in SE15" SEO | High | M | Phase 2 | |
| S-03 | Sitemap generation — auto from school + area pages, Google Search Console | Medium | S | Phase 2 | |
| S-04 | Marketing Agent: SEO module — batch SEO content from CSV, integrate with deploy | Medium | S | Phase 2 | |
| S-05 | Marketing Agent: B2B module — firm research + outreach emails, test 10 targets | High | XS | Phase 2 | |
| S-06 | Google Analytics / PostHog — searches, branch selections, paywall, conversions | High | S | Phase 1 | |

### Infrastructure & Data

| ID | Title | Priority | Effort | Phase | Notes |
|---|---|---|---|---|---|
| D-01 | API cost instrumentation — log tokens + estimated cost per report | Critical | S | Phase 1 | |
| D-02 | Rate limiting — N searches per IP per day on free tier | High | S | Phase 2 | |
| D-03 | Data freshness monitoring — alert on Ofsted/GIAS/DfE structure changes | Medium | M | Phase 2 | |
| D-04 | AWS scaling review — CloudFront + backend config for traffic spikes | Medium | S | Phase 2 | |
| D-05 | School data cache — cache parsed gov data per school, TTL 7 days | High | M | Phase 2 | See also TD-003, TD-004, TD-007 |
| D-06 | Error handling & fallbacks — graceful degradation, partial report not error page | High | S | Phase 1 | See also TD-005 |

### Summary Counts

- **Critical:** 5 (B-04, U-01, U-05, M-06, D-01)
- **High:** 21
- **Medium:** 14
- **Low:** 5
- **Total:** 45 product backlog items + 21 tech debt entries = 66 tracked items
