# State Secondary KS4/KS5 Wire Mock — Template Reference

State secondary schools with sixth form have full DfE KS4 + KS5 performance data.
KS4-only (no sixth form) omits KS5 sub-sections (A3.11–A3.17).

**Legend:** `la X` = from EES API by LA code. `eng X` = from `NATIONAL_AVG`. `—` = suppressed.

---

## A1. School Identity

```
**School:** {officialName} · URN {urn} · {type} · {phase} (ages {ageLow}–{ageHigh}) · LA: {la} · {postcode} · {gender} · {religion} · admissions: {admissions} · capacity: {capacity} ({nor} on roll — {fillRate}% full)
```
**Links:** GIAS · Compare School Performance · FBIT · Ofsted

---

## A2. Inspection Outcomes (Ofsted)

```
- Overall: **{grade}** ({date})
- Quality of Education: {grade}
- Behaviour and Attitudes: {grade}
- Personal Development: {grade}
- Leadership and Management: {grade}
- [Sixth form provision: {grade}] — if sixth form present
- Parent View: {url} _(data not retrieved)_
```

**What it's like to be a pupil**
Ofsted PDF narrative, first ~800 chars, truncated with link to full PDF.

**What the School Needs to Improve**
Verbatim from Ofsted next steps. Fallback: `_No improvement requirements stated._`

---

## A3. Academic Performance

### Key Stage 4

#### A3.1 — Attainment 8

Columns: All pupils | Girls | Boys | Disadvantaged | Not Disadv. | EAL | Local Authority | England

| Metric | All | Girls | Boys | Disadv. | Not Disadv. | EAL | LA | England |
|---|---|---|---|---|---|---|---|---|
| Attainment 8 score | `ATT8SCR` | `_GIRLS` | `_BOYS` | `_DIS` | `_NOTDIS` | `_EAL` | la `att8` | eng `ATT8SCR` |
| English element | `ATT8SCRENG` | `_GIRLS` | `_BOYS` | `_DIS` | `_NOTDIS` | `_EAL` | la `att8Eng` | eng `ATT8_ENG` |
| Maths element | `ATT8SCRMAT` | `_GIRLS` | `_BOYS` | `_DIS` | `_NOTDIS` | `_EAL` | la `att8Mat` | eng `ATT8_MAT` |
| EBacc element | `ATT8SCREBAC` | `_GIRLS` | `_BOYS` | `_DIS` | `_NOTDIS` | `_EAL` | la `att8Ebacc` | eng `ATT8_EBACC` |
| Open element | `ATT8SCROPEN` | `_GIRLS` | `_BOYS` | `_DIS` | `_NOTDIS` | `_EAL` | la `att8Open` | eng `ATT8_OPEN` |
| Open — GCSE only | `ATT8SCROPENG` | `_GIRLS` | `_BOYS` | `_DIS` | `_NOTDIS` | `_EAL` | la `att8OpenG` | eng `ATT8_OPENG` |
| Open — non-GCSE | `ATT8SCROPENNG` | `_GIRLS` | `_BOYS` | `_DIS` | `_NOTDIS` | `_EAL` | la `att8OpenNg` | eng `ATT8_OPENNG` |

#### A3.2 — Progress 8

| Metric | All | Girls | Boys | Disadv. | Not Disadv. | EAL | LA | England |
|---|---|---|---|---|---|---|---|---|
| Progress 8 score | `P8MEA` | `_GIRLS` | `_BOYS` | `_DIS` | `_NOTDIS` | `_EAL` | la `p8` | 0.00 |

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

#### A3.4 — Grade 5+ and 4+ English & Maths

| Metric | All | Girls | Boys | Disadv. | Not Disadv. | EAL | LA | England |
|---|---|---|---|---|---|---|---|---|
| % grade 5+ English & maths | `PTL2BASICS_95` | `_GIRLS` | `_BOYS` | `PTFSM6CLA1ABASICS_95` | `PTNOTFSM6CLA1ABASICS_95` | `PTL2BASICSEAL_95` | la `grade5Em` | eng `PTL2BASICS_95` |
| % grade 4+ English & maths | `PTL2BASICS_94` | `_GIRLS` | `_BOYS` | `PTFSM6CLA1ABASICS_94` | `PTNOTFSM6CLA1ABASICS_94` | `PTL2BASICSEAL_94` | la `grade4Em` | eng `PTL2BASICS_94` |

#### A3.5 — EBacc Entry by Subject

| Category | All pupils | LA |
|---|---|---|
| English | `PTEBACENG_E_PTQ_EE` | la `ebEeng` |
| Maths | `PTEBACMAT_E_PTQ_EE` | la `ebEmat` |
| Science | `PTEBAC2SCI_E_PTQ_EE` | la `ebEsci` |
| Humanities | `PTEBACHUM_E_PTQ_EE` | la `ebEhum` |
| Languages | `PTEBACLAN_E_PTQ_EE` | la `ebElan` |

#### A3.6 — Post-16 Destinations (2023 leavers)

