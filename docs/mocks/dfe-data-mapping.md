# DfE Performance Data — Variable-to-Section Mapping

Every variable available in the DfE school performance CSV download, mapped to its render section.
Variables not listed are either admin/metadata (PCODE, SCHNAME, URN, etc.) or not present in the 2024/25 publication.

## School types → namespaces

| School type | L | CENSUS_25 | ABS_24 | KS2_25 | KS4_25 | KS4_PUPDEST_25 | KS5_25 | KS5_STUDEST_25 |
|---|---|---|---|---|---|---|---|---|
| Infant | ✓ | ✓ | ✓ | | | | | |
| Junior | ✓ | ✓ | ✓ | ✓ | | | | |
| Primary | ✓ | ✓ | ✓ | ✓ | | | | |
| Secondary | ✓ | ✓ | ✓ | | ✓ | ✓ | | |
| Sixth form | ✓ | | | | | | ✓ | ✓ |
| Sec+Sixth | ✓ | ✓ | ✓ | | ✓ | ✓ | ✓ | ✓ |
| Ind. primary | ✓ | ✓* | | | | | | |
| Ind. secondary | ✓ | ✓* | | | ✓ | | ✓ | |
| Ind. all-through | ✓ | ✓* | | | ✓ | | ✓ | |

\* Percentages suppressed (0%/0.0%) — rendered as `—`

---

## A4 — Pupil Census (CENSUS_25)

| DfE variable | Rendered as |
|---|---|
| `NOR` | Pupils on roll |
| `PNUMFSMEVER` | % FSM eligible (last 6 years) |
| `PNUMEAL` | % EAL pupils |
| `PSENELK` | % SEN support |
| `PSENELSE` | % EHC plans |

**Rule:** Row hidden if value is DfE suppression (0%, 0.0%, 0.00%).
National averages shown for comparison.
Ethnicity from bundled DfE index — hidden if ALL groups are 0%.

**NOT shown from CENSUS_25:** `NORG`, `NORB`, `PNORG`, `PNORB` (counts of boys/girls — in A1 instead). `NUMFSM`, `NUMEAL`, `NUMENGFL` (raw counts — percentages preferred). `TSENELK`, `TSENELSE` (pupil counts — percentages preferred).

---

## A5 — Academic Performance

### Detection rules

- KS2 section shown if `KS2_25` namespace exists in the data
- KS4 section shown if `KS4_25` exists AND any of `P8MEA`, `ATT8SCR`, `PTL2BASICS_95`, `PTL2BASICS_94` is present
- KS5 section shown if `KS5_25` exists AND `TALLPUP_1618` or `TALLPUP_ALEV_1618` is present
- Each sub-table shown only if at least one row has non-suppressed data

### KS2 tables (from KS2_25 namespace)

#### Table 1 — Cohort

| DfE variable | Rendered as |
|---|---|
| `TELIG` | Eligible cohort |
| `BELIG` | Boys |
| `GELIG` | Girls |

#### Table 2 — Attainment (timeseries)

| DfE variable (2025) | DfE variable (2024) | DfE variable (2023) | Rendered as | LA key |
|---|---|---|---|---|
| `PTRWM_EXP` | `PTRWM_EXP_24` | `PTRWM_EXP_23` | % meeting expected standard (RWM) | `rwm.expected` |
| `PTRWM_HIGH` | `PTRWM_HIGH_24` | `PTRWM_HIGH_23` | % achieving higher standard (RWM) | `rwm.higher` |

Each row has School / LA / England sub-rows. LA data from EES API (`getLAPerformanceKS2`). England from `NATIONAL_AVG.KS2`.

#### Table 3 — Scaled scores (timeseries)

| DfE variable (2025) | DfE variable (2024) | DfE variable (2023) | Rendered as | LA key |
|---|---|---|---|---|
| `READ_AVERAGE` | `READ_AVERAGE_24` | `READ_AVERAGE_23` | Reading — average scaled score | `reading.avgScore` |
| `MAT_AVERAGE` | `MAT_AVERAGE_24` | `MAT_AVERAGE_23` | Maths — average scaled score | `maths.avgScore` |
| `GPS_AVERAGE` | | | GPS — average scaled score | `gps.avgScore` |

Note: GPS prior years not available in DfE CSV for all schools — show `—` if missing.

