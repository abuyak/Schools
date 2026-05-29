# Branch 2 Comparison Wiremock — Template Reference

Side-by-side comparison of two schools. Tables use format: `| Metric | School A | School B | National/Comparator |`.

**Legend:** `la X` = from EES API by LA code. `eng X` = from `NATIONAL_AVG`. `—` = suppressed/missing.

---

## Section order

```
A1. School Identity               ← server table, no Observations
A2. Inspection Outcomes           ← server table
A2. Observations                  ← AI bullets
Parent View                       ← server table (per-school survey data)
What the School Needs to Improve  ← server verbatim, no Observations
A3.1 through A3.17                ← server tables (varies by phase)
A3. Observations                  ← AI bullets (one combined section after all A3 subs)
A4. Intake & Cohort               ← server table
A4. Observations                  ← AI bullets
A5. Absence & Engagement          ← server table
A5. Observations                  ← AI bullets
A6. Financial Health              ← server table
A6. Observations                  ← AI bullets
A7. Area Context                  ← server table
A7. Observations                  ← AI bullets
B1. Parent View                   ← AI reproduces pre-fetched table + commentary
B2. Admissions                    ← AI from web search
B3. Extracurricular & Clubs       ← AI from web search
B4. What Parents Say              ← AI from web search
B5. Where Pupils Go Next          ← AI from web search + pre-fetched destinations
C1. Head-to-Head Verdict          ← AI table + paragraph
C2. Which Child Thrives Where     ← AI per-school paragraph
C3. Tradeoffs                     ← AI bullets
C4. Best Next Move                ← AI bullets
C5. Sources                       ← AI source list
```

Observations are AI-written. Data tables are server-rendered (deterministic). Part A is interleaved: data table, then its observation section.

---

## A1. School Identity

Side-by-side comparison table. No Observations.

```
| | School A | School B |
|---|---:|---:|
| Official name | {officialName} | {officialName} |
| URN | {urn} | {urn} |
| Type | {type} | {type} |
| Phase & age range | {phase}, ages {lo}–{hi} | {phase}, ages {lo}–{hi} |
| Gender | {gender} | {gender} |
| Religious character | {religion} | {religion} |
| Admissions policy | {admpol} | {admpol} |
| Address | {address} | {address} |
| Pupils on roll | {nor} | {nor} |
```

Religion and Admissions hidden when "Does not apply" / "Not applicable".

---

## A2. Inspection Outcomes

Side-by-side table. Column header: `School A | School B` (no National column).

**State schools (Ofsted):**
```
| | School A | School B |
|---|---:|---:|
| Overall grade | {grade} | {grade} |
| Inspection date | {date} | {date} |
```

**Independent schools (ISI):**
```
| | School A | School B |
|---|---:|---:|
| Overall (ISI) | {grade} | {grade} |
| Inspection date | {date} | {date} |
```

A deterministic analysis paragraph is appended server-side comparing grades and dates.

### A2. Observations

Heading: `## A2. Observations` · Flag: `green` if one school clearly wins (Outstanding/Exceptional vs lower), `red` if either school is RI/Inadequate, else `none`

Bullet list, 3–4 bullets:
- Compare inspection grades — which school is stronger
- Call out any sub-grade weaker than overall for either school
- Note inspection recency — if either is >5 years old, flag it
- For ISI vs Ofsted: note frameworks are not directly comparable

---

## Parent View (unnumbered, server-rendered)

No Observations — the table speaks for itself. Deterministic server render.

**Data source:** `fetchParentView(urn)` — Ofsted Parent View print page.

Rendered only when at least one school has `ofsted.parentView` data. Independent schools skipped.

```
| | School A | School B |
|---|---:|---:|
| Total responses | {N} | {N} |
| Would recommend this school | {X}% ⚠️ | {X}% |
| My child is happy here | {X}% | {X}% |
| My child feels safe | {X}% | {X}% ⚠️ |
| Pupils are well behaved | {X}% | {X}% |
| Bullying dealt with well | {X}% | {X}% ⚠️ |
| School communicates well | {X}% | {X}% |
| Concerns dealt with properly | {X}% | {X}% ⚠️ |
| Acts in child's best interests | {X}% | {X}% |
| Right support to learn | {X}% | {X}% |
| SEND support | {X}% | {X}% |
```