| Category | All pupils | LA |
|---|---|---|
| % sustained education or employment | `OVERALL_DESTPER` | la `destOver` |
| % in education | `EDUCATIONPER` | la `destEdu` |
| % sixth form college | `SIXTH_COLPER` | |
| % further education | `FEPER` | |
| % apprenticeships | `APPRENPER` | |
| % employment | `EMPLOYMENTPER` | |
| % not sustained | `NOT_SUSTAINEDPER` | |

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

#### A3.9 — Results Over Time (KS4)

| | 2023 final | 2024 final | 2025 final |
|---|---|---|---|
| Attainment 8 Score | `ATT8SCR_PREV2` | `ATT8SCR_PREV` | `ATT8SCR` |
| Local Authority | la `att8.yr23` | la `att8.yr24` | la `att8.yr25` |
| Progress 8 Score | `P8MEA_PREV2` | `P8MEA_PREV` | `P8MEA` |
| Local Authority | la `p8.yr23` | la `p8.yr24` | la `p8.yr25` |
| Grade 5+ English & Maths | `PTL2BASICS_95_PREV2` | `PTL2BASICS_95_PREV` | `PTL2BASICS_95` |
| Local Authority | la `grade5Em.yr23` | la `grade5Em.yr24` | la `grade5Em.yr25` |
| Grade 4+ English & Maths | `PTL2BASICS_94_PREV2` | `PTL2BASICS_94_PREV` | `PTL2BASICS_94` |
| Local Authority | la `grade4Em.yr23` | la `grade4Em.yr24` | la `grade4Em.yr25` |
| EBacc Entry | `PTEBACC_E_PTQ_EE_PREV2` | `PTEBACC_E_PTQ_EE_PREV` | `PTEBACC_E_PTQ_EE` |
| Local Authority | la `ebaccEntry.yr23` | la `ebaccEntry.yr24` | la `ebaccEntry.yr25` |

#### A3.10 — Subjects Entered (KS4)

| Subject | Qualification | Entries | Grade 7+ |
|---|---|---|---|
| (per-school, sorted by entries desc) | | | |

From bundled EES CSV (`subject-entries-by-urn.json`). Grade 7+ = A/A* equivalent.

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

Hidden when no disadvantaged pupils.

| Category | All pupils |
|---|---|
| Disadvantaged students | `TALLPUP_ALEV_1618_DIS` |
| Average grade (disadvantaged) | `TALLPPEGRD_ALEV_DIS` |
| Average points (disadvantaged) | `TALLPPE_ALEV_1618_DIS` |
| Progress score (disadvantaged) | `VA_INS_ALEV_DIS` (CI: `LCI_INS_ALEV_DIS` to `UCI_INS_ALEV_DIS`) |

#### A3.14 — Facilitating Subjects & Destinations

| Category | All pupils | England |
|---|---|---|
| % AAB in ≥2 facilitating subjects | `PTAAB_2FAC` | — |
| % achieving advanced maths | `L3M_PER` | eng `advMaths` |
| % retained to end of course | `PT_RETAINED_ALEV_RET` | eng `retained` |
| % to higher education | `TOT_HEPER` | — |
| % to any sustained destination | `ALL_PROGRESSED` | — |

#### A3.15 — Tech Levels & T-levels / Applied General

Hidden when no data.

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

From bundled EES CSV (`ks5-subject-entries-by-urn.json`). A–B = A-level equivalent of grade 7+.

---

## A4. Intake & Cohort — Pupil Census (DfE)

### Pupil numbers
| Category | School | National avg |
|---|---:|---:|
| Pupils on roll | `NOR` | ~1,000 secondary |
| FSM eligible (last 6 years) | `PNUMFSMEVER`% | ~20% secondary |
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

---

## A5. Absence & Engagement (DfE)

| Category | School | National avg |
|---|---:|---:|
| Overall absence | `PERCTOT`% | 6.6% |
| Persistent absence | `PPERSABS10`% | 21.3% |

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

---

## Column codes (for A3 tables)

| Code | Columns |
|---|---|
| `a` | All pupils |
| `b` | Boys |
| `g` | Girls |
| `d` | Disadvantaged |
| `n` | Not disadvantaged |
| `e` | EAL |
| `l` | Local Authority |
| `E` | England |

## State vs Independent differences (for A3)

| Section | State | Independent |
|---|---|---|
| Attainment 8 | 8 columns (abgdnelE) | 5 columns (abg...lE) |
| Progress 8 | Always shown | Always hidden |
| Grade 5+/4+ | 8 columns | Hidden if iGCSE (0.0%) |
| Post-16 destinations | Always shown | Always hidden |
| EBacc entry | 2 columns (al) | 2 columns (al) |
| Cohort | Single column (a) | Single column (a) |
| Entry volumes | Single column (a) | Single column (a) |
| Subjects entered | 4 columns with Grade 7+ | 4 columns with Grade 7+ |
| KS5 subjects | 4 columns with A–B | 4 columns with A–B |
