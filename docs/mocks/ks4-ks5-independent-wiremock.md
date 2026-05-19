# Independent School KS4/KS5 Wire Mock — Template Reference

Independent schools use iGCSEs so DfE performance data is sparse.
Disadvantaged/Not Disadv./EAL columns stripped (always `—`).
Grade 5+/4+ and Progress 8 hidden when all data suppressed.
Also covers independent all-through (ages 4–18) — no KS1/KS2 performance data.

**Legend:** `la X` = from EES API by LA code. `eng X` = from `NATIONAL_AVG`. `—` = suppressed.

---

## A1. School Identity

```
**School:** {officialName} · URN {urn} · {type} · {phase} (ages {ageLow}–{ageHigh}) · LA: {la} · {postcode} · {gender} · {religion} · admissions: {admissions} · capacity: {capacity} ({nor} on roll — {fillRate}% full)
```
**Links:** GIAS · Compare School Performance · FBIT · Ofsted

---

## A2. Inspection Outcomes (ISI)

Independent schools use ISI, not Ofsted.

```
- Overall: **ISI: {grade}** ({date})
- Framework: ISI Educational Quality Inspection
- Academic achievement: {grade}
- Personal development: {grade}
```

**Recommendations**
Verbatim from ISI recommendations. Fallback: `_Independent school — no improvement recommendations available._`

No "What it's like to be a pupil" narrative for ISI (no PDF parsing).

**What the School Needs to Improve**
Same as recommendations. Fallback: `_Independent school — no improvement recommendations available._`

---

## A3. Academic Performance

### Key Stage 4

**Columns: All pupils | Girls | Boys | Local Authority | England** (no Disadv/Not Disadv/EAL)

#### A3.1 — Attainment 8

| Metric | All pupils | Girls | Boys | LA | England |
|---|---|---|---|---|---|
| Attainment 8 score | `ATT8SCR` | `_GIRLS` | `_BOYS` | la `att8` | eng `ATT8SCR` |
| English element | `ATT8SCRENG` | `_GIRLS` | `_BOYS` | la `att8Eng` | eng `ATT8_ENG` |
| Maths element | `ATT8SCRMAT` | `_GIRLS` | `_BOYS` | la `att8Mat` | eng `ATT8_MAT` |
| EBacc element | `ATT8SCREBAC` | `_GIRLS` | `_BOYS` | la `att8Ebacc` | eng `ATT8_EBACC` |
| Open element | `ATT8SCROPEN` | `_GIRLS` | `_BOYS` | la `att8Open` | eng `ATT8_OPEN` |
| Open — GCSE only | `ATT8SCROPENG` | `_GIRLS` | `_BOYS` | la `att8OpenG` | eng `ATT8_OPENG` |
| Open — non-GCSE | `ATT8SCROPENNG` | `_GIRLS` | `_BOYS` | la `att8OpenNg` | eng `ATT8_OPENNG` |

#### A3.2 — Progress 8

**Always hidden for independent schools.**

#### A3.3 — Cohort Characteristics

| Category | All pupils |
|---|---|
| Pupils at end of KS4 | `TPUP` |
| % boys | `PBPUP` |
| % girls | `PGPUP` |
| % disadvantaged | `PTFSM6CLA1A` |
| % not disadvantaged | `PTNOTFSM6CLA1A` |
| % EAL | `PTEALGRP2` |
| % non-mobile | `PTNMOB` |
| % SEN with EHC plan | `PSENE4` |
| % SEN total | `PSEN_ALL4` |
| % SEN without EHC | `PSENK4` |

Rows hidden when 0% or suppressed.

#### A3.4 — Grade 5+ and 4+ English & Maths

**Hidden when all data suppressed (0.0% — common for iGCSE schools).**

When shown, columns: All pupils | Girls | Boys | LA | England.

| Metric | All pupils | Girls | Boys | LA | England |
|---|---|---|---|---|---|
| % grade 5+ English & maths | `PTL2BASICS_95` | `PGL2BASICS_95` | `PBL2BASICS_95` | la `grade5Em` | eng `PTL2BASICS_95` |
| % grade 4+ English & maths | `PTL2BASICS_94` | `PGL2BASICS_94` | `PBL2BASICS_94` | la `grade4Em` | eng `PTL2BASICS_94` |