⚠️ thresholds:
- Would recommend: below 80%
- Child feels safe: below 88%
- Bullying dealt with well: below 70%
- Concerns dealt with properly: below 75%

Footer appended below table: `⚠️ = below threshold (...). Fewer than 20 responses = too thin to rely on.`

Total responses shown as plain number (no % suffix). All other rows shown as percentages.

Section heading: `Parent View` or `Parent View ({academicYear})` (e.g. `Parent View (2024/2025)`).

---

## What the School Needs to Improve (unnumbered)

Per-school, verbatim from Ofsted/ISI. Fallback: `_No improvement requirements stated._`

For independent schools: `_Independent school — no improvement recommendations available._`

No Observations section.

---

## A3. Academic Performance

Subsections vary by phase. All tables: `| Metric | School A | School B | National |`

### Primary (KS2) subsections

#### A3.1 — Cohort

```
| Category | School A | School B | National |
|---|---:|---:|---:|
| Eligible cohort | {TELIG} | {TELIG} | — |
| % girls | {PGELIG} | {PGELIG} | — |
| % boys | {PBELIG} | {PBELIG} | — |
| % disadvantaged | {PTFSM6CLA1A} | {PTFSM6CLA1A} | — |
| % EAL | {PTEALGRP2} | {PTEALGRP2} | — |
```

#### A3.2 — Attainment (RWM)

```
| Category | School A | School B | National |
|---|---:|---:|---:|
| % expected standard (RWM) | {PTRWM_EXP}% | {PTRWM_EXP}% | {eng PTRWM_EXP}% |
| % higher standard (RWM) | {PTRWM_HIGH}% | {PTRWM_HIGH}% | {eng PTRWM_HIGH}% |
```

#### A3.3 — Scaled Scores

```
| Category | School A | School B | National |
|---|---:|---:|---:|
| Reading — avg scaled score | {READ_AVERAGE} | {READ_AVERAGE} | 105 |
| Maths — avg scaled score | {MAT_AVERAGE} | {MAT_AVERAGE} | 104 |
| GPS — avg scaled score | {GPS_AVERAGE} | {GPS_AVERAGE} | 105 |
```

#### A3.4 — Per-subject: Expected Standard

```
| Category | School A | School B | National |
|---|---:|---:|---:|
| Reading | {PTREAD_EXP}% | {PTREAD_EXP}% | {eng PTREAD_EXP}% |
| Writing (TA) | {PTWRITTA_EXP}% | {PTWRITTA_EXP}% | {eng PTWRITTA_EXP}% |
| Maths | {PTMAT_EXP}% | {PTMAT_EXP}% | {eng PTMAT_EXP}% |
| GPS | {PTGPS_EXP}% | {PTGPS_EXP}% | {eng PTGPS_EXP}% |
| Science (TA) | {PTSCITA_EXP}% | {PTSCITA_EXP}% | {eng PTSCITA_EXP}% |
```

#### A3.5 — Per-subject: Higher Standard

```
| Category | School A | School B | National |
|---|---:|---:|---:|
| Reading | {PTREAD_HIGH}% | {PTREAD_HIGH}% | {eng PTREAD_HIGH}% |
| Writing (TA) | {PTWRITTA_HIGH}% | {PTWRITTA_HIGH}% | {eng PTWRITTA_HIGH}% |
| Maths | {PTMAT_HIGH}% | {PTMAT_HIGH}% | {eng PTMAT_HIGH}% |
| GPS | {PTGPS_HIGH}% | {PTGPS_HIGH}% | {eng PTGPS_HIGH}% |
```

#### A3.6 — Cohort Characteristics

```
| Category | School A | School B | National |
|---|---:|---:|---:|
| % disadvantaged | {PTFSM6CLA1A}% | {PTFSM6CLA1A}% | — |
| % EAL | {PTEALGRP2}% | {PTEALGRP2}% | — |
| % non-mobile | {PTMOBN}% | {PTMOBN}% | — |
| % SEN with EHC plan | {PSENELE}% | {PSENELE}% | — |
| % SEN support | {PSENELK}% | {PSENELK}% | — |
```

#### A3.7 — Disadvantage Gap

```
| Category | School A | School B | National |
|---|---:|---:|---:|
| RWM expected — gap vs national (pp) | {DIFFN_RWM_EXP} | {DIFFN_RWM_EXP} | 0 |
| RWM higher — gap vs national (pp) | {DIFFN_RWM_HIGH} | {DIFFN_RWM_HIGH} | 0 |
```

