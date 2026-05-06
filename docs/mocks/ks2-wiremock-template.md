# KS2 Wire Mock — Template Reference

All tables use `| Category |` as the first column header.
Columns are: All pupils, Girls, Boys, Disadvantaged, Not Disadv., EAL, Local Authority, England.
`—` = suppressed or not published by DfE for that subgroup.

---

## Table 1 — Cohort

| Category | All pupils | Girls | Boys | Disadvantaged | Not Disadv. | EAL | Local Authority | England |
|---|---|---|---|---|---|---|---|---|
| Eligible cohort | `TELIG` | `GELIG` | `BELIG` | `TFSM6CLA1A` | `TNOTFSM6CLA1A` | `TEALGRP2` | — | — |

---

## Table 2 — Attainment (RWM)

| Category | All pupils | Girls | Boys | Disadvantaged | Not Disadv. | EAL | Local Authority | England |
|---|---|---|---|---|---|---|---|---|
| % meeting expected standard (RWM) | `PTRWM_EXP` | `PTRWM_EXP_G` | `PTRWM_EXP_B` | `PTRWM_EXP_FSM6CLA1A` | `PTRWM_EXP_NOTFSM6CLA1A` | `PTRWM_EXP_EAL` | la `rwm.expected` | eng `PTRWM_EXP` |
| % achieving higher standard (RWM) | `PTRWM_HIGH` | `PTRWM_HIGH_G` | `PTRWM_HIGH_B` | `PTRWM_HIGH_FSM6CLA1A` | `PTRWM_HIGH_NOTFSM6CLA1A` | `PTRWM_HIGH_EAL` | la `rwm.higher` | eng `PTRWM_HIGH` |

---

## Table 3 — Scaled Scores

| Category | All pupils | Girls | Boys | Disadvantaged | Not Disadv. | EAL | Local Authority | England |
|---|---|---|---|---|---|---|---|---|
| Reading — average scaled score | `READ_AVERAGE` | `READ_AVERAGE_G` | `READ_AVERAGE_B` | `READ_AVERAGE_FSM6CLA1A` | `READ_AVERAGE_NOTFSM6CLA1A` | `READ_AVERAGE_EAL` | la `reading.avgScore` | 105 |
| Maths — average scaled score | `MAT_AVERAGE` | `MAT_AVERAGE_G` | `MAT_AVERAGE_B` | `MAT_AVERAGE_FSM6CLA1A` | `MAT_AVERAGE_NOTFSM6CLA1A` | `MAT_AVERAGE_EAL` | la `maths.avgScore` | 104 |
| GPS — average scaled score | `GPS_AVERAGE` | `GPS_AVERAGE_G` | `GPS_AVERAGE_B` | `GPS_AVERAGE_FSM6CLA1A` | `GPS_AVERAGE_NOTFSM6CLA1A` | `GPS_AVERAGE_EAL` | la `gps.avgScore` | 105 |

---

## Table 4 — Per-subject Attainment: % Expected Standard

Girls/Boys/EAL not published by DfE for individual subjects.

| Category | All pupils | Disadv. | Not Disadv. | LA | England |
|---|---|---|---|---|---|
| Reading | `PTREAD_EXP` | `PTREAD_EXP_FSM6CLA1A` | `PTREAD_EXP_NOTFSM6CLA1A` | la `reading.expected` | eng `PTREAD_EXP` |
| Writing (Teacher Assessment) | `PTWRITTA_EXP` | `PTWRITTA_EXP_FSM6CLA1A` | `PTWRITTA_EXP_NOTFSM6CLA1A` | la `writing.expected` | eng `PTWRITTA_EXP` |
| Maths | `PTMAT_EXP` | `PTMAT_EXP_FSM6CLA1A` | `PTMAT_EXP_NOTFSM6CLA1A` | la `maths.expected` | eng `PTMAT_EXP` |
| GPS | `PTGPS_EXP` | `PTGPS_EXP_FSM6CLA1A` | `PTGPS_EXP_NOTFSM6CLA1A` | la `gps.expected` | eng `PTGPS_EXP` |
| Science (Teacher Assessment) | `PTSCITA_EXP` | — | — | la `science.expected` | eng `PTSCITA_EXP` |

---

## Table 5 — Per-subject Attainment: % Higher Standard

