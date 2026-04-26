# `govuk.js` — Authoritative Data Schema

> **Ground truth for all gov.uk data.** When adding, changing, or debugging any data point in govuk.js,
> update this file in the same commit. Any discrepancy between this file and the code is a bug.

---

## 1. Data Flow

```
User question
  └─ extractSchoolNames()              regex + AI preflight call
      └─ lookupSchoolURN(name)         GIAS search HTML → GIASIdentity
          └─ [parallel]
              ├─ getOfstedData(urn)       reports.ofsted.gov.uk HTML → OfstedResult (grades only)
              │   └─ [if branch 1 + reportUrl]
              │       └─ fetchAndParseOfstedPdf(url)  Ofsted CDN PDF → PdfSections
              ├─ fetchParentView(urn)     parentview.ofsted.gov.uk (3-step HTML) → ParentViewResult
              ├─ getPerformanceData(urn)  compare-school-performance CSV download → PerformanceData
              └─ getFinancialData(urn)    FBIT HTML + ZIP→CSV → FinancialData
                  └─ [if branch 1 + postcode from PerformanceData.L.PCODE]
                      └─ getAreaData(postcode)
                          ├─ postcodes.io → lsoa, msoa, district, lat/lon
                          ├─ fetchNomisEthnicity(lsoa)    Nomis TS021 Census 2021
                          ├─ fetchPricePaid(lat, lon)      Land Registry Price Paid
                          ├─ fetchONSIncome(msoa)          ONS FYE 2018 CSV
                          ├─ fetchIMD(lsoa)                findthatpostcode.uk (MHCLG IMD)
                          └─ fetchCrystalRoof(postcode)    ⚠️ TEMP — see §9

  └─ getSchoolEthnicity(urn)           local-data.js bundled JSON — zero latency

  └─ buildSlimBlock(school)            formats all of the above into AI prompt markdown
  └─ fetchGovDataForPrompt()           orchestrates everything; returns { block, flags }
```

---

## 2. Type Definitions

> Written as TypeScript interfaces for precision. The codebase is plain JS.
> `null` means "fetch was attempted but failed". `undefined` means "field not populated for this school type".

### `FetchGovDataResult` — return value of `fetchGovDataForPrompt()`

```ts
interface FetchGovDataResult {
  block: string;   // markdown injected verbatim into AI system prompt
  flags: {
    'A2. Ofsted Inspection Grades'?:      'green' | 'red';
    'A4. What the School Needs to Improve'?: 'green' | 'red';
    'A6. Academic Performance'?:          'green' | 'red' | 'none';
    'A7. Absence'?:                        'green' | 'red';
  };
}
```

### `SchoolResult` — internal, passed to `buildSlimBlock` / `buildComparisonBlock`

```ts
interface SchoolResult {
  input:           string;              // raw name from question
  identity:        GIASIdentity | null;
  ofsted:          OfstedResult | null;
  performance:     PerformanceData | null;
  financial:       FinancialData | null;
  area:            AreaData | null;     // branch 1 only; null for branch 2
  schoolEthnicity: EthnicityRow | null; // local-data.js; null if URN not in index
}
```

### `GIASIdentity` — from `lookupSchoolURN()`

```ts
interface GIASIdentity {
  urn:           string;         // 6-digit e.g. "101930"
  officialName:  string;         // full registered name
  type:          string | null;  // e.g. "Academy converter", "Community school"
  phase:         string | null;  // e.g. "Secondary", "Primary", "All-through"
  la:            string | null;  // LA name e.g. "Enfield"
  isIndependent: boolean;
  isOpen:        boolean;
}
```

### `OfstedResult` — from `getOfstedData()` merged with `fetchAndParseOfstedPdf()` and `fetchParentView()`

```ts
interface OfstedResult {
  // ── From reports.ofsted.gov.uk HTML ──────────────────────────────────────
  overall:          string | null;  // "Good" | "Outstanding" | "Exceptional" | "Requires Improvement" | "Inadequate"
  date:             string | null;  // "26 April 2022"
  reportUrl:        string | null;  // "https://files.ofsted.gov.uk/v1/file/{id}"
  parentViewUrl:    string;         // always set; "https://parentview.ofsted.gov.uk/parent-view-results/urn/{urn}"
  safeguarding:     string | null;  // substring containing "effective" or "not met"

  // Old framework (pre-Nov 2025) sub-grades — null for new-format reports
  qualityOfEducation:  string | null;  // "Outstanding" | "Good" | "Requires Improvement" | "Inadequate"
  behaviour:           string | null;
  personalDevelopment: string | null;
  leadership:          string | null;
  sixthForm:           string | null;

  // New Nov-2025 report card areas — null for old-format reports
  achievement:   string | null;   // "Exceptional" | "Strong" | "Expected" | "Needs Attention" | "Urgent Improvement"
  attendance:    string | null;
  curriculum:    string | null;
  inclusion:     string | null;
  leadershipGov: string | null;
  wellbeing:     string | null;
  post16:        string | null;

  // ── From fetchAndParseOfstedPdf() — branch 1 only ────────────────────────
  // NOTE: stored as *Detail to avoid overwriting grade strings of same name above
  pupilExperience:               string | null;  // "What it's like to be a pupil" section
  qualityOfEducationDetail:      string | null;  // old framework narrative
  behaviourAndAttitudesDetail:   string | null;
  personalDevelopmentDetail:     string | null;
  leadershipAndManagementDetail: string | null;
  achievementDetail:             string | null;  // new framework narrative
  inclusionDetail:               string | null;
  nextSteps:                     string | null;  // verbatim improvement requirements — reproduce exactly in A4

  // ── From fetchParentView() ────────────────────────────────────────────────
  parentView: ParentViewResult | null;
}
```