Hidden when both schools have 0 pupils in disadvantaged group.

#### A3.8 — Test Participation

```
| Category | School A | School B |
|---|---:|---:|
| Reading — % absent | {PTREAD_AT}% | {PTREAD_AT}% |
| Maths — % absent | {PTMAT_AT}% | {PTMAT_AT}% |
| GPS — % absent | {PTGPS_AT}% | {PTGPS_AT}% |
```

Rows hidden when 0% (DfE-suppressed).

#### A3.9 — Progress (KS1 to KS2)

```
| Progress Scores | School A | School B | National |
|---|---:|---:|---:|
| Reading | {READPROG_23} ({READPROG_DESCR_23}) | {READPROG_23} ({READPROG_DESCR_23}) | 0 |
| Writing | {WRITPROG_23} ({WRITPROG_DESCR_23}) | {WRITPROG_23} ({WRITPROG_DESCR_23}) | 0 |
| Maths | {MATPROG_23} ({MATPROG_DESCR_23}) | {MATPROG_23} ({MATPROG_DESCR_23}) | 0 |
```

#### A3.10 — Results Over Time (KS2)

**Expected Standard RWM:**
```
| | School A | School B | National |
|---|---:|---:|---:|
| 2023 | {PTRWM_EXP_23}% | {PTRWM_EXP_23}% | 60% |
| 2024 | {PTRWM_EXP_24}% | {PTRWM_EXP_24}% | 61% |
| 2025 | {PTRWM_EXP}% | {PTRWM_EXP}% | 62% |
```

**Higher Standard RWM:**
```
| | School A | School B | National |
|---|---:|---:|---:|
| 2023 | {PTRWM_HIGH_23}% | {PTRWM_HIGH_23}% | 8% |
| 2024 | {PTRWM_HIGH_24}% | {PTRWM_HIGH_24}% | 8% |
| 2025 | {PTRWM_HIGH}% | {PTRWM_HIGH}% | 8% |
```

---

### Secondary (KS4) subsections

Columns: `All pupils | Girls | Boys | Disadv. | Not Disadv. | EAL | LA | England` → for comparison, simplified to `School A | School B | National`.

Sub-group columns (girls/boys/disadvantaged/EAL) are not shown side-by-side for both schools — they would require 16 columns. The wiremock shows the All-pupils values for each school side by side, with National as anchor.

#### A3.1 — Attainment 8

```
| Metric | School A | School B | National |
|---|---:|---:|---:|
| Attainment 8 score | {ATT8SCR} | {ATT8SCR} | {eng ATT8SCR} |
| English element | {ATT8SCRENG} | {ATT8SCRENG} | {eng ATT8_ENG} |
| Maths element | {ATT8SCRMAT} | {ATT8SCRMAT} | {eng ATT8_MAT} |
| EBacc element | {ATT8SCREBAC} | {ATT8SCREBAC} | {eng ATT8_EBACC} |
| Open element | {ATT8SCROPEN} | {ATT8SCROPEN} | {eng ATT8_OPEN} |
| Open — GCSE only | {ATT8SCROPENG} | {ATT8SCROPENG} | {eng ATT8_OPENG} |
| Open — non-GCSE | {ATT8SCROPENNG} | {ATT8SCROPENNG} | {eng ATT8_OPENNG} |
```

Independent schools: columns reduced to `School A | School B | National` (no Disadv/EAL columns in data).

#### A3.2 — Progress 8

```
| Metric | School A | School B | National |
|---|---:|---:|---:|
| Progress 8 score | {P8MEA} | {P8MEA} | 0.00 |
```

**Always hidden for independent schools.**

#### A3.3 — Cohort Characteristics

```
| Category | School A | School B |
|---|---:|---:|
| Pupils at end of KS4 | {TPUP} | {TPUP} |
| % disadvantaged | {PTFSM6CLA1A}% | {PTFSM6CLA1A}% |
| % EAL | {PTEALGRP2}% | {PTEALGRP2}% |
| % non-mobile | {PTNMOB}% | {PTNMOB}% |
| % SEN with EHC plan | {PSENE4}% | {PSENE4}% |
| % SEN total | {PSEN_ALL4}% | {PSEN_ALL4}% |
```

