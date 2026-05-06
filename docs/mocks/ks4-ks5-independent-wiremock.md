# Independent School KS4/KS5 Wire Mock — Template Reference

Independent schools use iGCSEs so DfE performance data is sparse.
Disadvantaged/Not Disadv./EAL columns are stripped (always `—`).
Grade 5+/4+ and Progress 8 tables hidden when all data suppressed.
Post-16 destinations not published for independents (no KS4_PUPDEST_25 namespace).

**Table order for KS4:** Cohort → Attainment 8 → Grade 5+/4+ → EBacc entry by subject → Entry volumes → EBacc subject achievement → Results over time

**Legend:** `la X` = queried from EES API by LA code (derived from school postcode). `eng X` = from `NATIONAL_AVG` in govuk.js.

---

## KS4 Tables

### Cohort characteristics
*Shown first — always visible even when sparse.*

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

### Attainment 8
*Columns: All pupils \| Girls \| Boys \| Local Authority \| England*

| Metric | All pupils | Girls | Boys | LA | England |
|---|---|---|---|---|---|
| Attainment 8 score | `ATT8SCR` | `_GIRLS` | `_BOYS` | la `att8` | eng `ATT8SCR` |
| English element | `ATT8SCRENG` | suffix | suffix | la `att8Eng` | eng `ATT8_ENG` |
| Maths element | `ATT8SCRMAT` | suffix | suffix | la `att8Mat` | eng `ATT8_MAT` |
| EBacc element | `ATT8SCREBAC` | suffix | suffix | la `att8Ebacc` | eng `ATT8_EBACC` |
| Open element | `ATT8SCROPEN` | suffix | suffix | la `att8Open` | eng `ATT8_OPEN` |
| Open — GCSE only | `ATT8SCROPENG` | suffix | suffix | la `att8OpenG` | eng `ATT8_OPENG` |
| Open — non-GCSE | `ATT8SCROPENNG` | suffix | suffix | la `att8OpenNg` | eng `ATT8_OPENNG` |

### Grade 5+ and 4+ English & Maths
*Hidden when all data suppressed (0.0% — common for iGCSE schools). When shown, same column layout as Attainment 8.*

| Metric | All pupils | Girls | Boys | LA | England |
|---|---|---|---|---|---|
| % grade 5+ English & maths | `PTL2BASICS_95` | `PGL2BASICS_95` | `PBL2BASICS_95` | la `grade5Em` | eng `PTL2BASICS_95` |
| % grade 4+ English & maths | `PTL2BASICS_94` | `PGL2BASICS_94` | `PBL2BASICS_94` | la `grade4Em` | eng `PTL2BASICS_94` |

### EBacc entry by subject
| Category | All pupils |
|---|---|
| English | `PTEBACENG_E_PTQ_EE` |
| Maths | `PTEBACMAT_E_PTQ_EE` |
| Science | `PTEBAC2SCI_E_PTQ_EE` |
| Humanities | `PTEBACHUM_E_PTQ_EE` |
| Languages | `PTEBACLAN_E_PTQ_EE` |

### Entry volumes
| Category | All pupils |
|---|---|
| Avg KS4 entries per pupil | `TAVENT_E_3NG_PTQ_EE` |
| Avg KS4 entries (disadv.) | `TAVENT_E_3NG_FSM6CLA1A_PTQ_EE` |
| Avg GCSE entries per pupil | `TAVENT_G_PTQ_EE` |
| % entering multiple languages | `PTMULTILAN_E` |
| % entering triple science | `PTTRIPLESCI_E` |
| Level 2 threshold (9-4 EM) | `PT5EM_94` |
| % achieving any qualification | `PTANYQ_PTQ_EE` |

### EBacc subject achievement
*7-column format: School/LA/England for both 9-4 and 9-5.*

| Category | School 9-4 | LA 9-4 | England 9-4 | School 9-5 | LA 9-5 | England 9-5 |
|---|---|---|---|---|---|---|
| English | `PTEBACENG_94` | la `eng94` | eng `EBACC_ENG_94` | `PTEBACENG_95` | la `eng95` | eng `EBACC_ENG_95` |
| Maths | `PTEBACMAT_94` | la `mat94` | eng `EBACC_MAT_94` | `PTEBACMAT_95` | la `mat95` | eng `EBACC_MAT_95` |
| Science | `PTEBAC2SCI_94` | la `sci94` | eng `EBACC_SCI_94` | `PTEBAC2SCI_95` | la `sci95` | eng `EBACC_SCI_95` |
| Humanities | `PTEBACHUM_94` | la `hum94` | eng `EBACC_HUM_94` | `PTEBACHUM_95` | la `hum95` | eng `EBACC_HUM_95` |
| Languages | `PTEBACLAN_94` | la `lan94` | eng `EBACC_LAN_94` | `PTEBACLAN_95` | la `lan95` | eng `EBACC_LAN_95` |

