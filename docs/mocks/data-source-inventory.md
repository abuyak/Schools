# Data Source Inventory — School Scanner

Every source we fetch from, what we extract, and what's left behind.

---

## Sources we HIT

### 1. GIAS — Get Information About Schools
**Endpoint:** `get-information-schools.service.gov.uk/Establishments/Establishment/Details/{URN}`  
**What we extract:** officialName, URN, type, phase, LA, address, postcode, capacity, headteacher, website, religious character, admissions policy, gender, age range, isIndependent, isOpen  
**What's left:** Ofsted rating (embedded), SEN provision details, trust/federation info, governance details, linked schools, previous names/URNs  
**Gap:** Website field extraction sometimes fails (depends on GIAS page layout)

### 2. DfE Performance CSV
**Endpoint:** `compare-school-performance.service.gov.uk/download-school-data?urn={URN}`  
**What we extract:** ALL non-admin variables from every namespace (L, CENSUS_25, ABS_24, KS2_25, KS4_25, KS4_PUPDEST_25, KS5_25, KS5_STUDEST_25) — filtered by relevance  
**What's left:** Nothing — we parse the full vertical CSV and keep everything non-admin  
**Gap:** Independent schools get sparse data (iGCSEs not counted)

### 3. Ofsted Inspection Reports
**Endpoint:** `reports.ofsted.gov.uk/provider/{23|21|ELS|46}/{URN}`  
**What we extract:** Overall grade, date, sub-grades (QoE, B&A, PD, L&M, 6th form, FE-specific), safeguarding status, report PDF URL, pupil experience narrative (800 chars), next steps, recommendations  
**What's left:** Parent View % data (JS-rendered), full inspection history (timeline), previous report comparisons  
**Gap:** PDF parsing doesn't extract sub-grades for ALL pre-2019 frameworks. Provider 23 JS-shell forces fallback.

### 4. FBIT — Financial Benchmarking
**Endpoint:** `financial-benchmarking-and-insights-tool.education.gov.uk/school/{URN}`  
**What we extract:** In-year balance, revenue reserve, spend/pupil, comparator spend/pupil, workforce FTE, teachers FTE, SLT FTE, TA FTE, QTS %, comparator QTS %, pupil:teacher ratio, per-category spending vs comparator  
**What's left:** Multi-year financial trends, staffing trends  
**Gap:** Some schools have broken JS rendering (SDK failure) → no data. Census ZIP sometimes returns empty stub.

### 5. EES API — Explore Education Statistics
**Base:** `api.education.gov.uk/statistics/v1`  
**Datasets used:**
- `019afee5-...` (KS2 LA) — per-subject expected/higher/avgScore by LA
- `b3e19901-...` (KS4 LA) — 25 indicators by LA, 3-year timeseries

**Datasets NOT used:**
- `1ae39901-...` (Subject school level) — SCH codes unmapped, filter codes undocumented → TD-013
- `019d913a-...` (KS5 regional) — LA level available, filter codes undocumented → TD-014
- `19e39901-560d-...` (National characteristics) — England summary not needed (we use NATIONAL_AVG)
- `b70e71fa-...` (KS4 destinations) — not explored
- `657a20f6-...` (16-18 destinations) — not explored

### 6. ISI — Independent Schools Inspectorate
**Source:** `reports.isi.net` (index: `isi-institutions.json`)  
**What we extract:** Inspection type (EQI/FCI/ROU), overall grade, date, academic judgment, personal development judgment, key findings, recommendations, pupil experience, achievement/personal development detail  
**Gap:** ROU (compliance-only) reports have limited data. 2023+ report format needs different section numbering.

### 7. Area Data
**Sources:** postcodes.io, ONS Census 2021, Land Registry, Crystal Roof  
**What we extract:** IMD decile, sub-domain scores, household income (gross/net/after-housing), house prices (median by type, 5yr transactions), local ethnicity (LSOA), qualifications (OA), occupation (OA)  
**Gap:** Crystal Roof is undocumented/unauthenticated (TD-001). Income data is ONS 2018 era.

### 8. DfE Ethnicity Index (bundled)
**File:** `sources/dfe-school-ethnicity.json`  
**What we extract:** % by ethnic group (White, Mixed, Asian, Black, Chinese, Other, Not stated)  
**Gap:** Independent schools not included (all zeros). Annual rebuild needed (June GitHub Issue).

### 9. Independent School Fees
**Source:** School websites (scraped via GIAS website field)  
**What we extract:** Day/boarding fees (min/max, period)  
**Gap:** Many school websites fail to parse (varying formats). Only works when GIAS website field is populated.

---

## Sources we DON'T hit

### UCAS / University Admissions
**Files present:** `sources/Oxford/oxford_admissions_merged.csv`, `sources/Cambridge/cambridge_admissions_merged.csv`  
**Status:** TD-012 — data is stale, Oxford source unknown, no automated refresh  
**Other universities:** Imperial, LSE, UCL, Durham, Warwick publish school-level data  

### DfE School Workforce Census
**Status:** Not fetched — would provide teacher qualifications, experience, turnover  

### Ofsted Parent View (detailed %)
**Status:** Page URL found, but % data is JS-rendered. We pass the URL to the AI for web search  

### School Websites (beyond fees)
**Status:** Not scraped — would provide open days, clubs, term dates, uniform, SENCo details  

---

## What the AI has to search for

| Data point | Why not pre-fetched |
|---|---|
| Open days / admissions deadlines | On school websites, changes frequently |
| Extracurricular / clubs | On school websites |
| Parent reviews (Mumsnet, Reddit) | Dynamic, needs web search |
| University destinations (non-Oxbridge) | Not centrally published |
| Catchment area boundaries | Not centrally published for most schools |
| Waiting lists / oversubscription | Published by LAs individually |
| Building / facilities condition | Not centrally published |
