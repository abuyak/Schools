# Output Wiremock — Branch 2 (Compare Schools)

Every section the AI must produce, in order. This is the single contract for:
- The prompt (what to output)
- The parser (what to accept and how to normalise)
- Tests (what to validate)

**Legend:**
- `##` = H2 section heading (rendered as an accordion section in the UI)
- `|...|` = markdown table with leading and trailing pipes on every row
- `- ` = bullet list (single dash + space)
- Flag values: `none` / `green` / `red`

---

## Part A — Official Record Comparison

*All Part A sections use ONLY pre-fetched government data. Each section has a side-by-side table + one paragraph of comparison analysis.*

### A1. School Identity

Heading: `## A1. School Identity`
Format: Side-by-side table (rows: Official name, URN, Type, Phase & age range, Gender, Religious character, Admissions policy, Pupils on roll, Capacity/fill rate). No prose.

### A2. Inspection Grades

Heading: `## A2. Inspection Grades`
Format: Side-by-side table (Overall grade, Inspection date) + 1 paragraph on which school is stronger and what the gap means.

### A3. Academic Performance

Heading: `## A3. Academic Performance`
Format: Side-by-side table (KS2 RWM/higher/progress for primary; Attainment 8, Progress 8, grade 5+ EM%, EBacc, A-level grade+VA for secondary) + 1 paragraph analysis. Every cell must have a number from the QC table or Detailed School Data.

### A4. Intake & Cohort

Heading: `## A4. Intake & Cohort`
Format: Side-by-side table with National column (FSM%, EAL%, SEN support%, EHC plan%) + 1 paragraph on intake implications. Skip for independent schools or mark FSM as "(indep)".

### A5. Absence & Engagement

Heading: `## A5. Absence & Engagement`
Format: Side-by-side table with National column (Overall absence, Persistent absence) + 1 paragraph. Skip for independent schools.

### A6. Financial Health

Heading: `## A6. Financial Health`
Format: Side-by-side table with Comparator column (Spend per pupil, In-year balance, QTS%) + 1 paragraph. Skip for independent schools.

### A7. Area Context

Heading: `## A7. Area Context`
Format: Side-by-side table (IMD decile, Mean household income, % degree-level quals) + 1 paragraph. Skip if area data missing.

---

## Part B — Independent Research

*Sourced from web search. Each section is bullet-point format.*

### B1. Pupil Experience

Heading: `## B1. Pupil Experience`
Format: Bullet list, 4–5 bullets comparing both schools on culture, atmosphere, behaviour, pastoral feel.

### B2. Admissions

Heading: `## B2. Admissions`
Format: Bullet list comparing entry routes, oversubscription, criteria, open days. Include fees for independent schools.

### B3. Extracurricular & Clubs

Heading: `## B3. Extracurricular & Clubs`
Format: Bullet list comparing sports, arts, music, clubs. Address child's interests if described.

### B4. What Parents Say

Heading: `## B4. What Parents Say`
Format: Bullet list summarising forum/review themes. State clearly if no substantive discussion found.

### B5. Where Pupils Go Next

Heading: `## B5. Where Pupils Go Next`
Format: Bullet list. Primary: Year 6 destinations. Secondary: post-16/university destinations.

---

## Part C — Verdict & Synthesis

### C1. Head-to-Head Verdict

Heading: `## C1. Head-to-Head Verdict`
Format: Side-by-side table (Dimension | Winner | By how much) + 1 paragraph final recommendation. Flag: `green` if clear winner, `none` otherwise.
Rules: Every dimension from Parts A and B that had data must appear. The final paragraph must name the 1–2 decisive factors with numbers.

### C2. Which Child Thrives Where

Heading: `## C2. Which Child Thrives Where`
Format: One paragraph per school. "[School A] suits a child who…". Be specific.

### C3. Tradeoffs

Heading: `## C3. Tradeoffs`
Format: Bullet list, 2–3 bullets. What the parent gives up with each choice.

### C4. Best Next Move

Heading: `## C4. Best Next Move`
Format: Bullet list, exactly 3 bullets: Visit, Check, Compare/fallback.

### C5. Sources

Heading: `## C5. Sources`
Format: Primary Sources + Secondary Sources. Every entry must have a real URL.