### Results over time
*LA row shown for each metric. 3-year data from EES multi-period query.*

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

---

## KS5 Tables

### A-level attainment
| Category | All pupils | England |
|---|---|---|
| Total 16–18 students | `TALLPUP_1618` | — |
| A-level students | `TALLPUP_ALEV_1618` | — |
| Average A-level grade | `TALLPPEGRD_ALEV_1618` | eng `avgGrade` |
| Average A-level points | `TALLPPE_ALEV_1618` | eng `avgPts` |
| Best 3 A-levels — grade | `TB3PTSE_GRD` | — |
| Best 3 A-levels — points | `TB3PTSE` | — |

### A-level progress
| Category | All pupils | England |
|---|---|---|
| Progress score (VA) | `VA_INS_ALEV` (CI: `LCI_INS_ALEV` to `UCI_INS_ALEV`) | 0 |
| Progress band | `PROGRESS_BAND_ALEV` | — |

### A-level value-added — disadvantaged
*Hidden when no disadvantaged pupils (common for independents).*

| Category | All pupils |
|---|---|
| Disadvantaged students | `TALLPUP_ALEV_1618_DIS` |
| Average grade (disadvantaged) | `TALLPPEGRD_ALEV_DIS` |
| Average points (disadvantaged) | `TALLPPE_ALEV_1618_DIS` |
| Progress score (disadvantaged) | `VA_INS_ALEV_DIS` (CI: `LCI_INS_ALEV_DIS` to `UCI_INS_ALEV_DIS`) |

### Facilitating subjects & destinations
| Category | All pupils | England |
|---|---|---|
| % AAB in ≥2 facilitating subjects | `PTAAB_2FAC` | — |
| % achieving advanced maths | `L3M_PER` | eng `advMaths` |
| % retained to end of course | `PT_RETAINED_ALEV_RET` | eng `retained` |
| % to higher education | `TOT_HEPER` | — |
| % to any sustained destination | `ALL_PROGRESSED` | — |

### Tech levels & T-levels / Applied general
*Hidden when no data (common for independents).*

### Results over time
| | 2022 final | 2023 final | 2024 final | 2025 final |
|---|---|---|---|---|
| Average grade | `TALLPPEGRD_ALEV_1618_22` | `TALLPPEGRD_ALEV_1618_23` | `TALLPPEGRD_ALEV_1618_24` | `TALLPPEGRD_ALEV_1618` |
| Average points | `TALLPPE_ALEV_1618_22` | `TALLPPE_ALEV_1618_23` | `TALLPPE_ALEV_1618_24` | `TALLPPE_ALEV_1618` |
| VA score | `VA_INS_ALEV_22` | `VA_INS_ALEV_23` | `VA_INS_ALEV_24` | `VA_INS_ALEV` |

---

## Data sources

### LA comparisons (EES API)
Dataset `b3e19901-5d2b-b676-bb4c-e60937d74725` (KS4) queried by LA ONS code derived from school postcode. Multi-year queries for Results over time. 14 indicators mapped.

### England national averages (`NATIONAL_AVG`)
- **KS4**: ATT8SCR, PTL2BASICS_95, PTL2BASICS_94, PTEBACC_E_PTQ_EE, PTEBACC_94, PTEBACC_95, per-subject EBacc at grades 5+/4+, A8 element breakdowns
- **KS5**: avgGrade, avgPts, retained, advMaths

### Tables hidden for independent schools
- **Grade 5+/4+ English & Maths**: hidden when PTL2BASICS_94/95 are 0.0% (iGCSE schools)
- **Progress 8**: never published for independent schools
- **Post-16 destinations**: KS4_PUPDEST_25 namespace not present for independent schools
- **A-level disadvantaged**: hidden when no disadvantaged students
- **Tech levels / Applied general**: hidden when no data
- **Disadvantaged / Not Disadv. / EAL columns**: stripped from all tables via `indCols()` filter
