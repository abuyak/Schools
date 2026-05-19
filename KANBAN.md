# School Scanner Kanban Board

Living document — update as items are completed or reprioritised. Last updated 2026-05-17.

## Legend

**Priority:** `!!!` Critical / `!!` High / `!` Medium / `·` Low
**Effort:** `XS` hours / `S` 1–2 days / `M` 3–5 days / `L` 1–2 weeks / `XL` 2+ weeks

---

## Backlog

### Core Product — Branches & Prompts

| ID | Title | Pri | Eff |
|---|---|---|---|
| B-01 | Branch 2: Compare Schools — side-by-side, delta analysis, ranked verdict | `!!` | M |
| B-02 | Branch 3: Check an Area — postcode → top schools ranked by distance/fit | `!!` | L |
| B-03 | Branch 4: Plan Backup Options — reserve list, admissions deadlines, Plan B | `!` | M |
| B-04 | Update Branch 2–4 prompts to match Branch 1 quality/structure | `!!!` | S |

### Context & Personalisation

| ID | Title | Pri | Eff |
|---|---|---|---|
| C-01 | Advanced Context text boxes — child age, child description (personality, interests, special needs), commute (from and to postcodes), school preferences (state, independent, mixed, non-religious, etc) | `!!!` | S |
| C-02 | Context persistence across branch switches (session) | `!` | S |
| C-03 | Structured onboarding form (post-beta, requires accounts) | `·` | L |
| C-04 | Multi-child profiles (requires accounts) | `·` | L |
| C-05 | Commute calculator integration (TfL / Google Maps API) | `!` | M |
| C-06 | Analytics update with new information| `!` | M |


### UX & Interface

| ID | Title | Pri | Eff |
|---|---|---|---|
| U-01 | Feedback widget — thumbs up/down + optional text, no account | `!!!` | S |
| U-02 | Loading state with progress — show what the tool is doing | `!!` | S |
| U-03 | Blurred paywall gate — lock Part B/C behind paywall with unlock CTA | `!` | M |
| U-04 | Source list cleanup — curate to 6–8 relevant links, hide secondary | `!!` | S |
| U-05 | Remove Buy Me a Coffee — replace with proper CTA | `!!!` | XS |
| U-06 | Input hint placement — move guidance above/inside input box | `!` | XS |
| U-07 | Mobile responsiveness audit — tables and traffic lights | `!` | S |
| U-08 | Email capture widget — Tally.so form on homepage | `!` | XS |

### Monetisation & Auth

| ID | Title | Pri | Eff |
|---|---|---|---|
| M-01 | Stripe bundle payments — Taster/Starter/Family, credits stored server-side | `!!` | L |
| M-02 | Agency subscription billing — Stripe recurring, monthly cap | `!!` | L |
| M-03 | Search credit system — track, deduct, display remaining credits | `!!` | M |
| M-04 | Credit rollover logic — unused credits roll over 1 month | `!` | S |
| M-05 | User accounts — email/password auth for credits/profiles/billing | `!!` | L |
| M-06 | GDPR compliance — privacy policy, cookie consent, data retention | `!!!` | M |

### B2B & White-Label

| ID | Title | Pri | Eff |
|---|---|---|---|
| W-01 | PDF export — branded full school report | `!!!` | M |
| W-02 | White-label branding — logo + brand colour on PDFs and header | `!!` | M |
| W-03 | White-label domain support — agencies serve on own subdomain | `!` | L |
| W-04 | Bulk report mode — CSV upload → batch reports in one PDF | `!` | L |
| W-05 | Agency dashboard — usage stats, credit balance, team seats, history | `!` | L |
| W-06 | API access — programmatic queries, embed results in other tools | `·` | XL |

### Internationalisation

| ID | Title | Pri | Eff |
|---|---|---|---|
| I-01 | Mandarin language support — full UI + report output | `!!` | L |
| I-02 | Mandarin input handling — Chinese characters → UK school records | `!` | M |
| I-03 | WeChat sharing / integration — mini-programme if traction | `·` | XL |
| I-04 | Russian language support — UI + report output | `·` | L |

### SEO & Marketing

