# Output Wiremock — Branch 1 (Specific School)

Every section the AI must produce, in order. This is the single contract for:
- The prompt (what to output)
- The parser (what to accept and how to normalise)
- Tests (what to validate)

**Legend:**
- `##` = H2 section heading (rendered as an accordion section in the UI)
- `|...|` = markdown table with leading and trailing pipes on every row
- `- ` = bullet list (single dash + space)
- `**text**` = bold inline
- Flag values: `none` / `green` / `amber` / `red` — only for observation sections

---

## Part A — Verdicts

*AI-written observations on the server-rendered data tables. Each A section is a single H2 heading followed by bullet points. No data tables — the tables are already shown to the user from the pre-fetched block. The AI only writes the verdict bullets.*

### Section A3 — Improvement Requirements

Heading: `## A3. Improvement Requirements`
Format: Bullet list (`- `)
Rules:
- If no improvement requirements: single bullet `- No improvement requirements — school inspected without any action points.` with flag `none`
- If only ISI "might wish" suggestion: treat as `none`, not red
- Otherwise: summarise each requirement, flag serious ones as `red`
- Never repeat the raw Ofsted text — the user can see it in Part A already

### Section A4 — Pupil Census Observations

Heading: `## A4. Cohort & Intake Observations`
Format: Bullet list (`- `)
Rules:
- Compare FSM/EAL to national norms, note intake implications
- SEN provision: flag if EHC% above/below national ~4.5%
- School ethnicity vs area ethnicity gap if notable
- Independent schools: ignore FSM (always near 0%)
- Flag: `red` only if high FSM without strong attainment OR high EHC/SEN with weak outcomes

### Section A5 — Academic Performance Observations

Heading: `## A5. Academic Performance Observations`
Format: Bullet list (`- `)
Rules:
- Overall attainment vs national and LA benchmarks
- Progress scores if present — direction and significance
- Multi-year trend if notable
- Cohort size caveat if below 30
- Flag: `green` if well above national, `amber` if mixed, `red` if well below

### Section A6 — Absence Observations

Heading: `## A6. Absence Observations`
Format: Bullet list (`- `)
Rules:
- Overall absence vs national
- Persistent absence (stronger signal)
- Flag: `green` if well below national, `red` if well above, else `amber`

### Section A7 — Financial Observations

Heading: `## A7. Financial Health Observations`
Format: Bullet list (`- `)
Rules:
- Spend per pupil vs comparator
- In-year balance — flag deficit explicitly
- QTS% and pupil:teacher ratio vs comparator
- Flag: `red` for deficit or spend significantly below comparator, `green` for strong reserves/balanced

### Section A8 — Area Context Observations

Heading: `## A8. Area & Catchment Observations`
Format: Bullet list (`- `)
Rules:
- IMD decile and what it means for the school's environment
- Income/housing profile — mixed, affluent, or deprived catchment
- School FSM/EAL vs area profile — divergence suggests selection or outreach
- Flag: inform only, no colour

---

## Part B — Independent Research

*Sourced entirely from web search. Each section is a single H2 heading followed by bullet points — never data tables, never prose paragraphs.*

### Section B1 — Pupil Experience

Heading: `## B1. What It's Like to Be a Pupil`
Format: Bullet list (`- `), 3–5 bullets
Rules:
- School culture and atmosphere
- How pupils treat each other and staff
- Behaviour and attitudes
- Standout strengths or concerns
- If child described: one bullet on personal fit
- Never output as prose paragraph

### Section B2 — Admissions

Heading: `## B2. Admissions`
Format: Bullet list (`- `)
Rules:
- Entry points and age ranges
- Admissions criteria, oversubscription rules
- Assessment format if selective
- Sibling priority, catchment, faith criteria
- Oversubscription ratio if published
- Next open day date
- Independent schools: fees, bursaries, scholarships

### Section B3 — Extracurricular

Heading: `## B3. Extracurricular & Clubs`
Format: Bullet list (`- `)
Rules:
- Sports offer
- Arts, music, drama
- Academic clubs and enrichment
- Other notable activities
- If child described: fit with interests
- Approximate club count if stated

### Section B4 — Community Sentiment

Heading: `## B4. What Parents Say`
Format: Bullet list (`- `)
Rules:
- Positive themes from forums/reviews
- Negative themes — prioritise safeguarding, SEN, staff turnover, bullying, communication
- Flag significant events since last inspection
- If no substantive discussion found, say so clearly

### Section B5 — Destinations

Heading: `## B5. Where Pupils Go Next`
Format: Bullet list (`- `)
Rules:
- Primary schools: Year 6 destinations
- Secondary schools: post-16 or university destinations
- Note clearly if no data published

---

## Part C — Verdict & Synthesis

*Must directly answer the parent's question. Generic output that ignores the question is a failure.*

### Section C1 — School Character

Heading: `## C1. School Character — Who Thrives Here`

Format: 
- Open with one sentence restating the parent's question
- Then a markdown table with exactly these columns and rows:

```
| Dimension | Evidence level | Notes |
|---|---|---|
| Academic / high-attainment focus | STRONG | ... |
| Arts, music and creative | STRONG | ... |
| Sports and physical | STRONG | ... |
| STEM / science | STRONG | ... |
| Pastoral / wellbeing-centred | STRONG | ... |
| Leadership and pupil voice | STRONG | ... |
| Community and inclusion | STRONG | ... |
| Faith / values-driven | STRONG | ... |
```

Rules:
- Every row MUST start with `|` and end with `|`
- Separator row MUST be `|---|---|---|`
- Evidence level MUST be exactly one of: `Strong`, `Present`, `Not evident`
- Notes column: one short sentence explaining the rating
- Bold the 2–3 dimensions most relevant to the parent's question
- After the table, one paragraph (2–3 sentences, NOT in the table) answering: which types of child thrive here, which might struggle, and why this matters for the parent's specific question
- Never add extra columns to the table
- Never output the summary paragraph as a table row

### Section C2 — Pros and Cons

Heading: `## C2. Pros and Cons`
Format:
```
**Reasons to choose this school:**
- bullet 1
- bullet 2

**Reasons to think twice:**
- bullet 1
- bullet 2
```

Rules:
- Each bullet that relates to the parent's question must say so: "For your SEN child specifically, …"
- Honest, direct, no hedging
- If child described: final sentence on overall fit

### Section C3 — Next Steps

Heading: `## C3. Best Next Moves`
Format: Bullet list (`- `), exactly 3 bullets:
- Visit: open day date or how to book
- Check: admissions deadline and criteria
- Compare: one or two nearby alternatives (if question implies SEN/sport/etc, mention alternatives strong in that area)

### Section C4 — Sources

Heading: `## C4. Sources`
Format: Bullet list (`- `), each bullet is a markdown link:
```
- [Source Name](https://real-url-here)
```
Rules:
- Every entry MUST have a real URL
- Do NOT list a source without a URL
- Minimum sources: GIAS page, Compare School Performance page, Ofsted report
