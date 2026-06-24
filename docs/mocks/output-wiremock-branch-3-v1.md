# Branch 3 Area Search Wiremock — v1

Check an area from a school-choice perspective. Part A is AI-written (school landscape).
Part B is server-rendered (deterministic area data). Part C is AI-written (verdict).

**Order rationale:** Parents see schools first (Part A), area context second (Part B),
verdict last (Part C). Same flow as Branch 1/2: primary content first, supporting data after.

**Data sources:** `imd` = IMD 2025/2019 from findthatpostcode.uk. `ons` = ONS income
estimates FYE 2018. `lr` = Land Registry Price Paid. `n` = Nomis Census 2021.
`cr` = Crystal Roof (temp — see TD-001).

---

## Section order

```
A1. Direct Answer                  ← AI paragraph: "strong for state/private/both/limited"
A2. Top Schools                    ← AI numbered shortlist (3–5 schools)
A3. Quick Comparison Grid          ← AI lightweight table (Academic | Access | Fit | Flag)
A4. Area Strengths & Weaknesses    ← AI narrative
B1. Area Profile                   ← server table (IMD, income, ethnicity, qualifications)
B2. Crime & Safety                 ← server table (crime rate, trend)
B3. Housing                        ← server table (buy vs rent, property type breakdown)
B4. Connectivity                   ← server table (nearest stations, commute anchors)
C1. Area Scorecard                 ← AI dimension ratings
C2. Tradeoffs & Risks              ← AI bullets
C3. Best Next Moves                ← AI bullets
C4. Sources                        ← AI source list
```

Part A and C are AI-written. Part B is server-rendered (deterministic).
There are no "Observations" sections in Branch 3.

---

## Part A — School Landscape (AI)

### A1. Direct Answer

AI-written. One short paragraph stating a clear judgement.

```
Southwark is **strong for state schools**, with several outstanding primaries
and good secondary options within catchment distance. Private options are
present but limited compared to neighbouring boroughs. The area works well
for families prioritising state education with decent fallback depth.
```

Flag format: none (informational section, no verdict).

---

### A2. Top Schools

AI-written. Numbered shortlist of 3–5 schools within catchment/proximity.

```
1. **Redriff Primary School** (state, mixed, ages 3–11)
   - Why it matters: Ofsted Outstanding, strong KS2 results, established catchment
   - Best for: Families wanting a high-performing state primary within walking distance
   - Main caution: Tight catchment — address must be within ~0.3 mi for reliable entry

2. **St John's Catholic Primary School** (state, mixed, ages 4–11)
   - Why it matters: Good Ofsted, strong community reputation, faith-based entry
   - Best for: Catholic families or those comfortable with faith admissions criteria
   - Main caution: Faith-based admissions — non-Catholic places extremely limited

3. **Bacon's College** (state, mixed, ages 11–18)
   - Why it matters: Good Ofsted, Church of England secondary with sixth form
   - Best for: Families wanting an all-through secondary with faith ethos
   - Main caution: Progress 8 slightly below national — check latest performance data

4. **City of London Academy** (state, mixed, ages 11–18)
   - Why it matters: Strong Progress 8, sponsored by City of London, modern facilities
   - Best for: Ambitious families seeking strong academic progress at secondary
   - Main caution: Oversubscribed — 4+ applicants per place in recent years

5. **Haberdashers' Aske's Hatcham College** (state, mixed, ages 11–18)
   - Why it matters: Outstanding Ofsted, consistently high Progress 8, music specialism
   - Best for: Academically driven families; strong music programme
   - Main caution: Highly selective — banded admissions with entrance tests for music
```

Flag format: none.

---

### A3. Quick Comparison Grid

AI-written. Lightweight table — high-level only, not Prompt 2 depth.

```
| School | Academic | Access realism | Best for | Flag |
|---|---:|---:|---:|---:|
| Redriff Primary | Strong (KS2 above national) | Tight catchment | State primary families | 🟢 |
| St John's Primary | Good | Faith-limited | Catholic families | 🟡 |
| Bacon's College | Mixed (P8 below avg) | Open — mixed catchment | Faith ethos secondary | 🟡 |
| City of London Academy | Strong (P8 well above) | Competitive | Academic-focused families | 🟢 |
| Haberdashers' Aske's | Outstanding (top P8) | Highly selective | Top academic performers | 🟢 |
```

