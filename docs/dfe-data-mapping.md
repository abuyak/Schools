# DfE Performance Data — Variable Mapping & Render Rules

## School types and available namespaces

| Phase | DfE namespaces | Example |
|---|---|---|
| **Infant** (KS1 only) | L, CENSUS_25, ABS_24 | Earlswood Infant |
| **Junior** (KS2) | L, CENSUS_25, ABS_24, KS2_25 | Earlswood Junior |
| **Primary** (KS1+KS2) | L, CENSUS_25, ABS_24, KS2_25 | Redriff Primary |
| **Secondary** (KS4) | L, CENSUS_25, ABS_24, KS4_25, KS4_PUPDEST_25 | Reigate School |
| **Sixth Form** (KS5) | L, KS5_25, KS5_STUDEST_25 | Reigate College |
| **Secondary+Sixth** | L, CENSUS_25, ABS_24, KS4_25, KS4_PUPDEST_25, KS5_25, KS5_STUDEST_25 | Latymer School |
| **Ind. Primary** | L, CENSUS_25 (percentages suppressed) | Micklefield School |
| **Ind. Secondary** | L, CENSUS_25, KS4_25, KS5_25 (percentages suppressed) | Caterham School |
| **Ind. All-through** | L, CENSUS_25, KS4_25, KS5_25 (percentages suppressed) | UCS |

## Section mapping

### A1 — School Identity
*Source: L + GIAS detail*

| Variable | Render Rule |
|---|---|
| `officialName` (GIAS) | Always show |
| `urn` (GIAS) | Always show |
| `type` (GIAS) | Always show |
| `phase` (GIAS) | Always show |
| `AGELOW` / `AGEHIGH` (L) | Show as "ages X–Y" |
| `la` (GIAS) | Always show |
| `GENDER` (L) | Show as "Mixed / Boys only / Girls only" |
| `RELCHAR` (L) | Show unless "Does not apply" |
| `ADMPOL` (L) | Show unless "Not applicable" |
| `headteacher` (GIAS detail) | Show if available |
| `address` (GIAS tile) | Show if available |
| `capacity` (GIAS detail) | Show if available |
| `NOR` (CENSUS_25) | Show if available |

### A2 — Ofsted / ISI Inspection Grades
*Source: Ofsted HTML scrape (state) or ISI PDF parse (independent)*

| State schools | Independent schools |
|---|---|
| Overall grade + sub-grades (Quality of Education, Behaviour, Personal Development, Leadership) | ISI overall + academic/personal judgments |
| Inspection date | Inspection date |
| Framework marker | ISI framework marker |
| Safeguarding status | Safeguarding status |

**Render rules:**
- If independent + ISI data → show ISI grades table
- If independent + no ISI data → "ISI report not retrieved"
- If state + Ofsted → show full grades table
- If state + no Ofsted → "Not retrieved"
- Flag: green for Outstanding/Exceptional/Excellent, red for RI/Inadequate/Unsatisfactory/Sound

### A3 — Improvement Requirements
*Source: Ofsted PDF nextSteps or ISI PDF recommendations*

**Render rules:**
- If nextSteps/recommendations present → show content, flag red
- If Outstanding/Excellent with none → "No improvement requirements.", flag green
- Independent + no data → "No recommendations available"
- State + no data → "Not retrieved"

### A4 — Pupil Census
*Source: CENSUS_25 + bundled DfE ethnicity index*

| Variable | Render Rule |
|---|---|
| `NOR` (NOR) | Always show |
| `PNUMFSMEVER` (FSM %) | Show unless suppressed (0%, 0.0%, 0.00%) |
| `PNUMEAL` (EAL %) | Show unless suppressed |
| `PSENELK` (SEN support %) | Show unless suppressed |
| `PSENELSE` (EHC plans %) | Show unless suppressed |
| Ethnicity index (bundled) | Show unless ALL values are 0 (DfE suppression) |
| National averages | Show for comparison where available |

### A5 — Academic Performance
*Source: KS2_25, KS4_25, KS5_25*

**Detection rule:** Show each KS stage section ONLY if that namespace exists in the data (data-driven, not phase-driven).

#### KS2 (primary)

**Table 1 — Cohort**
Show if `TELIG` or `BELIG` or `GELIG` is present and not suppressed.

