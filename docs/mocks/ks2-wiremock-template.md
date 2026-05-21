# KS2 Wire Mock — Template Reference

State primary/junior schools with KS2 performance data. Also covers KS1+KS2 combined (state primary ages 3–11) — KS1 has no DfE data.

**Legend:** `la X` = from EES API by LA code. `eng X` = from `NATIONAL_AVG.KS2`. `—` = suppressed by DfE.

---

## A1. School Identity

```
**School:** {officialName} · URN {urn} · {type} · {phase} (ages {ageLow}–{ageHigh}) · LA: {la} · {postcode} · {gender} · {religion} · admissions: {admissions} · capacity: {capacity} ({nor} on roll — {fillRate}% full)
```
**Links:** GIAS · Compare School Performance · FBIT · Ofsted

Religion/admissions/capacity hidden when not applicable.

---

## A2. Inspection Outcomes (Ofsted)

```
- Overall: **{grade}** ({date})
- Quality of Education: {grade}
- Behaviour and Attitudes: {grade}
- Personal Development: {grade}
- Leadership and Management: {grade}
- Parent View: {url} _(data not retrieved)_
- [Full report: {pdfUrl}]
```

**What it's like to be a pupil**
Ofsted PDF narrative, first ~800 chars, truncated with link to full PDF.

**What the School Needs to Improve**
Verbatim from Ofsted next steps. Fallback: `_No improvement requirements stated._`

No Observations — the text speaks for itself.

### A2. Observations

Heading: `## A2. Observations` · Flag: `green` if Outstanding/Exceptional, `red` if RI/Inadequate, else `none`

Bullet list, 3–4 bullets:
- Overall grade and what it means for quality
- Any sub-grade weaker than the overall — call it out
- Inspection recency — stale if >5 years
- Pupil experience highlights from the narrative

---

## A3. Academic Performance

### A3.1 — Cohort

| Category | All pupils | Girls | Boys | Disadvantaged | Not Disadv. | EAL | Local Authority | England |
|---|---|---|---|---|---|---|---|---|
| Eligible cohort | `TELIG` | `GELIG` | `BELIG` | `TFSM6CLA1A` | `TNOTFSM6CLA1A` | `TEALGRP2` | — | — |

### A3.2 — Attainment (RWM)

| Category | All pupils | Girls | Boys | Disadvantaged | Not Disadv. | EAL | Local Authority | England |
|---|---|---|---|---|---|---|---|---|
| % meeting expected standard (RWM) | `PTRWM_EXP` | `PTRWM_EXP_G` | `PTRWM_EXP_B` | `PTRWM_EXP_FSM6CLA1A` | `PTRWM_EXP_NOTFSM6CLA1A` | `PTRWM_EXP_EAL` | la `rwm.expected` | eng `PTRWM_EXP` |
| % achieving higher standard (RWM) | `PTRWM_HIGH` | `PTRWM_HIGH_G` | `PTRWM_HIGH_B` | `PTRWM_HIGH_FSM6CLA1A` | `PTRWM_HIGH_NOTFSM6CLA1A` | `PTRWM_HIGH_EAL` | la `rwm.higher` | eng `PTRWM_HIGH` |

### A3.3 — Scaled Scores

| Category | All pupils | Girls | Boys | Disadvantaged | Not Disadv. | EAL | Local Authority | England |
|---|---|---|---|---|---|---|---|---|
| Reading — average scaled score | `READ_AVERAGE` | `READ_AVERAGE_G` | `READ_AVERAGE_B` | `READ_AVERAGE_FSM6CLA1A` | `READ_AVERAGE_NOTFSM6CLA1A` | `READ_AVERAGE_EAL` | la `reading.avgScore` | 105 |
| Maths — average scaled score | `MAT_AVERAGE` | `MAT_AVERAGE_G` | `MAT_AVERAGE_B` | `MAT_AVERAGE_FSM6CLA1A` | `MAT_AVERAGE_NOTFSM6CLA1A` | `MAT_AVERAGE_EAL` | la `maths.avgScore` | 104 |
| GPS — average scaled score | `GPS_AVERAGE` | `GPS_AVERAGE_G` | `GPS_AVERAGE_B` | `GPS_AVERAGE_FSM6CLA1A` | `GPS_AVERAGE_NOTFSM6CLA1A` | `GPS_AVERAGE_EAL` | la `gps.avgScore` | 105 |

### A3.4 — Per-subject Attainment: Expected Standard