**Table rules:**
- Maximum 6 columns (compact — this is not Prompt 2's full table)
- Flag: 🟢 = strong recommendation, 🟡 = conditional/niche, 🔴 = avoid
- "Access realism" = how likely a typical family is to get a place
- Do NOT include: class size, fees breakdown, destinations detail, full inspection analysis
- If the parent described a child, add a one-line "Child fit" row at the bottom

Flag format: none (informational).

---

### A4. Area Strengths & Weaknesses

AI-written. Narrative assessment of the area ecosystem.

```
**Strengths**
- Strong primary provision with multiple Good/Outstanding options within 1 mile
- Good secondary depth — 3+ solid state secondaries within commute range
- Good transport links into central London (Canada Water, Surrey Quays)
- Improving area — IMD has shifted from decile 7 (2015) to decile 8 (2025)

**Weaknesses**
- Catchment-sensitive: top primaries have tight admission radii (<0.5 mi in some cases)
- Limited private options — families wanting independent schools must look further afield
- Some secondaries show below-average Progress 8 — check individual school performance
- Housing costs are high and rising — 3-bed houses start at ~£600k
```

Flag format: none.

---

## Part B — Area Data (server-rendered)

### B1. Area Profile

Server-rendered table. Shows demographics for the searched postcode/area.

```
|  | Value |
|---|---:|
| Postcode | SE16 7LP |
| Area | Southwark, London |
| MSOA | Southwark 001 |
| LSOA | Southwark 001A |

| Deprivation | Value | England decile |
|---|---:|---:|
| IMD score | 12.4 | 8 (less deprived) |
| IMD rank | 24,310 / 32,844 | — |
| Income deprivation | — | 7 |
| Employment deprivation | — | 8 |
| Education deprivation | — | 9 |
| Health deprivation | — | 6 |
| Crime | — | 5 |
| Housing & services | — | 7 |
| Living environment | — | 9 |

| Household income | Value |
|---|---:|
| Mean gross annual (ONS) | £48,200 |
| Mean gross annual (Crystal Roof) | £52,100 |
| Net annual after housing costs | £31,400 |

| Ethnicity (Census 2021) | % |
|---|---:|
| White | 48% |
| Asian | 22% |
| Black | 16% |
| Mixed | 8% |
| Other | 6% |

| Qualifications (Census 2021) | % |
|---|---:|
| No qualifications | 12% |
| Level 4+ (degree) | 48% |

| Occupation (Census 2021) | % |
|---|---:|
| Managerial / professional | 42% |
| Intermediate | 24% |
| Routine / manual | 20% |
```

IMD decile: 1 = most deprived, 10 = least deprived. Sub-domain deciles shown when
available (2025 preferred, 2019 fallback).

---

### B2. Crime & Safety

Server-rendered table. Crime statistics for the area with multi-year trend.

```
| Crime | Rate per 1,000 | England avg | Trend (5yr) |
|---|---:|---:|---:|
| Overall crime | 78 | 82 | Improving ↓ |
| Violent crime | 22 | 28 | Stable → |
| Burglary | 8 | 9 | Improving ↓ |
| Anti-social behaviour | 15 | 14 | Stable → |
```

Trend arrows: ↑ worsening, ↓ improving, → stable. Rates per 1,000 residents.
Source: Police UK data (street-level crime) aggregated to LSOA/MSOA.

**Note:** Crime data not yet pre-fetched server-side — this section is aspirational
(see wiremock notes below). When implemented, fetches from `data.police.uk/api`.

---

### B3. Housing

Server-rendered table. Property prices and rental costs.

```
| Property type | Median buy price | Median rent (pcm) |
|---|---:|---:|
| Flat | £385,000 | £1,700 |
| Terraced | £620,000 | £2,400 |
| Semi-detached | £780,000 | £2,900 |
| Detached | £1,150,000 | £3,800 |
| Overall | £550,000 | £2,100 |
```

Source: Land Registry Price Paid (last 5 years, within 800m of postcode centroid)
for buy prices. Rental data from web search (Rightmove/Zoopla) — AI-populated if
not pre-fetched.

**Note:** Rental data and property-type breakdown for buy prices not yet pre-fetched.
Current implementation has only an overall median. See TD-022 (flats vs houses breakdown).
Rental data requires new data source.

---

### B4. Connectivity

Server-rendered table. Transport links near the postcode.

```
| Transport | Nearest | Distance | Travel time |
|---|---:|---:|---:|
| Tube / Metro | Canada Water (Jubilee) | 0.6 mi | 12 min walk |
| National Rail | Canada Water | 0.6 mi | 12 min walk |
| Bus stop | Surrey Quays Rd | 0.1 mi | 2 min walk |
| Major road | A200 | 0.3 mi | — |
| Airport | London City | 5.2 mi | 25 min drive |
```

Travel time: walking time for stations <1 mi, drive time for airports.

**Note:** Connectivity data not yet pre-fetched server-side. This section is AI-populated
via web search. Server-side transport lookup would require TfL API or similar for London
(Google Maps Distance Matrix for other regions).

---

## Part C — Verdict (AI)

### C1. Area Scorecard

AI-written. Dimension ratings for the area as a whole.

```
| Dimension | Rating | Note |
|---|---:|---:|
| State primary depth | Strong | Multiple Good/Outstanding within catchment |
| State secondary depth | Good | Solid options but mixed performance |
| Private options | Limited | Few independents within 2 miles |
| Access realism | Mixed | Top primaries are tight-catchment |
| Fallback strength | Good | Decent alternatives if first choice fails |
| Commute practicality | Strong | Good transport links to central London |
| Affordability | Mixed | High prices but better value than Zone 1–2 |
```

Ratings: Strong | Good | Mixed | Limited | Weak. One sentence per dimension.

Flag format: none (informational section).

---

### C2. Tradeoffs & Risks

AI-written. Bullet list of practical cautions.

```
- **Catchment vs budget**: The best primaries have tight catchments — house prices
  within those radii are 15–20% higher than the area average
- **Secondary depth varies**: Strong at the top (Haberdashers') but mid-tier options
  are inconsistent — check individual Progress 8 scores
- **Faith school dependency**: Two of the strongest primaries are faith-based;
  non-religious families have fewer top-tier options
- **Rising demand**: Several schools in the area have seen oversubscription ratios
  increase over the last 3 years — admissions may tighten further
```

**Child fit summary** (only if child described): one short paragraph.

---

### C3. Best Next Moves

AI-written. Bullet list of practical next actions.

```
- **Narrow your radius**: Focus on the SE16 7xx postcode sector for the best
  primary catchment options
- **Visit Redriff Primary and St John's**: Both have open days in September–October
  — check school websites for exact dates
- **Check admissions criteria**: For Haberdashers' Aske's, check the music aptitude
  test requirements and banded admissions policy
- **Compare with SE15**: Peckham/Nunhead offers similar transport links with
  slightly lower house prices — worth a parallel search
- **Monitor catchment trends**: Use the local authority's admissions dashboard
  to check how catchment radii have changed over the last 3 years
```

---

### C4. Sources

AI-written. Links used.

```
Primary Sources
- [Redriff Primary — Ofsted](https://reports.ofsted.gov.uk/provider/21/100865)
- [Haberdashers' Aske's Hatcham College — Ofsted](https://reports.ofsted.gov.uk/...)
- [GIAS — Redriff Primary](https://get-information-schools.service.gov.uk/Establishments/Establishment/Details/100865)
- [DfE Performance — City of London Academy](https://www.compare-school-performance.service.gov.uk/...)
- [ONS Income Estimates — Southwark 001 MSOA](https://www.ons.gov.uk/...)
- [IMD 2025 — Southwark 001A LSOA](https://findthatpostcode.uk/...)

Secondary Sources
- [Rightmove — SE16 property prices](https://www.rightmove.co.uk/...)
- [Police UK — Southwark crime statistics](https://www.police.uk/...)
- [TfL — Canada Water station](https://tfl.gov.uk/...)
```

---

## Wiremock notes

### What's server-rendered (deterministic, no AI)

| Section | Status | Data source |
|---|---|---|
| B1. Area Profile | ✅ Implemented (`getAreaData` + `fmtAreaDataSlim`) | IMD, ONS, Nomis, Crystal Roof |
| B2. Crime & Safety | ❌ Not yet implemented | Police UK API (`data.police.uk`) |
| B3. Housing | ⚠️ Partial — overall median only | Land Registry (buy), Rightmove (rent — AI) |
| B4. Connectivity | ❌ Not yet implemented | TfL / Google Maps API (AI web search for now) |

### What's AI-written

| Section | Key constraints |
|---|---|
| A1. Direct Answer | One paragraph. Must use a clear verdict word: strong/good/mixed/limited |
| A2. Top Schools | 3–5 schools, numbered. Each: why it matters, best for, main caution |
| A3. Quick Comparison Grid | Max 6 columns. Lightweight — NOT Prompt 2 depth. No class size or fees detail |
| A4. Area Strengths & Weaknesses | Ecosystem-level, not per-school |
| C1. Area Scorecard | 7 dimensions, rating + one-sentence note |
| C2. Tradeoffs & Risks | Bullets. New points only — no restating |
| C3. Best Next Moves | Practical, actionable. Include visit suggestions with dates if findable |
| C4. Sources | Primary (gov data, Ofsted, school sites) + Secondary (all other URLs) |

### What Branch 3 explicitly does NOT do (unlike Branch 2)

- ❌ Per-school deep-dive inspection analysis
- ❌ Full class size research hunt
- ❌ Detailed destination/fees treatment unless parent explicitly asks
- ❌ Side-by-side full-width comparison table (Prompt 2's job)
- ❌ "Winner" logic — Branch 3 doesn't pick a winning school, it assesses the area
- ❌ Observations sections (no interleaving needed)

### Prompt boundaries

```
Prompt 1: "Tell me about this school."        (deep, one school)
Prompt 2: "Compare these schools."            (delta analysis, winner)
Prompt 3: "Is this area good for schools?"    (ecosystem scan, shortlist)
Prompt 4: "What's my backup plan?"            (admissions strategy)
```