#### Table 4 — Progress

| DfE variable | CI low | CI high | Rendered as |
|---|---|---|---|
| `READPROG` | `READPROG_LOWER` | `READPROG_UPPER` | Reading progress |
| `WRITPROG` | `WRITPROG_LOWER` | `WRITPROG_UPPER` | Writing progress |
| `MATPROG` | `MATPROG_LOWER` | `MATPROG_UPPER` | Maths progress |

Banding derived from `PROGRESS_BAND` (1=Well below average … 5=Well above average).

**NOT shown from KS2_25:** 
- Gender/FSM/EAL variant suffixes (e.g. `_BOYS`, `_GIRLS`, `_FSM6CLA1A`, `_EAL`) — 49 vars, would be handled by variant finder but not currently rendered in timeseries tables
- Subject-level attainment for reading/writing/maths/GPS separately (`PTREAD_EXP`, `PTMAT_EXP`, etc.) — redundant with RWM combined + scaled scores
- Teacher assessment variables (`PTWRITTA_EXP`, `PTSCITA_EXP`) — less reliable than test scores
- Raw pupil counts (`T*` prefix) — percentages preferred
- Prior-year progress (`READPROG_23`, `MATPROG_24` etc.) — not currently in timeseries but available

### KS4 tables (from KS4_25 + KS4_PUPDEST_25)

#### Attainment 8

| DfE variable | Rendered as |
|---|---|
| `ATT8SCR` | Attainment 8 score |
| Gender/FSM/EAL variants via `findVar` | Boys, Girls, Disadvantaged, EAL columns |

England: `NATIONAL_AVG.KS4.ATT8SCR`. LA: from `getLAPerformanceKS4`.

#### Attainment 8 breakdown

| DfE variable | Rendered as |
|---|---|
| `ATT8SCRENG` | English element |
| `ATT8SCRMAT` | Maths element |
| `ATT8SCREBAC` | EBacc element |
| `ATT8SCROPEN` | Open element (total) |
| `ATT8SCROPENG` | Open — GCSE only |
| `ATT8SCROPENNG` | Open — non-GCSE |

#### Progress 8

| DfE variable | Rendered as |
|---|---|
| `P8MEA` | Progress 8 score |
| `P8LOWER` / `P8UPPER` | CI |

#### Grade thresholds

| DfE variable | Rendered as |
|---|---|
| `PTL2BASICS_95` | % grade 5+ English & maths |
| `PTL2BASICS_94` | % grade 4+ English & maths |

#### EBacc entry

| DfE variable | Rendered as |
|---|---|
| `PTEBACC_E_PTQ_EE` | % entering EBacc |
| `PTEBACENG_E_PTQ_EE` | English |
| `PTEBACMAT_E_PTQ_EE` | Maths |
| `PTEBAC2SCI_E_PTQ_EE` | Science |
| `PTEBACHUM_E_PTQ_EE` | Humanities |
| `PTEBACLAN_E_PTQ_EE` | Languages |

#### EBacc achievement

| DfE variable | Rendered as |
|---|---|
| `PTEBACC_95` | % EBacc 5+ |
| `PTEBACC_94` | % EBacc 4+ |
| `EBACCAPS` | EBacc APS |

#### EBacc subject achievement

| DfE variable | Rendered as |
|---|---|
| `PTEBACENG_94` / `_95` | English 9-4 / 9-5 |
| `PTEBACMAT_94` / `_95` | Maths 9-4 / 9-5 |
| `PTEBAC2SCI_94` / `_95` | Science 9-4 / 9-5 |
| `PTEBACHUM_94` / `_95` | Humanities 9-4 / 9-5 |
| `PTEBACLAN_94` / `_95` | Languages 9-4 / 9-5 |

#### KS4 destinations (from KS4_PUPDEST_25)

| DfE variable | Rendered as |
|---|---|
| `OVERALL_DESTPER` | % sustained education or employment |
| `EDUCATIONPER` | % in education |
| `SIXTH_COLPER` | % sixth form college |
| `FEPER` | % further education |
| `APPRENPER` | % apprenticeships |
| `EMPLOYMENTPER` | % employment |
| `NOT_SUSTAINEDPER` | % not sustained |

### KS5 tables (from KS5_25 + KS5_STUDEST_25)