#### A3.5 — EBacc Entry by Subject

| Category | All pupils | LA |
|---|---|---|
| English | `PTEBACENG_E_PTQ_EE` | la `ebEeng` |
| Maths | `PTEBACMAT_E_PTQ_EE` | la `ebEmat` |
| Science | `PTEBAC2SCI_E_PTQ_EE` | la `ebEsci` |
| Humanities | `PTEBACHUM_E_PTQ_EE` | la `ebEhum` |
| Languages | `PTEBACLAN_E_PTQ_EE` | la `ebElan` |

Rows hidden when 0%.

#### A3.6 — Post-16 Destinations

**Always hidden for independent schools** (KS4_PUPDEST_25 namespace not present).

#### A3.7 — Entry Volumes

| Category | All pupils |
|---|---|
| Avg KS4 entries per pupil | `TAVENT_E_3NG_PTQ_EE` |
| Avg KS4 entries (disadv.) | `TAVENT_E_3NG_FSM6CLA1A_PTQ_EE` |
| Avg GCSE entries per pupil | `TAVENT_G_PTQ_EE` |
| % entering multiple languages | `PTMULTILAN_E` |
| % entering triple science | `PTTRIPLESCI_E` |
| Level 2 threshold (9-4 EM) | `PT5EM_94` |
| % achieving any qualification | `PTANYQ_PTQ_EE` |

#### A3.8 — EBacc Subject Achievement

| Category | School 9-4 | LA 9-4 | England 9-4 | School 9-5 | LA 9-5 | England 9-5 | School 1+ | LA 1+ | England 1+ |
|---|---|---|---|---|---|---|---|---|---|
| English | `PTEBACENG_94` | la `eng94` | eng `EBACC_ENG_94` | `PTEBACENG_95` | la `eng95` | eng `EBACC_ENG_95` | `PTEBACENG_E_PTQ_EE` | la `eng1+` | 93% |
| Maths | `PTEBACMAT_94` | la `mat94` | eng `EBACC_MAT_94` | `PTEBACMAT_95` | la `mat95` | eng `EBACC_MAT_95` | `PTEBACMAT_E_PTQ_EE` | la `mat1+` | 94.5% |
| Science | `PTEBAC2SCI_94` | la `sci94` | eng `EBACC_SCI_94` | `PTEBAC2SCI_95` | la `sci95` | eng `EBACC_SCI_95` | `PTEBAC2SCI_E_PTQ_EE` | la `sci1+` | 98.2% |
| Humanities | `PTEBACHUM_94` | la `hum94` | eng `EBACC_HUM_94` | `PTEBACHUM_95` | la `hum95` | eng `EBACC_HUM_95` | `PTEBACHUM_E_PTQ_EE` | la `hum1+` | 97% |
| Languages | `PTEBACLAN_94` | la `lan94` | eng `EBACC_LAN_94` | `PTEBACLAN_95` | la `lan95` | eng `EBACC_LAN_95` | `PTEBACLAN_E_PTQ_EE` | la `lan1+` | 98.6% |

Rows hidden when 0%. Hidden entirely if all rows would be 0%.

#### A3.9 — Results Over Time (KS4)

| | 2023 final | 2024 final | 2025 final |
|---|---|---|---|
| Attainment 8 Score | `ATT8SCR_PREV2` | `ATT8SCR_PREV` | `ATT8SCR` |
| Local Authority | la `att8.yr23` | la `att8.yr24` | la `att8.yr25` |

Other rows (Progress 8, Grade 5+, Grade 4+, EBacc entry) hidden when data suppressed.

#### A3.10 — Subjects Entered (KS4)

| Subject | Qualification | Entries | Grade 7+ |
|---|---|---|---|
| (per-school, sorted by entries desc) | | | |

From bundled EES CSV. Grade 7+ = A/A* equivalent.

---

### Key Stage 5

**Shown when KS5_25 namespace present and TALLPUP_1618 or TALLPUP_ALEV_1618 has data.**

#### A3.11 — A-level Attainment