| Category | All pupils | Disadv. | Not Disadv. | LA | England |
|---|---|---|---|---|---|
| Reading | `PTREAD_HIGH` | `PTREAD_HIGH_FSM6CLA1A` | `PTREAD_HIGH_NOTFSM6CLA1A` | la `reading.higher` | eng `PTREAD_HIGH` |
| Writing (Teacher Assessment) | `PTWRITTA_HIGH` | `PTWRITTA_HIGH_FSM6CLA1A` | `PTWRITTA_HIGH_NOTFSM6CLA1A` | la `writing.higher` | eng `PTWRITTA_HIGH` |
| Maths | `PTMAT_HIGH` | `PTMAT_HIGH_FSM6CLA1A` | `PTMAT_HIGH_NOTFSM6CLA1A` | la `maths.higher` | eng `PTMAT_HIGH` |
| GPS | `PTGPS_HIGH` | `PTGPS_HIGH_FSM6CLA1A` | `PTGPS_HIGH_NOTFSM6CLA1A` | la `gps.higher` | eng `PTGPS_HIGH` |

---

## Table 6 — Cohort Characteristics

Single-value (no subgroup breakdowns).

| Category | All pupils |
|---|---|
| % disadvantaged | `PTFSM6CLA1A` |
| % not disadvantaged | `PTNOTFSM6CLA1A` |
| % EAL | `PTEALGRP2` |
| % non-mobile | `PTMOBN` |
| % SEN with EHC plan | `PSENELE` |
| % SEN support | `PSENELK` |
| % SEN total (EHC + support) | `PSENELEK` |

---

## Table 7 — Disadvantage Gap

| Category | All pupils |
|---|---|
| RWM expected — gap vs national (pp) | `DIFFN_RWM_EXP` |
| RWM higher — gap vs national (pp) | `DIFFN_RWM_HIGH` |

---

## Table 8 — Test Participation

Absent/disapplied rows hidden when value is DfE-suppressed (0%).

| Category | All pupils |
|---|---|
| Reading — % absent from test | `PTREAD_AT` |
| Maths — % absent from test | `PTMAT_AT` |
| GPS — % absent from test | `PTGPS_AT` |
| Writing — % working towards expected | `PTWRITTA_WTS` |
| Writing — % absent/disapplied | `PTWRITTA_AD` |
| Science — % absent/disapplied | `PTSCITA_AD` |

---

## Table 9 — Progress (KS1 to KS2) — 2022/23

Latest published progress data. Banding from `_DESCR` field (1=Well above → 5=Well below).

| Progress Scores | Score | Banding | Confidence Interval |
|---|---|---|---|
| Reading | `READPROG_23` | `READPROG_DESCR_23` | `READPROG_LOWER_23` to `READPROG_UPPER_23` |
| Writing | `WRITPROG_23` | `WRITPROG_DESCR_23` | `WRITPROG_LOWER_23` to `WRITPROG_UPPER_23` |
| Maths | `MATPROG_23` | `MATPROG_DESCR_23` | `MATPROG_LOWER_23` to `MATPROG_UPPER_23` |

---

## Table 10 — Results Over Time

School data from `_23`/`_24` suffixes. England from national averages. LA current year only.

### Expected Standard in RWM
| | 2023 final | 2024 final | 2025 final |
|---|---|---|---|
| School | `PTRWM_EXP_23` | `PTRWM_EXP_24` | `PTRWM_EXP` |
| Local Authority | — | — | la `rwm.expected` |
| England | 60% | 61% | 62% |

### Higher Standard in RWM
| | 2023 final | 2024 final | 2025 final |
|---|---|---|---|
| School | `PTRWM_HIGH_23` | `PTRWM_HIGH_24` | `PTRWM_HIGH` |
| Local Authority | — | — | la `rwm.higher` |
| England | 8% | 8% | 8% |

### Average Score in Reading
| | 2023 final | 2024 final | 2025 final |
|---|---|---|---|
| School | `READ_AVERAGE_23` | `READ_AVERAGE_24` | `READ_AVERAGE` |
| Local Authority | — | — | la `reading.avgScore` |
| England | 105 | 105 | 105 |

### Average Score in Maths
| | 2023 final | 2024 final | 2025 final |
|---|---|---|---|
| School | `MAT_AVERAGE_23` | `MAT_AVERAGE_24` | `MAT_AVERAGE` |
| Local Authority | — | — | la `maths.avgScore` |
| England | 104 | 104 | 104 |