Rows hidden when 0% or suppressed.

#### A3.4 — Grade 5+ and 4+ English & Maths

```
| Metric | School A | School B | National |
|---|---:|---:|---:|
| % grade 5+ English & maths | {PTL2BASICS_95}% | {PTL2BASICS_95}% | {eng PTL2BASICS_95}% |
| % grade 4+ English & maths | {PTL2BASICS_94}% | {PTL2BASICS_94}% | {eng PTL2BASICS_94}% |
```

Hidden for iGCSE schools (0.0% — all data suppressed).

#### A3.5 — EBacc Entry by Subject

```
| Category | School A | School B | National |
|---|---:|---:|---:|
| English | {PTEBACENG_E_PTQ_EE}% | {PTEBACENG_E_PTQ_EE}% | — |
| Maths | {PTEBACMAT_E_PTQ_EE}% | {PTEBACMAT_E_PTQ_EE}% | — |
| Science | {PTEBAC2SCI_E_PTQ_EE}% | {PTEBAC2SCI_E_PTQ_EE}% | — |
| Humanities | {PTEBACHUM_E_PTQ_EE}% | {PTEBACHUM_E_PTQ_EE}% | — |
| Languages | {PTEBACLAN_E_PTQ_EE}% | {PTEBACLAN_E_PTQ_EE}% | — |
```

Rows hidden when 0%.

#### A3.6 — Post-16 Destinations (2023 leavers)

```
| Category | School A | School B | National |
|---|---:|---:|---:|
| % sustained education or employment | {OVERALL_DESTPER}% | {OVERALL_DESTPER}% | — |
| % in education | {EDUCATIONPER}% | {EDUCATIONPER}% | — |
| % further education | {FEPER}% | {FEPER}% | — |
| % apprenticeships | {APPRENPER}% | {APPRENPER}% | — |
| % employment | {EMPLOYMENTPER}% | {EMPLOYMENTPER}% | — |
| % not sustained | {NOT_SUSTAINEDPER}% | {NOT_SUSTAINEDPER}% | — |
```

**Always hidden for independent schools.**

#### A3.7 — Entry Volumes

```
| Category | School A | School B |
|---|---:|---:|
| Avg KS4 entries per pupil | {TAVENT_E_3NG_PTQ_EE} | {TAVENT_E_3NG_PTQ_EE} |
| Avg GCSE entries per pupil | {TAVENT_G_PTQ_EE} | {TAVENT_G_PTQ_EE} |
| % entering multiple languages | {PTMULTILAN_E}% | {PTMULTILAN_E}% |
| % entering triple science | {PTTRIPLESCI_E}% | {PTTRIPLESCI_E}% |
| % achieving any qualification | {PTANYQ_PTQ_EE}% | {PTANYQ_PTQ_EE}% |
```

#### A3.8 — EBacc Subject Achievement

```
| Category | School A 9-5 | School B 9-5 | National 9-5 | School A 9-4 | School B 9-4 | National 9-4 |
|---|---:|---:|---:|---:|---:|---:|
| English | {PTEBACENG_95}% | {PTEBACENG_95}% | {eng 9-5}% | {PTEBACENG_94}% | {PTEBACENG_94}% | {eng 9-4}% |
| Maths | {PTEBACMAT_95}% | {PTEBACMAT_95}% | {eng 9-5}% | {PTEBACMAT_94}% | {PTEBACMAT_94}% | {eng 9-4}% |
| Science | {PTEBAC2SCI_95}% | {PTEBAC2SCI_95}% | {eng 9-5}% | {PTEBAC2SCI_94}% | {PTEBAC2SCI_94}% | {eng 9-4}% |
| Humanities | {PTEBACHUM_95}% | {PTEBACHUM_95}% | {eng 9-5}% | {PTEBACHUM_94}% | {PTEBACHUM_94}% | {eng 9-4}% |
| Languages | {PTEBACLAN_95}% | {PTEBACLAN_95}% | {eng 9-5}% | {PTEBACLAN_94}% | {PTEBACLAN_94}% | {eng 9-4}% |
```

Hidden if all rows 0%.

#### A3.9 — Results Over Time (KS4)

