# KS1/Infant School Wire Mock — Template Reference

Infant schools (ages 3–7) have no KS2/KS4/KS5 data.
Academic Results section shows "_No performance data available._"

## Section order

```
A1. School Identity            ← server table, no Observations
A2. Inspection Outcomes         ← server table
A2. Observations               ← AI bullets
What the School Needs to Improve ← server verbatim, no Observations
A3. Academic Performance        ← server (no data)
A3. Observations               ← AI bullets
A4. Intake & Cohort             ← server table
A4. Observations               ← AI bullets
A5. Absence & Engagement        ← server table
A5. Observations               ← AI bullets
A6. Financial Health            ← server table
A6. Observations               ← AI bullets
A7. Area Context                ← server bullets
A7. Observations               ← AI bullets
```

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

No Observations section for A1.

---

## A2. Inspection Outcomes

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

### A2. Observations

Heading: `## A2. Observations` · Flag: `green` if Outstanding/Exceptional, `red` if RI/Inadequate, else `none`

Bullet list, 3–4 bullets:
- Overall grade and what it means for quality
- Any sub-grade weaker than overall — call it out
- Inspection recency — stale if >5 years
- For ISI: note framework (EQI/ROU), flag ROU as limited

---

## A3. Academic Performance

```
_No performance data available._
```

Infant schools have no KS1/KS2/KS4/KS5 performance data in the DfE CSV.

### A3. Observations

Heading: `## A3. Observations` · Flag: `none`

One bullet: `- No published Key Stage results for infant schools.`

---

## What the School Needs to Improve

Verbatim from Ofsted PDF next steps. Ordered list if multiple points. Fallback:
`_No improvement requirements stated. Ofsted grade: {grade}._`

No Observations section — the text speaks for itself.

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

Heading: `## A4. Observations` · Flag: `red` if FSM >35% primary or EHC >6%, else `none`

Bullet list, 2–3 bullets:
- FSM rate vs national — what it says about intake
- SEN/EHC profile — well-resourced provision or capacity concern?
- School ethnicity vs area ethnicity gap if notable

---

## A5. Absence & Engagement (DfE)

| Category | School | National avg |
|---|---:|---:|
| Overall absence | `PERCTOT`% | 6.6% |
| Persistent absence | `PPERSABS10`% | 21.3% |

### A5. Observations

Heading: `## A5. Observations` · Flag: `green` if <5% overall or <15% persistent, `red` if >8.6% overall or >23.3% persistent

Bullet list, 2 bullets:
- Overall absence vs national — gap matters above 2pp
- Persistent absence — the stronger signal

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

### A6. Observations

Heading: `## A6. Observations` · Flag: `red` if in-year deficit or QTS below comparator avg, else `none`

Bullet list, 2–3 bullets:
- Spend per pupil vs comparator
- In-year balance — flag deficit explicitly
- QTS% and staffing stability
- For independents: note FBIT not available, comment on fees if shown

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