**Table 2 — Attainment**  
Format: timeseries (2023 | 2024 | 2025) with LA and England comparator rows.
| Row | Variable (2025) | Variable (2024) | Variable (2023) | LA key |
|---|---|---|---|---|
| % expected standard (RWM) | `PTRWM_EXP` | `PTRWM_EXP_24` | `PTRWM_EXP_23` | `rwm.expected` |
| % higher standard (RWM) | `PTRWM_HIGH` | `PTRWM_HIGH_24` | `PTRWM_HIGH_23` | `rwm.higher` |
Show if at least one year has non-suppressed data.

**Table 3 — Scaled scores**
Same timeseries format.
| Row | Variable (2025) | Variable (2024) | Variable (2023) |
|---|---|---|---|
| Reading | `READ_AVERAGE` | `READ_AVERAGE_24` | `READ_AVERAGE_23` |
| Maths | `MAT_AVERAGE` | `MAT_AVERAGE_24` | `MAT_AVERAGE_23` |
| GPS | `GPS_AVERAGE` | `GPS_AVERAGE_24` | `GPS_AVERAGE_23` |

**Table 4 — Progress**
Format: progress (Subject | Score | Banding | CI)
| Row | Variable | CI Low | CI High |
|---|---|---|---|
| Reading | `READPROG` | `READPROG_LO` | `READPROG_HI` |
| Writing | `WRITPROG` | `WRITPROG_LO` | `WRITPROG_HI` |
| Maths | `MATPROG` | `MATPROG_LO` | `MATPROG_HI` |
Banding: derived from PROGRESS_BAND (1=Well below … 5=Well above)

#### KS4 (secondary)

**Detection rule:** Show KS4 section if `P8MEA` OR `ATT8SCR` OR `PTL2BASICS_95` OR `PTL2BASICS_94` is present.

Tables currently rendered (from the restored pre-refactor code):
- Cohort size (with gender breakdown if available)
- Attainment 8 (All / Boys / Girls / Disadvantaged / EAL / Local avg / England)
- Attainment 8 element breakdown (English, Maths, EBacc, Open — GCSE/non-GCSE)
- Progress 8 (with CI)
- Grade 5+ / 4+ English & Maths
- EBacc entry / achievement / subject detail
- KS4 destinations

#### KS5 (post-16)

**Detection rule:** Show KS5 section if `TALLPUP_1618` or `TALLPUP_ALEV_1618` is present.

Current tables:
- A-level attainment (students, entries, grades, best 3)
- A-level progress (VA score, band, disadvantaged breakdown)
- Retention
- Destinations (L3 breakdown, disadvantaged gap)
- Facilitating subjects

### A6 — Absence
*Source: ABS_24*

| Variable | Render Rule |
|---|---|
| `PERCTOT` | Always show |
| `PPERSABS10` | Always show |
| National averages | Show for comparison |
| Flag: green if below 5%/15%, red if above 8.6%/23.3% |

### A7 — Financial Position
*Source: FBIT (state) or school website scrape (independent)*

| State schools | Independent schools |
|---|---|
| Spend per pupil | Day/boarding fee ranges |
| In-year balance | Source URL |
| Revenue reserves | |
| QTS % | |
| Pupil:teacher ratio | |

**Render rules:**
- Independent → show fees if available, else "not retrieved"
- State → show FBIT data if available, else "not retrieved"

### A8 — Area Profile
*Source: postcodes.io + Nomis + ONS + IMD + Crystal Roof*

| Variable | Source | Render Rule |
|---|---|---|
| Postcode, district, region | postcodes.io | Always show |
| IMD decile + sub-domains | findthatpostcode.uk | Always show |
| Household income | Crystal Roof + ONS | Show if available |
| House prices | Land Registry | Show if available |
| Ethnicity (LSOA) | Nomis Census 2021 | Show if available |
| Qualifications | Crystal Roof | Show if available (TEMP) |
| Flag: red if IMD decile ≤3 or income <£35k |

### A9 — Parent View
*Source: Ofsted Parent View print page (state only)*

Table: Question | % agree, with ⚠️ flags for low scores.

**Render rules:**
- Show only if Parent View data was retrieved
- Skip if independent school (no Parent View for independent schools)

## Suppression rules (applied everywhere)

DfE uses `0`, `0%`, `0.0%`, `0.00%` as suppression markers for small cohorts. These values MUST be rendered as `—` (not as genuine zero). Exception: raw counts like NOR (pupil headcount) where `0` would mean genuinely zero pupils — but this is a theoretical case.

**Implementation:** Every `c()` / `d()` formatting helper must check suppressed values and convert to `—`. Rows with ALL columns suppressed should be HIDDEN.
