# School Scanner — Sequence Diagram

## Prompt 1 (Single School)

```
USER SUBMITS QUESTION
       │  "Is Fortismere School good for music?"
       ▼
┌──────────────────────────────────────┐
│ 1. SCHOOL NAME RESOLUTION           │  extractSchoolNames()
│                                      │
│   extractNamesRegex(question)        │  ← fast regex, no API
│   └─ matches "Fortismere School"     │
│                                      │
│   extractNamesAI(question)           │  ← only if regex fails
│   └─ corrects misspellings           │
│                                      │
│   cleanNames()                       │  ← strips postcodes, normalises case
│   └─ ["Fortismere School"]           │
└──────────────────────────────────────┘
       │  ["Fortismere School"]
       ▼
┌──────────────────────────────────────┐
│ 2. GOV DATA FETCH                   │  fetchGovDataForPrompt()
│                                      │
│   for each name:                     │
│     lookupSchoolURN("Fortismere")    │  ← GIAS search → URN 102156
│     getOfstedData(102156)            │  ← Ofsted grade + PDF
│     getPerformanceData(102156)       │  ← DfE KS4/KS5 results
│     getFinancialData(102156)         │  ← FBIT spending
│     getAreaData(postcode)            │  ← IMD, income, housing
│     fetchParentView(102156)          │  ← parent survey
│                                      │
│   └─ { identity, ofsted, performance, financial, area }  │
└──────────────────────────────────────┘
       │  resolved school + gov data
       ▼
┌──────────────────────────────────────┐
│ 3. CALL 1 — QUICK TAKE              │  cheap model, no web search
│                                      │
│   prompt: QUICK_TAKE_INSTRUCTIONS    │
│   data:   buildQuickTakeBlock(school)│  ← identity + headline metrics only
│   output: { title, summary, scorecard }  │
│                                      │
│   → RENDERED IMMEDIATELY             │  ← user sees verdict in ~3s
└──────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────┐
│ 4. SERVER-RENDERED PART A           │  renderPartA(school)
│                                      │
│   A1. School Identity    ← identity  │
│   A2. Inspection Grades  ← ofsted    │
│   A3. Improvement Needs  ← ofsted    │
│   A4. Pupil Census        ← performance │
│   A5. Academic Results    ← performance │
│   A6. Absence             ← performance │
│   A7. Financial           ← financial │
│   A8. Area Profile        ← area      │
│                                      │
│   → RENDERED (pre-filled tables)     │
└──────────────────────────────────────┘
       │  partASections (no AI)
       ▼
┌──────────────────────────────────────┐
│ 5. CALL 2 — FULL ANALYSIS           │  full model + web search
│                                      │
│   prompt: prompt_branch_1_bc_v1.md   │
│   data:   buildSlimBlock(school)     │  ← full gov data
│   output:                            │
│     Part A verdicts (A3-A8)          │  ← AI observations on server tables
│     Part B (B1-B5)                   │  ← web search: admissions, clubs, etc
│     Part C (C1-C4)                   │  ← character, pros/cons, next steps
│                                      │
│   → interleave with server Part A    │
│   → tagPartLabels (A/B/C dividers)   │
│   → RENDERED                         │
└──────────────────────────────────────┘
```

## Prompt 2 (Compare Schools) — same architecture, different render function

```
Same flow as Prompt 1, except:

Step 4 (Server Tables):
  renderPartAComparison([schoolA, schoolB])
  └─ A1-A7 with side-by-side tables + National column

Step 5 (Call 2):
  AI produces:
    Part A observations (A2-A7)         ← comments on comparison tables
    Part B (B1-B5)                      ← web search comparison
    Part C (C1-C5)                      ← verdict + which child thrives
```

## Key principle

**The second API call receives only normalised, confirmed school names from gov data — never the user's original query text.**