#### A-level attainment

| DfE variable | Rendered as |
|---|---|
| `TALLPUP_1618` | Total 16–18 students |
| `TALLPUP_ALEV_1618` | A-level students |
| `ENTRIES_ALEV` | A-level entries |
| `TALLPPEGRD_ALEV_1618` | Average A-level grade |
| `TALLPPE_ALEV_1618` | Average A-level points |
| `TALLPPEGRD_ACAD_1618` | Average grade (all academic) |
| `TB3PTSE_GRD` | Best 3 A-levels — grade |
| `TB3PTSE` | Best 3 A-levels — points |

#### A-level progress

| DfE variable | Rendered as |
|---|---|
| `VA_INS_ALEV` | Progress score (VA) |
| `LCI_INS_ALEV` / `UCI_INS_ALEV` | CI |
| `PROGRESS_BAND_ALEV` | Progress band |

#### A-level disadvantaged

| DfE variable | Rendered as |
|---|---|
| `TALLPUP_ALEV_1618_DIS` | Disadvantaged students |
| `TALLPPEGRD_ALEV_DIS` | Average grade (disadvantaged) |
| `TALLPPE_ALEV_1618_DIS` | Average points (disadvantaged) |
| `VA_INS_ALEV_DIS` | Progress score (disadvantaged) |

#### Retention

| DfE variable | Rendered as |
|---|---|
| `PT_RETAINED_ALEV_RET` | % retained to end of course |
| `PT_RETAINED_ACAD_2NDYR` | % retained to 2nd year |
| `PT_RETAINED_ACAD_RET_DIS` | % retained (disadvantaged) |

#### L3 destinations (from KS5_STUDEST_25)

| DfE variable | Rendered as |
|---|---|
| `L3_OVERALLPER` | % sustained education or employment |
| `L3_HEPER` | % higher education |
| `L3_EMPLOYMENTPER` | % employment |
| `L3_APPRENPER` | % apprenticeships |
| `L3_FEPER` | % further education |
| `L3_NOT_SUSTAINEDPER` | % not sustained |

#### Disadvantaged progression gap (from KS5_STUDEST_25)

| DfE variable | Rendered as |
|---|---|
| `DIS_PROGRESSED` | % progressed (disadvantaged) |
| `ALL_PROGRESSED` | % progressed (all) |
| `DIS_HE` | % HE (disadvantaged) |
| `ALL_HE` | % HE (all) |
| `DIS_TOP3RD` | % top third HE (disadvantaged) |
| `ALL_TOP3RD` | % top third HE (all) |

#### Facilitating subjects

| DfE variable | Rendered as |
|---|---|
| `PTAAB_2FAC` | % AAB in ≥2 facilitating subjects |
| `L3M_PER` | % achieving advanced maths |

---

## A6 — Absence (ABS_24)

| DfE variable | Rendered as |
|---|---|
| `PERCTOT` | Overall absence % |
| `PPERSABS10` | Persistent absence % |

National averages from `NATIONAL_AVG.ABSENCE`.

---

## Suppression rules (universal)

DfE uses `0`, `0%`, `0.0%`, `0.00%` as suppression markers.
- `c()` and `d()` helpers MUST convert these to `—`
- Rows with ALL columns suppressed MUST be hidden
- Entire sub-tables with NO non-suppressed rows MUST be hidden
- Exception: raw counts (NOR, TELIG) — `0` may be genuine, but show as `—` to be safe since a school with genuinely 0 pupils wouldn't appear in DfE data

## Traffic light flags

| Section | Green condition | Red condition |
|---|---|---|
| A2 | Outstanding / Exceptional / Excellent | RI / Inadequate / Unsatisfactory / Sound |
| A3 | No improvements + grade Outstanding/Exceptional/Excellent | Improvements present |
| A4 | — | FSM >35% (primary) / >30% (secondary) OR EHC >6% |
| A5 | Attainment >10pp above national OR Progress >0.5 | Attainment >10pp below national OR Progress <-0.5 |
| A6 | Absence <5% AND persistent <15% | Absence >8.6% OR persistent >23.3% |
| A7 | Reserves >3 months spend AND QTS above comparator | Deficit OR QTS below comparator |
| A8 | — | IMD decile ≤3 OR income <£35k |