### `ParentViewResult` — from `fetchParentView()`

```ts
interface ParentViewResult {
  totalResponses: number;
  academicYear:   string | null;       // "2023/2024"

  // All values are % agree + strongly agree, except wouldRecommend (Yes%)
  // undefined = question not found in parsed HTML
  childHappy:       number | undefined;
  childSafe:        number | undefined;
  wellBehaved:      number | undefined;
  bullyingHandled:  number | undefined;
  communication:    number | undefined;
  concernsHandled:  number | undefined;
  wouldRecommend:   number | undefined;  // binary Yes/No question — first value = Yes%
  bestInterests:    number | undefined;
  rightSupport:     number | undefined;
  sendSupport:      number | undefined;
}
```

### `PerformanceData` — from `getPerformanceData()` → `parsePerformanceCsv()`

```ts
type PerformanceData = {
  [namespace: string]: Array<{
    variable:    string;  // DfE variable code — see §3 for the full list
    value:       string;  // ALWAYS a string from CSV; parse to number before arithmetic
    description: string;  // DfE human-readable label (used as row label in verbose tables)
  }>
}

// Namespaces present depend on school phase:
//   Primary:     KS2_25, ABS_24, CENSUS_25, L
//   Secondary:   KS4_25, KS5_25, KS5_STUDEST_25, ABS_24, CENSUS_25, L
//   Post-16:     KS5_25, KS5_STUDEST_25, ABS_24, CENSUS_25, L
//   Nursery:     ABS_24, CENSUS_25, L
//   All-through: KS1_25, KS2_25, KS4_25, KS5_25, KS5_STUDEST_25, ABS_24, CENSUS_25, L
//
// Suppressed values are pre-filtered: "NA", "NE", "SUPP", "NP", "LOW", "LOWCOV", ""
// are never present in PerformanceData arrays.
//
// Fast lookup helper (already written in fmtAcademicResultsSlim):
//   const v = (code) => allRows.find(r => r.variable === code)?.value ?? null;
// where allRows is all namespaces flattened, sorted descending by year suffix.
```

### `FinancialData` — from `getFinancialData()`

```ts
interface FinancialData {
  // From fetchFBITSpending() — FBIT spending-and-costs HTML
  inYearBalance:          string | null;  // "£123,456" (can be negative: "-£45,678")
  revenueReserve:         string | null;  // "£234,567"
  totalSpendPerPupil:     string | null;  // "£7,234/pupil" — sum of all /pupil categories
  comparatorTotalPerPupil: string | null; // comparator set average (same calculation)
  spendingCategories: {
    [categoryName: string]: {
      school:  string | null;   // "£3,234/pupil" or "£456/sqm"
      average: string | null;   // comparator average
      diff:    string | null;   // "£200 more than avg" or "£100 less than avg"
      pctDiff: string | null;   // "+3%" or "-2%" — added in getFinancialData()
    }
  } | null;

  // From fetchFBITCensus() — FBIT census ZIP → CSV
  workforceFTE:         number | null;
  teachersFTE:          number | null;
  seniorLeadershipFTE:  number | null;
  teachingAssistantFTE: number | null;
  qualifiedTeachersPct:  string | null;  // "97.5%" — this school only
  comparatorQtsAvgPct:   string | null;  // "96.2%" — computed from all rows in comparator CSV
  pupilTeacherRatio:     number | null;  // 14.2 — pupils per teacher FTE (1 dp)
}
```

### `AreaData` — from `getAreaData()`, branch 1 only

```ts
interface AreaData {
  postcode: string;
  district: string | null;   // ONS admin district name e.g. "Enfield"
  region:   string | null;   // e.g. "London"
  lsoa:     string | null;   // ONS LSOA code e.g. "E01001726"
  msoa:     string | null;   // ONS MSOA code e.g. "E02000363"
  // NOTE: postcodes.io also returns codes.admin_district (ONS district code e.g. "E09000010")
  // but this is NOT currently extracted. Needed for LA-level EES API queries — see §9.

  ethnicity:   Record<string, number> | null;  // label → % from Nomis TS021, LSOA level
  pricePaid:   PricePaidData | null;
  income:      ONSIncomeData | null;            // ONS FYE 2018 — see §9 for staleness note
  imd:         IMDData | null;
  crystalRoof: CrystalRoofData | null;          // ⚠️ TEMP — see §9
}

interface PricePaidData {
  radiusM:           number;           // 800
  yearsBack:         number;           // 5
  totalTransactions: number;
  postcodesQueried:  number;
  medianAllTypes:    string;           // "£485,000"
  byType: {
    'Detached'?: string;
    'Semi-detached'?: string;
    'Terraced'?: string;
    'Flat / Maisonette'?: string;
  } | null;
  source: 'HM Land Registry Price Paid Data';
}

interface ONSIncomeData {
  msoaName:                   string | null;
  netAnnualHouseholdIncome:   string | null;  // "£32,000"
  totalAnnualHouseholdIncome: string | null;
  afterHousingCostsIncome:    string | null;
  netEquivalisedIncome:       string | null;
  year: 'FYE 2018';
  source: 'ONS Small Area Income Estimates';
}

interface IMDData {
  lsoaCode:     string;
  year:         '2025' | '2019';
  imdScore:     number | null;   // higher = more deprived
  imdRank:      number | null;   // 1 = most deprived LSOA in England
  imdDecile:    number | null;   // 1–10; 1 = most deprived 10%
  subDomains: {
    'Income'?: number;                        // decile 1–10
    'Employment'?: number;
    'Education, Skills & Training'?: number;
    'Health & Disability'?: number;
    'Crime'?: number;
    'Barriers to Housing & Services'?: number;
    'Living Environment'?: number;
  } | null;
  population:     number | null;
  populationYear: '2022' | '2015' | null;
  source:         string;
}

interface CrystalRoofData {   // ⚠️ TEMP — see §9
  qualifications: {
    noQualifications: number | null;   // %
    level1AndEntry:   number | null;
    level2:           number | null;
    apprenticeship:   number | null;
    level3:           number | null;
    level4AndAbove:   number | null;
    other:            number | null;
    totalResidents:   number;
  } | null;
  occupation: {
    managerialProfessional:        number | null;  // %
    intermediate:                  number | null;
    routineAndManual:              number | null;
    neverWorkedLongTermUnemployed: number | null;
    fullTimeStudents:              number | null;
    totalResidents:                number;
  } | null;
  income: {
    meanAnnualHouseholdIncome: string;  // "£52,000"
    grain: 'MSOA';
    measure: 'mean gross annual household income';
  } | null;
}
```