```
| | School A | School B | National |
|---|---:|---:|---:|
| Attainment 8 (2023) | {ATT8SCR_PREV2} | {ATT8SCR_PREV2} | — |
| Attainment 8 (2024) | {ATT8SCR_PREV} | {ATT8SCR_PREV} | — |
| Attainment 8 (2025) | {ATT8SCR} | {ATT8SCR} | {eng ATT8SCR} |
| Progress 8 (2023) | {P8MEA_PREV2} | {P8MEA_PREV2} | 0 |
| Progress 8 (2024) | {P8MEA_PREV} | {P8MEA_PREV} | 0 |
| Progress 8 (2025) | {P8MEA} | {P8MEA} | 0 |
| Grade 5+ EM (2023) | {PTL2BASICS_95_PREV2}% | {PTL2BASICS_95_PREV2}% | — |
| Grade 5+ EM (2024) | {PTL2BASICS_95_PREV}% | {PTL2BASICS_95_PREV}% | — |
| Grade 5+ EM (2025) | {PTL2BASICS_95}% | {PTL2BASICS_95}% | {eng PTL2BASICS_95}% |
```

Rows hidden when data suppressed. For independents, only Attainment 8 rows shown.

#### A3.10 — Subjects Entered (KS4)

Per-school table: `| Subject | Qualification | Entries | Grade 7+ |`

For comparison, show two tables side by side or a combined table with School A and School B columns.

From bundled EES CSV (`subject-entries-by-urn.json`). Top 10 subjects by entries per school.

---

### Sixth-form (KS5) subsections

Shown when KS5_25 namespace present for at least one school.

#### A3.11 — A-level Attainment

```
| Category | School A | School B | National |
|---|---:|---:|---:|
| A-level students | {TALLPUP_ALEV_1618} | {TALLPUP_ALEV_1618} | — |
| Average A-level grade | {TALLPPEGRD_ALEV_1618} | {TALLPPEGRD_ALEV_1618} | {eng avgGrade} |
| Average A-level points | {TALLPPE_ALEV_1618} | {TALLPPE_ALEV_1618} | {eng avgPts} |
| Best 3 A-levels — grade | {TB3PTSE_GRD} | {TB3PTSE_GRD} | — |
```

#### A3.12 — A-level Progress

```
| Category | School A | School B | National |
|---|---:|---:|---:|
| Progress score (VA) | {VA_INS_ALEV} | {VA_INS_ALEV} | 0 |
| Progress band | {PROGRESS_BAND_ALEV} | {PROGRESS_BAND_ALEV} | — |
```

#### A3.13 — A-level Value-Added — Disadvantaged

Hidden when no disadvantaged pupils in either school.

```
| Category | School A | School B |
|---|---:|---:|
| Disadvantaged students | {TALLPUP_ALEV_1618_DIS} | {TALLPUP_ALEV_1618_DIS} |
| Average grade (disadv.) | {TALLPPEGRD_ALEV_DIS} | {TALLPPEGRD_ALEV_DIS} |
| Progress score (disadv.) | {VA_INS_ALEV_DIS} | {VA_INS_ALEV_DIS} |
```

#### A3.14 — Facilitating Subjects & Destinations

```
| Category | School A | School B | National |
|---|---:|---:|---:|
| % AAB in ≥2 facilitating subjects | {PTAAB_2FAC}% | {PTAAB_2FAC}% | — |
| % achieving advanced maths | {L3M_PER}% | {L3M_PER}% | {eng advMaths}% |
| % retained to end of course | {PT_RETAINED_ALEV_RET}% | {PT_RETAINED_ALEV_RET}% | {eng retained}% |
| % to higher education | {TOT_HEPER}% | {TOT_HEPER}% | — |
| % to any sustained destination | {ALL_PROGRESSED}% | {ALL_PROGRESSED}% | — |
```

#### A3.15 — Tech Levels & Applied General

Hidden when no data.

#### A3.16 — Results Over Time (KS5)

```
| | School A | School B | National |
|---|---:|---:|---:|
| Avg grade (2023) | {TALLPPEGRD_ALEV_1618_23} | {TALLPPEGRD_ALEV_1618_23} | — |
| Avg grade (2024) | {TALLPPEGRD_ALEV_1618_24} | {TALLPPEGRD_ALEV_1618_24} | — |
| Avg grade (2025) | {TALLPPEGRD_ALEV_1618} | {TALLPPEGRD_ALEV_1618} | {eng avgGrade} |
```

