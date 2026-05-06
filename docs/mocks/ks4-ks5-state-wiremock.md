# State Secondary KS4/KS5 Wire Mock — Template Reference

State secondary schools have full DfE performance data with all subgroup breakdowns.
Compare with `ks4-ks5-independent-wiremock.md` — independents strip Disadv/EAL columns
and hide Progress 8, post-16 destinations, and Grade 5+/4+ when iGCSE-suppressed.

**Table order for KS4:** Attainment 8 → Progress 8 → Cohort → Grade 5+/4+ → EBacc entry → Post-16 destinations → Entry volumes → Results over time → Subjects entered

**Legend:** `la X` = EES API by LA code. `eng X` = `NATIONAL_AVG` in govuk.js.

---

## KS4 Tables

### Attainment 8
*Columns: All pupils | Girls | Boys | Disadvantaged | Not Disadv. | EAL | Local Authority | England*

| Metric | All | Girls | Boys | Disadv. | Not Disadv. | EAL | LA | England |
|---|---|---|---|---|---|---|---|---|---|
| Attainment 8 score | `ATT8SCR` | `_GIRLS` | `_BOYS` | `_DIS` | `_NOTDIS` | `_EAL` | la `att8` | eng `ATT8SCR` |
| English element | `ATT8SCRENG` | suffix | suffix | suffix | suffix | suffix | la `att8Eng` | eng `ATT8_ENG` |
| Maths element | `ATT8SCRMAT` | suffix | suffix | suffix | suffix | suffix | la `att8Mat` | eng `ATT8_MAT` |
| EBacc element | `ATT8SCREBAC` | suffix | suffix | suffix | suffix | suffix | la `att8Ebacc` | eng `ATT8_EBACC` |
| Open element | `ATT8SCROPEN` | suffix | suffix | suffix | suffix | suffix | la `att8Open` | eng `ATT8_OPEN` |
| Open — GCSE only | `ATT8SCROPENG` | suffix | suffix | suffix | suffix | suffix | la `att8OpenG` | eng `ATT8_OPENG` |
| Open — non-GCSE | `ATT8SCROPENNG` | suffix | suffix | suffix | suffix | suffix | la `att8OpenNg` | eng `ATT8_OPENNG` |

### Progress 8
*Columns: same 8-column layout as Attainment 8.*

| Metric | All | Girls | Boys | Disadv. | Not Disadv. | EAL | LA | England |
|---|---|---|---|---|---|---|---|---|---|
| Progress 8 score | `P8MEA` | `_GIRLS` | `_BOYS` | `_DIS` | `_NOTDIS` | `_EAL` | la `p8` | 0.00 |

### Cohort characteristics
*Single value column — no subgroup breakdowns.*

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

### Grade 5+ and 4+ English & Maths
*Columns: same 8-column layout as Attainment 8.*

| Metric | All | Girls | Boys | Disadv. | Not Disadv. | EAL | LA | England |
|---|---|---|---|---|---|---|---|---|---|
| % grade 5+ English & maths | `PTL2BASICS_95` | `_GIRLS` | `_BOYS` | `PTFSM6CLA1ABASICS_95` | `PTNOTFSM6CLA1ABASICS_95` | `PTL2BASICSEAL_95` | la `grade5Em` | eng `PTL2BASICS_95` |
| % grade 4+ English & maths | `PTL2BASICS_94` | `_GIRLS` | `_BOYS` | `PTFSM6CLA1ABASICS_94` | `PTNOTFSM6CLA1ABASICS_94` | `PTL2BASICSEAL_94` | la `grade4Em` | eng `PTL2BASICS_94` |

### EBacc entry by subject
*Columns: All pupils | Local Authority. No gender/disadvantage breakdown.*

| Category | All pupils | LA |
|---|---|---|
| English | `PTEBACENG_E_PTQ_EE` | la `ebEeng` |
| Maths | `PTEBACMAT_E_PTQ_EE` | la `ebEmat` |
| Science | `PTEBAC2SCI_E_PTQ_EE` | la `ebEsci` |
| Humanities | `PTEBACHUM_E_PTQ_EE` | la `ebEhum` |
| Languages | `PTEBACLAN_E_PTQ_EE` | la `ebElan` |

### Post-16 destinations (2023 leavers)
*KS4_PUPDEST_25 namespace. Columns: All pupils | Local Authority.*