### `EthnicityRow` — from `getSchoolEthnicity()` in `local-data.js`

```ts
interface EthnicityRow {
  w:  number;         // % White
  m:  number;         // % Mixed
  a:  number;         // % Asian
  b:  number;         // % Black
  c:  number | null;  // % Chinese
  o:  number | null;  // % Other
  ns: number | null;  // % Not stated
  yr: string;         // data year e.g. "2024"
}
```

---

## 3. DfE CSV Variable Mapping

Source: `compare-school-performance.service.gov.uk/download-school-data?urn={urn}`

**Format:** vertical/long CSV — `No, Namespace, Variable, Value, Description`

**Suppressed sentinel values** (filtered out in `parsePerformanceCsv` — never reach the AI):
`NA`, `NE`, `SUPP`, `NP`, `LOW`, `LOWCOV`, empty string

**Admin fields skipped** (never useful in prompt):
`URN`, `LA`, `LEA`, `ESTAB`, `LAESTAB`, `RECTYPE`, `ALPHAIND`, `EDITION`, `YEAR`,
`ADDRESS1`–`ADDRESS3`, `TOWN`, `TELNUM`, `PCON_CODE`, `PCON_NAME`, `ICLOSE`, `SCHNAME`, `LANAME`

---

### L namespace — school identity (always present)

| Variable | Description | JS variable in `fmtAcademicResultsSlim` | Used for |
|---|---|---|---|
| `PCODE` | School postcode | `postcode` | Identity line; triggers `getAreaData` |
| `GENDER` | Mixed / Boys / Girls | `gender` | Identity line |
| `ADMPOL` | Admissions policy | `admPol` | Identity line |
| `RELCHAR` | Religious character | `relChar` | Identity line |
| `AGELOW` | Lowest age | `ageLow` | Identity line |
| `AGEHIGH` | Highest age | `ageHigh` | Identity line |
| `ISPRIMARY` | 1 = primary phase | — | Phase detection |
| `ISSECONDARY` | 1 = secondary phase | — | Phase detection |
| `ISPOST16` | 1 = has post-16 provision | `isPost16` | Triggers KS5 block |

---

### KS2_25 namespace — primary attainment 2024/25