#### A3.17 — Subjects Entered (KS5)

Per-school from bundled EES CSV (`ks5-subject-entries-by-urn.json`):
`| Subject | Qualification | Entries | A–B |`

---

### A3. Observations (combined)

Heading: `## A3. Observations` · Flag: `green` if one school clearly leads on attainment + progress, `red` if one school is well below national, else `none`

One combined observation section after all A3 sub-tables. Bullet list, 4–6 bullets:
- Overall attainment — which school is stronger and by what margin
- Progress scores — direction and significance for each school
- Standout subjects — which school excels in what areas (from A3.10 / A3.17)
- Multi-year trend — improving, declining, or stable for each
- KS5: A-level grade and progress comparison if sixth forms present
- Disadvantaged/SEN gaps if notable

---

## A4. Intake & Cohort

Side-by-side: `School A | School B | National`. State schools only get FSM/EAL/SEN rates; independents get SEN only.

```
| Category | School A | School B | National |
|---|---:|---:|---:|
| Pupils on roll | {NOR} | {NOR} | ~1,000 sec / ~280 pri |
| FSM eligible (last 6 years) | {PNUMFSMEVER}% | {PNUMFSMEVER}% | ~20% sec / ~25% pri |
| EAL pupils | {PNUMEAL}% | {PNUMEAL}% | — |
| SEN support | {PSENELK}% | {PSENELK}% | ~13% |
| EHC plans | {PSENELSE}% | {PSENELSE}% | ~4.5% |
```

Independent schools: FSM near 0%, EAL hidden, Ethnicity hidden.

A deterministic analysis paragraph is appended server-side.

### A4. Observations

Heading: `## A4. Observations` · Flag: `red` if either school has FSM >35% pri/30% sec or EHC >6%, else `none`

Bullet list, 2–3 bullets:
- Compare FSM rates — which school has more disadvantaged intake
- SEN/EHC profile comparison — which school has higher learning support demand
- If one school is selective/admissions-criteria-based, note the selection effect

---

## A5. Absence & Engagement

State schools only. Hidden if no state school has absence data.

```
| Category | School A | School B | National |
|---|---:|---:|---:|
| Overall absence | {PERCTOT}% | {PERCTOT}% | 6.6% |
| Persistent absence | {PPERSABS10}% | {PPERSABS10}% | 21.3% |
```

Independent schools show `(indep)` — no DfE absence data.

A deterministic analysis paragraph is appended server-side.

### A5. Observations

Heading: `## A5. Observations` · Flag: `green` if both schools <5% overall or <15% persistent, `red` if either >8.6% or >23.3%

Bullet list, 2 bullets:
- Compare overall absence — which school has better attendance
- Persistent absence comparison — the stronger signal
- If both independent: note no DfE absence data available

---

## A6. Financial Health

State schools only. Hidden if no state school has financial data.

```
| | School A | School B | Comparator |
|---:|---:|---:|---:|
| Spend per pupil | £{x} | £{x} | £{comp} |
| In-year balance | £{x} | £{x} | — |
| QTS % | {x}% | {x}% | {comp}% |
```

Independent schools: `_Not available for independent schools._`

A deterministic analysis paragraph is appended server-side.

### A6. Observations

Heading: `## A6. Observations` · Flag: `red` if either school has in-year deficit or QTS below comparator, else `none`

Bullet list, 2–3 bullets:
- Compare spend per pupil — which school invests more
- In-year balance — flag any deficit explicitly
- QTS% and staffing comparison
- If both independent: note FBIT not available

---

## A7. Area Context

```
| | School A | School B |
|---|---:|---:|
| IMD decile (1=most deprived) | {X}/10 | {X}/10 |
| Mean household income | £{X} | £{X} |
| Median property price (~800m) | £{X} | {X} |
| % degree-level qualifications | {X}% | {X}% |
```

Hidden if neither school has area data.

### A7. Observations

Heading: `## A7. Observations` · Flag: `red` if either school has IMD 1–3 or income <£35k, else `none`

Bullet list, 2–3 bullets:
- Compare IMD deciles — which school operates in a more deprived area
- Income and property price comparison — catchment affluence gap
- Note if either school draws from a wider geography (selective/independent)

---

## Part B — Independent Research

All Part B sections are AI-generated from web search and pre-fetched data. No server-side rendering.