| Category | All pupils | Disadv. | Not Disadv. | LA | England |
|---|---|---|---|---|---|
| Reading | `PTREAD_EXP` | `PTREAD_EXP_FSM6CLA1A` | `PTREAD_EXP_NOTFSM6CLA1A` | la `reading.expected` | eng `PTREAD_EXP` |
| Writing (TA) | `PTWRITTA_EXP` | `PTWRITTA_EXP_FSM6CLA1A` | `PTWRITTA_EXP_NOTFSM6CLA1A` | la `writing.expected` | eng `PTWRITTA_EXP` |
| Maths | `PTMAT_EXP` | `PTMAT_EXP_FSM6CLA1A` | `PTMAT_EXP_NOTFSM6CLA1A` | la `maths.expected` | eng `PTMAT_EXP` |
| GPS | `PTGPS_EXP` | `PTGPS_EXP_FSM6CLA1A` | `PTGPS_EXP_NOTFSM6CLA1A` | la `gps.expected` | eng `PTGPS_EXP` |
| Science (TA) | `PTSCITA_EXP` | — | — | la `science.expected` | eng `PTSCITA_EXP` |

### A3.5 — Per-subject Attainment: Higher Standard

| Category | All pupils | Disadv. | Not Disadv. | LA | England |
|---|---|---|---|---|---|
| Reading | `PTREAD_HIGH` | `PTREAD_HIGH_FSM6CLA1A` | `PTREAD_HIGH_NOTFSM6CLA1A` | la `reading.higher` | eng `PTREAD_HIGH` |
| Writing (TA) | `PTWRITTA_HIGH` | `PTWRITTA_HIGH_FSM6CLA1A` | `PTWRITTA_HIGH_NOTFSM6CLA1A` | la `writing.higher` | eng `PTWRITTA_HIGH` |
| Maths | `PTMAT_HIGH` | `PTMAT_HIGH_FSM6CLA1A` | `PTMAT_HIGH_NOTFSM6CLA1A` | la `maths.higher` | eng `PTMAT_HIGH` |
| GPS | `PTGPS_HIGH` | `PTGPS_HIGH_FSM6CLA1A` | `PTGPS_HIGH_NOTFSM6CLA1A` | la `gps.higher` | eng `PTGPS_HIGH` |

### A3.6 — Cohort Characteristics

| Category | All pupils |
|---|---|
| % disadvantaged | `PTFSM6CLA1A` |
| % not disadvantaged | `PTNOTFSM6CLA1A` |
| % EAL | `PTEALGRP2` |
| % non-mobile | `PTMOBN` |
| % SEN with EHC plan | `PSENELE` |
| % SEN support | `PSENELK` |
| % SEN total (EHC + support) | `PSENELEK` |

### A3.7 — Disadvantage Gap

| Category | All pupils |
|---|---|
| RWM expected — gap vs national (pp) | `DIFFN_RWM_EXP` |
| RWM higher — gap vs national (pp) | `DIFFN_RWM_HIGH` |

### A3.8 — Test Participation

| Category | All pupils |
|---|---|
| Reading — % absent from test | `PTREAD_AT` |
| Maths — % absent from test | `PTMAT_AT` |
| GPS — % absent from test | `PTGPS_AT` |
| Writing — % working towards expected | `PTWRITTA_WTS` |
| Writing — % absent/disapplied | `PTWRITTA_AD` |
| Science — % absent/disapplied | `PTSCITA_AD` |

Rows hidden when 0% (DfE-suppressed).

### A3.9 — Progress (KS1 to KS2)

| Progress Scores | Score | Banding | Confidence Interval |
|---|---|---|---|
| Reading | `READPROG_23` | `READPROG_DESCR_23` | `READPROG_LOWER_23` to `READPROG_UPPER_23` |
| Writing | `WRITPROG_23` | `WRITPROG_DESCR_23` | `WRITPROG_LOWER_23` to `WRITPROG_UPPER_23` |
| Maths | `MATPROG_23` | `MATPROG_DESCR_23` | `MATPROG_LOWER_23` to `MATPROG_UPPER_23` |

### A3.10 — Results Over Time

**Expected Standard in RWM**
| | 2023 final | 2024 final | 2025 final |
|---|---|---|---|
| School | `PTRWM_EXP_23` | `PTRWM_EXP_24` | `PTRWM_EXP` |
| Local Authority | — | — | la `rwm.expected` |
| England | 60% | 61% | 62% |

**Higher Standard in RWM**
| | 2023 final | 2024 final | 2025 final |
|---|---|---|---|
| School | `PTRWM_HIGH_23` | `PTRWM_HIGH_24` | `PTRWM_HIGH` |
| Local Authority | — | — | la `rwm.higher` |
| England | 8% | 8% | 8% |