| ID | Title | Pri | Eff |
|---|---|---|---|
| S-01 | School landing page pipeline — /schools/[slug] with lite report + CTA | `!!` | M |
| S-02 | Area landing page pipeline — /area/[postcode] SEO content | `!!` | M |
| S-03 | Sitemap generation — auto from school/area pages → Google Search Console | `!` | S |
| S-04 | Marketing Agent: SEO module — batch content from CSV | `!` | S |
| S-05 | Marketing Agent: B2B module — firm research + outreach emails | `!!` | XS |
| S-06 | Google Analytics / PostHog — searches, branch selection, conversions | `!!` | S |

### Infrastructure & Data

| ID | Title | Pri | Eff |
|---|---|---|---|
| D-01 | API cost instrumentation — log tokens used + estimated cost per report | `!!` | S |
| D-02 | Rate limiting — N searches per IP per day on free tier | `!!` | S |
| D-03 | Data freshness monitoring — alert on Ofsted/GIAS/DfE structure changes | `!` | M |
| D-04 | AWS scaling review — CloudFront + backend for traffic spikes | `!` | S |
| D-05 | School data cache — cache parsed gov data per school (TTL 7 days) | `!!` | M |
| D-06 | Error handling & fallbacks — graceful degradation, partial reports | `!!` | S |

### Tech Debt

| ID | Title | Pri | Eff |
|---|---|---|---|
| TD-001 | Crystal Roof → Nomis API replacement | `!!` | M |
| TD-002 | ONS Income CSV → deploy-time bundle | `!` | S |
| TD-003 | Ofsted PDF → S3 cache | `·` | S |
| TD-004 | DfE performance CSV → S3 cache | `·` | S |
| TD-005 | Structured logging + CloudWatch alarms | `·` | S |
| TD-007 | Ofsted grades → deploy-time bundle | `!` | M |
| TD-008 | GIAS register → deploy-time bundle | `!` | M |
| TD-009 | Parent View → fallback to historical years | `!` | S |
| TD-010 | Ofsted PDF → A9 pupil experience too thin | `!` | S |
| TD-011 | Area dynamics → multi-year IMD trends in Prompt 3 | `!` | M |
| TD-012 | University admissions → Oxford source + auto-refresh | `!` | M |
| TD-013 | EES subject-level exam data → per-subject tables | `!` | M |
| TD-014 | KS5 LA comparisons from EES API | `!` | M |
| TD-015 | Async Call 2 + queue-mediated inference | `!!` | L |
| TD-016 | Retry with backoff on OpenAI API calls | `!` | S |

---

## In Progress

| ID | Title | Status |
|---|---|---|
| B-01 | Branch 2 A/B/C restructure + wiremock + traffic lights | Deployed, testing |
| B-04 | Branch 1 prompt tone, Branch 2 prompt rewrite | Deployed |
| TD-016 | Retry helper (`fetchWithRetry` + `callOpenAI`) | Deployed |
| TD-015 | Async Call 2 (in-memory job store + polling endpoint) | Phase 1 deployed |

### Backlog (next up)

| ID | Title | Pri |
|---|---|---|
| N-01 | Fix error handling during school search and resolution | `!!` |
| N-02 | Name lookup suggestions / retry when GIAS returns empty | `!!` |

---

## Done (this session)

| ID | Title |
|---|---|
| — | Branch 2 two-call architecture (Quick Take + Full) |
| — | Branch 2 school name extraction fixes (regex + AI fallback) |
| — | Branch 2 gov data enrichment (38K chars, QC table) |
| — | Branch 2 output wiremock created |
| — | Collapsible/expandable sections (all branches) |
| — | C1 table normaliser fixes (pipe formatting, bold markers, citations) |
| — | Frontend error display (API errors no longer blank page) |
| — | Branch 1 Quick Take scorecard (dynamic, no NaN/empty dimensions) |
| TD-006 | Ofsted Parent View pre-fetch |

---

## Summary

| Priority | Count |
|---|---|
| `!!!` Critical | 5 |
| `!!` High | 22 |
| `!` Medium | 19 |
| `·` Low | 6 |
| **Total** | **52** |