| Category | All pupils | England |
|---|---|---|
| Total 16–18 students | `TALLPUP_1618` | — |
| A-level students | `TALLPUP_ALEV_1618` | — |
| Average A-level grade | `TALLPPEGRD_ALEV_1618` | eng `avgGrade` |
| Average A-level points | `TALLPPE_ALEV_1618` | eng `avgPts` |
| Best 3 A-levels — grade | `TB3PTSE_GRD` | — |
| Best 3 A-levels — points | `TB3PTSE` | — |

#### A3.12 — A-level Progress

| Category | All pupils | England |
|---|---|---|
| Progress score (VA) | `VA_INS_ALEV` (CI: `LCI_INS_ALEV` to `UCI_INS_ALEV`) | 0 |
| Progress band | `PROGRESS_BAND_ALEV` | — |

#### A3.13 — A-level Value-Added — Disadvantaged

**Hidden when no disadvantaged pupils** (common for independents).

#### A3.14 — Facilitating Subjects & Destinations

| Category | All pupils | England |
|---|---|---|
| % AAB in ≥2 facilitating subjects | `PTAAB_2FAC` | — |
| % achieving advanced maths | `L3M_PER` | eng `advMaths` |
| % retained to end of course | `PT_RETAINED_ALEV_RET` | eng `retained` |
| % to higher education | `TOT_HEPER` | — |
| % to any sustained destination | `ALL_PROGRESSED` | — |

#### A3.15 — Tech Levels & Applied General

**Hidden when no data** (common for independents).

#### A3.16 — Results Over Time (KS5)

| | 2022 final | 2023 final | 2024 final | 2025 final |
|---|---|---|---|---|
| Average grade | `TALLPPEGRD_ALEV_1618_22` | `TALLPPEGRD_ALEV_1618_23` | `TALLPPEGRD_ALEV_1618_24` | `TALLPPEGRD_ALEV_1618` |
| Average points | `TALLPPE_ALEV_1618_22` | `TALLPPE_ALEV_1618_23` | `TALLPPE_ALEV_1618_24` | `TALLPPE_ALEV_1618` |
| VA score | `VA_INS_ALEV_22` | `VA_INS_ALEV_23` | `VA_INS_ALEV_24` | `VA_INS_ALEV` |

#### A3.17 — Subjects Entered (KS5)

| Subject | Qualification | Entries | A–B |
|---|---|---|---|
| (per-school, sorted by entries desc) | | | |

From bundled EES CSV. A–B = A-level equivalent of grade 7+.

---

## A4. Intake & Cohort — Pupil Census (DfE)

### Pupil numbers
| Category | School | National avg |
|---|---:|---:|
| Pupils on roll | `NOR` | ~1,000 secondary |
| FSM eligible (last 6 years) | `PNUMFSMEVER`% | ~20% secondary |
| SEN support | `PSENELK`% | ~13% |
| EHC plans | `PSENELSE`% | ~4.5% |

**FSM:** Always near 0.00% for independents. Shown as-is.
**EAL:** Hidden (0.0% for independents).
**Ethnicity:** Hidden entirely (all groups 0% for independents in DfE data).

### SEN & Inclusion
Auto-generated paragraph based on SEN support + EHC plan %.

---

## A5. Absence & Engagement (DfE)

```
_No absence data available — independent schools do not report absence to DfE._
```

---

## A6. Financial Health

### Financial Benchmarking (FBIT)
```
_Not available for independent schools._
```

### School Fees
Shown when fees data scraped from school website:
```
### School Fees
- Day fees: £{min}–£{max} {period}
- [Boarding fees: £{amount} {period}]
```
Hidden when no fees data available.

---

## A7. Area Context

```
- Location: {postcode} · {district} · {region}
- Geography codes: LSOA {code} · MSOA {code}
- Deprivation (IMD 2025): decile **{X}/10** · weaker sub-domains: {list}
- Household income (MSOA): mean gross £{X} (Census 2021 era) · net £{X} (ONS 2018) · after housing £{X}
- House prices (~800m, {N} sales, 5yr): median £{X} · by type: {breakdown}
- Ethnicity (LSOA, Census 2021): {breakdown}
- Qualifications (OA, Census 2021): level 4+ {X%} · no qualifications {X%}
- Occupation (OA, Census 2021): professional/managerial {X%} · routine/manual {X%}
```