**Average Score in Reading**
| | 2023 final | 2024 final | 2025 final |
|---|---|---|---|
| School | `READ_AVERAGE_23` | `READ_AVERAGE_24` | `READ_AVERAGE` |
| Local Authority | — | — | la `reading.avgScore` |
| England | 105 | 105 | 105 |

**Average Score in Maths**
| | 2023 final | 2024 final | 2025 final |
|---|---|---|---|
| School | `MAT_AVERAGE_23` | `MAT_AVERAGE_24` | `MAT_AVERAGE` |
| Local Authority | — | — | la `maths.avgScore` |
| England | 104 | 104 | 104 |

### A3. Observations

Heading: `## A3. Observations` · Flag: `green` if Attainment 8 >national+10, P8 >0.5, or RWM >national+10; `red` if below by same margins

Bullet list, 3–4 bullets:
- Overall attainment vs national and LA benchmarks
- Progress scores if present — direction and significance
- Multi-year trend if notable (check A3.10 table)
- Cohort size caveat if below 30 pupils

---

## A4. Intake & Cohort — Pupil Census (DfE)

### Pupil numbers
| Category | School | National avg |
|---|---:|---:|
| Pupils on roll | `NOR` | ~280 primary / ~1,000 secondary |
| FSM eligible (last 6 years) | `PNUMFSMEVER`% | ~25% primary / ~20% secondary |
| EAL pupils | `PNUMEAL`% | — |
| SEN support | `PSENELK`% | ~13% |
| EHC plans | `PSENELSE`% | ~4.5% |

### SEN & Inclusion
Auto-generated paragraph based on SEN support + EHC plan % vs national ~17.5% combined.

### Ethnicity
| Ethnic group | % of pupils |
|---|---:|
| White | `schoolEthnicity.w`% |
| Mixed | `schoolEthnicity.m`% |
| Asian | `schoolEthnicity.a`% |
| Black | `schoolEthnicity.b`% |
| Chinese | `schoolEthnicity.c`% |
| Other | `schoolEthnicity.o`% |
| Not stated | `schoolEthnicity.ns`% |

Hidden entirely if all groups are 0%.

### A4. Observations

Heading: `## A4. Observations` · Flag: `red` if FSM >35% primary/30% secondary or EHC >6%, else `none`

Bullet list, 2–3 bullets:
- FSM rate vs national — what it says about intake
- SEN/EHC profile — well-resourced or capacity concern?
- School ethnicity vs area ethnicity gap if notable

---

## A5. Absence & Engagement (DfE)

| Category | School | National avg |
|---|---:|---:|
| Overall absence | `PERCTOT`% | 6.6% |
| Persistent absence | `PPERSABS10`% | 21.3% |

### A5. Observations

Heading: `## A5. Observations` · Flag: `green` if <5% overall or <15% persistent, `red` if >8.6% or >23.3%

Bullet list, 2 bullets:
- Overall absence vs national — gap matters >2pp
- Persistent absence — the stronger signal

---

## A6. Financial Health

### Financial Benchmarking (FBIT)

**Summary:**
```
- In-year balance: £{inYearBalance}
- Revenue reserve: £{revenueReserve}
- Total spend per pupil (excl. premises): £{totalSpendPerPupil}/pupil (comparator avg: £{comparatorTotalPerPupil}/pupil)
- Pupil:teacher ratio: {ptr}:1
- Total workforce FTE: {workforceFte}
- Teachers FTE: {teachersFte}
- Senior leadership FTE: {sltFte}
- Teaching assistants FTE: {taFte}
- % teachers with Qualified Teacher Status (QTS): {qts}% (comparator set avg: {comparatorQts}%)
```

**Spending per pupil vs similar schools**
8 categories, each: `- {category}: £{school}/pupil | avg £{comparator}/pupil | £{diff} more/less than avg | {pctDiff}%`

### A6. Observations

Heading: `## A6. Observations` · Flag: `red` if in-year deficit or QTS below comparator avg, else `none`

Bullet list, 2–3 bullets:
- Spend per pupil vs comparator
- In-year balance — flag deficit explicitly
- QTS% and staffing stability

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

### A7. Observations

Heading: `## A7. Observations` · Flag: `red` if IMD 1–3 or income <£35k, else `none`

Bullet list, 2–3 bullets:
- IMD decile and what it means for intake
- Income profile — affluent, mixed, or deprived catchment
- School FSM vs area deprivation — divergence suggests selection or outreach