| Variable | Description | JS variable | KS2 table row · column |
|---|---|---|---|
| `PTRWM_EXP` | % meeting expected standard in RWM | `rwm` | RWM expected · Value |
| `PTRWM_HIGH` | % achieving higher standard in RWM | `rwmH` | RWM high · Value |
| `PTRWM_EXP_24` | % RWM expected (2023/24) | `rwm24` | 3-yr trend (inline) |
| `PTRWM_EXP_23` | % RWM expected (2022/23) | `rwm23` | 3-yr trend (inline) |
| `PTREAD_EXP` | % expected in reading | `read` | Reading expected · Value |
| `READ_AVERAGE` | Average reading scaled score | `readSc` | Reading expected · inline |
| `PTMAT_EXP` | % expected in maths | `mat` | Maths expected · Value |
| `MAT_AVERAGE` | Average maths scaled score | `matSc` | Maths expected · inline |
| `PTWRITTA_EXP` | % expected in writing (teacher assessment) | `writ` | Writing expected · Value |
| `PTGPS_EXP` | % expected in GPS | `gps` | GPS expected · Value |
| `PTSCITA_EXP` | % expected in science | `sci` | Science expected · Value |
| `PTRWM_EXP_FSM6CLA1A` | % RWM expected — disadvantaged | `rwmDisadv` | RWM expected — disadvantaged |
| `PTRWM_EXP_NOTFSM6CLA1A` | % RWM expected — non-disadvantaged | `rwmNonDisadv` | RWM expected — non-disadvantaged |
| `PTFSM6CLA1A` | % of KS2 cohort who are disadvantaged | `cohortDisadv` | Disadvantaged share of KS2 cohort |
| `DIFFN_RWM_EXP` | Gap (pp) vs national non-disadvantaged | `gapNat` | Gap vs national non-disadvantaged |
| `PTREAD_EXP_FSM6CLA1A` | % reading expected — disadvantaged | `readDisadv` | Reading expected — disadvantaged |
| `PTMAT_EXP_FSM6CLA1A` | % maths expected — disadvantaged | `matDisadv` | Maths expected — disadvantaged |
| `PTRWM_HIGH_B` | % RWM high standard — boys | `rwmHighB` | RWM high standard — boys |
| `PTRWM_HIGH_G` | % RWM high standard — girls | `rwmHighG` | RWM high standard — girls |
| `TELIG` | KS2 eligible cohort size (pupils) | `cohort` | KS2 eligible cohort |
| `PTREAD_AT` | % absent from reading test | `readAt` | Absent from KS2 tests (inline) |
| `PTMAT_AT` | % absent from maths test | `matAt` | Absent from KS2 tests (inline) |
| `PTGPS_AT` | % absent from GPS test | `gpsAt` | Absent from KS2 tests (inline) |
| `READPROG_23` | Reading progress score 2022/23 | `rProg` | Progress: reading |
| `READPROG_LOWER_23` | Reading progress lower CI | `rLo` | Progress: reading · CI |
| `READPROG_UPPER_23` | Reading progress upper CI | `rHi` | Progress: reading · CI |
| `READPROG_DESCR_23` | Reading progress descriptor 1–5 | `rD` | Progress: reading · band label |
| `WRITPROG_23` | Writing progress score 2022/23 | `wProg` | Progress: writing |
| `WRITPROG_LOWER_23` | Writing progress lower CI | `wLo` | Progress: writing · CI |
| `WRITPROG_UPPER_23` | Writing progress upper CI | `wHi` | Progress: writing · CI |
| `WRITPROG_DESCR_23` | Writing progress descriptor | `wD` | Progress: writing · band label |
| `MATPROG_23` | Maths progress score 2022/23 | `mProg` | Progress: maths |
| `MATPROG_LOWER_23` | Maths progress lower CI | `mLo` | Progress: maths · CI |
| `MATPROG_UPPER_23` | Maths progress upper CI | `mHi` | Progress: maths · CI |
| `MATPROG_DESCR_23` | Maths progress descriptor | `mD` | Progress: maths · band label |

---

### KS4_25 namespace — secondary attainment 2024/25

KS4 table column order: **All pupils · Boys · Girls · Disadvantaged · EAL · Local avg · England**

| Variable | Description | JS variable | Row · Column |
|---|---|---|---|
| `TPUP` | Total KS4 cohort | `cohort` | Cohort size · All pupils |
| `BPUP` | Boys in KS4 cohort (**KS4-specific** — NOT school-wide) | `cohortB` | Cohort size · Boys |
| `GPUP` | Girls in KS4 cohort (**KS4-specific** — NOT school-wide) | `cohortG` | Cohort size · Girls |
| `TFSM6CLA1A` | Disadvantaged pupils in KS4 cohort | `cohortDis` | Cohort size · Disadvantaged |
| `ATT8SCR` | Attainment 8 — all | `att8` | Attainment 8 · All pupils |
| `ATT8SCR_BOYS` | Attainment 8 — boys | `att8b` | Attainment 8 · Boys |
| `ATT8SCR_GIRLS` | Attainment 8 — girls | `att8g` | Attainment 8 · Girls |
| `ATT8SCR_FSM6CLA1A` | Attainment 8 — disadvantaged | `att8dis` | Attainment 8 · Disadvantaged |
| `ATT8SCR_EAL` | Attainment 8 — EAL pupils | `att8eal` | Attainment 8 · EAL |
| `PTL2BASICS_95` | Grade 5+ English & Maths — all | `g5all` | Grade 5+ · All pupils |
| `PBL2BASICS_95` | Grade 5+ English & Maths — boys | `g5b` | Grade 5+ · Boys |
| `PGL2BASICS_95` | Grade 5+ English & Maths — girls | `g5g` | Grade 5+ · Girls |
| `PTFSM6CLA1ABASICS_95` | Grade 5+ English & Maths — disadvantaged | `g5dis` | Grade 5+ · Disadvantaged |
| `PTL2BASICSEAL_95` | Grade 5+ English & Maths — EAL | `g5eal` | Grade 5+ · EAL |
| `PTL2BASICS_94` | Grade 4+ English & Maths — all | `g4all` | Grade 4+ · All pupils |
| `PBL2BASICS_94` | Grade 4+ English & Maths — boys | `g4b` | Grade 4+ · Boys |
| `PGL2BASICS_94` | Grade 4+ English & Maths — girls | `g4g` | Grade 4+ · Girls |
| `PTFSM6CLA1ABASICS_94` | Grade 4+ English & Maths — disadvantaged | `g4dis` | Grade 4+ · Disadvantaged |
| `PTL2BASICSEAL_94` | Grade 4+ English & Maths — EAL | `g4eal` | Grade 4+ · EAL |
| `PTEBACC_95` | EBacc grade 5+ — all | `eb5all` | EBacc 5+ · All pupils |
| `PBEBACC_95` | EBacc grade 5+ — boys | `eb5b` | EBacc 5+ · Boys |
| `PGEBACC_95` | EBacc grade 5+ — girls | `eb5g` | EBacc 5+ · Girls |
| `PTEBACCEAL_95` | EBacc grade 5+ — EAL | `eb5eal` | EBacc 5+ · EAL |
| `PTEBACC_94` | EBacc grade 4+ — all | `eb4all` | EBacc 4+ · All pupils |
| `PBEBACC_94` | EBacc grade 4+ — boys | `eb4b` | EBacc 4+ · Boys |
| `PGEBACC_94` | EBacc grade 4+ — girls | `eb4g` | EBacc 4+ · Girls |
| `PTFSM6CLA1AEBACC_94` | EBacc grade 4+ — disadvantaged | `eb4dis` | EBacc 4+ · Disadvantaged |
| `PTEBACCEAL_94` | EBacc grade 4+ — EAL | `eb4eal` | EBacc 4+ · EAL |
| `EBACCAPS` | EBacc APS — all | `ebApsAll` | EBacc APS · All pupils |
| `EBACCAPS_BOYS` | EBacc APS — boys | `ebApsB` | EBacc APS · Boys |
| `EBACCAPS_GIRLS` | EBacc APS — girls | `ebApsG` | EBacc APS · Girls |
| `EBACCAPS_FSM6CLA1A` | EBacc APS — disadvantaged | `ebApsDis` | EBacc APS · Disadvantaged |
| `EBACCAPS_EAL` | EBacc APS — EAL | `ebApsEal` | EBacc APS · EAL |
| `PTEBACC_E_PTQ_EE` | % entering EBacc (all 5 subject pillars) | `entering` | Entering EBacc · All pupils |
| `P8MEA` | Progress 8 — all | `p8` | Progress 8 · All pupils |
| `P8LOWER` | Progress 8 lower CI | `p8lo` | Progress 8 · inline CI |
| `P8UPPER` | Progress 8 upper CI | `p8hi` | Progress 8 · inline CI |
| `P8MEA_FSM6CLA1A` | Progress 8 — disadvantaged | `p8dis` | Progress 8 · Disadvantaged |