### Part B rules
- All sections are mandatory — do not skip any
- Run all required searches before writing any B section
- Use official school names from the pre-fetched block
- If a search returns no useful results, say so clearly rather than fabricating

---

### B1. Parent View

Heading: `## B1. Parent View` · Flag: `none`

**Data source:** Pre-fetched block — the Ofsted section of each school's Detailed School Data.

For each school, reproduce the Parent View table exactly as it appears in the pre-fetched block. Then write 2–3 sentences comparing the two schools' Parent View results.

Thresholds (⚠️ flags already in the pre-fetched table):
- Would recommend: below 80%
- Child feels safe: below 88%
- Bullying dealt with well: below 70%
- Concerns dealt with properly: below 75%

Total responses below 20 → note as too thin to rely on.

If no Parent View data for either school, output: `_No Parent View data available for either school._`

---

### B2. Admissions

Heading: `## B2. Admissions` · Flag: `none`

**Data source:** Web search results 1, 2, 3.

For each school, report:
- Entry points (Nursery, Reception, 4+, 7+, 11+, sixth form)
- Admissions criteria and oversubscription rules
- Assessment format if selective
- Sibling priority, catchment area, faith criteria
- Oversubscription ratio if published
- Next open day date and how to book

Then 1–2 sentences comparing — which school is harder to get into.

For independent schools: include fees, bursaries, scholarship details.

Never guess contact details. Only cite what appears on the school's official website.

---

### B3. Extracurricular & Clubs

Heading: `## B3. Extracurricular & Clubs` · Flag: `none`

**Data source:** Web search result 4.

For each school, report:
- Sports offered
- Arts, music, and drama
- Academic clubs and enrichment
- Other notable activities
- Approximate number of clubs if stated

1–2 sentences comparing — which school has broader opportunities.

If a child description was provided, add one sentence on fit with the child's interests.

---

### B4. What Parents Say

Heading: `## B4. What Parents Say` · Flag: `none`

**Data source:** Web search result 5 (forum/review sites).

Report positive and negative themes:
- Recurring praise for each school
- Concerns: prioritise safeguarding, SEN, staff turnover, bullying response, communication
- Flag sudden leadership changes or significant events since last Ofsted

If no substantive school-specific discussion found, say so clearly.

---

### B5. Where Pupils Go Next

Heading: `## B5. Where Pupils Go Next` · Flag: `none`

**Data source:** Pre-fetched destinations tables (A3.6, A3.11, A3.14) + web search 6 if data missing.

**Primary schools:** report top secondary schools pupils move to.

**Secondary schools:** report post-16 or university destinations. Compare the two — which has stronger outcomes.

Note clearly if no destinations data is published.

---

## Part C — Verdict & Synthesis

### C1. Head-to-Head Verdict

Heading: `## C1. Head-to-Head Verdict` · Flag: `green` if clear winner, else `none`

Table: `| Dimension | Winner | By how much |` — exactly 3 columns.

Use these dimensions (populate from Parts A and B findings):
| Dimension | Winner | By how much |
|---|---|---|
| Inspection | | |
| Academic | | |
| Intake / cohort | | |
| Absence | | |
| Financial | | |
| Admissions | | |
| Extracurricular | | |
| Destinations | | |

The final verdict paragraph goes BELOW the table, separated by a blank line. Never append it to the last table row. 3 sentences max.

---

### C2. Which Child Thrives Where

Heading: `## C2. Which Child Thrives Where` · Flag: `none`

One paragraph per school. Start with "[School A] suits a child who…" Be specific — never say "suits most children."

---

### C3. Tradeoffs

Heading: `## C3. Tradeoffs` · Flag: `none`

Bullet list, 2–3 bullets. What the parent gives up with each choice.

---

### C4. Best Next Move

Heading: `## C4. Best Next Move` · Flag: `none`

Bullet list, 3 items: Visit (open day dates or how to book), Check (admissions deadline and criteria), Compare (one or two nearby alternatives).

---

### C5. Sources

Heading: `## C5. Sources` · Flag: `none`

Two groups:
- **Primary Sources** — school websites, Ofsted/ISI PDFs, GIAS, DfE performance pages (must have real URLs)
- **Secondary Sources** — all other URLs from web search

Every source must have a live URL. Do not list a source without its URL.