| Category | All pupils | LA |
|---|---|---|
| % sustained education or employment | `OVERALL_DESTPER` | la `destOver` |
| % in education | `EDUCATIONPER` | la `destEdu` |
| % sixth form college | `SIXTH_COLPER` | |
| % further education | `FEPER` | |
| % apprenticeships | `APPRENPER` | |
| % employment | `EMPLOYMENTPER` | |
| % not sustained | `NOT_SUSTAINEDPER` | |

### Entry volumes
*Single value column.*

| Category | All pupils |
|---|---|
| Avg KS4 entries per pupil | `TAVENT_E_3NG_PTQ_EE` |
| Avg KS4 entries (disadv.) | `TAVENT_E_3NG_FSM6CLA1A_PTQ_EE` |
| Avg GCSE entries per pupil | `TAVENT_G_PTQ_EE` |
| % entering multiple languages | `PTMULTILAN_E` |
| % entering triple science | `PTTRIPLESCI_E` |
| Level 2 threshold (9-4 EM) | `PT5EM_94` |
| % achieving any qualification | `PTANYQ_PTQ_EE` |

### Results over time
*LA row shown for each metric. EES API queried for 3 years per LA.*

| | 2023 | 2024 | 2025 |
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

### Subjects entered (KS4)
*From bundled EES CSV. 4 columns. Grade 7+ = A/A*/B equivalent.*

| Subject | Qualification | Entries | Grade 7+ |
|---|---:|---:|---:|
| (per-school, sorted by entries desc) | | | |

---

## KS5 Tables

### A-level attainment
*Columns: All pupils | England.*

| Category | All pupils | England |
|---|---|---|
| Total 16–18 students | `TALLPUP_1618` | — |
| A-level students | `TALLPUP_ALEV_1618` | — |
| Average A-level grade | `TALLPPEGRD_ALEV_1618` | eng `avgGrade` |
| Average A-level points | `TALLPPE_ALEV_1618` | eng `avgPts` |
| Best 3 A-levels — grade | `TB3PTSE_GRD` | — |
| Best 3 A-levels — points | `TB3PTSE` | — |

### A-level progress
*Columns: All pupils | England.*

| Category | All pupils | England |
|---|---|---|
| Progress score (VA) | `VA_INS_ALEV` (CI: `LCI_INS_ALEV` to `UCI_INS_ALEV`) | 0 |
| Progress band | `PROGRESS_BAND_ALEV` | — |

### A-level value-added — disadvantaged
*Hidden when no disadvantaged pupils.*

| Category | All pupils |
|---|---|
| Disadvantaged students | `TALLPUP_ALEV_1618_DIS` |
| Average grade (disadvantaged) | `TALLPPEGRD_ALEV_DIS` |
| Average points (disadvantaged) | `TALLPPE_ALEV_1618_DIS` |
| Progress score (disadvantaged) | `VA_INS_ALEV_DIS` (CI: `LCI_INS_ALEV_DIS` to `UCI_INS_ALEV_DIS`) |

### Facilitating subjects & destinations
*Columns: All pupils | England.*

| Category | All pupils | England |
|---|---|---|
| % AAB in ≥2 facilitating subjects | `PTAAB_2FAC` | — |
| % achieving advanced maths | `L3M_PER` | eng `advMaths` |
| % retained to end of course | `PT_RETAINED_ALEV_RET` | eng `retained` |
| % to higher education | `TOT_HEPER` | — |
| % to any sustained destination | `ALL_PROGRESSED` | — |

### Tech levels & T-levels / Applied general
*Hidden when no data.*

### Results over time
| | 2022 | 2023 | 2024 | 2025 |
|---|---|---|---|---|
| Average grade | `TALLPPEGRD_ALEV_1618_22` | `TALLPPEGRD_ALEV_1618_23` | `TALLPPEGRD_ALEV_1618_24` | `TALLPPEGRD_ALEV_1618` |
| Average points | `TALLPPE_ALEV_1618_22` | `TALLPPE_ALEV_1618_23` | `TALLPPE_ALEV_1618_24` | `TALLPPE_ALEV_1618` |
| VA score | `VA_INS_ALEV_22` | `VA_INS_ALEV_23` | `VA_INS_ALEV_24` | `VA_INS_ALEV` |

### A-level / Level 3 subjects entered
*From bundled EES CSV. 4 columns. A–B = A-level equivalent of grade 7+.*

| Subject | Qualification | Entries | A–B |
|---|---:|---:|---:|
| (per-school, sorted by entries desc) | | | |

---

## Column codes

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
| `all` | All pupils (single column only — no subgroup breakdown) |

`indCols()` strips `d`, `n`, `e` for independent schools.

## Differences from independent schools

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