**Variables NOT in the school CSV — require separate fetch:**

| Metric wanted | Source | EES dataset ID | EES indicator ID | Status |
|---|---|---|---|---|
| LA avg — Attainment 8 | EES API | `b3e19901-5d2b-b676-bb4c-e60937d74725` | `S9YVx` | ❌ Not implemented |
| LA avg — Grade 5+ E&M | EES API | `b3e19901-5d2b-b676-bb4c-e60937d74725` | `kxGhs` | ❌ Not implemented |
| LA avg — Grade 4+ E&M | EES API | `b3e19901-5d2b-b676-bb4c-e60937d74725` | `HPhzL` | ❌ Not implemented |
| LA avg — EBacc entry | EES API | `b3e19901-5d2b-b676-bb4c-e60937d74725` | `UZ5RF` | ❌ Not implemented |
| LA avg — EBacc APS | EES API | `b3e19901-5d2b-b676-bb4c-e60937d74725` | `4c9UZ` | ❌ Not implemented |

**EES API query pattern (when implemented):**
```
GET https://api.education.gov.uk/statistics/v1/data-sets/b3e19901-5d2b-b676-bb4c-e60937d74725/query
  ?locations.in=LA|code|{onsDistrictCode}    ← from postcodes.io codes.admin_district (NOT currently extracted)
  &timePeriods.in=2024/2025|AY
  &filters.in=WGD2b    ← Sex: Total
  &filters.in=bVOtT    ← Disadvantaged status: Total
  &filters.in=bBiet    ← Ethnicity (major): Total
  &filters.in=pcsSo    ← Ethnicity (minor): Total
  &filters.in=Cm2Id    ← First language: Total
  &filters.in=aqzLP    ← FSM status: Total
  &filters.in=mrV9K    ← KS2 scaled score group: Total
  &filters.in=V8F5X    ← Mobility: Total
  &filters.in=uiPo4    ← Prior attainment: Total
  &filters.in=rvQNj    ← School admission type: Total
  &filters.in=4Q8UZ    ← School religious character: Total
  &filters.in=iFV6X    ← SEN primary need: Total
  &filters.in=qTajG    ← SEN provision: Total
  &filters.in=W1UF2    ← SEN status: Total
  &filters.in=BUx7J    ← Young carer: Total
  &indicators=S9YVx&indicators=kxGhs&indicators=HPhzL&indicators=UZ5RF&indicators=4c9UZ
  &pageSize=10
```
Expected: 1 result row per LA. LA code from `r.codes?.admin_district` in postcodes.io response
(e.g. Enfield = `E09000010` — currently NOT extracted from postcodes.io; see §9).

---

### KS1_25 namespace — Year 2 attainment 2024/25 (primary / all-through only)

| Variable | Description | JS variable | KS1 table row |
|---|---|---|---|
| `PTREAD_EXP_KS1` | % expected in reading (phonics) | `ks1Read` | Reading expected standard |
| `PTWRITE_EXP_KS1` | % expected in writing | `ks1Writ` | Writing expected standard |
| `PTMAT_EXP_KS1` | % expected in maths | `ks1Mat` | Maths expected standard |
| `PTSCITA_EXP_KS1` | % expected in science | `ks1Sci` | Science expected standard |
| `NOR_KS1` | KS1 cohort size | `ks1NOR` | KS1 cohort |

---

### KS5_25 namespace — sixth form attainment 2024/25 (post-16 download)

