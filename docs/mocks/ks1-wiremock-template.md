# KS1/Infant School Wire Mock — Template Reference

Infant schools (ages 3–7) have no KS2/KS4/KS5 data.
Academic Results section shows "_No performance data available._"

---

## A1. School Identity

Single line in the slim block header:
```
**School:** {officialName} · URN {urn} · {type} · {phase} (ages {ageLow}–{ageHigh}) · LA: {la} · {postcode} · {gender} · {religion} · admissions: {admissions} · capacity: {capacity} ({nor} on roll — {fillRate}% full)
```

- Religion hidden if "Does not apply"
- Admissions hidden if "Not applicable"
- Capacity/fill rate hidden if no GIAS detail data

**Links:** GIAS · Compare School Performance · FBIT · Ofsted (all 4 always shown)

---

## A2. Inspection Outcomes (Ofsted)

```
- Overall: **{grade}** ({date})
- [Sub-grades if available — Quality of Education, Behaviour and Attitudes, Personal Development, Leadership and Management]
- Parent View: {url} _(data not retrieved)_
- [Full report: {pdfUrl}] — if PDF available
```

Pre-2019 inspections may have limited sub-grades (graded PDF fallback).

**What it's like to be a pupil**
Ofsted PDF narrative, first ~800 characters, truncated with link to full PDF:
```
Pupils eagerly anticipate coming to this school…_(truncated — full PDF: {pdfUrl})_
```

---

## A3. Academic Performance (DfE)

```
_No performance data available._
```

Infant schools have no KS1/KS2/KS4/KS5 performance data in the DfE CSV.

---

## What the School Needs to Improve

Verbatim from Ofsted PDF next steps. Ordered list if multiple points. Fallback:
`_No improvement requirements stated. Ofsted grade: {grade}._`

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

---

## A5. Absence & Engagement (DfE)

| Category | School | National avg |
|---|---:|---:|
| Overall absence | `PERCTOT`% | 6.6% |
| Persistent absence | `PPERSABS10`% | 21.3% |

---

## A6. Financial Health

### Financial Benchmarking (FBIT)
State schools only. Independent version: `_Not available for independent schools._`

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
8 categories, each on one line:
`- {category}: £{school}/pupil | avg £{comparator}/pupil | £{diff} more/less than avg | {pctDiff}%`

### School Fees (independent only)
Shown when fees data scraped from school website:
```
### School Fees
- Day fees: £{min}–£{max} {period}
- [Boarding fees: ...]
```

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