| Variable | Description | JS variable | KS5 table row |
|---|---|---|---|
| `TALLPUP_1618` | Total 16–18 students (all quals) | `studTotal` | Total 16–18 students |
| `TALLPUP_ALEV_1618` | A-level students | `alevPup` | A-level students |
| `TALLPPEGRD_ALEV_1618` | Average A-level grade letter e.g. "A-" | `avgGradeStr` | Average A-level grade · letter |
| `TALLPPE_ALEV_1618` | Average A-level grade points e.g. "47.33" | `avgGradePts` | Average A-level grade · points |
| `TALLPPE_ALEV_1618_24` | Average A-level grade points (2023/24) | `avgGradePts24` | 3-yr trend |
| `TALLPPE_ALEV_1618_23` | Average A-level grade points (2022/23) | `avgGradePts23` | 3-yr trend |
| `TB3PTSE_GRD` | Average best-3 A-level grade letter | `best3Grd` | Average best 3 grades · letter |
| `TB3PTSE` | Average best-3 A-level grade points | `best3Pts` | Average best 3 grades · points |
| `PTAAB_2FAC` | % achieving AAB in ≥2 facilitating subjects | `aab2fac` | AAB+ in ≥2 facilitating subjects |
| `L3M_PER` | % achieving advanced maths qualification | `advMaths` | Achieving advanced maths |
| `PT_RETAINED_ALEV_RET` | % retained to end of A-level course | `retained` | Students retained to end of course |
| `VA_INS_ALEV` | A-level value added / progress score | `progScore` | A-level progress score (VA) |
| `LCI_INS_ALEV` | A-level VA lower confidence interval | `progLo` | Progress score · CI |
| `UCI_INS_ALEV` | A-level VA upper confidence interval | `progHi` | Progress score · CI |
| `PROGRESS_BAND_ALEV` | Progress band 1=well above … 5=well below | `progBandNum` | Progress score · band label |
| `TALLPUP_ALEV_1618_DIS` | Disadvantaged A-level students | `disCount` | KS5 Disadvantaged · students |
| `TALLPPEGRD_ALEV_DIS` | Disadvantaged A-level grade letter | `avgGradeDisStr` | KS5 Disadvantaged · grade letter |
| `TALLPPE_ALEV_1618_DIS` | Disadvantaged A-level grade points | `avgGradeDisPts` | KS5 Disadvantaged · grade points |
| `VA_INS_ALEV_DIS` | Disadvantaged VA score | `progScoreDis` | KS5 Disadvantaged · progress |
| `LCI_INS_ALEV_DIS` | Disadvantaged VA lower CI | `progLoDis` | KS5 Disadvantaged · CI |
| `UCI_INS_ALEV_DIS` | Disadvantaged VA upper CI | `progHiDis` | KS5 Disadvantaged · CI |
| `TALLPPEGRD_ALEV_NOTDIS` | Non-disadvantaged A-level grade letter | — (inline) | KS5 Disadvantaged · non-dis. |
| `TALLPPE_ALEV_1618_NOTDIS` | Non-disadvantaged A-level grade points | — (inline) | KS5 Disadvantaged · non-dis. |

### KS5_STUDEST_25 namespace — 16–18 destinations 2024/25 (post-16 download)

| Variable | Description | JS variable | KS5 table row |
|---|---|---|---|
| `TOT_HEPER` | % progressed to higher education | `toHE` | Progressed to higher education |
| `ALL_PROGRESSED` | % to any sustained positive destination | `allProgress` | Sustained positive destination |

---

### CENSUS_25 namespace — pupil census 2025

| Variable | Description | JS variable | Prompt: Pupil Profile table |
|---|---|---|---|
| `NOR` | Pupils on roll | `nor` | Pupils on roll |
| `PNUMFSMEVER` | % FSM-eligible (last 6 years) | `fsm` | FSM-eligible (last 6 years) |
| `PNUMEAL` | % EAL pupils | `eal` | EAL pupils |
| `PSENELK` | % with SEN support (no EHC plan) | `sen` | SEN support |
| `PSENELSE` | % with EHC plan | `ehc` | EHC plans |

### ABS_24 namespace — absence 2023/24

| Variable | Description | JS variable | Prompt line |
|---|---|---|---|
| `PERCTOT` | Overall absence % | `abs` | Absence — overall |
| `PPERSABS10` | Persistent absence % (missed ≥10% of sessions) | `pers` | Absence — persistent |

---

## 4. Source-to-Prompt Mapping (A1–A9 + B1)

| Prompt section | Source service | Fetch function(s) | Key fields used |
|---|---|---|---|
| **A1 School Identity** | GIAS search + (optionally) detail | `lookupSchoolURN`, `getGIASDetails` | urn, officialName, type, phase, la, isIndependent, gender, religiousCharacter, admissionsPolicy |
| **A2 Ofsted Grades** | reports.ofsted.gov.uk HTML | `getOfstedData` | overall, date, sub-grades (old or new framework), safeguarding |
| **A3 Pupil Experience** | Ofsted PDF | `fetchAndParseOfstedPdf` | pupilExperience; detail sections for old/new framework areas |
| **A4 Improvement Req.** | Ofsted PDF | `fetchAndParseOfstedPdf` | nextSteps — reproduced verbatim; never paraphrase |
| **A5 Pupil Census** | DfE CSV (CENSUS_25) | `getPerformanceData` | NOR, PNUMFSMEVER, PNUMEAL, PSENELK, PSENELSE |
| **A5 Pupil Ethnicity** | local-data.js (DfE census, bundled) | `getSchoolEthnicity` | w, m, a, b, c, o, ns |
| **A6 KS2** | DfE CSV (KS2_25) | `getPerformanceData` | PTRWM_EXP/HIGH, per-subject, disadvantaged gap, progress scores |
| **A6 KS4 school** | DfE CSV (KS4_25) | `getPerformanceData` | ATT8SCR, PTL2BASICS_95/94, PTEBACC_94/95, P8MEA + all breakdowns |
| **A6 KS4 local avg** | EES API (not yet fetched) | — **TODO** | att8, g5, g4, ebaccEntry, ebaccAps per LA |
| **A6 KS4 national avg** | Hardcoded `NATIONAL_AVG.KS4` | — (compile-time constant) | ATT8SCR=46.4, PTL2BASICS_95=45.9%, PTL2BASICS_94=68.8%, PTEBACC_E_PTQ_EE=24.7%, PTEBACC_94=28.6% |
| **A6 KS5** | DfE CSV (KS5_25, KS5_STUDEST_25) | `getPerformanceData` | TALLPPEGRD_ALEV_1618, VA_INS_ALEV, TOT_HEPER + disadvantaged breakdowns |
| **A7 Absence** | DfE CSV (ABS_24) | `getPerformanceData` | PERCTOT, PPERSABS10 |
| **A8 Financial** | FBIT HTML + census ZIP | `getFinancialData` | inYearBalance, revenueReserve, totalSpendPerPupil, qualifiedTeachersPct, pupilTeacherRatio |
| **A9 Area Profile** | postcodes.io → Nomis / ONS / IMD / Land Registry / Crystal Roof | `getAreaData` | IMD decile, mean income, house prices, ethnicity, qualifications, occupation |
| **B1 Parent View** | parentview.ofsted.gov.uk (3-step) | `fetchParentView` | wouldRecommend, childSafe, bullyingHandled, concernsHandled (⚠️ flagged below threshold) |

---

## 5. National Averages — hardcoded in `NATIONAL_AVG`

**Update each November** when DfE publishes provisional attainment data.

| Constant key | 2024/25 value | Meaning | DfE source |
|---|---|---|---|
| `KS2.PTRWM_EXP` | 61% | % meeting expected standard in RWM | EES KS2 attainment |
| `KS2.PTRWM_HIGH` | 9% | % achieving higher standard in RWM | EES KS2 attainment |
| `KS2.PTREAD_EXP` | 74% | % expected in reading | EES KS2 attainment |
| `KS2.PTMAT_EXP` | 73% | % expected in maths | EES KS2 attainment |
| `KS2.PTWRITTA_EXP` | 72% | % expected in writing (TA) | EES KS2 attainment |
| `KS2.PTGPS_EXP` | 75% | % expected in GPS | EES KS2 attainment |
| `KS2.PTRWM_EXP_FSM6CLA1A` | 46% | % RWM expected — disadvantaged | EES KS2 attainment |
| `KS2.PTREAD_EXP_FSM6CLA1A` | 57% | % reading expected — disadvantaged | EES KS2 attainment |
| `KS2.PTMAT_EXP_FSM6CLA1A` | 56% | % maths expected — disadvantaged | EES KS2 attainment |
| `KS4.P8MEA` | 0.00 | Progress 8 national avg (= 0 by construction) | EES KS4 attainment |
| `KS4.ATT8SCR` | 46.4 | Attainment 8 national avg | EES KS4 attainment |
| `KS4.PTL2BASICS_95` | 45.9% | Grade 5+ English & Maths national avg | EES KS4 attainment |
| `KS4.PTL2BASICS_94` | 68.8% | Grade 4+ English & Maths national avg | EES KS4 attainment |
| `KS4.PTEBACC_E_PTQ_EE` | 24.7% | % entering EBacc national avg | EES KS4 attainment |
| `KS4.PTEBACC_94` | 28.6% | EBacc grade 4+ national avg | EES KS4 attainment |
| `KS4.P8MEA_FSM6CLA1A` | -0.58 | Progress 8 — disadvantaged national avg | EES KS4 attainment |
| `ABSENCE.PERCTOT` | 6.6% | Overall absence national avg | EES pupil absence |
| `ABSENCE.PPERSABS10` | 21.3% | Persistent absence national avg | EES pupil absence |

---

## 6. Parent View Thresholds

| Field | ⚠️ Threshold | Note |
|---|---|---|
| `wouldRecommend` | < 80% | Most important signal |
| `childSafe` | < 88% | Safeguarding proxy |
| `bullyingHandled` | < 70% | |
| `concernsHandled` | < 75% | |
| `childHappy` | not flagged | Too uniform to be meaningful |

---

## 7. Section Flags — computed deterministically in `fetchGovDataForPrompt`

These are computed from structured data — **not AI judgment**. They override whatever the model might infer.

| Flag key | `'green'` condition | `'red'` condition |
|---|---|---|
| `A2. Ofsted Inspection Grades` | overall matches `/outstanding\|exceptional/i` | overall matches `/requires improvement\|inadequate/i` |
| `A4. What the School Needs to Improve` | `nextSteps` is null **and** overall is Outstanding | `nextSteps` has any content |
| `A6. Academic Performance` | Att8 > 56.4 (nat+10) **or** P8 > 0.5 **or** RWM > 71 (nat+10) | Att8 < 36.4 (nat-10) **or** P8 < -0.5 **or** RWM < 51 (nat-10) |
| `A7. Absence` | overall < 5% **and** persistent < 15% | overall > 8.6% **or** persistent > 23.3% |

Note for A6: when no KS4 data exists (independent school, sixth-form only), falls back to
`PROGRESS_BAND_ALEV` — 1 → green, ≥4 → red, else `'none'` (prevents model guessing).

---

## 8. Fetch Source Registry

| Source | URL pattern | Function | Timeout | Notes |
|---|---|---|---|---|
| GIAS search | `GIAS_SEARCH?TextSearchModel.Text={name}` | `lookupSchoolURN` | 8 s | HTML; browser UA required; scores result tiles by name similarity |
| GIAS detail | `GIAS_DETAIL/{urn}` | `getGIASDetails` | 8 s | HTML; dt/dd and th/td patterns; used for postcode / gender / SEN % when not in CSV |
| Ofsted grades | `reports.ofsted.gov.uk/provider/23/{urn}` (fallback `/21/`) | `getOfstedData` | 8 s | HTML scrape; handles old + new framework + timeline fallback |
| Ofsted PDF | `files.ofsted.gov.uk/v1/file/{id}` | `fetchAndParseOfstedPdf` | 20 s | pdf-parse v1.1.1; 2 retries; import wrapped in try/catch |
| Parent View | `parentview.ofsted.gov.uk/...` | `fetchParentView` | 8 s | 3-step redirect chain → print page; chart URL parsing |
| DfE school CSV | `{COMPARE_PERF}/download-school-data?urn={urn}` | `getPerformanceData` | 20 s | Vertical CSV; looksLikeCsv guard; KS2/KS4/CENSUS/ABS |
| DfE post-16 CSV | `{COMPARE_PERF}/download-school-data?urn={urn}&type=16to18` | `getPerformanceData` | 20 s | Merged into same PerformanceData object; KS5_25, KS5_STUDEST_25 |
| FBIT spending | `{FIN_BENCH}/school/{urn}/spending-and-costs` | `fetchFBITSpending` | 8 s | HTML scrape; 8 spending category sections |
| FBIT census | `{FIN_BENCH}/school/{urn}/census/download` | `fetchFBITCensus` | 20 s | ZIP download → single CSV; magic byte validation |
| postcodes.io | `api.postcodes.io/postcodes/{postcode}` | `getAreaData` | 8 s | Returns lsoa, msoa, district (name), region, lat, lon — **not** ONS district code (see §9) |
| Nomis ethnicity | `nomisweb.co.uk/api/v01/dataset/NM_2041_1/...` | `fetchNomisEthnicity` | 8 s | 2-step: ONS MSOA code → NomisKey, then TS021 data |
| ONS income | ONS FYE 2018 CSV (~680 KB) | `fetchONSIncome` | 8 s | Full file downloaded; row found by MSOA code |
| Land Registry | `landregistry.data.gov.uk/.../transaction-record.json` | `fetchPricePaid` | 8 s | Up to 100 postcodes within 800 m, all parallel |
| IMD | `findthatpostcode.uk/areas/{lsoa}.json` | `fetchIMD` | 8 s | MHCLG IMD 2025 preferred, fallback to 2019 |
| Crystal Roof ⚠️ TEMP | `crystalroof.co.uk/data-api/affluence/postcode/v2/{pc}` | `fetchCrystalRoof` | 8 s | **Unauthenticated commercial API — no SLA** |
| EES API | `api.education.gov.uk/statistics/v1/data-sets/...` | — (not yet implemented) | — | For LA-level KS4 averages — see §9 |
| DfE school ethnicity | `local-data.js` (bundled JS object) | `getSchoolEthnicity` | 0 ms | Indexed by URN; no HTTP; updated annually |

---

## 9. Known Gaps and Pending Work

| # | Gap | Impact | Fix |
|---|---|---|---|
| 1 | **LA-level KS4 averages not fetched** | "Local avg" column shows `—` for all KS4 rows | Add `fetchLAKS4(onsDistrictCode)` calling EES API (see §3 for query pattern + indicator IDs). Requires also extracting `r.codes?.admin_district` from postcodes.io response in `getAreaData`. |
| 2 | **`postcodes.io codes.admin_district` not extracted** | Blocker for gap #1 | In `getAreaData`, add: `const districtCode = r.codes?.admin_district ?? null;` and include in returned `AreaData` object. |
| 3 | **Crystal Roof is unauthenticated** | Qualifications + occupation + income could break without notice | Replace: qualifications → Nomis `NM_2082_1` (TS067); occupation → Nomis `NM_2066_1`; income → newer ONS MSOA URL. |
| 4 | **ONS income is FYE 2018** | Stale (7+ years old); Crystal Roof income is more recent | Find current ONS MSOA income estimates CSV URL; replace `fetchONSIncome`. |
| 5 | **KS4 EAL cohort count not published** | Can't show EAL cohort size in KS4 table | Not available in DfE school-level CSV — document as unavailable. |
| 6 | **Progress 8 not published for 2024/25 or 2025/26** | `P8MEA` will be absent for most schools | Note in A6 output; do not show empty P8 row. COVID disruption affected KS2 assessments for these cohorts. |
| 7 | **`getGIASDetails` not called in main flow** | GIAS detail page fields (capacity, fsmPct, ehcPlanPct from GIAS) are unused | The performance CSV provides most of these via CENSUS_25; GIAS detail is a redundant fallback. Currently exported but not wired into `fetchGovDataForPrompt`. |
