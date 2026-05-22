/**
 * govuk.js
 *
 * Pre-fetches UK government school data and injects it into the AI prompt
 * before the main OpenAI research call. Runs for branches 1 and 2 only.
 *
 * Sources:
 *   - GIAS  — school identity + URN lookup
 *   - Ofsted / infotap — inspection ratings (state schools)
 *   - compare-school-performance — key performance metrics
 *   - financial-benchmarking-and-insights-tool — income / expenditure data
 *   - local-data.js — bundled DfE data (ethnicity index, zero-latency)
 *
 * All failures are non-fatal. Missing data is noted in the output block so
 * the AI knows to fetch it via web search rather than silently omitting it.
 */

import { readFileSync } from 'fs';
import { getSchoolEthnicity } from './local-data.js';
import { getISIInspection, getIndependentFees } from './independent.js';

const FETCH_TIMEOUT_MS      =  8000;  // standard HTML / JSON fetches
const FETCH_TIMEOUT_LONG_MS = 20000;  // binary / ZIP downloads (FBIT census, DfE performance)

const GIAS_SEARCH   = 'https://www.get-information-schools.service.gov.uk/Establishments/Search';
const GIAS_DETAIL   = 'https://www.get-information-schools.service.gov.uk/Establishments/Establishment/Details';
const COMPARE_PERF  = 'https://www.compare-school-performance.service.gov.uk';
const FIN_BENCH     = 'https://financial-benchmarking-and-insights-tool.education.gov.uk';
const POSTCODES_IO  = 'https://api.postcodes.io/postcodes';

// ─── Logging ──────────────────────────────────────────────────────────────────
//
// Two tiers:
//   Always-log — emitted on every request; minimal noise, maximum traceability.
//     Includes start/done, the per-school manifest, and hard failures that
//     explain why a section shows "_Not retrieved_" in the AI output.
//   Verbose-log — gated behind GOVUK_VERBOSE_LOGS=1.
//     Per-URL HTTP outcomes, intermediate per-school steps, buffer ops.
//     Turn on to debug a specific data-source problem; leave off in production.
//
// Journey you can trace with always-log only:
//   govuk_start  →  govuk_manifest (one per school)  →  govuk_done
//   Any failure events in between explain gaps in the output block.

const GOVUK_VERBOSE = process.env.GOVUK_VERBOSE_LOGS === '1';

const GLOG_ALWAYS = new Set([
  // Lifecycle — always needed for request tracing
  'govuk_no_names',    // explains why the block is empty
  'govuk_start',       // which schools are being fetched
  'govuk_manifest',    // per-school data-coverage map (see fetchGovDataForPrompt)
  'govuk_done',        // total ms + school counts

  // Hard failures — explain "_Not retrieved_" entries in the AI prompt block.
  // These fire at most once per school per data source, so noise is low.
  'govuk_gias_fail',               // URN lookup HTTP error → identity missing
  'govuk_gias_location_retry',     // stripping suffix to find location-matched candidates
  'govuk_ofsted_fail',             // Ofsted page HTTP error → grade missing
  'govuk_parentview_ok',           // Parent View fetched successfully
  'govuk_parentview_retry',        // Parent View retry on previous year
  'govuk_parentview_empty',        // Parent View — no data in any recent year
  'govuk_pdf_import_fail',   // pdf-parse not bundled → narrative missing
  'govuk_pdf_empty',         // PDF fetched but parse returned no text
  'govuk_perf_fail',         // DfE CSV download failed → performance missing
  'govuk_fin_census_fail',   // FBIT census ZIP failed → staffing/QTS missing
  'govuk_area_postcode_fail',// postcodes.io failed → area section missing
]);

function glog(event, props = {}) {
  if (!GOVUK_VERBOSE && !GLOG_ALWAYS.has(event)) return;
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), src: 'govuk', ...props }));
}

// ─── National averages (DfE published statistics) ────────────────────────────
// Updated once per year when DfE publishes provisional attainment data (typically Nov).
// Sources:
//   KS2:     https://explore-education-statistics.service.gov.uk/find-statistics/key-stage-2-attainment
//   KS4:     https://explore-education-statistics.service.gov.uk/find-statistics/key-stage-4-attainment
//   Absence: https://explore-education-statistics.service.gov.uk/find-statistics/pupil-absence-in-schools-in-england
// ⚠️  Verify and update these figures each November when DfE publishes new provisional data.
const NATIONAL_AVG = {
  // KS2 attainment 2024/25 (provisional, published Nov 2025)
  KS2: {
    PTRWM_EXP:              62,   // % meeting expected standard in reading, writing and maths
    PTRWM_HIGH:              8,   // % achieving higher standard in RWM
    PTREAD_EXP:             75,   // % meeting expected in reading
    PTMAT_EXP:              74,   // % meeting expected in maths
    PTWRITTA_EXP:           72,   // % meeting expected in writing (teacher assessment)
    PTGPS_EXP:              73,   // % meeting expected in grammar, punctuation and spelling
    PTSCITA_EXP:            82,   // % meeting expected in science (teacher assessment)
    PTREAD_HIGH:            33,   // % achieving higher standard in reading
    PTMAT_HIGH:             26,   // % achieving higher standard in maths
    PTWRITTA_HIGH:          13,   // % working at greater depth in writing
    PTGPS_HIGH:             30,   // % achieving higher standard in GPS
    PTRWM_EXP_FSM6CLA1A:   47,   // % disadvantaged meeting expected in RWM
    PTRWM_HIGH_FSM6CLA1A:   4,   // % disadvantaged achieving higher in RWM
    PTRWM_EXP_NFSM6CLA1A:  69,   // % non-disadvantaged meeting expected in RWM
    PTRWM_HIGH_NFSM6CLA1A: 11,   // % non-disadvantaged achieving higher in RWM
    PTREAD_EXP_FSM6CLA1A:  58,   // % disadvantaged meeting expected in reading (est. from 17pp gap)
    PTMAT_EXP_FSM6CLA1A:   54,   // % disadvantaged meeting expected in maths (est. from 20pp gap)
    PTWRITTA_EXP_FSM6CLA1A:53,   // % disadvantaged meeting expected in writing (est. from 19pp gap)
    PTGPS_EXP_FSM6CLA1A:   54,   // % disadvantaged meeting expected in GPS (est. from 19pp gap)
    PTSCITA_EXP_FSM6CLA1A: 65,   // % disadvantaged meeting expected in science (est. from 17pp gap)
    READPROG:               0.0,  // progress score national average = 0 by definition
    WRITPROG:               0.0,
    MATPROG:                0.0,
  },
  // KS4 attainment 2024/25 (provisional, published Oct 2025)
  // Source: https://www.compare-school-performance.service.gov.uk — verified May 2026
  KS4: {
    P8MEA:              0.00,  // Progress 8 — national average = 0 by definition
    ATT8SCR:           46.1,   // Attainment 8 score (was 46.4 — now 46.1)
    PTL2BASICS_95:     45.4,   // % achieving grade 5+ in English and maths (was 45.9)
    PTL2BASICS_94:     64.8,   // % achieving grade 4+ in English and maths (was 68.8)
    PTEBACC_E_PTQ_EE:  40.5,   // % entering EBacc (was 24.7)
    PTEBACC_94:        25.8,   // % achieving EBacc at grade 4+ (was 28.6)
    P8MEA_FSM6CLA1A:  -0.58,  // Progress 8 for disadvantaged pupils
    PTEBACC_95:        18.7,   // % achieving EBacc at grade 5+ (was missing)
    // Per-subject grade 5+ (England state-funded)
    EBACC_ENG_95:      60.4,   // English at grade 5+
    EBACC_MAT_95:      51.2,   // Maths at grade 5+
    EBACC_SCI_95:      47.9,   // Science at grade 5+
    EBACC_HUM_95:      51.3,   // Humanities at grade 5+
    EBACC_LAN_95:      60.7,   // Languages at grade 5+
    // Per-subject grade 4+ (England state-funded)
    EBACC_ENG_94:      74.3,   // English at grade 4+
    EBACC_MAT_94:      69.8,   // Maths at grade 4+
    EBACC_SCI_94:      65.8,   // Science at grade 4+
    EBACC_HUM_94:      63.5,   // Humanities at grade 4+
    EBACC_LAN_94:      73.1,   // Languages at grade 4+
    // Attainment 8 element breakdowns (England state-funded)
    ATT8_ENG:           9.8,   // English element
    ATT8_MAT:           9.1,   // Maths element
    ATT8_EBACC:        13.5,   // EBacc element
    ATT8_OPEN:         13.6,   // Open element
    ATT8_OPENG:        11.5,   // Open — GCSE only
    ATT8_OPENNG:        2.2,   // Open — non-GCSE
    // Per-subject grade 1+ (England state-funded)
    EBACC_ENG_1:        93.0,   // English at grade 1+
    EBACC_MAT_1:        94.5,   // Maths at grade 1+
    EBACC_SCI_1:        98.2,   // Science at grade 1+
    EBACC_HUM_1:        97.0,   // Humanities at grade 1+
    EBACC_LAN_1:        98.6,   // Languages at grade 1+
  },
  // KS5 / 16–18 attainment 2024/25 — England state-funded schools/colleges
  // Source: https://www.compare-school-performance.service.gov.uk — verified May 2026
  KS5: {
    AVG_GRADE:     'B-',            // England state-funded average A-level grade
    AVG_PTS:       36.1,            // England state-funded average A-level points per entry
    avgGradeDis:   'C+ (32 pts)',   // England state-funded average A-level grade (disadvantaged)
    avgGradeNonDis:'B- (36 pts)',   // England state-funded average A-level grade (non-disadvantaged)
    retained:      93.1,            // % retained to end of course (was 92.5)
    advMaths:      30.0,            // % achieving advanced maths
    aab2fac:       null,            // % AAB in 2 facilitating subjects — national not published inline
  },
  // Absence 2023/24 (most recent final data, published Jul 2024)
  ABSENCE: {
    PERCTOT:    6.6,   // overall absence %
    PPERSABS10: 21.3,  // persistent absence %
  },
};

// ─── Part A section registry — single source of truth ────────────────────────
// Every renderer, flag computer, and slim-block builder references these labels.
// To change a section heading, edit here and nowhere else.

const PART_A = {
  A1: 'School Identity',
  A2: 'Inspection Outcomes',
  A3: 'Academic Performance',
  A4: 'Intake & Cohort',
  A5: 'Absence & Engagement',
  A6: 'Financial Health',
  A7: 'Area Context',
  improvement: 'What the School Needs to Improve',  // unnumbered, between A2 and A3
};

/** "A2. Inspection Outcomes" */
const pa = (key) => /^A\d/.test(key) ? `${key}. ${PART_A[key]}` : PART_A[key];

/** Flag key for a section — e.g. paFlag('A2') → "A2. Inspection Outcomes" */
const paFlag = (key) => pa(key);

// ─── Shared data helpers ──────────────────────────────────────────────────────

const _parseNum = v => (v != null && typeof v === 'string') ? parseFloat(v.replace(/[%,£\s,]/g, '')) : Number(v);
const _fmtVal = v => { const n = _parseNum(v); return !isNaN(n) ? n.toFixed(1) : null; };
const _fmtPct = v => { const n = _parseNum(v); return !isNaN(n) ? n.toFixed(1) + '%' : null; };
const _val = (v, fallback) => v != null ? v : (fallback ?? '—');
const _isState = s => !(s?.identity?.isIndependent ?? false);

const _nsField = (s, variable) => {
  const perf = s?.performance ?? {};
  const sorted = Object.entries(perf)
    .sort(([a], [b]) => (parseInt(b.match(/_\d+$/)?.[1] ?? '0', 10) - parseInt(a.match(/_\d+$/)?.[1] ?? '0', 10)))
    .flatMap(([, rows]) => rows);
  return sorted.find(r => r.variable === variable)?.value ?? null;
};

const _lField = (s, v) => (s?.performance?.L ?? []).find(r => r.variable === v)?.value ?? null;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

// Government sites block non-browser User-Agents; use a realistic one.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Retry wrapper — only retries on timeout/network errors, not HTTP 4xx/5xx
async function withRetry(fn, retries = 2, baseDelayMs = 800) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await fn();
    if (result !== null) return result;
    if (attempt < retries) {
      await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
    }
  }
  return null;
}

async function safeFetchText(url, extraHeaders = {}) {
  const tag = url.slice(0, 100);
  const attempt = async () => {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
          'Accept-Language': 'en-GB,en;q=0.9',
          ...extraHeaders,
        },
      });
      if (!res.ok) { glog('fetch_text_fail', { url: tag, status: res.status }); return null; }
      return await res.text();
    } catch (err) {
      glog('fetch_text_err', { url: tag, err: String(err.message ?? err).slice(0, 120) });
      return null;
    }
  };
  return withRetry(attempt);
}

async function safeFetchJson(url, extraHeaders = {}) {
  const tag = url.slice(0, 100);
  const attempt = async () => {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'application/json,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9',
          ...extraHeaders,
        },
      });
      if (!res.ok) { glog('fetch_json_fail', { url: tag, status: res.status }); return null; }
      return await res.json();
    } catch (err) {
      glog('fetch_json_err', { url: tag, err: String(err.message ?? err).slice(0, 120) });
      return null;
    }
  };
  return withRetry(attempt);
}

// ─── Ofsted PDF extraction ────────────────────────────────────────────────────

/**
 * Fetches the Ofsted report PDF and extracts key narrative sections:
 *  - "What it's like to be a pupil / to attend this school"
 *  - "Next steps" (inspector improvement flags)
 *
 * Returns { pupilExperience, nextSteps } or null on failure.
 */
export async function fetchAndParseOfstedPdf(reportUrl) {
  if (!reportUrl) return null;

  // pdf-parse v1.1.1 — import from lib directly to bypass the self-test that
  // tries to open './test/data/05-versions-space.pdf' on module load (fails in Lambda).
  // Import once outside the retry loop so it isn't re-evaluated on each attempt.
  // Guard with try/catch: if pdf-parse is absent from the Lambda bundle the import
  // throws "Cannot find package", which would otherwise poison the Promise.all in
  // fetchGovDataForPrompt and discard ALL pre-fetched gov.uk data.
  let pdfParse;
  try {
    const mod = await import('pdf-parse/lib/pdf-parse.js');
    pdfParse = mod.default ?? mod;
  } catch (err) {
    glog('govuk_pdf_import_fail', { error: String(err.message ?? err).slice(0, 120) });
    return null;
  }

  let fullText;
  // Retry once: Ofsted CDN is occasionally slow and a single 20-second window
  // causes ~75% failure rate under light load. Two attempts covers the tail.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(reportUrl, {
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': BROWSER_UA },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      const parsed = await pdfParse(buffer);
      fullText = parsed?.text ?? null;
      if (fullText) break; // success — don't retry
    } catch (err) {
      glog('govuk_pdf_attempt_fail', { url: reportUrl, attempt, error: err.message });
      if (attempt === 2) return null; // both attempts failed
      await new Promise(r => setTimeout(r, 500)); // brief pause before retry
    }
  }

  if (!fullText) { glog('govuk_pdf_empty', { url: reportUrl }); return null; }

  // Normalise whitespace: collapse horizontal runs, unify line endings.
  // Then rejoin lines that are clearly mid-sentence (PDF hard-wraps mid-line):
  // if a line does NOT end with a sentence-terminal character (. ! ? : — or a
  // bullet marker) and the next line starts with a lowercase letter or a
  // continuation character, collapse the newline to a space.
  // Lines that start bullets (- •) or are blank are left intact.
  const text = fullText
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    // Strip Ofsted PDF page headers that appear inline in extracted text.
    // Pattern: "Inspection report: [School Name]\n[date line]\n[page number]\n"
    // The date line contains a 4-digit year; the page number is digits only.
    .replace(/\n+Inspection report:[^\n]+\n+[^\n]*\d{4}[^\n]*\n+\d+\n+/g, '\n')
    .replace(/([^\n.!?:—\-•])\n(?=[a-z,;(])/g, '$1 ');

  // Shared cleanup for extracted PDF text — strips page artifacts that
  // bleed through from PDF headers/footers regardless of the specific
  // Ofsted report format (pre-2019, 2019–2024, Nov-2025+).
  const cleanExtractedText = (raw) => {
    if (!raw) return null;
    return raw
      // Strip page-header lines: "Inspection report: School Name"
      .replace(/\n+\s*Inspection report:[^\n]*/gi, '\n')
      // Strip date lines that appear as page headers ("6 and 7 December 2023")
      .replace(/\n+\s*\d{1,2}\s+(?:and\s+\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\s*\n+/gi, '\n')
      // Strip standalone page numbers (1-3 digits on their own line)
      .replace(/\n\s*\d{1,3}\s*\n/g, '\n')
      // Strip PDF Private Use Area bullet glyphs → plain hyphen
      .replace(/[-]/g, '- ')
      // Clean doubled bullets
      .replace(/^- - /gm, '- ')
      // Collapse multiple blank lines
      .replace(/\n{3,}/g, '\n\n')
      .trim() || null;
  };

  // ── Extract sub-grades from PDF text ──────────────────────────────────────
  // Ofsted PDFs list grades on page 1–2 in a block.  Two frameworks exist:
  //   2019–2024: Quality of education / Behaviour and attitudes / Personal
  //              development / Leadership and management
  //   Pre-2019:  Quality of teaching, learning and assessment / Personal
  //              development, behaviour and welfare / Outcomes for pupils /
  //              Effectiveness of leadership and management
  // Both list "Overall effectiveness" first.
  const pdfSubGrades = {};
  // Match: "Label Grade" or "Label: Grade" or "Label – Grade"
  const gradeRe = /(Overall effectiveness|Quality of education|Behaviour and attitudes|Personal development(?:,\s*behaviour\s+and\s+welfare)?|Leadership and management|Effectiveness of leadership and management|Early years provision|Sixth form provision|Achievement|Attendance and behaviour|Curriculum and teaching|Inclusion|Leadership and governance|Personal development and wellbeing|Quality of teaching,\s*learning\s+and\s+assessment|Outcomes for pupils|Personal development,\s*behaviour\s+and\s+welfare)\s*(?:–|-|:)?\s*(Outstanding|Good|Requires Improvement|Inadequate|Excellent)/gi;
  for (const m of text.matchAll(gradeRe)) {
    const label = m[1].toLowerCase().trim().replace(/,/g, '');
    const grade = m[2];
    pdfSubGrades[label] = grade;
    // Map to the camelCase keys used downstream.
    // Current framework (2019–2024)
    if (label === 'quality of education'
        || label === 'curriculum and teaching'
        || label === 'quality of teaching learning and assessment')
      pdfSubGrades.qualityOfEducation = grade;
    if (label === 'behaviour and attitudes'
        || label === 'attendance and behaviour'
        || label === 'behaviour and safety of pupils')
      pdfSubGrades.behaviour = grade;
    if (label === 'personal development'
        || label === 'personal development and wellbeing'
        || label === 'personal development behaviour and welfare') {
      pdfSubGrades.personalDevelopment = grade;
      if (label === 'personal development behaviour and welfare')
        pdfSubGrades.behaviour = grade;  // old framework merged these two
    }
    // Old framework (pre-2019): catch all sub-grades
    if (label === 'outcomes for children and learners'
        || label === 'outcomes for pupils')
      pdfSubGrades.achievement = grade;
    if (label === 'quality of teaching'
        || label === 'quality of teaching learning and assessment')
      pdfSubGrades.qualityOfEducation = grade;
    if (label === 'leadership and management'
        || label === 'leadership and governance'
        || label === 'effectiveness of leadership and management')
      pdfSubGrades.leadership = grade;
    if (label === 'outcomes for pupils')
      pdfSubGrades.achievement = grade;
    if (label === 'achievement')
      pdfSubGrades.achievement = grade;
    if (label === 'early years provision')
      pdfSubGrades.earlyYears = grade;
    if (label === 'sixth form provision')
      pdfSubGrades.sixthForm = grade;
  }

  return {
    // PDF-extracted sub-grades (fallback when HTML scrape finds none)
    pdfSubGrades: Object.keys(pdfSubGrades).length > 0 ? pdfSubGrades : null,

    // ── Present in all report types ───────────────────────────────────────
    // "What it's like to be a pupil / attend this school" — the introductory
    // narrative paragraph(s). Truncated to ~800 chars so the AI summarises
    // rather than reproducing the full PDF text verbatim.
    pupilExperience: cleanExtractedText(extractSection(text, [
      /what\s+is\s+it\s+like\s+to\s+attend\s+this\s+school/i,
      /what\s+it['']s\s+like\s+to\s+be\s+a\s+pupil/i,
      /what\s+it\s+is\s+like\s+to\s+be\s+a\s+pupil/i,
    ], 5000)?.slice(0, 800) ?? null),

    // ── Old framework (pre-Nov 2025) graded inspection sub-sections ───────
    qualityOfEducation: cleanExtractedText(extractSection(text, [
      /^quality\s+of\s+education\s*$/im,
      /^curriculum\s+and\s+teaching\s*$/im,
    ])),
    behaviourAndAttitudes: cleanExtractedText(extractSection(text, [
      /^behaviour\s+and\s+attitudes?\s*$/im,
      /^attendance\s+and\s+behaviour\s*$/im,
    ])),
    personalDevelopment: cleanExtractedText(extractSection(text, [
      /^personal\s+development\s*$/im,
      /^personal\s+development\s+and\s+wellbeing\s*$/im,
    ])),
    leadershipAndManagement: cleanExtractedText(extractSection(text, [
      /^leadership\s+and\s+management\s*$/im,
      /^leadership\s+and\s+governance\s*$/im,
    ])),

    // ── New Nov-2025 format sections (not present in older reports) ────────
    achievement: cleanExtractedText(extractSection(text, [/^achievement\s*$/im])),
    inclusion:   cleanExtractedText(extractSection(text, [/^inclusion\s*$/im])),

    // ── Improvement flags ─────────────────────────────────────────────────
    // Heading varies by report era:
    //   Nov 2025+  → "Next steps"
    //   2019–2024  → "What does the school need to do to improve?"
    //   2022–2024  → "What does the school do well and what does it need to do better?"
    //                (merged section — Outstanding schools have no bullet requirements
    //                 inside it; non-Outstanding schools list improvement items)
    //   Older      → "Areas for improvement"
    nextSteps: (() => {
      const raw = extractSection(text, [
        /^next\s+steps\s*$/im,
        /^what\s+does\s+the\s+school\s+need\s+to\s+do\s+to\s+improve/im,
        /^what\s+does\s+the\s+school\s+do\s+well\s+and\s+what\s+does\s+it\s+need\s+to\s+do\s+better/im,
        /^areas\s+for\s+improvement\s*$/im,
      ]);
      if (!raw) return null;
      // Strip only the Ofsted legal/admin preamble — not the content header.
      // "The school needs to do the following:" is kept because it signals that
      // improvement requirements exist, even when pdf-parse cannot extract the
      // bullets (table/image layout in some PDFs).
      return raw
        .replace(/^\s*\(Information for the school[^)]*\)\s*/i, '')
        // Strip Ofsted admin boilerplate that follows the actual requirements
        .replace(/\n+\s*How can I feed back my views\?[\s\S]*/i, '')
        .replace(/\n+\s*The Department for Education has further guidance[\s\S]*/i, '')
        // Strip Ofsted PDF page footer that bleeds in when next-steps runs to
        // the bottom of a page: "Inspection report: School Name\nDate\nPageNum\n***"
        .replace(/\n+\s*Inspection report:[\s\S]*/i, '')
        // Strip stray lone page numbers (a bare digit or two on its own line)
        .replace(/\n\s*\d{1,3}\s*\n/g, '\n')
        // Strip separator lines of asterisks
        .replace(/\n\s*\*{3,}\s*\n?/g, '\n')
        // Replace PDF Private Use Area bullet glyphs (e.g. \uf06e from Wingdings/Symbol)
        // with a plain hyphen-space so output is readable.
        .replace(/[\uE000-\uF8FF]/g, '- ')
        // Clean up any doubled bullet markers that result
        .replace(/^- - /gm, '- ')
        .trim() || null;
    })(),
  };
}

/**
 * Finds a section in PDF text by matching one of several heading patterns,
 * then returns the text up to the next heading (capitalised line) or maxChars.
 *
 * @param {string}   text      - Full normalised PDF text
 * @param {RegExp[]} patterns  - Ordered list of heading patterns to try
 * @param {number}   [maxChars=3000] - Maximum characters to return
 */
function extractSection(text, patterns, maxChars = 3000) {
  for (const pattern of patterns) {
    const match = text.search(pattern);
    if (match === -1) continue;

    // Start after the heading line
    const afterHeading = text.indexOf('\n', match);
    if (afterHeading === -1) continue;
    const start = afterHeading + 1;

    // End at next heading-like line (capitalised short line) or maxChars
    const window = maxChars + 1000;   // lookahead buffer
    const chunk = text.slice(start, start + window);
    const nextHeading = chunk.search(/\n[A-Z][A-Za-z ,'\-]{5,60}\n/);
    const end = nextHeading > 100 ? nextHeading : Math.min(chunk.length, maxChars);

    const section = chunk.slice(0, end).trim();
    if (section.length > 50) return section;
  }
  return null;
}

// ─── Location hint extraction ─────────────────────────────────────────────────

/**
 * Extracts location tokens from the question that can disambiguate schools
 * when multiple GIAS results share the same name.
 *
 * Returns an array of lowercase strings (postcode outward codes, full
 * postcodes, London borough names, major city names) found in the question.
 * These are matched against each GIAS tile's postcode / LA / address text.
 */
export function extractLocationHints(question, schoolNames = []) {
  const hints = new Set();
  const q = question.toLowerCase();

  // Full postcode: SE16 4PS → normalised to "se164ps"
  for (const m of question.matchAll(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b/gi)) {
    hints.add((m[1] + m[2]).toLowerCase());   // se164ps
    hints.add(m[1].toLowerCase());             // se16  (outward code alone as backup)
  }

  // Outward code alone when no inward part given: SE16, SW1, EC2, W1A …
  for (const m of question.matchAll(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\b/gi)) {
    hints.add(m[1].toLowerCase());
  }

  // London boroughs (covers informal names parents actually write)
  const BOROUGHS = [
    'southwark','bermondsey','lambeth','hackney','islington','camden',
    'tower hamlets','greenwich','lewisham','wandsworth','hammersmith',
    'fulham','kensington','chelsea','westminster','city of london',
    'barking','dagenham','havering','redbridge','newham','waltham forest',
    'haringey','enfield','barnet','harrow','brent','ealing','hounslow',
    'richmond','kingston','merton','sutton','croydon','bromley','bexley',
    'sidcup','rotherhithe','peckham','brixton','clapham','stockwell',
    'elephant and castle','old street','shoreditch','bethnal green',
    'whitechapel','bow','stratford','forest gate','ilford',
  ];
  for (const b of BOROUGHS) {
    if (q.includes(b)) hints.add(b);
  }

  // Major cities / towns (fallback for non-London schools)
  const CITIES = [
    'birmingham','manchester','liverpool','leeds','sheffield','bristol',
    'nottingham','leicester','coventry','bradford','cardiff','edinburgh',
    'glasgow','belfast','newcastle','gateshead','sunderland','middlesbrough',
    'reading','oxford','cambridge','brighton','hove','portsmouth','southampton',
    'exeter','plymouth','derby','stoke','wolverhampton','hull','york','Norwich',
    'ipswich','luton','milton keynes','slough','watford','gloucester','cheltenham',
    'hereford','shrewsbury','worcester','bath','swindon','salisbury','winchester',
    'maidstone','guildford','crawley','hastings','eastbourne','folkestone',
    'gillingham','rochester','chatham','barking','hullbridge','wirral','wirral',
    'reigate','dorking','epsom','farnham','godalming','haslemere','leatherhead',
    'redhill','staines','weybridge','woking','banstead','cobham','esher',
    'hounslow','kingston upon thames','richmond upon thames','surbiton',
    'sunbury','ashford','caterham','chertsey','egham','horley','walton',
    'sevenoaks','tonbridge','tunbridge wells','canterbury','dover','faversham',
    'whitstable','herne bay','margate','ramsgate','broadstairs','deal',
    'crowborough','east grinstead','haywards heath','lewes','uckfield',
    'henley','marlow','windsor','ascot','bracknell','wokingham','crowthorne',
    'sandhurst','camberley','fleet','farnborough','aldershot','basingstoke',
    'andover','petersfield','havant','fareham','gosport','lymington',
  ];
  for (const c of CITIES) {
    if (q.includes(c.toLowerCase())) hints.add(c.toLowerCase());
  }

  // Broad sweep: any word 3+ chars not in stop words, not a school-name token,
  // and not already captured is likely a location indicator (town, village, area).
  // This catches places like Reigate, Knutsford, Sevenoaks that aren't in the
  // hardcoded CITIES list.  False positives are harmless — the location bonus
  // only fires when the word actually appears in a tile's postcode/LA/address.
  const schoolTokens = new Set(
    schoolNames.flatMap(n => n.toLowerCase().split(/\s+/))
  );
  // Also exclude words that look like school-type suffixes
  const SCHOOL_TYPE_WORDS = new Set([
    'school','college','academy','grammar','primary','secondary','prep',
    'preparatory','infant','junior','senior','high','upper','lower','middle',
    'foundation','nursery','convent','sixth','form','free',
  ]);
  for (const word of q.split(/[^a-z0-9'-]+/)) {
    const w = word.replace(/^['-]+|['-]+$/g, '');
    if (w.length < 3) continue;
    if (REGEX_STOP_WORDS.has(w)) continue;
    if (SCHOOL_TYPE_WORDS.has(w)) continue;
    if (schoolTokens.has(w)) continue;
    if (hints.has(w)) continue;
    // Skip postcode-shaped tokens (already captured above)
    if (/^[a-z]{1,2}\d{1,2}[a-z]?$/.test(w)) continue;
    hints.add(w);
  }

  return [...hints];
}

// ─── School name extraction ───────────────────────────────────────────────────

/**
 * Regex-based extraction. Matches title-cased word sequences that end in a
 * recognised school-type suffix. Fast but misses short-form names ("Eton").
 */
// Common English words that should never be treated as school-name tokens
// even when title-cased.  Keep this compact — false positives are worse than
// false negatives because they make the regex greedily consume sentence words.
const REGEX_STOP_WORDS = new Set([
  // pronouns / determiners
  'i','me','my','we','us','our','you','your','he','she','his','her','they',
  'them','their','it','its','this','that','these','those',
  // common verbs / auxiliaries
  'am','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','shall','would','should',
  'could','may','might','must','can','get','got','go','goes','went',
  // question / request words
  'what','which','who','whom','whose','when','where','how','why',
  'please','tell','told','ask','asked','asking','know','think','thought',
  'wonder','wondering','check','find','look','looking','want','need','like','liked',
  // comparison words — never part of a school name
  'vs','versus','compare','comparing','between',
  // prepositions / conjunctions
  'a','an','the','in','on','at','to','for','of','or','and','but','nor',
  'with','from','by','about','into','onto','upon','near','nearby',
  'close','around','between','across','over','under','after','before',
  // common adjectives / adverbs that are never school-name tokens
  'good','best','great','really','very','quite','just','also','too','so',
  'there','here','yes','no','not','only','even','still','now','then',
  // misc sentence filler
  'well','right','sure','okay','ok','up','its','it\'s','there\'s',
  'local','area','child','kid','son','daughter','us','them',
]);

function extractNamesRegex(question) {
  const pattern =
    /\b([A-Z][a-zA-Z'-]+(?:\s+(?:of|the|and|&|St\.?|Saint|de|la|les|upon|at)?\s*[A-Z][a-zA-Z'-]+){0,6}\s+(?:School|College|Academy|Grammar|Primary|Secondary|Prep|Preparatory|Infant|Junior|Senior|High|Upper|Lower|Middle|Foundation|Free\s+School|Sixth\s+Form|Nursery|Convent))\b/g;

  // Words that appear as school-type descriptors, not school names.
  // "State Infant" should not match just because Infant is a phase label.
  const DESCRIPTOR_WORDS = new Set([
    'state', 'independent', 'private', 'maintained', 'voluntary',
    'community', 'foundation', 'trust', 'academy', 'free',
    'co-ed', 'coeducational', 'mixed', 'boys', 'girls', 'single',
    'selective', 'non-selective', 'grammar',
    'infant', 'junior', 'primary', 'secondary', 'nursery',
    'school', 'college', 'prep', 'preparatory', 'senior', 'high',
    'upper', 'lower', 'middle', 'sixth', 'form', 'convent',
    'toddler',
  ]);

  const isDescriptorOnly = (name) => {
    const words = name.split(/\s+/).filter(w => !/^(of|the|and|&|in|at|for)$/i.test(w));
    // If all meaningful words are type descriptors, it's not a school name
    return words.length > 0 && words.every(w => DESCRIPTOR_WORDS.has(w.toLowerCase()));
  };

  // First pass: try on the original question (handles already-capitalised input).
  // Normalise: all-caps words → lowercase, mid-word caps → lowercase
  // "FORTISMERE SCHOOL" → "fortismere school", "COllege" → "College"
  let qNorm = question.replace(/\b([A-Z]{2,})\b/g, w => w.toLowerCase());
  qNorm = qNorm.replace(/\B[A-Z]\B/g, c => c.toLowerCase());
  const matches1 = [...qNorm.matchAll(pattern)]
    .map(m => m[1].trim())
    .filter(n => !isDescriptorOnly(n));
  if (matches1.length) return [...new Set(matches1)];

  // Second pass: capitalise non-stop-words so the pattern can find school names
  // in all-lowercase queries like "redriff primary se16".
  // Stop-words are left as-is so "Tell me about Eton College" → only "Eton"
  // is capitalised in the name-candidate area.
  const normalised = question.replace(/\b([a-z][a-zA-Z'-]*)\b/g, (word) =>
    REGEX_STOP_WORDS.has(word.toLowerCase())
      ? word
      : word.charAt(0).toUpperCase() + word.slice(1)
  );

  const matches2 = [...normalised.matchAll(pattern)]
    .map(m => m[1].trim())
    .filter(n => !isDescriptorOnly(n));
  if (matches2.length) return [...new Set(matches2)];

  // Third pass: comparison-aware. Split on vs/or/compare/between.
  const comparisonDelim = /\b(?:vs\.?|versus|or|compare|between)\b/i;
  if (comparisonDelim.test(question)) {
    const segments = question.split(comparisonDelim);
    const candidates = [];
    const NAME_CONNECTORS = new Set(['of', 'the', 'and', '&', 'st', 'saint', 'de', 'la', 'les', 'upon', 'at']);
    const STOP = new Set(['what','which','where','when','why','how','tell','find','show','give','need','want','looking','help','please','there','their','they','this','that','these','those','does','should','could','would','will','can','may','with','without','more','less','most','for','who','is','a','an','the','in','on','at','to','from','of','by']);
    for (const seg of segments) {
      const words = seg.trim().split(/\s+/);
      let i = 0;
      while (i < words.length) {
        const w = words[i];
        if (!/^[A-Z]/.test(w) || STOP.has(w.toLowerCase())) { i++; continue; }
        const phrase = [w];
        let j = i + 1;
        while (j < words.length) {
          const nw = words[j]; const lw = nw.toLowerCase();
          if (NAME_CONNECTORS.has(lw) || /^(St\.?|Saint)$/i.test(nw)) { phrase.push(nw); j++; continue; }
          if (/^[A-Z]/.test(nw) && !STOP.has(lw) && !NAME_CONNECTORS.has(lw)) { phrase.push(nw); j++; continue; }
          break;
        }
        const name = phrase.join(' ');
        if (!isDescriptorOnly(name)) candidates.push(name);
        i = j;
      }
    }
    // Split any candidate on " and " for schools like "Redriff Primary and Alfred Salter"
    const out = [];
    for (const c of candidates) {
      if (/\band\b/i.test(c)) out.push(...c.split(/\s+and\s+/i).filter(p => p.trim()));
      else out.push(c);
    }
    if (out.length >= 2) return [...new Set(out)];
  }

  return [];
}

/**
 * AI-assisted extraction via a minimal preflight call to the Responses API.
 * Used as a fallback when regex returns zero results, or for branch 2 where
 * short-form names are common ("Eton vs Winchester").
 */
async function extractNamesAI(question, branch, apiKey, baseUrl, model) {
  console.log(JSON.stringify({ event: 'ai_extract_enter', question: question.slice(0, 80), branch }));
  const isComparison = branch === 'prompt_branch_2';
  const instructions = isComparison
    ? 'Extract all school names from the text. Return ONLY a JSON array of strings. Example: ["Eton College","Winchester College"]. If none found, return [].'
    : 'Extract the school name from the text. Return ONLY a JSON array with one string. Example: ["Highgate School"]. If none found, return [].';

  try {
    const res = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      signal: AbortSignal.timeout(6000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        instructions,
        input: question,
        max_output_tokens: 80,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    // Check both output_text and output[].content[].text
    let text = (data.output_text ?? '').trim();
    if (!text && Array.isArray(data.output)) {
      const fragments = [];
      for (const item of data.output) {
        if (Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.text?.trim()) fragments.push(c.text);
          }
        }
      }
      text = fragments.join(' ').trim();
    }
    if (!text) return [];
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    return JSON.parse(match[0]).filter(n => typeof n === 'string' && n.trim());
  } catch {
    return [];
  }
}

/**
 * Returns an array of school name strings to look up.
 * Tries regex first; falls back to AI when regex misses or finds too few
 * names for a comparison query.
 */
/**
 * Builds a search phrase from the distinctive words in a question — words that
 * are neither stop-words nor school-type descriptors. Used as a fallback when
 * regex name extraction finds nothing, so GIAS token-based search can match
 * reordered/fragmented names like "latymer godolphin" → "Godolphin and Latymer".
 */
function extractSearchPhrase(question) {
  const SCHOOL_WORDS = new Set([
    'school','college','academy','grammar','primary','secondary','prep',
    'preparatory','infant','junior','senior','high','upper','lower','middle',
    'foundation','nursery','convent','sixth','form','free','state',
    'independent','private','maintained','voluntary','community','trust',
    'co-ed','coeducational','mixed','boys','girls','single','selective',
    'non-selective','toddler','sen','send','ehc','fsm','eal','pupil','pupils','ofsted',
  ]);

  return question
    .split(/[^a-z0-9'-]+/i)
    .filter(w => {
      const lw = w.toLowerCase();
      if (lw.length < 3) return false;
      if (REGEX_STOP_WORDS.has(lw)) return false;
      if (SCHOOL_WORDS.has(lw)) return false;
      // Skip words that look like postcodes
      if (/^[a-z]{1,2}\d{1,2}[a-z]?$/i.test(w)) return false;
      return true;
    })
    .join(' ');
}

async function extractSchoolNames(question, branch, apiKey, baseUrl, model) {
  const regexNames = extractNamesRegex(question);
  const isComparison = branch === 'prompt_branch_2';

  const cleanNames = (names) => names
    .map(n => n.replace(/^(Compare|Versus|Vs\.?)\s+/i, '').trim())
    .map(n => n.replace(/\s+[A-Z]{1,2}\d{1,2}[A-Z]?(\s*\d[A-Z]{2})?$/i, '').trim())
    .map(n => n.replace(/'([A-Z])/g, (_, ch) => "'" + ch.toLowerCase()))
    .map(n => n.replace(/\B[A-Z]\B/g, ch => ch.toLowerCase()))
    .map(n => n.replace(/\b[Cc]olledge\b/g, 'College'))  // common misspelling
    .filter(Boolean);

  // Regex is sufficient when it found results and this isn't a comparison
  if (regexNames.length >= 1 && !isComparison) return cleanNames(regexNames);
  // For comparisons we want ≥2; fall through to AI if we have fewer
  if (regexNames.length >= 2 && isComparison) return cleanNames(regexNames);

  // Always use AI when regex finds nothing — search phrases can't fix misspellings.
  const aiNames = await extractNamesAI(question, branch, apiKey, baseUrl, model);
  if (aiNames.length) return cleanNames(aiNames);

  // Fall back to keyword search phrase if AI returns nothing
  const phrase = extractSearchPhrase(question);
  if (phrase && regexNames.length === 0 && phrase.split(/\s+/).length >= 2) return cleanNames([phrase]);

  return regexNames;
}

// ─── GIAS URN lookup ──────────────────────────────────────────────────────────

/**
 * Searches GIAS by name, parses all result tiles, and returns the best match.
 *
 * GIAS renders results as <li class="gias-result-tile"> cards, not a table.
 * Each card has:
 *   <h3><a href="/Establishments/.../Details/[URN]?...">School Name</a></h3>
 *   <dl>
 *     <dt>Phase / type:</dt><dd>Secondary, Independent schools</dd>
 *     <dt class="result-urn-label">URN:</dt><dd class="result-urn-value">123456</dd>
 *   </dl>
 */
export async function lookupSchoolURN(name, locationHints = []) {
  const url =
    `${GIAS_SEARCH}?TextSearchModel.Text=${encodeURIComponent(name)}&SelectedTab=Establishments`;

  const html = await safeFetchText(url);
  if (!html) { glog('govuk_gias_fail', { name }); return null; }

  // Parse every result tile
  const tiles = [];
  const tileRe = /<li[^>]*class="[^"]*gias-result-tile[^"]*"[^>]*>([\s\S]*?)<\/li>/g;

  for (const tileMatch of html.matchAll(tileRe)) {
    const tile = tileMatch[1];

    // Name + URN from the heading link
    const linkMatch = tile.match(
      /href="\/Establishments\/Establishment\/Details\/(\d{5,7})[^"]*"[^>]*>\s*([^<]+?)\s*<\/a>/
    );
    if (!linkMatch) continue;

    const urn      = linkMatch[1];
    const tileName = linkMatch[2].trim();

    // Phase / type from the DL: <dt>Phase / type:</dt><dd>Secondary, Independent schools</dd>
    const ptMatch     = tile.match(/Phase\s*\/\s*type[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
    const phaseTypeRaw = ptMatch
      ? ptMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      : null;

    const parts         = phaseTypeRaw ? phaseTypeRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const phase         = parts[0] ?? null;
    const type          = parts.slice(1).join(', ') || null;
    const isIndependent = /independent/i.test(phaseTypeRaw ?? '');

    const statusMatch = tile.match(/Status[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
    const status      = statusMatch ? statusMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
    const isOpen      = !status || /^open$/i.test(status);

    const laMatch = tile.match(/Local\s+authority[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
    const la      = laMatch ? laMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;

    // Address and postcode — used for location-based tiebreaking when multiple
    // schools share the same name. GIAS tiles show address inline; postcode is
    // typically the last token.
    const addrMatch = tile.match(/Address[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
    const address   = addrMatch
      ? addrMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          .replace(/&#39;/gi, "'").replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
      : null;

    // Also try to pull a postcode-shaped token directly from the raw tile text.
    // GIAS renders the postcode visibly on every card (e.g. "SE16 4PS").
    const tileText    = tile.replace(/<[^>]+>/g, ' ');
    const pcMatch     = tileText.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b/);
    const postcode    = pcMatch ? `${pcMatch[1]}${pcMatch[2]}`.toLowerCase() : null;  // e.g. "se164ps"
    const outward     = pcMatch ? pcMatch[1].toLowerCase() : null;                    // e.g. "se16"

    tiles.push({ urn, officialName: tileName, type, phase, la, address, postcode, outward, isIndependent, isOpen });
  }

  if (!tiles.length) {
    // Zero tiles — retry with just the distinctive name part (strip school-type
    // suffix like "Primary", "School", "Academy") so GIAS fuzzy search has a
    // better chance of handling spelling variations (e.g. "Mickelfield" → "Micklefield").
    const stripped = name
      .replace(/\b(School|College|Academy|Grammar|Primary|Secondary|Prep|Preparatory|Infant|Junior|Senior|High|Upper|Lower|Middle|Foundation|Nursery|Convent|Sixth\s+Form|Free\s+School)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (stripped && stripped.toLowerCase() !== name.toLowerCase()) {
      glog('govuk_gias_retry', { name, stripped });
      const url2 = `${GIAS_SEARCH}?TextSearchModel.Text=${encodeURIComponent(stripped)}&SelectedTab=Establishments`;
      const html2 = await safeFetchText(url2);
      if (html2) {
        for (const tileMatch of html2.matchAll(tileRe)) {
          const tile = tileMatch[1];
          const linkMatch = tile.match(/href="\/Establishments\/Establishment\/Details\/(\d{5,7})[^"]*"[^>]*>\s*([^<]+?)\s*<\/a>/);
          if (!linkMatch) continue;
          const urn = linkMatch[1]; const tileName = linkMatch[2].trim();
          const ptMatch = tile.match(/Phase\s*\/\s*type[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
          const phaseTypeRaw = ptMatch ? ptMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
          const parts = phaseTypeRaw ? phaseTypeRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
          const phase = parts[0] ?? null; const type = parts.slice(1).join(', ') || null;
          const isIndependent = /independent/i.test(phaseTypeRaw ?? '');
          const statusMatch = tile.match(/Status[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
          const status = statusMatch ? statusMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
          const isOpen = !status || /^open$/i.test(status);
          const laMatch = tile.match(/Local\s+authority[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
          const la = laMatch ? laMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
          const addrMatch = tile.match(/Address[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
          const address = addrMatch
            ? addrMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
                .replace(/&#39;/gi, "'").replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
            : null;
          const tileText = tile.replace(/<[^>]+>/g, ' ');
          const pcMatch = tileText.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b/);
          const postcode = pcMatch ? `${pcMatch[1]}${pcMatch[2]}`.toLowerCase() : null;
          const outward = pcMatch ? pcMatch[1].toLowerCase() : null;
          tiles.push({ urn, officialName: tileName, type, phase, la, address, postcode, outward, isIndependent, isOpen });
        }
      }
    }
    if (!tiles.length) { glog('govuk_gias_no_result', { name }); return null; }
  }

  const nameLower = name.toLowerCase().trim();
  const hintsLower = locationHints.map(h => h.toLowerCase());

  // When location hints are supplied but no tile matches any of them, the
  // school-type suffix (e.g. "Primary") may be narrowing GIAS results to the
  // wrong phase. Retry with the suffix stripped to find more candidates.
  // Example: "Micklefield Primary" + hint "reigate" returns only the Leeds
  // school; stripping "Primary" finds "Micklefield School" in Reigate.
  if (hintsLower.length) {
    const anyTileMatchesHint = tiles.some(tile => {
      const locationText = [tile.postcode, tile.outward, tile.la?.toLowerCase(), tile.address?.toLowerCase()]
        .filter(Boolean).join(' ');
      return hintsLower.some(h => locationText.includes(h));
    });
    if (!anyTileMatchesHint) {
      const stripped = name
        .replace(/\b(School|College|Academy|Grammar|Primary|Secondary|Prep|Preparatory|Infant|Junior|Senior|High|Upper|Lower|Middle|Foundation|Nursery|Convent|Sixth\s+Form|Free\s+School)\b/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (stripped && stripped.toLowerCase() !== name.toLowerCase()) {
        glog('govuk_gias_location_retry', { name, stripped, hints: hintsLower });
        const url2 = `${GIAS_SEARCH}?TextSearchModel.Text=${encodeURIComponent(stripped)}&SelectedTab=Establishments`;
        const html2 = await safeFetchText(url2);
        if (html2) {
          const seenUrns = new Set(tiles.map(t => t.urn));
          for (const tileMatch of html2.matchAll(tileRe)) {
            const tile = tileMatch[1];
            const linkMatch = tile.match(/href="\/Establishments\/Establishment\/Details\/(\d{5,7})[^"]*"[^>]*>\s*([^<]+?)\s*<\/a>/);
            if (!linkMatch) continue;
            const urn = linkMatch[1];
            if (seenUrns.has(urn)) continue;
            seenUrns.add(urn);
            const tileName = linkMatch[2].trim();
            const ptMatch = tile.match(/Phase\s*\/\s*type[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
            const phaseTypeRaw = ptMatch ? ptMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
            const parts = phaseTypeRaw ? phaseTypeRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
            const phase = parts[0] ?? null; const type = parts.slice(1).join(', ') || null;
            const isIndependent = /independent/i.test(phaseTypeRaw ?? '');
            const statusMatch = tile.match(/Status[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
            const status = statusMatch ? statusMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
            const isOpen = !status || /^open$/i.test(status);
            const laMatch = tile.match(/Local\s+authority[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
            const la = laMatch ? laMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null;
            const addrMatch = tile.match(/Address[^<]*<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/i);
            const address = addrMatch
              ? addrMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
                  .replace(/&#39;/gi, "'").replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
              : null;
            const tileText = tile.replace(/<[^>]+>/g, ' ');
            const pcMatch = tileText.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b/);
            const postcode = pcMatch ? `${pcMatch[1]}${pcMatch[2]}`.toLowerCase() : null;
            const outward = pcMatch ? pcMatch[1].toLowerCase() : null;
            tiles.push({ urn, officialName: tileName, type, phase, la, address, postcode, outward, isIndependent, isOpen });
          }
        }
      }
    }
  }

  // Score tiles by name similarity — higher is better.
  // Open schools get a +200 bonus so a closed school is never preferred
  // over an open one with an equal or similar name match.
  //
  // Location bonus (+150): when the caller supplies location hints (postcodes,
  // borough names, city names extracted from the question), tiles whose
  // postcode / outward code / LA / address match any hint are boosted.
  // This resolves ties between schools with identical names (e.g. 14 schools
  // all called "Riverside Primary School").

  function score(tile) {
    const t = tile.officialName.toLowerCase();
    let s = 0;
    if (t === nameLower)              s = 100;
    else if (t.startsWith(nameLower)) s = 80;
    else if (nameLower.startsWith(t)) s = 70;
    else if (t.includes(nameLower))   s = 50;
    else if (nameLower.includes(t))   s = 40;
    else {
      const qWords = nameLower.split(/\s+/);
      const tWords = t.split(/\s+/);
      s = qWords.filter(w => tWords.includes(w)).length * 10;
    }
    if (tile.isOpen) s += 200;

    // Location tiebreaker — match hints against postcode, outward code, LA, address
    if (hintsLower.length) {
      const locationText = [tile.postcode, tile.outward, tile.la?.toLowerCase(), tile.address?.toLowerCase()]
        .filter(Boolean).join(' ');
      for (const hint of hintsLower) {
        if (locationText.includes(hint)) { s += 150; break; }
      }
    }

    return s;
  }

  const best = tiles.reduce((a, b) => score(a) >= score(b) ? a : b);
  glog('govuk_gias_found', { name, urn: best.urn, officialName: best.officialName, type: best.type, la: best.la, postcode: best.postcode, locationHints: hintsLower, isIndependent: best.isIndependent });
  return best;
}

// ─── GIAS establishment detail ───────────────────────────────────────────────

/**
 * Fetches the GIAS establishment detail page and extracts fields not available
 * from the search result tiles: postcode, capacity, pupil numbers, FSM %,
 * SEN %, EHC plan %, gender, religious character, admissions policy.
 *
 * Returns a flat object of available fields; missing fields are omitted.
 */
export async function getGIASDetails(urn) {
  const html = await safeFetchText(`${GIAS_DETAIL}/${urn}`);
  if (!html) { glog('govuk_gias_detail_fail', { urn }); return null; }

  // GIAS uses a definition-list pattern:
  //   <dt ...>Label</dt><dd ...>Value</dd>
  // We normalise label → camelCase key with a lookup table.
  const LABEL_MAP = {
    'postcode':                                  'postcode',
    'headteacher':                              'headteacher',
    'headteacher (head of institution)':        'headteacher',
    'head teacher':                             'headteacher',
    'head teacher (full name)':                 'headteacher',
    'local authority':                  'la',
    'school capacity':                  'capacity',
    'number of pupils on roll':         'numberOnRoll',
    'total pupils':                     'numberOnRoll',
    'number of boys':                   'numberBoys',
    'number of girls':                  'numberGirls',
    'percentage of pupils eligible for free school meals': 'fsmPct',
    'free school meals (%)':            'fsmPct',
    'percentage of pupils with ehc plans': 'ehcPlanPct',
    'pupils with special educational needs': 'senSupportPct',
    'pupils with sen support':          'senSupportPct',
    'gender':                           'gender',
    'religious character':              'religiousCharacter',
    'admissions policy':                'admissionsPolicy',
    'ofsted rating':                    'ofstedRating',
    'last changed / inspected':         'ofstedDate',
    'type of establishment':            'establishmentType',
    'school website':                   'website',
    'website':                          'website',
  };

  const result = {};

  // Match every <dt>...</dt> <dd>...</dd> pair
  for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
    const label = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const value = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!value || value === 'Not applicable' || value === 'Unknown') continue;
    const key = LABEL_MAP[label];
    if (key && !result[key]) result[key] = value;
  }

  // Also try <th> / <td> table pattern (alternative GIAS layout)
  if (!result.postcode) {
    for (const m of html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/gi)) {
      const label = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const value = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!value || value === 'Not applicable' || value === 'Unknown') continue;
      const key = LABEL_MAP[label];
      if (key && !result[key]) result[key] = value;
    }
  }

  if (!Object.keys(result).length) { glog('govuk_gias_detail_empty', { urn }); return null; }
  glog('govuk_gias_detail_ok', { urn, fields: Object.keys(result) });
  return result;
}

// ─── Area data (postcodes.io → ONS / Land Registry) ──────────────────────────

/**
 * Resolves a postcode to LSOA/MSOA codes and fetches area-level data:
 *  - ONS Census 2021: ethnicity breakdown, household deprivation
 *  - ONS household income estimates (MSOA level)
 *  - HM Land Registry: average house prices
 *
 * All sub-fetches are non-fatal. Returns whatever data is available.
 */
export async function getAreaData(postcode) {
  if (!postcode) return null;
  const clean = postcode.replace(/\s+/g, '').toUpperCase();

  // Step 1 — resolve postcode to area codes
  const geo = await safeFetchJson(`${POSTCODES_IO}/${encodeURIComponent(clean)}`);
  if (!geo?.result) { glog('govuk_area_postcode_fail', { postcode }); return null; }

  const r = geo.result;
  const lsoa     = r.codes?.lsoa  ?? r.lsoa  ?? null;
  const msoa     = r.codes?.msoa  ?? r.msoa  ?? null;
  const district = r.admin_district ?? null;
  // For two-tier areas (county + district), education is run by the county council.
  // admin_county holds the county ONS code (e.g. E10000030 for Surrey); postcodes.io returns
  // E99999999 as a placeholder when there is no county (London Boroughs, unitary authorities),
  // so we exclude that sentinel and fall back to admin_district (which IS the education authority
  // for unitary/London areas).
  const countyCode = r.codes?.admin_county;
  const laCode = (countyCode && countyCode !== 'E99999999')
    ? countyCode
    : r.codes?.admin_district || null;
  const region   = r.region ?? null;
  const lat      = r.latitude  ?? null;
  const lon      = r.longitude ?? null;

  if (!lsoa && !msoa) { glog('govuk_area_no_codes', { postcode }); return null; }

  // Step 2 — fetch area data in parallel (all non-fatal)
  // Ethnicity:    Nomis Census 2021 TS021 — LSOA level (~0.5 mile, ~400-1,200 households)
  // PricePaid:    Land Registry Price Paid — all postcodes within 800 m, last 5 years
  // ONS Income:   ONS Small Area Income Estimates FYE 2018 — MSOA (oldest but detailed)
  // IMD:          MHCLG Indices of Multiple Deprivation 2025 — LSOA level
  // CrystalRoof:  ⚠️ TEMP — qualifications + occupation (Census 2021 OA) + newer income
  //               Replace with direct Nomis calls. See fetchCrystalRoof() for details.
  const [ethnicityData, pricePaidData, incomeData, imdData, crystalRoofData] = await Promise.allSettled([
    fetchNomisEthnicity(lsoa),
    fetchPricePaid(lat, lon),
    fetchONSIncome(msoa),
    fetchIMD(lsoa),
    fetchCrystalRoof(postcode),  // ⚠️ TEMP — see fetchCrystalRoof() comment
  ]);

  const result = {
    postcode: r.postcode,
    district,
    laCode,
    region,
    lsoa,
    msoa,
    ethnicity:   ethnicityData.status    === 'fulfilled' ? ethnicityData.value    : null,
    pricePaid:   pricePaidData.status    === 'fulfilled' ? pricePaidData.value    : null,
    income:      incomeData.status       === 'fulfilled' ? incomeData.value       : null,
    imd:         imdData.status          === 'fulfilled' ? imdData.value          : null,
    crystalRoof: crystalRoofData.status  === 'fulfilled' ? crystalRoofData.value  : null,
  };

  glog('govuk_area_ok', {
    postcode,
    district,
    hasEthnicity:    !!result.ethnicity,
    hasPricePaid:    !!result.pricePaid,
    transactions:    result.pricePaid?.totalTransactions ?? 0,
    hasIncome:       !!result.income,
    hasIMD:          !!result.imd,
    hasCrystalRoof:  !!result.crystalRoof,  // ⚠️ TEMP
  });

  return result;
}

/**
 * Fetches Census 2021 ethnic group percentages for an MSOA from Nomis (TS021).
 *
 * Nomis requires an internal NomisKey (not the ONS geography code) for MSOA-level
 * queries. We resolve it in one pre-flight request, then fetch the data.
 */
async function fetchNomisEthnicity(msoaCode) {
  if (!msoaCode) return null;

  // Step 1 — resolve ONS MSOA code to a Nomis internal geography key
  const defUrl = `https://www.nomisweb.co.uk/api/v01/dataset/NM_2041_1/geography/${msoaCode}.def.sdmx.json`;
  const defData = await safeFetchJson(defUrl);
  const codes = defData?.structure?.codelists?.codelist?.[0]?.code;
  if (!Array.isArray(codes)) return null;

  const entry = codes.find(c => c.value === msoaCode);
  const nomisKey = entry?.annotations?.annotation?.find(a => a.annotationtitle === 'NomisKey')?.annotationtext;
  if (!nomisKey) return null;

  // Step 2 — query ethnicity percentages (20 categories, skip total=0)
  const cats = Array.from({ length: 19 }, (_, i) => i + 1).join(',');
  const dataUrl = `https://www.nomisweb.co.uk/api/v01/dataset/NM_2041_1.data.json?geography=${nomisKey}&c2021_eth_20=${cats}&measures=20301&select=c2021_eth_20_name,obs_value`;
  const data = await safeFetchJson(dataUrl);
  if (!Array.isArray(data?.obs)) return null;

  const result = {};
  for (const obs of data.obs) {
    const label = obs.c2021_eth_20?.description;
    const val   = parseFloat(obs.obs_value?.value);
    if (label && !isNaN(val) && val > 0) result[label] = val;
  }
  return Object.keys(result).length ? result : null;
}

/**
 * Fetches ONS model-based household income estimates for an MSOA.
 *
 * Source: "Small Area Income Estimates for Middle Layer Super Output Areas, England
 * and Wales" — Financial Year Ending 2018 (most recent MSOA-level release).
 * Published as a ~680 KB CSV; we stream the full file and find the matching row.
 *
 * Columns (after 6 identifier fields):
 *   6 — Net annual household income (£)
 *   7 — Total annual household income (£) [before housing costs]
 *   8 — Net annual household income after housing costs (£)
 *   9 — Net annual equivalised household income (£)
 *
 * Data is FYE 2018 — cite the year; do not present as current.
 */
async function fetchONSIncome(msoaCode) {
  if (!msoaCode) return null;

  const url =
    'https://www.ons.gov.uk/file?uri=/employmentandlabourmarket/peopleinwork/' +
    'earningsandworkinghours/datasets/smallareaincomeestimatesformiddlelayer' +
    'superoutputareasenglandandwales/financialyearending2018/netannualincome20181.csv';

  const text = await safeFetchText(url, { Accept: 'text/csv,*/*' });
  if (!text) return null;

  // Minimal quoted-CSV row splitter
  function splitCSV(line) {
    const fields = [];
    let cur = '', inQ = false;
    for (const ch of line) {
      if (ch === '"')                    { inQ = !inQ; continue; }
      if (ch === ',' && !inQ)            { fields.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    fields.push(cur.trim());
    return fields;
  }

  for (const line of text.split('\n')) {
    if (!line.trim() || !line.startsWith(msoaCode)) continue;
    const row = splitCSV(line);
    if (row[0] !== msoaCode) continue;

    const fmt = (v) => v ? `£${parseInt(v.replace(/,/g, ''), 10).toLocaleString('en-GB')}` : null;
    return {
      msoaName:                    row[1] ?? null,
      netAnnualHouseholdIncome:    fmt(row[6]),
      totalAnnualHouseholdIncome:  fmt(row[7]),
      afterHousingCostsIncome:     fmt(row[8]),
      netEquivalisedIncome:        fmt(row[9]),
      year: 'FYE 2018',
      source: 'ONS Small Area Income Estimates',
    };
  }
  return null;
}

/**
 * Fetches actual sale prices from the HM Land Registry Price Paid dataset
 * for all postcodes within ~800 m of the school (≈ 0.5 mile catchment area).
 *
 * Strategy:
 *   1. postcodes.io nearby-postcodes endpoint → up to 100 postcodes within 800 m
 *   2. Land Registry Price Paid JSON API for each postcode (all parallel, last 5 yr)
 *   3. Aggregate medians by property type
 *
 * Parallel requests to Land Registry complete in ~1 s in practice (tested).
 * Falls back gracefully when transactions are too few (<5) to be meaningful.
 */
async function fetchPricePaid(lat, lon) {
  if (lat == null || lon == null) return null;

  // Step 1 — nearby postcodes within 800 m
  const nearbyUrl = `${POSTCODES_IO}?lon=${lon}&lat=${lat}&radius=800&limit=100`;
  const nearbyData = await safeFetchJson(nearbyUrl);
  const postcodes = (nearbyData?.result ?? []).map(p => p.postcode).filter(Boolean);
  if (!postcodes.length) return null;

  // Step 2 — Price Paid API, last 5 years, all postcodes in parallel
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  const dateStr = cutoff.toISOString().slice(0, 10);

  const results = await Promise.all(postcodes.map(pc =>
    safeFetchJson(
      `https://landregistry.data.gov.uk/data/ppi/transaction-record.json` +
      `?propertyAddress.postcode=${encodeURIComponent(pc)}` +
      `&min-transactionDate=${dateStr}&_pageSize=100`
    )
  ));

  // Step 3 — aggregate
  const TYPE_MAP = {
    'detached':        'Detached',
    'semi-detached':   'Semi-detached',
    'terraced':        'Terraced',
    'flat-maisonette': 'Flat / Maisonette',
    'flat':            'Flat / Maisonette',
  };

  const byType   = {};
  const allPrices = [];

  for (const d of results) {
    for (const t of d?.result?.items ?? []) {
      const price = t.pricePaid;
      if (!price) continue;
      allPrices.push(price);
      const typeRaw = (t.propertyType?.prefLabel?.[0]?._value ?? '').toLowerCase();
      const type    = TYPE_MAP[typeRaw];
      if (type) { if (!byType[type]) byType[type] = []; byType[type].push(price); }
    }
  }

  if (allPrices.length < 5) return null;  // not enough data to be meaningful

  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const fmt = (n) => `£${Math.round(n).toLocaleString('en-GB')}`;

  const byTypeMedians = {};
  for (const [type, prices] of Object.entries(byType)) {
    if (prices.length >= 3) byTypeMedians[type] = fmt(median(prices));
  }

  return {
    radiusM:           800,
    yearsBack:         5,
    totalTransactions: allPrices.length,
    postcodesQueried:  postcodes.length,
    medianAllTypes:    fmt(median(allPrices)),
    byType:            Object.keys(byTypeMedians).length ? byTypeMedians : null,
    source:            'HM Land Registry Price Paid Data',
  };
}

/**
 * Fetches Index of Multiple Deprivation data for an LSOA.
 * Source: findthatpostcode.uk — aggregates MHCLG IMD releases (2019, 2025)
 * and makes them available as JSON without authentication.
 *
 * IMD Decile:  1 = most deprived 10% of LSOAs in England
 *              10 = least deprived 10%
 *
 * We use the most recent year available (2025 > 2019) and also extract
 * sub-domain deciles (income, employment, education, health, crime, housing,
 * living environment) to give a richer neighbourhood picture.
 */
async function fetchIMD(lsoaCode) {
  if (!lsoaCode) return null;

  const url  = `https://findthatpostcode.uk/areas/${encodeURIComponent(lsoaCode)}.json`;
  const data = await safeFetchJson(url);
  const stats = data?.data?.attributes?.stats;
  if (!stats) return null;

  // Prefer most recent year
  const imd  = stats.imd2025 ?? stats.imd2019 ?? null;
  const year = stats.imd2025 ? '2025' : stats.imd2019 ? '2019' : null;
  if (!imd || !year) return null;

  // Sub-domain deprivation deciles (1 = most deprived, 10 = least deprived)
  const SD_MAP = {
    imd_income_decile:      'Income',
    imd_employment_decile:  'Employment',
    imd_education_decile:   'Education, Skills & Training',
    imd_health_decile:      'Health & Disability',
    imd_crime_decile:       'Crime',
    imd_housing_decile:     'Barriers to Housing & Services',
    imd_environment_decile: 'Living Environment',
  };
  const subDomains = {};
  for (const [key, label] of Object.entries(SD_MAP)) {
    if (imd[key] != null) subDomains[label] = parseInt(imd[key]);
  }

  // Population (most recent available year)
  const pop = stats.population2022 ?? stats.population2015 ?? null;
  const popYear = stats.population2022 ? '2022' : stats.population2015 ? '2015' : null;

  return {
    lsoaCode,
    year,
    imdScore:   imd.imd_score  != null ? Math.round(imd.imd_score  * 100) / 100 : null,
    imdRank:    imd.imd_rank   != null ? parseInt(imd.imd_rank)               : null,
    imdDecile:  imd.imd_decile != null ? parseInt(imd.imd_decile)             : null,
    subDomains: Object.keys(subDomains).length ? subDomains : null,
    population: pop?.population_total ?? null,
    populationYear: popYear,
    source: `MHCLG Indices of Multiple Deprivation ${year} via findthatpostcode.uk`,
  };
}

// ─── Crystal Roof — qualifications, occupation & income (TEMP) ───────────────
//
// ⚠️  TEMPORARY DATA SOURCE — DO NOT TREAT AS STABLE
//
// Crystal Roof (crystalroof.co.uk) is a commercial property-data product.
// Their data-api/affluence endpoint is currently unauthenticated — note that
// the *website* requires login but the underlying JSON API has NO server-side
// auth check. This means:
//   1. They can add auth (or a rate-limit/block) at any point without notice.
//   2. We have no SLA, no ToS permission for API access, no contact if it breaks.
//
// PRODUCTION REPLACEMENT — implement direct Nomis Census 2021 calls:
//   • Qualifications: dataset NM_2082_1 (TS067 — Highest level of qualification)
//     at Output Area level — same 2-step NomisKey resolution as fetchNomisEthnicity()
//   • Occupation/NS-SeC: dataset NM_2066_1 at Output Area level
//   • Income: find the most recent ONS MSOA income estimates CSV URL
//     (currently using FYE 2018; Crystal Roof shows FYE ~2021 figures)
//
// INTEGRATION TEST — add to CI (runs on every push to master):
//   node functions/research/test-crystal-roof-api.mjs
// This exits 0 if the API still responds with the expected shape, 1 if broken.
// See that file for details.

/**
 * Fetches Census 2021 qualifications, occupation, and household income from
 * the Crystal Roof affluence API.
 *
 * ⚠️  TEMP — see block comment above. Replace with Nomis when time allows.
 *
 * @param {string} postcode - School postcode (spaces stripped internally)
 */
async function fetchCrystalRoof(postcode) {
  if (!postcode) return null;
  const clean = postcode.replace(/\s+/g, '').toUpperCase();
  const url   = `https://crystalroof.co.uk/data-api/affluence/postcode/v2/${clean}`;

  const raw = await safeFetchJson(url);
  if (!raw?.data) return null;
  const d = raw.data;

  // ── Qualifications (Output Area level, Census 2021) ───────────────────────
  let qualifications = null;
  const qOa = d.qualificationOa;
  if (qOa?.total > 0) {
    const tot = qOa.total;
    const pct = (n) => (n != null ? Math.round(n / tot * 100) : null);
    qualifications = {
      noQualifications: pct(qOa.noQualifications),
      level1AndEntry:   pct(qOa.level1andEntryLevel),
      level2:           pct(qOa.level2),
      apprenticeship:   pct(qOa.apprenticeship),
      level3:           pct(qOa.level3),
      level4AndAbove:   pct(qOa.level4andAbove),
      other:            pct(qOa.other),
      totalResidents:   tot,
    };
  }

  // ── Occupation / NS-SeC (Output Area level, Census 2021) ──────────────────
  let occupation = null;
  const oOa = d.occupationOa;
  if (oOa?.total > 0) {
    const tot = oOa.total;
    const pct = (n) => (n != null ? Math.round(n / tot * 100) : null);
    occupation = {
      managerialProfessional:        pct(oOa.managerialAdministrativeAndProfessional),
      intermediate:                  pct(oOa.intermediate),
      routineAndManual:              pct(oOa.routineAndManual),
      neverWorkedLongTermUnemployed: pct(oOa.neverWorkedAndLongTermUnemployed),
      fullTimeStudents:              pct(oOa.fullTimeStudents),
      totalResidents:                tot,
    };
  }

  // ── Household income (MSOA level — more recent than ONS FYE 2018 CSV) ─────
  // Crystal Roof labels this "totalAnnualIncome" but their map tile layer is
  // named "household_income_england_wales_mean", so this is the MEAN (gross).
  // This is distinct from the ONS net/equivalised figures — label clearly.
  let income = null;
  const iMsoa = d.householdIncomeMsoa;
  if (iMsoa?.totalAnnualIncome != null) {
    income = {
      meanAnnualHouseholdIncome: `£${Math.round(iMsoa.totalAnnualIncome).toLocaleString('en-GB')}`,
      grain: 'MSOA',
      measure: 'mean gross annual household income',
    };
  }

  if (!qualifications && !occupation && !income) return null;

  return { qualifications, occupation, income };
}

// ─── Ofsted data (state schools) ─────────────────────────────────────────────

/**
 * Scrapes the Ofsted provider page for a school's inspection summary.
 * Secondary schools: /provider/23/[URN]
 * Primary schools:   /provider/21/[URN]
 * Tries 23 first, falls back to 21.
 *
 * Handles both the old framework (4 sub-grades) and the new Nov-2025
 * report card format (7 areas, different grade labels).
 * Also handles the timeline format used for older/closed school pages.
 */

// ── EES dataset IDs ────────────────────────────────────────────────────────
// Published at: https://api.education.gov.uk/statistics/v1/publications/{pubId}/data-sets
const EES_KS2_LA_DATASET = '019afee5-4791-7467-a788-c163fd9b57de';
const EES_KS4_LA_DATASET = 'b3e19901-5d2b-b676-bb4c-e60937d74725';

// Filter/indicator codes for KS2 LA dataset (verified 2026-04-27)
const EES_KS2 = {
  // Filter group IDs
  fCharacteristic: 'TkqPJ',  // "Characteristics of each group"
  fTopic:          '0ciT5',  // "Topic of Characteristics"
  fSchoolType:     'hZYyW',  // "School type"
  fSubject:        'mWI9K',  // "Subjects"
  // Filter option IDs
  total:      'qf3xj',  // Characteristic = Total (all pupils)
  allPupils:  'DIbUQ',  // Topic = All pupils
  stateFunded:'Bpiw7',  // School type = All state funded
  // Subject options
  rwm:      'XVrAf',   // Reading, writing and maths
  reading:  'uLXpo',
  writing:  'crTy3',
  maths:    'kZvTh',
  gps:      'zTwGF',   // Grammar, punctuation and spelling
  science:  'ThInP',
  // Indicator IDs
  indExpected: 'WmV2b',  // % meeting expected standard
  indHigher:   'E1cqF',  // % meeting higher standard
  indAvgScore: '45XUZ',  // Average scaled score
};

/**
 * Fetches KS2 local-authority averages (state-funded, all pupils) from the
 * DfE Explore Education Statistics API for a given LA ONS code.
 *
 * Returns an object keyed by subject with expected/higher/avgScore fields,
 * or null if the fetch fails or the LA code is not found.
 *
 * @param {string} laCode  ONS LA code from postcodes.io (e.g. "E09000028" for Southwark)
 */
export async function getLAPerformanceKS2(laCode) {
  if (!laCode) return null;

  const EES_BASE = 'https://api.education.gov.uk/statistics/v1';

  const params = new URLSearchParams({
    'locations.in':  `LA|code|${laCode}`,
    'pageSize':      '90',
  });
  // Fetch 3 years: each as separate timePeriods.in param
  params.append('timePeriods.in', '2022/2023|AY');
  params.append('timePeriods.in', '2023/2024|AY');
  params.append('timePeriods.in', '2024/2025|AY');
  // Filters: Total characteristic, All pupils topic, State funded school type
  params.append('filters.in', EES_KS2.total);
  params.append('filters.in', EES_KS2.allPupils);
  params.append('filters.in', EES_KS2.stateFunded);
  // Indicators
  params.append('indicators', EES_KS2.indExpected);
  params.append('indicators', EES_KS2.indHigher);
  params.append('indicators', EES_KS2.indAvgScore);

  const url = `${EES_BASE}/data-sets/${EES_KS2_LA_DATASET}/query?${params}`;
  const data = await safeFetchJson(url);

  if (!data?.results?.length) {
    glog('govuk_ks2_la_fail', { laCode, status: data ? 'empty' : 'null' });
    return null;
  }

  // Subject code → result key
  const SUBJ_MAP = {
    [EES_KS2.rwm]:     'rwm',
    [EES_KS2.reading]: 'reading',
    [EES_KS2.writing]: 'writing',
    [EES_KS2.maths]:   'maths',
    [EES_KS2.gps]:     'gps',
    [EES_KS2.science]: 'science',
  };

  // Time period code → short year key
  const YEAR_MAP = { '202223': '23', '202324': '24', '202425': '25' };

  const out = {};

  for (const row of data.results) {
    const filters = row.filters ?? {};
    // Only keep "Total" rows (characteristic = qf3xj, topic = DIbUQ)
    if (filters[EES_KS2.fCharacteristic] !== EES_KS2.total)   continue;
    if (filters[EES_KS2.fTopic]          !== EES_KS2.allPupils) continue;

    const subjCode = filters[EES_KS2.fSubject];
    const key      = SUBJ_MAP[subjCode];
    if (!key) continue;

    // Extract year from time_period (e.g. "202425" → "25")
    const tp = (row.time_period || '').replace(/\//g, '');
    const yr = YEAR_MAP[tp] || '25';

    const vals = row.values ?? {};
    const clean = (v) => (v && v !== 'z' && v !== 'x' && v !== 'c') ? String(v) : null;

    out[key] = out[key] || {};
    out[key]['yr' + yr] = {
      expected: clean(vals[EES_KS2.indExpected]),
      higher:   clean(vals[EES_KS2.indHigher]),
      avgScore: clean(vals[EES_KS2.indAvgScore]),
    };
  }

  if (!Object.keys(out).length) {
    glog('govuk_ks2_la_no_match', { laCode });
    return null;
  }

  glog('govuk_ks2_la_ok', { laCode, subjects: Object.keys(out) });
  return out;
}

/**
 * Fetches KS4 local-authority averages (state-funded, all pupils) from the
 * DfE Explore Education Statistics API for a given LA ONS code.
 *
 * Returns { att8, p8, grade5Em } or null.
 */
export async function getLAPerformanceKS4(laCode) {
  if (!laCode) return null;

  const EES_BASE = 'https://api.education.gov.uk/statistics/v1';
  // Build base params (everything except time period)
  const baseParams = new URLSearchParams({
    'locations.in':  `LA|code|${laCode}`,
    'pageSize':      '10',
  });
  baseParams.append('filters.in', 'uRBo4');
  baseParams.append('filters.in', 'bVOtT');
  const INDICATORS = [
    'S9YVx','OvpCL','kxGhs','HPhzL','UZ5RF','4c9UZ','u2bo4','CpmId',
    'R8uka','bBrtT','yxmaB','DOiQe','ea0uS','5USdi',
    'XdlfK','5kQdi','tfREm','TawPJ','cDF31',
    'YTyHK','BVh7J','zecFQ','qHPjG','a1GLP',
    'ISTBz','6gYrf','0yZT5','iG76X','LibWj',
    'olpmX','dh70Z','75TXo','SUzVx','VRg5X','GJQgr','rO8Nj',
  ];
  for (const ind of INDICATORS) baseParams.append('indicators', ind);

  const clean = (v) => (v && v !== 'z' && v !== 'x' && v !== 'c') ? String(v) : null;
  const KEYS = ['att8','p8','grade5Em','grade4Em','ebaccEntry','ebaccAPS','ebacc5','ebacc4',
    'att8Eng','att8Mat','att8Ebacc','att8Open','att8OpenG','att8OpenNg',
    'eng95','mat95','sci95','hum95','lan95',
    'eng94','mat94','sci94','hum94','lan94',
    'eng1','mat1','sci1','hum1','lan1',
    'destOver','destEdu','ebEeng','ebEmat','ebEsci','ebEhum','ebElan'];

  // Fetch 3 years: 2022/23, 2023/24, 2024/25
  const YEARS = ['2022/2023|AY', '2023/2024|AY', '2024/2025|AY'];
  const YEAR_KEYS = ['yr23', 'yr24', 'yr25'];

  const allResults = {};
  for (let yi = 0; yi < YEARS.length; yi++) {
    const params = new URLSearchParams(baseParams);
    params.set('timePeriods.in', YEARS[yi]);
    const url = `${EES_BASE}/data-sets/${EES_KS4_LA_DATASET}/query?${params}`;
    const data = await safeFetchJson(url).catch(() => null);
    if (!data?.results?.length) continue;
    const vals = data.results[0].values ?? {};
    const yrKey = YEAR_KEYS[yi];
    for (let ki = 0; ki < KEYS.length; ki++) {
      const val = clean(vals[INDICATORS[ki]]);
      if (val != null) {
        allResults[KEYS[ki]] = allResults[KEYS[ki]] || {};
        allResults[KEYS[ki]][yrKey] = val;
      }
    }
  }

  if (!Object.keys(allResults).length) {
    glog('govuk_ks4_la_fail', { laCode });
    return null;
  }

  glog('govuk_ks4_la_ok', { laCode, metrics: Object.keys(allResults).length, years: Object.values(allResults)[0] ? Object.keys(Object.values(allResults)[0]).length : 0 });
  return allResults;
}

export async function getOfstedData(urn) {
  // Provider 23 is the current Ofsted URL but is increasingly JS-rendered
  // (returns an 8KB HTML shell with no inspection data). Provider 21 still
  // serves SSR content.  Try 23 first, but fall back to 21 if the response
  // lacks the inspection data markers we need.
  let html = await safeFetchText(`https://reports.ofsted.gov.uk/provider/23/${urn}`);
  if (html && !/subjudgements__overall|subjudgements__rates__item/i.test(html)) {
    html = null; // JS shell — force fallback to provider 21
  }
  if (!html) html = await safeFetchText(`https://reports.ofsted.gov.uk/provider/21/${urn}`);
  if (!html) html = await safeFetchText(`https://reports.ofsted.gov.uk/provider/ELS/${urn}`);
  if (!html) html = await safeFetchText(`https://reports.ofsted.gov.uk/provider/46/${urn}`);
  if (!html) { glog('govuk_ofsted_fail', { urn }); return null; }

  // ── Overall grade ─────────────────────────────────────────────────────────
  // <div class="subjudgements__overall">
  //   <p>The overall outcome of the inspection on 26 April 2022 was:</p>
  //   <strong>Good</strong>
  // </div>
  const overallBlock = html.match(/<div[^>]*class="[^"]*subjudgements__overall[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const overall = overallBlock
    ? (overallBlock[1].match(/<strong>([^<]+)<\/strong>/i)?.[1].trim() ?? null)
    : null;

  // Date is embedded in the <p> inside the overall block, or in the timeline <time> tag
  const dateInBlock = overallBlock?.[1].match(/inspection on\s+([^<"]+?)\s+was/i)?.[1].trim() ?? null;
  const dateInTime  = html.match(/<time>([^<]+)<\/time>/i)?.[1].trim() ?? null;
  const date = dateInBlock ?? dateInTime;

  // ── Sub-grades ────────────────────────────────────────────────────────────
  // Structure varies: <p>/<span>/<div> → label, then <strong> → grade.
  // Tolerate intervening whitespace and elements between label and grade.
  const subGrades = {};
  const itemRe = /<div[^>]*class="[^"]*subjudgements__rates__item[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  for (const m of html.matchAll(itemRe)) {
    const block = m[1];
    // Extract label from the first <p> or <span> or plain text before <strong>
    const labelMatch = block.match(/<(?:p|span|div)[^>]*>([^<]+)<\/(?:p|span|div)>/i)
      ?? block.match(/>([^<]{3,40})</i);
    const gradeMatch = block.match(/<strong[^>]*>([^<]+)<\/strong>/i);
    if (labelMatch && gradeMatch) {
      const label = labelMatch[1].replace(/:$/, '').trim().toLowerCase();
      subGrades[label] = gradeMatch[1].trim();
    }
  }

  const g = (key) => subGrades[key] ?? null;

  // Old framework (pre-Nov 2025)
  const qualityOfEducation  = g('quality of education');
  const behaviour           = g('behaviour and attitudes');
  const personalDevelopment = g('personal development');
  const leadership          = g('leadership and management');
  const sixthForm           = g('sixth form provision');

  // FE/Sixth-form college specific labels (provider ELS/46)
  const eduProgrammes  = g('education programmes for young people');
  const highNeeds      = g('provision for learners with high needs');

  // New Nov-2025 report card areas
  const achievement   = g('achievement');
  const attendance    = g('attendance and behaviour');
  const curriculum    = g('curriculum and teaching');
  const inclusion     = g('inclusion');
  const leadershipGov = g('leadership and governance');
  const wellbeing     = g('personal development and wellbeing');
  const post16        = g('post-16 provision');

  // ── Safeguarding ──────────────────────────────────────────────────────────
  const safeguarding = html.match(/safeguarding[^<]*(?:<[^>]+>)*([^<]{0,40}(?:effective|met|not met)[^<]{0,40})/i)?.[1].trim() ?? null;

  // ── PDF link (most recent report) ─────────────────────────────────────────
  // Links are like: href="https://files.ofsted.gov.uk/v1/file/50196369"
  const reportUrl = html.match(/href="(https:\/\/files\.ofsted\.gov\.uk\/v1\/file\/\d+)"/i)?.[1] ?? null;

  // ── Parent View URL ───────────────────────────────────────────────────────
  // The Ofsted page links to Parent View results via /parent-view-results/urn/{URN}.
  // The actual % data is JS-rendered so we can't fetch it here; we pass the URL
  // to the AI so it can fetch it via web search if needed.
  const parentViewUrl = html.match(/href="(\/parent-view-results\/urn\/\d+)"/)
    ? `https://parentview.ofsted.gov.uk/parent-view-results/urn/${urn}`
    : `https://parentview.ofsted.gov.uk/parent-view-results/urn/${urn}`; // include always — page exists for all state schools

  // ── Timeline fallback (older / closed school pages) ──────────────────────
  // Ofsted timelines list events as <li class="timeline__day"> — the first
  // item is often a status change (e.g. "Closed"), so scan all and pick the
  // most recent one that contains a graded inspection.
  let timelineOverall = null, timelineDate = null, timelineUrl = null;
  if (!overall || !date) {
    // First pass: look for a graded inspection (contains <strong>Grade</strong>)
    for (const m of html.matchAll(/<li[^>]*class="[^"]*timeline__day[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
      const block = m[1];
      if (!/inspection/i.test(block)) continue;
      const grade = block.match(/inspection[^<]*<strong>([^<]+)<\/strong>/i)?.[1].trim() ?? null;
      if (!grade) {
        // Ungraded / monitoring inspection — capture it but keep looking for a graded one
        if (!timelineDate) {
          timelineOverall = 'Ungraded inspection';
          timelineDate    = block.match(/<time>([^<]+)<\/time>/i)?.[1].trim() ?? null;
          timelineUrl     = block.match(/href="(https:\/\/files\.ofsted\.gov\.uk\/v1\/file\/\d+)"/i)?.[1] ?? null;
        }
        continue;
      }
      // Graded inspection found — prefer this over any ungraded entry
      timelineOverall = grade;
      timelineDate    = block.match(/<time>([^<]+)<\/time>/i)?.[1].trim() ?? null;
      timelineUrl     = block.match(/href="(https:\/\/files\.ofsted\.gov\.uk\/v1\/file\/\d+)"/i)?.[1] ?? null;
      break;
    }
  }

  // If the overall grade came from the timeline fallback, pair it with the
  // matching timeline date — not the page-wide dateInTime which may belong to
  // a more recent ungraded inspection.
  const finalOverall = overall ?? timelineOverall;
  const finalDate    = overall ? date : (timelineDate ?? date);
  const finalReport  = reportUrl ?? timelineUrl;

  if (!finalOverall && !finalDate) {
    glog('govuk_ofsted_no_data', { urn });
    return null;
  }

  // When the latest inspection page has no sub-grades (ungraded monitoring visit,
  // or old-framework page where sub-judgements aren't rendered), fall back to
  // the previous full inspection PDF to extract them.
  const hasSubGrades = qualityOfEducation || behaviour || personalDevelopment || leadership || sixthForm
    || achievement || attendance || curriculum || inclusion || leadershipGov || wellbeing;
  const needsGradedPdf = !hasSubGrades && !!timelineUrl && timelineUrl !== finalReport;

  const result = {
    overall: finalOverall, date: finalDate,
    qualityOfEducation, behaviour, personalDevelopment, leadership, sixthForm,
    eduProgrammes, highNeeds,
    achievement, attendance, curriculum, inclusion, leadershipGov, wellbeing, post16,
    safeguarding, reportUrl: finalReport,
    gradedReportUrl: needsGradedPdf ? timelineUrl : null,  // for sub-grade extraction
    parentViewUrl,
    pupilExperience: null,
    nextSteps:       null,
  };

  // ── PDF enrichment ────────────────────────────────────────────────────────
  // Fetch and parse the main report PDF for narrative + sub-grades.
  // If the page had no sub-grades (ungraded or old-framework), also fetch
  // the most recent graded inspection PDF for sub-grade fallback.
  let pdfSections = null;
  let gradedPdfSections = null;
  if (finalReport) {
    pdfSections = await fetchAndParseOfstedPdf(finalReport).catch(() => null);
  }
  if (needsGradedPdf && timelineUrl) {
    gradedPdfSections = await fetchAndParseOfstedPdf(timelineUrl).catch(() => null);
  }

  const pdfSg  = pdfSections?.pdfSubGrades ?? null;
  const gpdfSg = gradedPdfSections?.pdfSubGrades ?? null;
  const bestSg  = gpdfSg ?? pdfSg;  // graded PDF is the better source for sub-grades

  const enriched = {
    ...result,
    // Sub-grades: HTML first, graded PDF second, main PDF last
    qualityOfEducation: result.qualityOfEducation ?? bestSg?.qualityOfEducation ?? null,
    behaviour:          result.behaviour          ?? bestSg?.behaviour          ?? null,
    personalDevelopment: result.personalDevelopment ?? bestSg?.personalDevelopment ?? null,
    leadership:         result.leadership         ?? bestSg?.leadership         ?? null,
    sixthForm:          result.sixthForm          ?? bestSg?.sixthForm          ?? null,
    achievement:        result.achievement        ?? bestSg?.achievement        ?? null,
    // PDF narrative sections
    pupilExperience:               pdfSections?.pupilExperience         ?? null,
    qualityOfEducationDetail:      pdfSections?.qualityOfEducation      ?? null,
    behaviourAndAttitudesDetail:   pdfSections?.behaviourAndAttitudes   ?? null,
    personalDevelopmentDetail:     pdfSections?.personalDevelopment     ?? null,
    leadershipAndManagementDetail: pdfSections?.leadershipAndManagement ?? null,
    achievementDetail:             pdfSections?.achievement             ?? null,
    inclusionDetail:               pdfSections?.inclusion               ?? null,
    nextSteps:                     pdfSections?.nextSteps               ?? null,
  };

  glog('govuk_ofsted_ok', { urn, overall: finalOverall, date: finalDate,
    subGrades: [enriched.qualityOfEducation, enriched.behaviour, enriched.personalDevelopment, enriched.leadership].filter(Boolean).length,
    hasPdfNarrative: !!enriched.pupilExperience,
    usedGradedPdf: !!gpdfSg,
  });
  return enriched;
}

// ─── Ofsted Parent View ───────────────────────────────────────────────────────

/**
 * Fetches aggregated Parent View survey results for a school by scraping the
 * print-friendly results page (no JavaScript required, no auth required).
 *
 * Flow:
 *   1. GET /parent-view-results/urn/{urn}  → 302 → extract Parent View ID
 *   2. GET /result/{pvId}/current          → 302 → extract year code
 *   3. GET /result-print/{pvId}/{yearCode} → parse HTML for question % data
 *
 * The print page embeds percentages inside image-charts.com chart URLs
 * as a `chd=t:SA,A,D,SD,DK` parameter — no JS rendering needed.
 *
 * Returns null if the school has no Parent View data or the fetch fails.
 */
/**
 * Parses a Parent View print page and returns structured question results.
 * Returns null if the page has no data.
 */
function parseParentViewHtml(html) {
  if (!html || !html.includes('question-result')) return null;

  const totalMatch   = html.match(/Responses for this school[\s\S]*?<div class="field__item">(\d+)<\/div>/);
  const yearStrMatch = html.match(/Responses for year[\s\S]*?<div class="field__item">([^<]+)<\/div>/);
  const total        = totalMatch ? parseInt(totalMatch[1], 10) : 0;
  const academicYear = yearStrMatch?.[1]?.trim() ?? null;

  const questionBlocks = html.matchAll(
    /<a[^>]+class="[^"]*question-result[^"]*"[^>]*>([^<]+)<\/a>[\s\S]{0,1200}?chd=t(%3A|:)([\d%2C,]+)/g,
  );

  const findPct = (text, ...keywords) =>
    keywords.some(kw => text.toLowerCase().includes(kw.toLowerCase()));

  const questions = {};
  for (const m of questionBlocks) {
    const qText  = m[1].replace(/^\d+\.\s*/, '').trim();
    const chdRaw = decodeURIComponent(m[3]);
    const vals   = chdRaw.split(',').map(v => parseInt(v, 10) || 0);
    const agreeAndAbove = (vals[0] ?? 0) + (vals[1] ?? 0);

    if      (findPct(qText, 'happy'))                             questions.childHappy      = agreeAndAbove;
    else if (findPct(qText, 'feels safe', 'feel safe'))           questions.childSafe       = agreeAndAbove;
    else if (findPct(qText, 'well behaved'))                      questions.wellBehaved     = agreeAndAbove;
    else if (findPct(qText, 'bullied'))                           questions.bullyingHandled = agreeAndAbove;
    else if (findPct(qText, 'communicates', 'aware of what'))     questions.communication   = agreeAndAbove;
    else if (findPct(qText, 'concerns', 'worries'))               questions.concernsHandled = agreeAndAbove;
    else if (findPct(qText, 'recommend'))                         questions.wouldRecommend  = vals[0] ?? agreeAndAbove;
    else if (findPct(qText, 'best interests'))                    questions.bestInterests   = agreeAndAbove;
    else if (findPct(qText, 'support', 'learn well'))             questions.rightSupport    = agreeAndAbove;
    else if (findPct(qText, 'special educational'))               questions.sendSupport     = agreeAndAbove;
  }

  if (!total && !Object.keys(questions).length) return null;
  return { totalResponses: total, academicYear, ...questions };
}

async function fetchParentView(urn) {
  if (!urn) return null;

  try {
    // ── Step 1: URN → Parent View ID (via redirect, don't follow) ──────────
    const urnRes = await fetch(
      `https://parentview.ofsted.gov.uk/parent-view-results/urn/${urn}`,
      { redirect: 'manual', headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    if (urnRes.status < 300 || urnRes.status >= 400) return null;
    const loc1 = urnRes.headers.get('location') ?? '';
    const pvIdMatch = loc1.match(/\/result\/(\d+)\/current/);
    if (!pvIdMatch) return null;
    const pvId = pvIdMatch[1];

    // ── Step 2: PV ID → latest year code (via /current redirect) ───────────
    const currentRes = await fetch(
      `https://parentview.ofsted.gov.uk/parent-view-results/survey/result/${pvId}/current`,
      { redirect: 'manual', headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    );
    const loc2 = currentRes.headers.get('location') ?? '';
    const yearMatch = loc2.match(/\/result\/\d+\/(\d+)$/);
    if (!yearMatch) return null;
    const latestYearCode = parseInt(yearMatch[1], 10);

    // ── Step 3: Try current year, fall back to previous 3 years ────────────
    // Parent View year codes are numeric survey-cycle IDs. If the latest year
    // has no data (school last inspected under an older framework, or data
    // not yet published), walk backwards to find any available data.
    // Stop after 3 misses — older data has diminishing signal value.
    for (let offset = 0; offset <= 3; offset++) {
      const yearCode = latestYearCode - offset;
      if (yearCode <= 0) break;

      const html = await safeFetchText(
        `https://parentview.ofsted.gov.uk/parent-view-results/survey/result-print/${pvId}/${yearCode}`,
      );
      const result = parseParentViewHtml(html);
      if (result) {
        glog('govuk_parentview_ok', {
          urn, pvId, yearCode, academicYear: result.academicYear,
          total: result.totalResponses, fallback: offset > 0 ? `-${offset}y` : null,
        });
        return result;
      }
      if (offset > 0) {
        glog('govuk_parentview_retry', { urn, pvId, yearCode, offset });
      }
    }

    glog('govuk_parentview_empty', { urn, pvId, latestYearCode });
    return null;

  } catch (err) {
    glog('govuk_parentview_fail', { urn, error: err.message });
    return null;
  }
}

// ─── School performance data ──────────────────────────────────────────────────

/**
 * Attempts to retrieve performance metrics from the compare-school-performance
 * download endpoint. Falls back to scraping the school profile page.
 */
export async function getPerformanceData(urn) {
  // Fetch both the primary/secondary download AND the 16-18 download in parallel.
  // The default URL returns KS2/KS4 for state schools; post-16 data is on a separate endpoint.
  const [mainText, post16Text] = await Promise.all([
    safeFetchText(`${COMPARE_PERF}/download-school-data?urn=${urn}`, { Accept: 'text/csv,text/html,*/*' }),
    safeFetchText(`${COMPARE_PERF}/download-school-data?urn=${urn}&type=16to18`, { Accept: 'text/csv,text/html,*/*' }),
  ]);

  if (!mainText && !post16Text) { glog('govuk_perf_fail', { urn }); return null; }

  // Detect if we got HTML instead of CSV (e.g. Cloudflare challenge page).
  // The vertical DfE CSV always starts with "No," as the first field.
  const looksLikeCsv = (t) => /^\s*No\s*,/i.test(t?.slice(0, 20) ?? '');
  if (mainText   && !looksLikeCsv(mainText))   glog('govuk_perf_not_csv',   { urn, bytes: mainText.length,   preview: mainText.slice(0, 120).replace(/\s+/g, ' ') });
  if (post16Text && !looksLikeCsv(post16Text)) glog('govuk_perf_not_csv16', { urn, bytes: post16Text.length, preview: post16Text.slice(0, 120).replace(/\s+/g, ' ') });

  const main   = (mainText   && looksLikeCsv(mainText))   ? parsePerformanceCsv(mainText)   : null;
  const post16 = (post16Text && looksLikeCsv(post16Text)) ? parsePerformanceCsv(post16Text) : null;

  // Merge: post-16 namespaces are added to the main result (KS5_25, KS5_STUDEST_25, etc.)
  const merged = { ...(main ?? {}), ...(post16 ?? {}) };

  if (Object.keys(merged).length) {
    glog('govuk_perf_ok', { urn, namespaces: Object.keys(merged) });
    return merged;
  }

  glog('govuk_perf_no_data', { urn });
  return null;
}

function parseCsvRow(line) {
  const vals = [];
  let inQuote = false, cur = '';
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { vals.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  vals.push(cur.trim());
  return vals;
}

/**
 * The DfE download-school-data CSV is a vertical/long format:
 *   No, Namespace, Variable, Value, Description
 *
 * Returns ALL non-suppressed rows grouped by namespace so the AI model
 * can interpret whatever data is present for this school type — rather
 * than hardcoding field names that may not exist (e.g. KS2 for a nursery,
 * KS4 for a primary).
 *
 * Returns: { namespace: [ { variable, value, description } ] }
 */
function parsePerformanceCsv(csv) {
  if (!csv?.trim()) return null;
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return null;

  // Confirm vertical format (first header cell is "No")
  const firstRow = parseCsvRow(lines[0]);
  if (firstRow[0]?.toLowerCase() !== 'no') return null;

  // Sentinel values DfE uses when data is unavailable or suppressed
  const SUPPRESS = new Set(['NA', 'NE', 'SUPP', 'NP', '', 'LOW', 'LOWCOV']);

  // Pure admin/identifier fields — not useful in the prompt block
  const SKIP_VARS = new Set([
    'URN', 'LA', 'LEA', 'ESTAB', 'LAESTAB', 'URN_AC',
    'RECTYPE', 'ALPHAIND', 'EDITION', 'YEAR',
    'ADDRESS1', 'ADDRESS2', 'ADDRESS3', 'TOWN', 'TELNUM',
    'PCON_CODE', 'PCON_NAME', 'ICLOSE', 'TAB15', 'TAB1618',
    'SCHNAME', 'LANAME',
  ]);

  // Keep useful L-namespace identity fields (PCODE needed for area lookups)
  const L_KEEP = new Set(['PCODE', 'GENDER', 'ADMPOL', 'RELCHAR', 'AGELOW', 'AGEHIGH', 'ISPRIMARY', 'ISSECONDARY', 'ISPOST16']);

  const byNamespace = {};

  for (const line of lines.slice(1)) {
    const parts = parseCsvRow(line);
    if (parts.length < 4) continue;
    const [, namespace, variable, value, ...rest] = parts;
    if (!namespace || !variable) continue;
    if (namespace === 'L' && !L_KEEP.has(variable)) continue;
    if (SKIP_VARS.has(variable)) continue;
    if (SUPPRESS.has(value) || !value?.trim()) continue;

    const description = rest.join(',').trim();
    if (!byNamespace[namespace]) byNamespace[namespace] = [];
    byNamespace[namespace].push({ variable, value, description });
  }

  return Object.keys(byNamespace).length ? byNamespace : null;
}

// ─── Financial benchmarking data ──────────────────────────────────────────────

/**
 * Fetches a URL and returns the response body as a Buffer.
 * Used for binary downloads (ZIP files).
 */
async function safeFetchBuffer(url, extraHeaders = {}) {
  const tag = url.slice(0, 100);
  const attempt = async () => {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_LONG_MS),
        headers: { 'User-Agent': BROWSER_UA, ...extraHeaders },
      });
      if (!res.ok) { glog('fetch_buffer_fail', { url: tag, status: res.status }); return null; }
      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);
      glog('fetch_buffer_ok', { url: tag, bytes: buf.length });
      return buf;
    } catch (err) {
      glog('fetch_buffer_err', { url: tag, err: String(err.message ?? err).slice(0, 120) });
      return null;
    }
  };
  return withRetry(attempt);
}

/**
 * Decompresses the first file from a single-file ZIP buffer.
 * Uses Node's built-in zlib (inflateRaw) — no npm dependency needed.
 * Returns the content as a UTF-8 string, or null on failure.
 */
async function unzipFirst(buf) {
  if (!buf || buf.length < 30) return null;
  try {
    const { inflateRawSync } = await import('node:zlib');
    // Locate PK\x03\x04 local file header
    const i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (i === -1) return null;
    const compression  = buf.readUInt16LE(i + 8);   // 0 = stored, 8 = deflate
    const compressedSz = buf.readUInt32LE(i + 18);
    const filenameLen  = buf.readUInt16LE(i + 26);
    const extraLen     = buf.readUInt16LE(i + 28);
    const dataStart    = i + 30 + filenameLen + extraLen;
    const data         = buf.subarray(dataStart, dataStart + compressedSz);
    if (compression === 0) return data.toString('utf8');           // stored
    if (compression === 8) return inflateRawSync(data).toString('utf8'); // deflate
    return null;
  } catch {
    return null;
  }
}

/**
 * Scrapes headline figures and per-category spending from FBIT.
 *
 * Balance/reserve live on the main school page (lighter, 31KB).
 * Per-category detail lives on spending-and-costs (131KB, all 8 categories).
 * Both fetches run in parallel.
 */
async function fetchFBITSpending(urn) {
  const [mainHtml, costsHtml] = await Promise.all([
    safeFetchText(`${FIN_BENCH}/school/${urn}`),
    safeFetchText(`${FIN_BENCH}/school/${urn}/spending-and-costs`),
  ]);
  if (!mainHtml && !costsHtml) return null;

  const decode = (s) => (s ?? '').replace(/&#xA3;/g, '£').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
  const main   = decode(mainHtml);
  const d      = decode(costsHtml);

  // Headline figures — label paragraph immediately followed by value paragraph
  const headlineRe = (src, label) => {
    const re = new RegExp(label + '[\\s\\S]{0,300}?(-?£[\\d,]+)', 'i');
    const m  = src.match(re);
    return m ? m[1] : null;
  };
  const balance = headlineRe(main, 'In year balance');
  const reserve = headlineRe(main, 'Revenue reserve');

  // Per-category spending: split HTML on spending-priorities section IDs
  const categories = {};
  const blocks = d.split(/<section id="spending-priorities-/);
  for (const block of blocks.slice(1)) {
    const heading = (block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1]
      ?.replace(/<[^>]+>/g, '').trim();
    if (!heading) continue;
    const spans = Array.from(block.matchAll(/<span>(£[\d,]+)<\/span>/g)).map(x => x[1]);
    if (!spans.length) continue;
    const unit     = block.includes('per sq metre') ? '/sqm' : '/pupil';
    const moreLess = block.includes('>more<') ? 'more' : block.includes('>less<') ? 'less' : null;
    categories[heading] = {
      school:  spans[0] ? spans[0] + unit : null,
      average: spans[1] ? spans[1] + unit : null,
      diff:    (spans[2] && moreLess) ? `${spans[2]} ${moreLess} than avg` : null,
    };
  }

  if (!balance && !reserve && !Object.keys(categories).length) return null;
  return { balance, reserve, categories };
}

/**
 * Parses a single CSV row, respecting double-quoted fields that may contain commas.
 * Handles the RFC 4180 convention used by FBIT census exports.
 */
function parseCSVRow(line) {
  const fields = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; } // escaped quote
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Downloads the FBIT census ZIP export and parses the row for this school.
 * The ZIP contains a single CSV with workforce and pupil metrics for the
 * school and its comparator set.
 *
 * NOTE: School names can contain commas (e.g. "Redriff Primary, City of London
 * Academy"), so all row parsing uses parseCSVRow() rather than a bare split(',').
 */
async function fetchFBITCensus(urn) {
  const buf = await safeFetchBuffer(`${FIN_BENCH}/school/${urn}/census/download`);
  if (!buf) { glog('govuk_fin_census_fail', { urn, reason: 'no_buffer' }); return null; }

  // Validate ZIP magic bytes (PK\x03\x04). If we got HTML (e.g. Cloudflare challenge),
  // the buffer starts with '<' (0x3c) — log the first bytes so CloudWatch shows the cause.
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  if (!isZip) {
    glog('govuk_fin_census_fail', {
      urn, reason: 'not_zip', bytes: buf.length,
      prefix: buf.subarray(0, 60).toString('utf8').replace(/\s+/g, ' '),
    });
    return null;
  }

  const csv = await unzipFirst(buf);
  if (!csv) { glog('govuk_fin_census_fail', { urn, reason: 'unzip_fail', bytes: buf.length }); return null; }

  const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  // Strip BOM, split headers (header row has no quoted commas, safe to split naively)
  const headers = lines[0].replace(/^\uFEFF/, '').split(',').map(h => h.trim());
  const urnIdx  = headers.findIndex(h => /^URN$/i.test(h));
  if (urnIdx === -1) return null;

  // Find the row for this school — must use proper CSV parse so quoted school
  // names with commas don't shift field indices
  const row = lines.slice(1).find(l => parseCSVRow(l)[urnIdx]?.trim() === String(urn));
  if (!row) return null;

  const cells = parseCSVRow(row);
  const get   = (col) => {
    const idx = headers.findIndex(h => h === col);
    return idx !== -1 ? (cells[idx]?.trim() || null) : null;
  };

  const pupils       = parseFloat(get('TotalPupils'))                       || null;
  const teachersFTE  = parseFloat(get('Teachers'))                          || null;
  const workforceFTE = parseFloat(get('Workforce'))                         || null;
  const seniorFTE    = parseFloat(get('SeniorLeadership'))                  || null;
  const taFTE        = parseFloat(get('TeachingAssistant'))                 || null;
  const qualPct      = parseFloat(get('PercentTeacherWithQualifiedStatus')) || null;
  const ptRatio      = (pupils && teachersFTE) ? Math.round(pupils / teachersFTE * 10) / 10 : null;

  // Compute comparator-set average QTS% from all rows in the CSV
  // (comparator rows also need proper CSV parsing for the same reason)
  const qtsIdx = headers.findIndex(h => h === 'PercentTeacherWithQualifiedStatus');
  const comparatorQtsValues = lines.slice(1)
    .map(l => parseFloat(parseCSVRow(l)[qtsIdx]))
    .filter(v => !isNaN(v));
  const comparatorQtsAvg = comparatorQtsValues.length
    ? Math.round(comparatorQtsValues.reduce((s, v) => s + v, 0) / comparatorQtsValues.length * 10) / 10
    : null;

  return {
    workforceFTE,
    teachersFTE,
    seniorLeadershipFTE:      seniorFTE,
    teachingAssistantFTE:     taFTE,
    qualifiedTeachersPct:     qualPct != null ? qualPct + '%' : null,
    comparatorQtsAvgPct:      comparatorQtsAvg != null ? comparatorQtsAvg + '%' : null,
    pupilTeacherRatio:        ptRatio,
  };
}

/**
 * Fetches financial benchmarking data from FBIT:
 *   - spending-and-costs page (HTML) → balance, reserve, 8 spending categories
 *   - census/download (ZIP→CSV)      → workforce FTE, pupil:teacher ratio, QTS %
 *
 * Both fetches run in parallel. Either can succeed independently.
 */
// ─── KS5 LA performance (EES A-level datasets) ──────────────────────────

const EES_KS5_REGION_DS = '019d913a-eae0-7043-b196-875639ce5402';
const EES_KS5_RETENTION_DS = '019d9139-4416-70c8-9275-ed2def6c2eb9';

/**
 * Fetches KS5 LA-level averages from EES datasets.
 * Returns { avgPoints, retention } or null.
 */
export async function getLAPerformanceKS5(laCode) {
  if (!laCode) return null;
  const EES_BASE = 'https://api.education.gov.uk/statistics/v1';
  const result = {};

  // 1. A-level region/subject dataset — average points per entry
  try {
    const params = new URLSearchParams({
      'locations.in': `LA|code|${laCode}`,
      'timePeriods.in': '2024/2025|AY',
      'pageSize': '50',
    });
    const url = `${EES_BASE}/data-sets/${EES_KS5_REGION_DS}/query?${params}`;
    const data = await safeFetchJson(url);
    if (data?.results?.length) {
      // Find aggregate row: institution type = state-funded, metric = avg points
      for (const r of data.results) {
        if (r.filters?.['41LUZ'] === '0hvJT' && r.filters?.['mMa9K'] === 'eL5au' && r.filters?.['52udi'] === '43TGU') {
          const pts = parseFloat(r.values?.tjcGE);
          if (!isNaN(pts) && pts > 20 && pts < 60) result.avgPoints = String(pts);
        }
        // VA score
        if (r.filters?.['41LUZ'] === 'WiUz2' && r.filters?.['mMa9K'] === 'fdCSY' && r.filters?.['52udi'] === '43TGU') {
          const va = parseFloat(r.values?.tjcGE);
          if (!isNaN(va) && va > -3 && va < 3) result.vaScore = String(va);
        }
      }
    }
  } catch (_) {}

  // 2. Retention dataset
  try {
    const params = new URLSearchParams({
      'locations.in': `LA|code|${laCode}`,
      'timePeriods.in': '2024/2025|AY',
      'pageSize': '10',
    });
    const url = `${EES_BASE}/data-sets/${EES_KS5_RETENTION_DS}/query?${params}`;
    const data = await safeFetchJson(url);
    if (data?.results?.length) {
      // TcBPJ=9cnB4 = All pupils, hrSyW=IpD1B = Total
      for (const r of data.results) {
        if (r.filters?.['TcBPJ'] === '9cnB4' && r.filters?.['hrSyW'] === 'IpD1B') {
          const ret = parseFloat(r.values?.wEWyb);
          if (!isNaN(ret) && ret > 50 && ret < 100) result.retention = String(ret);
        }
      }
    }
  } catch (_) {}

  return Object.keys(result).length ? result : null;
}

// ─── KS4 Subject entries (bundled EES CSV lookup) ─────────────────────────

let _subjectEntriesIndex = null;

function loadSubjectEntriesIndex() {
  if (!_subjectEntriesIndex) {
    const path = new URL('./sources/subject-entries-by-urn.json', import.meta.url);
    _subjectEntriesIndex = JSON.parse(readFileSync(path, 'utf8'));
  }
  return _subjectEntriesIndex;
}

export function fetchSubjectEntries(urn) {
  if (!urn) return null;
  const index = loadSubjectEntriesIndex();
  return index[String(urn)] || null;
}

// ─── KS5 Subject entries (bundled EES CSV lookup) ─────────────────────────

let _ks5SubjectIndex = null;

function loadKS5SubjectIndex() {
  if (!_ks5SubjectIndex) {
    const path = new URL('./sources/ks5-subject-entries-by-urn.json', import.meta.url);
    _ks5SubjectIndex = JSON.parse(readFileSync(path, 'utf8'));
  }
  return _ks5SubjectIndex;
}

export function fetchKS5SubjectEntries(urn) {
  if (!urn) return null;
  const index = loadKS5SubjectIndex();
  return index[String(urn)] || null;
}

export async function getFinancialData(urn) {
  const [spendRes, censusRes] = await Promise.allSettled([
    fetchFBITSpending(urn),
    fetchFBITCensus(urn),
  ]);

  const s = spendRes.status  === 'fulfilled' ? spendRes.value  : null;
  const c = censusRes.status === 'fulfilled' ? censusRes.value : null;

  if (!s && !c) { glog('govuk_fin_no_data', { urn }); return null; }

  // Derive total spend per pupil by summing all per-pupil categories.
  // Premises is expressed per sqm so is excluded from the sum.
  // Also add derived percentage diff to each category and compute comparator total.
  let totalSpendPerPupil = null;
  let comparatorTotalPerPupil = null;
  if (s?.categories) {
    const parse = (str) => str ? parseInt(str.replace(/[£,\/a-z ]/gi, ''), 10) : NaN;
    let schoolSum = 0, avgSum = 0, schoolCount = 0, avgCount = 0;

    for (const [, v] of Object.entries(s.categories)) {
      if (!v.school?.endsWith('/pupil')) continue;
      const sVal = parse(v.school);
      const aVal = parse(v.average);
      if (!isNaN(sVal)) { schoolSum += sVal; schoolCount++; }
      if (!isNaN(aVal)) { avgSum    += aVal; avgCount++; }
      // Add percentage diff to the category object
      if (!isNaN(sVal) && !isNaN(aVal) && aVal > 0) {
        v.pctDiff = Math.round((sVal - aVal) / aVal * 100) + '%';
      }
    }

    if (schoolCount) totalSpendPerPupil     = '£' + schoolSum.toLocaleString('en-GB') + '/pupil';
    if (avgCount)    comparatorTotalPerPupil = '£' + avgSum.toLocaleString('en-GB')   + '/pupil';
  }

  const result = {
    inYearBalance:         s?.balance                    ?? null,
    revenueReserve:        s?.reserve                    ?? null,
    totalSpendPerPupil,
    comparatorTotalPerPupil,
    spendingCategories:    s?.categories                 ?? null,
    workforceFTE:          c?.workforceFTE               ?? null,
    teachersFTE:           c?.teachersFTE                ?? null,
    seniorLeadershipFTE:   c?.seniorLeadershipFTE        ?? null,
    teachingAssistantFTE:  c?.teachingAssistantFTE       ?? null,
    qualifiedTeachersPct:  c?.qualifiedTeachersPct       ?? null,
    comparatorQtsAvgPct:   c?.comparatorQtsAvgPct        ?? null,
    pupilTeacherRatio:     c?.pupilTeacherRatio          ?? null,
  };

  glog('govuk_fin_ok', { urn, hasSpending: !!s, hasCensus: !!c });
  return result;
}

// ─── Prompt block formatters ──────────────────────────────────────────────────

function fmtOfsted(ofsted, isIndependent) {
  if (isIndependent) {
    return '- Independent school: Ofsted does not inspect — fetch ISI report from isi.net via web search.';
  }
  if (!ofsted?.overall) return '- _Not retrieved — search reports.ofsted.gov.uk by URN or school name._';

  const lines = [
    `- Overall: **${ofsted.overall}**${ofsted.date ? ` (${ofsted.date})` : ''}`,
  ];
  // New Nov-2025 report card format
  if (ofsted.achievement)   lines.push(`- Achievement: ${ofsted.achievement}`);
  if (ofsted.attendance)    lines.push(`- Attendance and Behaviour: ${ofsted.attendance}`);
  if (ofsted.curriculum)    lines.push(`- Curriculum and Teaching: ${ofsted.curriculum}`);
  if (ofsted.inclusion)     lines.push(`- Inclusion: ${ofsted.inclusion}`);
  if (ofsted.leadershipGov) lines.push(`- Leadership and Governance: ${ofsted.leadershipGov}`);
  if (ofsted.wellbeing)     lines.push(`- Personal Development and Wellbeing: ${ofsted.wellbeing}`);
  if (ofsted.post16)        lines.push(`- Post-16 Provision: ${ofsted.post16}`);
  // Old framework grades
  if (!ofsted.achievement) {
    if (ofsted.qualityOfEducation)  lines.push(`- Quality of Education: ${ofsted.qualityOfEducation}`);
    if (ofsted.behaviour)           lines.push(`- Behaviour and Attitudes: ${ofsted.behaviour}`);
    if (ofsted.personalDevelopment) lines.push(`- Personal Development: ${ofsted.personalDevelopment}`);
    if (ofsted.leadership)          lines.push(`- Leadership and Management: ${ofsted.leadership}`);
    if (ofsted.sixthForm)           lines.push(`- Sixth Form Provision: ${ofsted.sixthForm}`);
  }
  // FE/Sixth-form college sub-grades
  if (ofsted.eduProgrammes) lines.push(`- Education programmes for young people: ${ofsted.eduProgrammes}`);
  if (ofsted.highNeeds)     lines.push(`- Provision for learners with high needs: ${ofsted.highNeeds}`);
  if (ofsted.safeguarding) lines.push(`- Safeguarding: ${ofsted.safeguarding}`);
  if (ofsted.framework)    lines.push(`- Framework: ${ofsted.framework}`);

  // PDF narrative sections extracted server-side
  // Helper: add a section only if it has content
  const addSection = (heading, content) => {
    if (content) lines.push(`\n**${heading}**\n${content}`);
  };

  addSection("What it's like to be a pupil", ofsted.pupilExperience);
  // Old framework graded inspection sub-sections
  addSection('Quality of Education',       ofsted.qualityOfEducation);
  addSection('Behaviour and Attitudes',    ofsted.behaviourAndAttitudes);
  addSection('Personal Development',       ofsted.personalDevelopment);
  addSection('Leadership and Management',  ofsted.leadershipAndManagement);
  // New Nov-2025 format sections (won't appear for older reports)
  addSection('Achievement',                ofsted.achievement);
  addSection('Inclusion',                  ofsted.inclusion);
  // Improvement flags
  addSection('What the school needs to do to improve', ofsted.nextSteps);

  const anyPdfContent = ofsted.pupilExperience || ofsted.qualityOfEducation
    || ofsted.behaviourAndAttitudes || ofsted.personalDevelopment
    || ofsted.leadershipAndManagement || ofsted.achievement || ofsted.inclusion
    || ofsted.nextSteps;

  if (!anyPdfContent && ofsted.reportUrl) {
    lines.push(`- Report PDF: ${ofsted.reportUrl} _(content not extracted — fetch via web search if needed)_`);
  }

  return lines.join('\n');
}

/**
 * Renders DfE performance data grouped by namespace, filtered to phase-relevant
 * namespaces only. Displays as markdown tables using the CSV description field
 * as the human-readable row label.
 *
 * Phase filtering:
 *   Primary / Middle-primary → KS2, ABS, CENSUS, L
 *   Secondary / All-through  → KS4, KS5, ABS, CENSUS, L
 *   16 plus                  → KS5, ABS, CENSUS, L
 *   Nursery / unknown        → ABS, CENSUS, L
 */
function fmtAcademicResults(perf, phase) {
  if (!perf) return '_Not retrieved — search compare-school-performance.service.gov.uk by URN._';

  const ph = (phase ?? '').toLowerCase();
  let allowed;
  if (/primary|middle.*primary/i.test(ph)) {
    allowed = ns => /^(KS1|KS2|ABS|CENSUS|L)/.test(ns);
  } else if (/secondary|all.through|middle.*secondary/i.test(ph)) {
    allowed = ns => /^(KS1|KS2|KS4|KS5|ABS|CENSUS|L)/.test(ns); // all-through may have KS1/KS2
  } else if (/16.plus/i.test(ph)) {
    allowed = ns => /^(KS5|ABS|CENSUS|L)/.test(ns);
  } else {
    allowed = () => true; // unknown phase — pass everything through
  }

  // Friendly section headings
  const NS_LABELS = {
    KS1_25:    'Key Stage 1 (2024/25)',
    KS2_25:    'Key Stage 2 (2024/25)',
    KS4_25:    'Key Stage 4 (2024/25)',
    KS5_25:    'Key Stage 5 (2024/25)',
    ABS_24:    'Absence (2023/24)',
    CENSUS_25: 'Pupil Census (2025)',
    L:         'School Identity (DfE)',
  };

  const blocks = [];
  for (const [namespace, rows] of Object.entries(perf)) {
    if (!allowed(namespace)) continue;
    const label = NS_LABELS[namespace] ?? namespace;

    // Build a markdown table; use description as the metric label, fall back to variable code
    const tableRows = rows.map(({ variable, value, description }) => {
      // Truncate very long descriptions to keep the table legible
      let metric = (description || variable).trim();
      if (metric.length > 90) metric = metric.slice(0, 87) + '…';
      return `| ${metric} | ${value} |`;
    });

    if (tableRows.length) {
      blocks.push(`**${label}**\n| Metric | Value |\n|---|---|\n${tableRows.join('\n')}`);
    }
  }
  return blocks.length ? blocks.join('\n\n') : '_No performance data available._';
}

function fmtFinancial(fin, isIndependent) {
  if (!fin) {
    if (isIndependent) return '- _Not available for independent schools._';
    return '- _Not retrieved — data may not be published for this school on the financial benchmarking service. Check https://financial-benchmarking-and-insights-tool.education.gov.uk by URN._';
  }
  const lines = [];

  // Headline balance figures
  if (fin.inYearBalance)     lines.push(`- In-year balance: ${fin.inYearBalance}`);
  if (fin.revenueReserve)    lines.push(`- Revenue reserve: ${fin.revenueReserve}`);
  if (fin.totalSpendPerPupil) {
    const comparatorNote = fin.comparatorTotalPerPupil ? ` (comparator avg: ${fin.comparatorTotalPerPupil})` : '';
    lines.push(`- Total spend per pupil (excl. premises): ${fin.totalSpendPerPupil}${comparatorNote}`);
  }

  // Workforce / staffing
  if (fin.pupilTeacherRatio)    lines.push(`- Pupil:teacher ratio: ${fin.pupilTeacherRatio}:1`);
  if (fin.workforceFTE)         lines.push(`- Total workforce FTE: ${fin.workforceFTE}`);
  if (fin.teachersFTE)          lines.push(`- Teachers FTE: ${fin.teachersFTE}`);
  if (fin.seniorLeadershipFTE)  lines.push(`- Senior leadership FTE: ${fin.seniorLeadershipFTE}`);
  if (fin.teachingAssistantFTE) lines.push(`- Teaching assistants FTE: ${fin.teachingAssistantFTE}`);
  if (fin.qualifiedTeachersPct) {
    const comparatorNote = fin.comparatorQtsAvgPct ? ` (comparator set avg: ${fin.comparatorQtsAvgPct})` : '';
    lines.push(`- % teachers with Qualified Teacher Status (QTS): ${fin.qualifiedTeachersPct}${comparatorNote}`);
  }

  // Per-category spending vs comparator average
  if (fin.spendingCategories && Object.keys(fin.spendingCategories).length) {
    lines.push('');
    lines.push('**Spending per pupil vs similar schools (FBIT)**');
    for (const [cat, data] of Object.entries(fin.spendingCategories)) {
      const parts = [data.school ?? '?'];
      if (data.average) parts.push(`avg ${data.average}`);
      if (data.diff)    parts.push(data.diff);
      if (data.pctDiff) parts.push(data.pctDiff);
      lines.push(`- ${cat}: ${parts.join(' | ')}`);
    }
  }

  return lines.length ? lines.join('\n') : '- _No financial figures parsed._';
}

function fmtGIASDetails(details) {
  if (!details) return null;
  const lines = [];
  if (details.postcode)           lines.push(`- Postcode: ${details.postcode}`);
  if (details.la)                 lines.push(`- Local authority: ${details.la}`);
  if (details.numberOnRoll)       lines.push(`- Pupils on roll: ${details.numberOnRoll}`);
  if (details.capacity)           lines.push(`- Capacity: ${details.capacity}`);
  if (details.fsmPct)             lines.push(`- FSM eligible (%): ${details.fsmPct}`);
  if (details.ehcPlanPct)         lines.push(`- Pupils with EHC plan (%): ${details.ehcPlanPct}`);
  if (details.senSupportPct)      lines.push(`- Pupils with SEN support (%): ${details.senSupportPct}`);
  if (details.gender)             lines.push(`- Gender: ${details.gender}`);
  if (details.religiousCharacter) lines.push(`- Religious character: ${details.religiousCharacter}`);
  if (details.admissionsPolicy)   lines.push(`- Admissions policy: ${details.admissionsPolicy}`);
  return lines.length ? lines.join('\n') : null;
}

function fmtAreaData(area) {
  if (!area) return '- _Not retrieved — postcode lookup unavailable._';
  const lines = [];

  // ── Header: geography context ────────────────────────────────────────────
  lines.push(`- Postcode: ${area.postcode ?? '?'}`);
  lines.push(`- LSOA: ${area.lsoa ?? '?'} | MSOA: ${area.msoa ?? '?'}`);
  lines.push(`- District: ${area.district ?? 'Unknown'} | Region: ${area.region ?? 'Unknown'}`);

  // ── Deprivation (LSOA — tightest geographic grain available) ────────────
  if (area.imd) {
    const imd = area.imd;
    const popNote = imd.population ? ` · pop. ~${imd.population.toLocaleString('en-GB')} (${imd.populationYear})` : '';
    lines.push('');
    lines.push(`**Deprivation — IMD ${imd.year}, LSOA: ${imd.lsoaCode}${popNote}**`);
    lines.push('| Measure | Value | Interpretation |');
    lines.push('|---|---|---|');
    if (imd.imdScore  != null) lines.push(`| Overall IMD Score | ${imd.imdScore} | Higher = more deprived |`);
    if (imd.imdRank   != null) lines.push(`| Overall IMD Rank | ${imd.imdRank.toLocaleString('en-GB')} | (1 = most deprived in England) |`);
    if (imd.imdDecile != null) lines.push(`| Overall IMD Decile | ${imd.imdDecile} / 10 | (1 = most deprived 10%) |`);
    if (imd.subDomains && Object.keys(imd.subDomains).length) {
      lines.push('| | | |');
      lines.push('| **Sub-domain deciles** | **Decile** | **1 = most deprived** |');
      for (const [domain, dec] of Object.entries(imd.subDomains)) {
        lines.push(`| ${domain} | ${dec} / 10 | |`);
      }
    }
    lines.push(`_Source: ${imd.source}_`);
  } else {
    lines.push('');
    lines.push('**Deprivation (IMD):** _Not retrieved_');
  }

  // ── Household income ─────────────────────────────────────────────────────
  // Crystal Roof (TEMP): more recent mean gross figure at MSOA level
  // ONS FYE 2018: older but gives net / after-housing-costs breakdown
  {
    const cr  = area.crystalRoof?.income ?? null;
    const ons = area.income ?? null;
    const hasAny = cr || ons;
    lines.push('');
    lines.push('**Household Income — MSOA level**');
    if (hasAny) {
      lines.push('| Measure | Annual | Notes |');
      lines.push('|---|---|---|');
      if (cr)  lines.push(`| Mean gross household income | ${cr.meanAnnualHouseholdIncome} | Census 2021 era (Crystal Roof ⚠️ TEMP) |`);
      if (ons?.netAnnualHouseholdIncome)    lines.push(`| Net household income | ${ons.netAnnualHouseholdIncome} | ONS FYE 2018 |`);
      if (ons?.totalAnnualHouseholdIncome)  lines.push(`| Total income (before housing costs) | ${ons.totalAnnualHouseholdIncome} | ONS FYE 2018 |`);
      if (ons?.afterHousingCostsIncome)     lines.push(`| Net income after housing costs | ${ons.afterHousingCostsIncome} | ONS FYE 2018 |`);
      if (ons?.netEquivalisedIncome)        lines.push(`| Net equivalised income (per capita) | ${ons.netEquivalisedIncome} | ONS FYE 2018 |`);
      if (ons?.msoaName)                    lines.push(`_MSOA: ${ons.msoaName}_`);
    } else {
      lines.push('_Not retrieved_');
    }
  }

  // ── House prices — actual sales within 800m, last 5 years ────────────────
  if (area.pricePaid) {
    const pp = area.pricePaid;
    lines.push('');
    lines.push(`**Actual Sale Prices — within ~800m of school, last 5 years (${pp.totalTransactions} sales)**`);
    lines.push('| Property type | Median sale price |');
    lines.push('|---|---|');
    lines.push(`| All types combined | ${pp.medianAllTypes} |`);
    if (pp.byType) {
      // Consistent order
      for (const type of ['Detached', 'Semi-detached', 'Terraced', 'Flat / Maisonette']) {
        if (pp.byType[type]) lines.push(`| ${type} | ${pp.byType[type]} |`);
      }
    }
    lines.push(`_Source: ${pp.source} · ${pp.postcodesQueried} postcodes queried_`);
  } else {
    lines.push('');
    lines.push('**Actual Sale Prices:** _Not retrieved_');
  }

  // ── Ethnic profile (LSOA — tightest grain available) ─────────────────────
  if (area.ethnicity && Object.keys(area.ethnicity).length) {
    const sorted = Object.entries(area.ethnicity).sort(([,a],[,b]) => b - a);

    // Broad group summary
    const groups = {};
    for (const [label, pct] of sorted) {
      const broad = label.startsWith('White:') ? 'White'
        : label.startsWith('Asian')            ? 'Asian'
        : label.startsWith('Black')            ? 'Black'
        : label.startsWith('Mixed')            ? 'Mixed'
        : 'Other';
      groups[broad] = (groups[broad] ?? 0) + pct;
    }
    const broadSummary = Object.entries(groups)
      .sort(([,a],[,b]) => b - a)
      .map(([k, v]) => `${k} ${Math.round(v)}%`)
      .join(' | ');

    lines.push('');
    const lsoaNote = area.lsoa ? `LSOA ${area.lsoa}` : 'local area';
    const popNote  = area.imd?.population ? `, ~${area.imd.population.toLocaleString('en-GB')} residents` : '';
    lines.push(`**Ethnic Profile — immediate area around school (${lsoaNote}${popNote}), Census 2021** (${broadSummary})`);
    lines.push('| Group | % |');
    lines.push('|---|---|');
    for (const [label, pct] of sorted) {
      lines.push(`| ${label} | ${pct}% |`);
    }
  } else {
    lines.push('');
    lines.push('**Ethnicity:** _Not retrieved_');
  }

  // ── Qualifications (Output Area, Census 2021) — from Crystal Roof ⚠️ TEMP ──
  const cr = area.crystalRoof ?? null;
  if (cr?.qualifications) {
    const q = cr.qualifications;
    lines.push('');
    lines.push(`**Qualifications — immediate area around school (Output Area, Census 2021, n≈${q.totalResidents})** _(⚠️ TEMP: Crystal Roof — replace with Nomis NM_2082_1)_`);
    lines.push('| Highest qualification | % of residents |');
    lines.push('|---|---|');
    if (q.level4AndAbove   != null) lines.push(`| Level 4+ (degree and above) | ${q.level4AndAbove}% |`);
    if (q.level3           != null) lines.push(`| Level 3 (A-level equivalent) | ${q.level3}% |`);
    if (q.level2           != null) lines.push(`| Level 2 (GCSE equivalent) | ${q.level2}% |`);
    if (q.apprenticeship   != null) lines.push(`| Apprenticeship | ${q.apprenticeship}% |`);
    if (q.level1AndEntry   != null) lines.push(`| Level 1 and entry level | ${q.level1AndEntry}% |`);
    if (q.noQualifications != null) lines.push(`| No qualifications | ${q.noQualifications}% |`);
    if (q.other            != null) lines.push(`| Other / not classified | ${q.other}% |`);
  } else {
    lines.push('');
    lines.push('**Qualifications:** _Not retrieved_');
  }

  // ── Occupation / NS-SeC (Output Area, Census 2021) — from Crystal Roof ⚠️ TEMP
  if (cr?.occupation) {
    const o = cr.occupation;
    lines.push('');
    lines.push(`**Occupation (NS-SeC) — immediate area around school (Output Area, Census 2021, n≈${o.totalResidents})** _(⚠️ TEMP: Crystal Roof — replace with Nomis NM_2066_1)_`);
    lines.push('| Category | % of residents |');
    lines.push('|---|---|');
    if (o.managerialProfessional        != null) lines.push(`| Managerial, administrative & professional | ${o.managerialProfessional}% |`);
    if (o.intermediate                  != null) lines.push(`| Intermediate occupations | ${o.intermediate}% |`);
    if (o.routineAndManual              != null) lines.push(`| Routine and manual | ${o.routineAndManual}% |`);
    if (o.neverWorkedLongTermUnemployed != null) lines.push(`| Never worked / long-term unemployed | ${o.neverWorkedLongTermUnemployed}% |`);
    if (o.fullTimeStudents              != null) lines.push(`| Full-time students | ${o.fullTimeStudents}% |`);
  } else {
    lines.push('');
    lines.push('**Occupation:** _Not retrieved_');
  }

  return lines.join('\n');
}

function govLinks(urn) {
  return [
    `https://www.get-information-schools.service.gov.uk/Establishments/Establishment/Details/${urn}`,
    `https://www.compare-school-performance.service.gov.uk/school/${urn}`,
    `https://financial-benchmarking-and-insights-tool.education.gov.uk/school/${urn}`,
    `https://reports.ofsted.gov.uk/provider/21/${urn}`,
  ];
}

// ─── Slim formatters (used for prompt injection — targets ~1,800 tokens) ─────
//
// The detailed formatters above are kept for the debug script / human report.
// These slim versions strip sub-breakdowns and use compact prose/minimal tables
// so the AI model gets high-signal data without 50% of the token budget being
// consumed by 136 rows of DfE variable codes it barely needs.

/**
 * Picks ~15 high-signal variables by code rather than dumping all rows.
 * Covers KS2 (primary), KS4 (secondary), plus pupil census and absence for all.
 */
function fmtAcademicResultsSlim(perf, phase, fallbackNor = null, laPerf = null, tablesOnly = false, isIndependent = false, laPerfKS5 = null, subjectEntries = null, ks5SubjectEntries = null) {

  if (!perf) return '_Not retrieved_';

  const lines = [];

  // ── Data helpers ──────────────────────────────────────────────────────────

  // All rows across all namespaces, latest year first
  const allRows = Object.entries(perf)
    .sort(([a], [b]) => {
      const ya = parseInt(a.match(/_(\d+)$/)?.[1] ?? '0', 10);
      const yb = parseInt(b.match(/_(\d+)$/)?.[1] ?? '0', 10);
      return yb - ya;
    })
    .flatMap(([, rows]) => rows);

  const v = (code) => allRows.find(r => r.variable === code)?.value ?? null;

  // DfE uses 0, 0%, 0.0% as suppression markers for small cohorts.
  const suppressed = (val) => {
    if (val == null) return true;
    const s = String(val).trim();
    return s === '0' || s === '0%' || s === '0.0%' || s === '0.0';
  };
  const c = (val) => {
    if (val == null) return '—';
    const s = String(val).trim();
    return suppressed(s) ? '—' : s;
  };

  // Discover breakdown variants — tries KS2 (_B, _G) then KS4 (_BOYS, _GIRLS)
  const findVar = (base, suffix) => {
    if (!suffix) return v(base);
    const val = v(base + suffix);
    if (val != null && !suppressed(String(val).trim())) return val;
    // KS2 vs KS4 gender suffix cross-try
    if (suffix === '_BOYS' || suffix === '_B') {
      for (const s of ['_B', '_BOYS']) {
        const sv = v(base + s);
        if (sv != null && !suppressed(String(sv).trim())) return sv;
      }
    }
    if (suffix === '_GIRLS' || suffix === '_G') {
      for (const s of ['_G', '_GIRLS']) {
        const sv = v(base + s);
        if (sv != null && !suppressed(String(sv).trim())) return sv;
      }
    }
    if (suffix === '_NOTFSM6CLA1A' || suffix === '_NFSM6CLA1A') {
      for (const s of ['_NOTFSM6CLA1A', '_NFSM6CLA1A']) {
        const sv = v(base + s);
        if (sv != null && !suppressed(String(sv).trim())) return sv;
      }
    }
    // KS4 prefix variants: PT → PB (boys), PT → PG (girls)
    // e.g. PTL2BASICS_95 → PBL2BASICS_95, PGL2BASICS_95
    if ((suffix === '_BOYS' || suffix === '_B') && base.startsWith('PT')) {
      const pb = v('PB' + base.slice(2));
      if (pb != null && !suppressed(String(pb).trim())) return pb;
    }
    if ((suffix === '_GIRLS' || suffix === '_G') && base.startsWith('PT')) {
      const pg = v('PG' + base.slice(2));
      if (pg != null && !suppressed(String(pg).trim())) return pg;
    }
    // Also try for EBacc variant prefix
    if ((suffix === '_BOYS' || suffix === '_B') && base.startsWith('PTEBACC')) {
      const pb2 = v('PBEBACC' + base.slice(7));
      if (pb2 != null && !suppressed(String(pb2).trim())) return pb2;
    }
    if ((suffix === '_GIRLS' || suffix === '_G') && base.startsWith('PTEBACC')) {
      const pg2 = v('PGEBACC' + base.slice(7));
      if (pg2 != null && !suppressed(String(pg2).trim())) return pg2;
    }
    return null;
  };

  // National averages
  const nat2 = NATIONAL_AVG.KS2;
  const nat4 = NATIONAL_AVG.KS4;
  const nat5 = NATIONAL_AVG.KS5 ?? {};

  // ── Namespace detection ───────────────────────────────────────────────────

  const nsList = Object.keys(perf).filter(k => k !== 'L');
  const hasNs = (prefix) => nsList.some(n => n.startsWith(prefix));
  const hasKS2 = hasNs('KS2');
  const hasKS4 = hasNs('KS4');
  const hasKS5 = hasNs('KS5');

  // LA helpers (populated when laPerf is available)
  // Supports nested paths like 'rwm.yr25.expected' or 'att8' (auto-defaults to yr25)
  const la = (path) => {
    if (!laPerf) return '—';
    const parts = path.split('.');
    // KS2: 'rwm.expected' → auto-insert yr25 → 'rwm.yr25.expected'
    if (parts.length === 2 && !parts[1].startsWith('yr')) parts.splice(1, 0, 'yr25');
    let v = laPerf;
    for (const p of parts) {
      v = v?.[p];
      // Auto-default: if value is a {yr23, yr24, yr25} object, pick yr25
      if (v && typeof v === 'object' && v.yr25 != null && !Array.isArray(v)) v = v.yr25;
      if (v == null) return '—';
    }
    return String(v);
  };
  const laPct = (path) => {
    const val = la(path);
    return val !== '—' ? val + '%' : '—';
  };

  // ── Topic registry ────────────────────────────────────────────────────────
  //
  // Each topic: { heading, rows: [{label, var, col?}], cols }
  // col selects which column set: 'all' = single-value, 'abg' = All/Boys/Girls,
  // 'abgd' = +Disadvantaged, 'abgde' = +Disadvantaged+EAL,
  // 'abgdel' = +Disadvantaged+EAL+Local, 'abgdelE' = +England
  //
  // A topic renders only if at least one row has real (non-suppressed) data.

  const KS2_TOPICS = [
    {
      heading: 'Cohort',
      cols: 'abgdnelE',
      rows: [
        { label: 'Eligible cohort', var: 'TELIG',
          colVars: { '_G': 'GELIG', '_B': 'BELIG', '_FSM6CLA1A': 'TFSM6CLA1A', '_NOTFSM6CLA1A': 'TNOTFSM6CLA1A', '_EAL': 'TEALGRP2' } },
      ],
    },
    {
      heading: 'Attainment',
      cols: 'abgdnelE',
      rows: [
        { label: '% meeting expected standard (Reading, Writing & Maths)', var: 'PTRWM_EXP', la: 'rwm.expected', eng: nat2.PTRWM_EXP + '%' },
        { label: '% achieving higher standard (Reading, Writing & Maths)', var: 'PTRWM_HIGH', la: 'rwm.higher', eng: nat2.PTRWM_HIGH + '%' },
      ],
    },
    {
      heading: 'Scaled scores',
      cols: 'abgdnelE',
      rows: [
        { label: 'Reading — average scaled score', var: 'READ_AVERAGE', la: 'reading.avgScore', eng: '105' },
        { label: 'Maths — average scaled score', var: 'MAT_AVERAGE', la: 'maths.avgScore', eng: '104' },
        { label: 'GPS — average scaled score', var: 'GPS_AVERAGE', la: 'gps.avgScore', eng: '105' },
      ],
    },
    {
      heading: 'Per-subject attainment — % expected standard',
      cols: 'abgdnelE',
      rows: [
        { label: 'Reading', var: 'PTREAD_EXP', la: 'reading.expected', eng: nat2.PTREAD_EXP + '%' },
        { label: 'Writing (Teacher Assessment)', var: 'PTWRITTA_EXP', la: 'writing.expected', eng: nat2.PTWRITTA_EXP + '%' },
        { label: 'Maths', var: 'PTMAT_EXP', la: 'maths.expected', eng: nat2.PTMAT_EXP + '%' },
        { label: 'GPS', var: 'PTGPS_EXP', la: 'gps.expected', eng: nat2.PTGPS_EXP + '%' },
        { label: 'Science (Teacher Assessment)', var: 'PTSCITA_EXP', la: 'science.expected', eng: nat2.PTSCITA_EXP + '%' },
      ],
    },
    {
      heading: 'Per-subject attainment — % higher standard',
      cols: 'abgdnelE',
      rows: [
        { label: 'Reading', var: 'PTREAD_HIGH', la: 'reading.higher', eng: nat2.PTREAD_HIGH + '%' },
        { label: 'Writing (Teacher Assessment)', var: 'PTWRITTA_HIGH', la: 'writing.higher', eng: nat2.PTWRITTA_HIGH + '%' },
        { label: 'Maths', var: 'PTMAT_HIGH', la: 'maths.higher', eng: nat2.PTMAT_HIGH + '%' },
        { label: 'GPS', var: 'PTGPS_HIGH', la: 'gps.higher', eng: nat2.PTGPS_HIGH + '%' },
      ],
    },
  ];

  const KS2_EXTRA_TOPICS = [
    {
      heading: 'Cohort characteristics',
      cols: 'a',
      rows: [
        { label: '% disadvantaged', var: 'PTFSM6CLA1A' },
        { label: '% not disadvantaged', var: 'PTNOTFSM6CLA1A' },
        { label: '% EAL', var: 'PTEALGRP2' },
        { label: '% non-mobile', var: 'PTMOBN' },
        { label: '% SEN with EHC plan', var: 'PSENELE' },
        { label: '% SEN support', var: 'PSENELK' },
        { label: '% SEN total (EHC + support)', var: 'PSENELEK' },
      ],
    },
    {
      heading: 'Disadvantage gap',
      cols: 'a',
      rows: [
        { label: 'Reading, Writing & Maths expected — gap vs national (percentage points)', var: 'DIFFN_RWM_EXP' },
        { label: 'Reading, Writing & Maths higher — gap vs national (percentage points)', var: 'DIFFN_RWM_HIGH' },
      ],
    },
    {
      heading: 'Test participation',
      cols: 'a',
      rows: [
        { label: 'Reading — % absent from test', var: 'PTREAD_AT' },
        { label: 'Maths — % absent from test', var: 'PTMAT_AT' },
        { label: 'GPS — % absent from test', var: 'PTGPS_AT' },
        { label: 'Writing — % working towards expected', var: 'PTWRITTA_WTS' },
        { label: 'Writing — % absent/disapplied', var: 'PTWRITTA_AD' },
        { label: 'Science — % absent/disapplied', var: 'PTSCITA_AD' },
      ],
    },
  ];

  const KS4_TOPICS = [
    { heading: "Attainment 8", cols: "abgdnelE", rows: [
      { label: "Attainment 8 score", var: "ATT8SCR", la: "att8", eng: String(nat4.ATT8SCR) },
      { label: "English element", var: "ATT8SCRENG", la: "att8Eng", eng: String(nat4.ATT8_ENG) },
      { label: "Maths element", var: "ATT8SCRMAT", la: "att8Mat", eng: String(nat4.ATT8_MAT) },
      { label: "EBacc element", var: "ATT8SCREBAC", la: "att8Ebacc", eng: String(nat4.ATT8_EBACC) },
      { label: "Open element", var: "ATT8SCROPEN", la: "att8Open", eng: String(nat4.ATT8_OPEN) },
      { label: "Open — GCSE only", var: "ATT8SCROPENG", la: "att8OpenG", eng: String(nat4.ATT8_OPENG) },
      { label: "Open — non-GCSE", var: "ATT8SCROPENNG", la: "att8OpenNg", eng: String(nat4.ATT8_OPENNG) },
    ]},
    { heading: "Progress 8", cols: "abgdnelE", rows: [
      { label: "Progress 8 score", var: "P8MEA", la: "p8", eng: '0.00' },
    ]},
    { heading: "Cohort characteristics", cols: "a", rows: [
      { label: "Pupils at end of KS4", var: "TPUP" },
      { label: "% boys", var: "PBPUP" },
      { label: "% girls", var: "PGPUP" },
      { label: "% disadvantaged", var: "PTFSM6CLA1A" },
      { label: "% not disadvantaged", var: "PTNOTFSM6CLA1A" },
      { label: "% EAL", var: "PTEALGRP2" },
      { label: "% non-mobile", var: "PTNMOB" },
      { label: "% SEN with EHC plan", var: "PSENE4" },
      { label: "% SEN total", var: "PSEN_ALL4" },
      { label: "% SEN without EHC", var: "PSENK4" },
    ]},
    { heading: "Grade 5+ and 4+ English & Maths", cols: "abgdnelE", rows: [
      { label: "% grade 5+ English & maths", var: "PTL2BASICS_95", la: "grade5Em", eng: String(nat4.PTL2BASICS_95),
        colVars: { '_FSM6CLA1A': 'PTFSM6CLA1ABASICS_95', '_NOTFSM6CLA1A': 'PTNOTFSM6CLA1ABASICS_95', '_EAL': 'PTL2BASICSEAL_95' } },
      { label: "% grade 4+ English & maths", var: "PTL2BASICS_94", la: "grade4Em", eng: String(nat4.PTL2BASICS_94),
        colVars: { '_FSM6CLA1A': 'PTFSM6CLA1ABASICS_94', '_NOTFSM6CLA1A': 'PTNOTFSM6CLA1ABASICS_94', '_EAL': 'PTL2BASICSEAL_94' } },
    ]},
    { heading: "EBacc entry by subject", cols: "al", rows: [
      { label: "English", var: "PTEBACENG_E_PTQ_EE", la: "ebEeng" },
      { label: "Maths", var: "PTEBACMAT_E_PTQ_EE", la: "ebEmat" },
      { label: "Science", var: "PTEBAC2SCI_E_PTQ_EE", la: "ebEsci" },
      { label: "Humanities", var: "PTEBACHUM_E_PTQ_EE", la: "ebEhum" },
      { label: "Languages", var: "PTEBACLAN_E_PTQ_EE", la: "ebElan" },
    ]},
    { heading: "Post-16 destinations (2023 leavers)", cols: "al", rows: [
      { label: "% sustained education or employment", var: "OVERALL_DESTPER", la: "destOver" },
      { label: "% in education", var: "EDUCATIONPER", la: "destEdu" },
      { label: "% sixth form college", var: "SIXTH_COLPER" },
      { label: "% further education", var: "FEPER" },
      { label: "% apprenticeships", var: "APPRENPER" },
      { label: "% employment", var: "EMPLOYMENTPER" },
      { label: "% not sustained", var: "NOT_SUSTAINEDPER" },
    ]},
    { heading: "Entry volumes", cols: "a", rows: [
      { label: "Avg KS4 entries per pupil", var: "TAVENT_E_3NG_PTQ_EE" },
      { label: "Avg KS4 entries (disadv.)", var: "TAVENT_E_3NG_FSM6CLA1A_PTQ_EE" },
      { label: "Avg GCSE entries per pupil", var: "TAVENT_G_PTQ_EE" },
      { label: "% entering multiple languages", var: "PTMULTILAN_E" },
      { label: "% entering triple science", var: "PTTRIPLESCI_E" },
      { label: "Level 2 threshold (9-4 EM)", var: "PT5EM_94" },
      { label: "% achieving any qualification", var: "PTANYQ_PTQ_EE" },
    ]},
  ];

const KS5_TOPICS = [
    {
      heading: 'A-level attainment',
      cols: 'aE',
      rows: [
        { label: 'Total 16–18 students', var: 'TALLPUP_1618' },
        { label: 'A-level students', var: 'TALLPUP_ALEV_1618' },
        { label: 'Average A-level grade', var: 'TALLPPEGRD_ALEV_1618', eng: nat5.AVG_GRADE ?? 'B-' },
        { label: 'Average A-level points', var: 'TALLPPE_ALEV_1618', eng: String(nat5.AVG_PTS) },
        { label: 'Best 3 A-levels — grade', var: 'TB3PTSE_GRD' },
        { label: 'Best 3 A-levels — points', var: 'TB3PTSE' },
      ],
    },
    {
      heading: 'A-level progress',
      cols: 'aE',
      rows: [
        { label: 'Progress score (VA)', var: 'VA_INS_ALEV', ciLo: 'LCI_INS_ALEV', ciHi: 'UCI_INS_ALEV', eng: '0' },
        { label: 'Progress band', var: 'PROGRESS_BAND_ALEV' },
      ],
    },
    {
      heading: 'A-level value-added — disadvantaged',
      cols: 'a',
      rows: [
        { label: 'Disadvantaged students', var: 'TALLPUP_ALEV_1618_DIS' },
        { label: 'Average grade (disadvantaged)', var: 'TALLPPEGRD_ALEV_DIS' },
        { label: 'Average points (disadvantaged)', var: 'TALLPPE_ALEV_1618_DIS' },
        { label: 'Progress score (disadvantaged)', var: 'VA_INS_ALEV_DIS', ciLo: 'LCI_INS_ALEV_DIS', ciHi: 'UCI_INS_ALEV_DIS' },
      ],
    },
    {
      heading: 'Facilitating subjects & destinations',
      cols: 'aE',
      rows: [
        { label: '% AAB in ≥2 facilitating subjects', var: 'PTAAB_2FAC' },
        { label: '% achieving advanced maths', var: 'L3M_PER', eng: String(nat5.advMaths) },
        { label: '% retained to end of course', var: 'PT_RETAINED_ALEV_RET', eng: String(nat5.retained) },
        { label: '% to higher education', var: 'TOT_HEPER' },
        { label: '% to any sustained destination', var: 'ALL_PROGRESSED' },
      ],
    },
    {
      heading: 'Tech levels & T-levels',
      cols: 'all',
      rows: [
        { label: 'Tech cert students', var: 'TALLPUP_TECHCERT' },
        { label: 'Tech cert average grade', var: 'TALLPPEGRD_TECHCERT' },
        { label: 'Tech cert average points', var: 'TALLPPE_TECHCERT' },
        { label: 'T-level students', var: 'TALLPUP_TLEV' },
        { label: 'T-level average grade', var: 'TALLPPEGRD_TLEV' },
        { label: 'T-level average points', var: 'TALLPPE_TLEV' },
      ],
    },
    {
      heading: 'Applied general',
      cols: 'all',
      rows: [
        { label: 'Applied general students', var: 'TALLPUP_AGEN' },
        { label: 'Applied general average grade', var: 'TALLPPEGRD_AGEN' },
        { label: 'Applied general average points', var: 'TALLPPE_AGEN' },
      ],
    },
  ];

  // ── Table renderer ────────────────────────────────────────────────────────

  const hasData = (rows) => rows.some(r => !suppressed(v(r.var)));

  function renderTopic(topic, nsLabel) {
    if (!hasData(topic.rows)) return;

    lines.push('');
    lines.push(`**${topic.heading}**`);

    const cols = topic.cols;
    const isAll   = cols === 'all' || cols === 'a';
    const showAll  = isAll || cols !== 'progress';
    const showG    = !isAll && cols.includes('g');
    const showB    = !isAll && cols.includes('b');
    const showD    = !isAll && cols.includes('d');
    const showN    = !isAll && cols.includes('n');
    const showEal  = !isAll && cols.includes('e');
    const showLa   = !isAll && cols.includes('l');
    const showEng  = !isAll && cols.includes('E');

    // Build header — Girls before Boys per wire mock
    const header = ['Category'];
    if (showAll) header.push('All pupils');
    if (showG)   header.push('Girls');
    if (showB)   header.push('Boys');
    if (showD)   header.push('Disadvantaged');
    if (showN)   header.push('Not Disadv.');
    if (showEal) header.push('EAL');
    if (showLa)  header.push('Local Authority');
    if (showEng) header.push('England');
    lines.push('| ' + header.join(' | ') + ' |');
    lines.push('|' + header.map(() => '---:').join('|') + '|');

    for (const row of topic.rows) {
      const val = v(row.var);
      if (suppressed(val) && !row.ciLo && !row.eng) continue;

      const cells = [row.label];

      if (showAll) {
        let cell = c(val);
        if (row.ciLo && row.ciHi) {
          const lo = v(row.ciLo), hi = v(row.ciHi);
          if (lo != null && hi != null) cell += ` (CI: ${lo} to ${hi})`;
        }
        cells.push(cell);
      }
      const cv = row.colVars || {};
      if (showG) cells.push(c(cv['_G'] ? v(cv['_G']) : findVar(row.var, '_G')));
      if (showB) cells.push(c(cv['_B'] ? v(cv['_B']) : findVar(row.var, '_B')));
      if (showD) cells.push(c(cv['_FSM6CLA1A'] ? v(cv['_FSM6CLA1A']) : findVar(row.var, '_FSM6CLA1A')));
      if (showN) cells.push(c(cv['_NOTFSM6CLA1A'] ? v(cv['_NOTFSM6CLA1A']) : findVar(row.var, '_NOTFSM6CLA1A')));
      if (showEal) cells.push(c(cv['_EAL'] ? v(cv['_EAL']) : findVar(row.var, '_EAL')));
      if (showLa) {
        if (row.la) {
          const laVal = la(row.la);
          const isPlain = row.la.includes('Score') || /^(att8|p8|ebaccAPS|att8Eng|att8Mat|att8Ebacc|att8Open|att8OpenG|att8OpenNg)$/.test(row.la);
          cells.push(isPlain ? laVal : laPct(row.la));
        } else {
          cells.push('—');
        }
      }
      if (showEng) {
        cells.push(row.eng ?? '—');
      }

      if (cells.slice(1).some(cell => cell !== '—')) {
        lines.push('| ' + cells.join(' | ') + ' |');
      }
    }
  }

  // ── Progress renderer (different column layout) ───────────────────────────

  const PROGRESS_BANDS = ['Well below average', 'Below average', 'Average', 'Above average', 'Well above average'];

  function renderProgress() {
    const subjects = [
      { label: 'Reading', base: 'READPROG' },
      { label: 'Writing', base: 'WRITPROG' },
      { label: 'Maths',  base: 'MATPROG' },
    ];
    const rows = subjects.filter(s => v(s.base + '_23') != null);
    if (!rows.length) return;

    lines.push('');
    lines.push('**Progress (KS1 to KS2) — 2022/23**');
    lines.push('| Progress Scores | Score | Banding | Confidence Interval |');
    lines.push('|---|---:|---|---|');

    for (const s of rows) {
      const b = s.base;
      const rawScore = v(b + '_23');
      const score = rawScore != null ? String(rawScore).trim() : '—';
      const descrIdx = parseInt(v(b + '_DESCR_23') ?? '3', 10);
      const band = PROGRESS_BANDS[Math.max(0, Math.min(4, 5 - (descrIdx || 3)))] || 'Average';
      const lo = v(b + '_LOWER_23');
      const hi = v(b + '_UPPER_23');
      const loStr = lo != null ? String(lo).trim() : '—';
      const hiStr = hi != null ? String(hi).trim() : '—';
      const ci = (loStr !== '—' && hiStr !== '—') ? `${loStr} to ${hiStr}` : '—';
      lines.push(`| ${s.label} | ${score} | ${band} | ${ci} |`);
    }
  }

  // ── EBacc subject achievement (9-4 and 9-5 combined table) ─────────────

  function renderEBaccSubjects() {
    const subjects = [
      { label: 'English',    v94: 'PTEBACENG_94',  v95: 'PTEBACENG_95',  v1: 'PTEBACENG91',  la94: 'eng94', la95: 'eng95', la1: 'eng1', eng94: String(nat4.EBACC_ENG_94), eng95: String(nat4.EBACC_ENG_95), eng1: String(nat4.EBACC_ENG_1) },
      { label: 'Maths',      v94: 'PTEBACMAT_94',  v95: 'PTEBACMAT_95',  v1: 'PTEBACMAT91',  la94: 'mat94', la95: 'mat95', la1: 'mat1', eng94: String(nat4.EBACC_MAT_94), eng95: String(nat4.EBACC_MAT_95), eng1: String(nat4.EBACC_MAT_1) },
      { label: 'Science',    v94: 'PTEBAC2SCI_94', v95: 'PTEBAC2SCI_95', v1: 'PTEBAC2SCI91', la94: 'sci94', la95: 'sci95', la1: 'sci1', eng94: String(nat4.EBACC_SCI_94), eng95: String(nat4.EBACC_SCI_95), eng1: String(nat4.EBACC_SCI_1) },
      { label: 'Humanities', v94: 'PTEBACHUM_94',  v95: 'PTEBACHUM_95',  v1: 'PTEBACHUM91',  la94: 'hum94', la95: 'hum95', la1: 'hum1', eng94: String(nat4.EBACC_HUM_94), eng95: String(nat4.EBACC_HUM_95), eng1: String(nat4.EBACC_HUM_1) },
      { label: 'Languages',  v94: 'PTEBACLAN_94',  v95: 'PTEBACLAN_95',  v1: 'PTEBACLAN91',  la94: 'lan94', la95: 'lan95', la1: 'lan1', eng94: String(nat4.EBACC_LAN_94), eng95: String(nat4.EBACC_LAN_95), eng1: String(nat4.EBACC_LAN_1) },
    ];
    const rows = subjects.filter(s => !suppressed(v(s.v94)) || !suppressed(v(s.v95)) || !suppressed(v(s.v1)));
    if (!rows.length) return;

    lines.push('');
    lines.push('**EBacc subject achievement**');
    lines.push('| Category | School | LA | England | School | LA | England | School | LA | England |');
    lines.push('| | 9-4 | 9-4 | 9-4 | 9-5 | 9-5 | 9-5 | 1+ | 1+ | 1+ |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const s of rows) {
      const la94 = la(s.la94); const la95 = la(s.la95); const la1 = la(s.la1);
      lines.push(`| ${s.label} | ${c(v(s.v94))} | ${la94 !== '—' ? la94 + '%' : '—'} | ${s.eng94}% | ${c(v(s.v95))} | ${la95 !== '—' ? la95 + '%' : '—'} | ${s.eng95}% | ${c(v(s.v1))} | ${la1 !== '—' ? la1 + '%' : '—'} | ${s.eng1}% |`);
    }
  }

  // ── KS4 timeseries — results over time ──────────────────────────────────

  function renderKS4Timeseries() {
    const groups = [
      { label: 'Attainment 8 Score', base: 'ATT8SCR', laKey: 'att8', isPct: false },
      { label: 'Progress 8 Score', base: 'P8MEA', laKey: 'p8', isPct: false },
      { label: 'Grade 5+ English & Maths', base: 'PTL2BASICS_95', laKey: 'grade5Em', isPct: true },
      { label: 'Grade 4+ English & Maths', base: 'PTL2BASICS_94', laKey: 'grade4Em', isPct: true },
      { label: 'EBacc Entry', base: 'PTEBACC_E_PTQ_EE', laKey: 'ebaccEntry', isPct: true },
    ];

    const fmt = (val, isPct) => {
      if (val == null) return '—';
      const s = String(val).trim().replace(/%$/, '');
      return suppressed(s) ? '—' : s + (isPct ? '%' : '');
    };

    const rows = [];
    for (const g of groups) {
      const s25 = v(g.base);
      const s24 = v(g.base + '_PREV');
      const s23 = v(g.base + '_PREV2');
      if (suppressed(s25) && suppressed(s24) && suppressed(s23)) continue;

      // Get LA values for each year
      const laVal = (yr) => {
        if (!laPerf || !g.laKey) return '—';
        const v = laPerf[g.laKey];
        if (!v || typeof v !== 'object') return '—';
        const yrVal = v[yr];
        return yrVal != null ? (g.isPct ? yrVal + '%' : yrVal) : '—';
      };

      rows.push(`| ${g.label} | ${fmt(s23, g.isPct)} | ${fmt(s24, g.isPct)} | ${fmt(s25, g.isPct)} |`);
      rows.push(`| Local Authority | ${laVal('yr23')} | ${laVal('yr24')} | ${laVal('yr25')} |`);
    }

    if (rows.length) {
      lines.push('');
      lines.push('**Results over time**');
      lines.push('| Category | 2023 final | 2024 final | 2025 final |');
      lines.push('|---|---:|---:|---:|');
      lines.push(...rows);
    }
  }

  // ── Timeseries renderer — results over time ──────────────────────────────

  function renderTimeseries() {
    // England national averages 2023/2024/2025 (DfE KS2 attainment)
    const ENG = {
      rwmExp:    ['60', '61', String(nat2.PTRWM_EXP)],
      rwmHigher: ['8',  '8',  String(nat2.PTRWM_HIGH)],
      readScore: ['105','105','105'],
      mathScore: ['104','104','104'],
    };

    const groups = [
      { heading: 'Expected Standard in Reading, Writing and Maths (RWM)',
        base: 'PTRWM_EXP', laKey: 'rwm.expected', eng: ENG.rwmExp, isPct: true },
      { heading: 'Higher Standard in Reading, Writing and Maths (RWM)',
        base: 'PTRWM_HIGH', laKey: 'rwm.higher', eng: ENG.rwmHigher, isPct: true },
      { heading: 'Average Score in Reading',
        base: 'READ_AVERAGE', laKey: 'reading.avgScore', eng: ENG.readScore, isPct: false },
      { heading: 'Average Score in Maths',
        base: 'MAT_AVERAGE', laKey: 'maths.avgScore', eng: ENG.mathScore, isPct: false },
    ];

    let hasAny = false;
    const out = [];

    for (const g of groups) {
      const s25 = v(g.base);
      const s24 = v(g.base + '_24');
      const s23 = v(g.base + '_23');
      const la23 = la(g.laKey.replace(/^([^.]+)\.(.+)$/, '$1.yr23.$2'));
      const la24 = la(g.laKey.replace(/^([^.]+)\.(.+)$/, '$1.yr24.$2'));
      const la25 = la(g.laKey);
      if (suppressed(s25) && suppressed(s24) && suppressed(s23)) continue;
      hasAny = true;

      const sfx = g.isPct ? '%' : '';
      const f = (val) => {
        if (val == null) return '—';
        const s = String(val).trim().replace(/%$/, '');
        return suppressed(s) ? '—' : s + sfx;
      };
      out.push('');
      out.push(`**${g.heading}**`);
      out.push('| Category | 2023 final | 2024 final | 2025 final |');
      out.push('|---|---:|---:|---:|');
      out.push(`| School | ${f(s23)} | ${f(s24)} | ${f(s25)} |`);
      out.push(`| Local Authority | ${la23 !== '—' ? la23 + sfx : '—'} | ${la24 !== '—' ? la24 + sfx : '—'} | ${la25 !== '—' ? la25 + sfx : '—'} |`);
      out.push(`| England | ${g.eng[0]}${sfx} | ${g.eng[1]}${sfx} | ${g.eng[2]}${sfx} |`);
    }

    if (hasAny) {
      lines.push('');
      lines.push('**Results over time**');
      lines.push(...out);
    }
  }

  // ── KS5 timeseries — results over time ──────────────────────────────────

  function renderKS5Timeseries() {
    const groups = [
      { label: 'Average grade', var25: 'TALLPPEGRD_ALEV_1618', var24: 'TALLPPEGRD_ALEV_1618_24', var23: 'TALLPPEGRD_ALEV_1618_23', var22: 'TALLPPEGRD_ALEV_1618_22' },
      { label: 'Average points', var25: 'TALLPPE_ALEV_1618', var24: 'TALLPPE_ALEV_1618_24', var23: 'TALLPPE_ALEV_1618_23', var22: 'TALLPPE_ALEV_1618_22' },
      { label: 'VA score', var25: 'VA_INS_ALEV', var24: 'VA_INS_ALEV_24', var23: 'VA_INS_ALEV_23', var22: 'VA_INS_ALEV_22' },
    ];

    const rows = [];
    for (const g of groups) {
      const vals = [v(g.var22), v(g.var23), v(g.var24), v(g.var25)];
      if (vals.every(x => x == null || suppressed(String(x)))) continue;
      rows.push(`| ${g.label} | ${vals.map(x => x != null && !suppressed(String(x)) ? String(x).trim() : '—').join(' | ')} |`);
    }

    if (rows.length) {
      lines.push('');
      lines.push('**Results over time**');
      lines.push('| Category | 2022 final | 2023 final | 2024 final | 2025 final |');
      lines.push('|---|---:|---:|---:|---:|');
      lines.push(...rows);
    }
  }

  // ── Render key stages ─────────────────────────────────────────────────────

  // Independent schools: strip Disadv/Not Disadv/EAL columns (always —)
  const indCols = (topic) => {
    if (!isIndependent) return topic;
    if (topic.cols === 'a' || topic.cols === 'all') return topic;
    const stripped = topic.cols.replace(/[dne]/g, '');
    return stripped === topic.cols ? topic : { ...topic, cols: stripped };
  };

  if (hasKS2) {
    lines.push('**Key Stage 2 (2024/25)**');
    lines.push('');
    lines.push('*Reading, Maths and Grammar/Punctuation/Spelling are SATs-tested. Writing and Science are Teacher Assessed.*');
    for (const topic of KS2_TOPICS) renderTopic(indCols(topic), 'KS2');
    for (const topic of KS2_EXTRA_TOPICS) renderTopic(indCols(topic), 'KS2');
    renderProgress();
    renderTimeseries();
  }

  if (hasKS4) {
    lines.push('');
    lines.push('**Key Stage 4 (2024/25)**');
    for (const topic of KS4_TOPICS) renderTopic(indCols(topic), 'KS4');
    renderEBaccSubjects();
    renderKS4Timeseries();
    // Subject entries table
    if (subjectEntries?.length) {
      lines.push('');
      lines.push('**Subjects entered (KS4)**');
      const hasG7 = subjectEntries.some(e => e.grade7PlusPct !== undefined);
      if (hasG7) {
        lines.push('| Subject | Qualification | Entries | Grade 7+ |');
        lines.push('|---|---:|---:|---:|');
        for (const e of subjectEntries) {
          const g7 = e.grade7PlusPct !== undefined ? `${e.grade7PlusPct}%` : '—';
          lines.push(`| ${e.subject} | ${e.qualification} | ${e.entries} | ${g7} |`);
        }
      } else {
        lines.push('| Subject | Qualification | Entries |');
        lines.push('|---|---:|---:|');
        for (const e of subjectEntries) {
          lines.push(`| ${e.subject} | ${e.qualification} | ${e.entries} |`);
        }
      }
    }
  }

  if (hasKS5) {
    lines.push('');
    lines.push('**Key Stage 5 / 16–18 (2024/25)**');
    for (const topic of KS5_TOPICS) renderTopic(indCols(topic), 'KS5');
    renderKS5Timeseries();

    // KS5 subject entries table
    if (ks5SubjectEntries?.length) {
      lines.push('');
      lines.push('**A-level / Level 3 subjects entered**');
      const hasAB = ks5SubjectEntries.some(e => e.aToBPct !== undefined);
      if (hasAB) {
        lines.push('| Subject | Qualification | Entries | A–B |');
        lines.push('|---|---:|---:|---:|');
        for (const e of ks5SubjectEntries) {
          const ab = e.aToBPct !== undefined ? `${e.aToBPct}%` : '—';
          // Shorten verbose qualification names
          const qual = e.qualification
            .replace('GCE A level', 'A-level')
            .replace('GCE AS level', 'AS-level')
            .replace(/BTEC National Extended Certificate L3 - Band \w - P-D\*/, 'BTEC L3 Ext Cert')
            .replace(/BTEC National Diploma L3 - Band \w - PP-D\*D\*/, 'BTEC L3 Diploma')
            .replace(/OCR Cambridge Technical Extended Certificate at Level 3/, 'OCR L3 Ext Cert')
            .replace(/OCR Cambridge Technical Diploma at Level 2/, 'OCR L2 Diploma')
            .replace(/OCR Cambridge Technical Certificate at Level 2/, 'OCR L2 Cert')
            .replace(/VRQ Level 3/, 'VRQ L3')
            .replace(/Extended Project \(Diploma\)/, 'Extended Project')
            .replace(/Core Maths Qualifications at Level 3/, 'Core Maths');
          lines.push(`| ${e.subject} | ${qual} | ${e.entries} | ${ab} |`);
        }
      } else {
        lines.push('| Subject | Qualification | Entries |');
        lines.push('|---|---:|---:|');
        for (const e of ks5SubjectEntries) {
          lines.push(`| ${e.subject} | ${e.qualification} | ${e.entries} |`);
        }
      }
    }
  }

  return lines.filter(l => l !== '').length > 1
    ? lines.join('\n')
    : '_No performance data available._';

}
function fmtOfstedSlim(ofsted, isIndependent) {
  // For independent schools with ISI data, render ISI grades + narrative.
  // For independent schools without ISI data, tell the AI to web-search.
  if (isIndependent) {
    if (ofsted?.overall) {
      const lines = [`- Overall: **${ofsted.overall}**${ofsted.date ? ` (${ofsted.date})` : ''}`];
      if (ofsted.framework) lines.push(`- Framework: ${ofsted.framework}`);
      if (ofsted.academicJudgment) lines.push(`- Academic achievement: ${ofsted.academicJudgment}`);
      if (ofsted.personalJudgment) lines.push(`- Personal development: ${ofsted.personalJudgment}`);
      if (ofsted.keyFindings) {
        lines.push(`\n**Key findings**\n${ofsted.keyFindings.slice(0, 1500)}`);
      }
      if (ofsted.recommendations) {
        lines.push(`\n**Recommendations**\n${ofsted.recommendations.slice(0, 1500)}`);
      }
      return lines.join('\n');
    }
    return '- Independent school — fetch ISI report from isi.net via web search.';
  }
  if (!ofsted?.overall) return '- _Not retrieved — search reports.ofsted.gov.uk_';

  const lines = [`- Overall: **${ofsted.overall}**${ofsted.date ? ` (${ofsted.date})` : ''}`];

  // Sub-grades (whichever framework was used)
  const addGrade = (label, val) => { if (val) lines.push(`- ${label}: ${val}`); };
  addGrade('Quality of Education',          ofsted.qualityOfEducation);
  addGrade('Behaviour and Attitudes',       ofsted.behaviour);
  addGrade('Personal Development',          ofsted.personalDevelopment);
  addGrade('Leadership and Management',     ofsted.leadership);
  addGrade('Education programmes for young people', ofsted.eduProgrammes);
  addGrade('Provision for learners with high needs', ofsted.highNeeds);
  addGrade('Achievement',                   ofsted.achievement);
  addGrade('Attendance and Behaviour',      ofsted.attendance);
  addGrade('Curriculum and Teaching',       ofsted.curriculum);
  addGrade('Inclusion',                     ofsted.inclusion);
  addGrade('Leadership and Governance',     ofsted.leadershipGov);
  addGrade('Personal Development/Wellbeing',ofsted.wellbeing);
  if (ofsted.safeguarding) lines.push(`- Safeguarding: ${ofsted.safeguarding}`);

  // Parent View — fetched from print page (no auth, no JS needed)
  const pv = ofsted.parentView;
  if (pv) {
    const yr = pv.academicYear ? ` (${pv.academicYear})` : '';
    lines.push(`\n**Ofsted Parent View${yr} — ${pv.totalResponses} responses**`);
    lines.push('| Question | % agree or strongly agree |');
    lines.push('|---|---:|');
    const pvRow = (label, val, threshold) => {
      if (val == null) return;
      const flag = threshold && val < threshold ? ' ⚠️' : '';
      lines.push(`| ${label} | ${val}%${flag} |`);
    };
    pvRow('Would recommend this school',       pv.wouldRecommend,  80);
    pvRow('My child is happy here',            pv.childHappy,      null);
    pvRow('My child feels safe',               pv.childSafe,       88);
    pvRow('Pupils are well behaved',           pv.wellBehaved,     null);
    pvRow('Bullying dealt with well',          pv.bullyingHandled, 70);
    pvRow('School communicates well',          pv.communication,   null);
    pvRow('Concerns dealt with properly',      pv.concernsHandled, 75);
    pvRow('Acts in child\'s best interests',   pv.bestInterests,   null);
    pvRow('Right support to learn',            pv.rightSupport,    null);
    pvRow('SEND support',                      pv.sendSupport,     null);
  } else if (ofsted.parentViewUrl) {
    lines.push(`- Parent View: ${ofsted.parentViewUrl} _(data not retrieved)_`);
  }

  // Narrative — cap at 3,000 chars (raised from 1,500 to avoid cutting SEN/SEND commentary).
  // Each section is capped independently so a long quality-of-education section
  // doesn't crowd out safeguarding or SEND observations lower in the report.
  const addNarrative = (heading, text, maxChars = 3000) => {
    if (!text) return;
    const snippet = text.length > maxChars
      ? text.slice(0, maxChars).replace(/\s+\S*$/, '') + ' …_(truncated — full PDF: ' + (ofsted.reportUrl ?? 'see Ofsted site') + ')_'
      : text;
    lines.push(`\n**${heading}**\n${snippet}`);
  };
  addNarrative("What it's like to be a pupil", ofsted.pupilExperience, 500);   // short — AI should summarise key themes
  addNarrative('Quality of Education (detail)', ofsted.qualityOfEducationDetail?.length      > 100 ? ofsted.qualityOfEducationDetail      : null);
  addNarrative('Behaviour and Attitudes (detail)', ofsted.behaviourAndAttitudesDetail?.length > 100 ? ofsted.behaviourAndAttitudesDetail   : null);
  addNarrative('Personal Development (detail)', ofsted.personalDevelopmentDetail?.length     > 100 ? ofsted.personalDevelopmentDetail     : null);
  addNarrative('Leadership and Management (detail)', ofsted.leadershipAndManagementDetail?.length > 100 ? ofsted.leadershipAndManagementDetail : null);
  addNarrative('Achievement (detail)', ofsted.achievementDetail?.length                      > 100 ? ofsted.achievementDetail             : null);
  addNarrative('Inclusion (detail)', ofsted.inclusionDetail?.length                          > 100 ? ofsted.inclusionDetail               : null);
  if (!ofsted.pupilExperience && ofsted.reportUrl) {
    lines.push(`- Full report: ${ofsted.reportUrl}`);
  }

  return lines.join('\n');
}

/**
 * Slim area: compact bullet-list format — no big tables.
 * Key numbers only; AI can web-search for granular breakdowns.
 */
function fmtAreaDataSlim(area) {
  if (!area) return '_Not retrieved_';
  const lines = [];

  // Geography
  lines.push(`- Location: ${area.postcode ?? '?'} · ${area.district ?? '?'} · ${area.region ?? '?'}`);
  lines.push(`- Geography codes: LSOA ${area.lsoa ?? '?'} · MSOA ${area.msoa ?? '?'}`);

  // IMD — headline decile + flag any sub-domain below 8
  if (area.imd) {
    const imd = area.imd;
    const weakDomains = imd.subDomains
      ? Object.entries(imd.subDomains).filter(([, d]) => d <= 6).map(([k, d]) => `${k} ${d}/10`).join(', ')
      : null;
    lines.push(`- Deprivation (IMD ${imd.year}): decile **${imd.imdDecile}/10**${weakDomains ? ` · weaker sub-domains: ${weakDomains}` : ' (all sub-domains ≥ 7)'}`);
  }

  // Income
  const crInc = area.crystalRoof?.income;
  const onsInc = area.income;
  if (crInc || onsInc) {
    const parts = [];
    if (crInc)                        parts.push(`mean gross ${crInc.meanAnnualHouseholdIncome} (Census 2021 era)`);
    if (onsInc?.netAnnualHouseholdIncome) parts.push(`net ${onsInc.netAnnualHouseholdIncome} (ONS 2018)`);
    if (onsInc?.afterHousingCostsIncome)  parts.push(`after housing ${onsInc.afterHousingCostsIncome}`);
    lines.push(`- Household income (MSOA): ${parts.join(' · ')}`);
  }

  // House prices
  if (area.pricePaid) {
    const pp = area.pricePaid;
    const byType = pp.byType
      ? Object.entries(pp.byType).map(([t, p]) => `${t} ${p}`).join(', ')
      : null;
    lines.push(`- House prices (~800m, ${pp.totalTransactions} sales, 5yr): median ${pp.medianAllTypes}${byType ? ` · by type: ${byType}` : ''}`);
  }

  // Ethnicity — broad groups only
  if (area.ethnicity && Object.keys(area.ethnicity).length) {
    const groups = {};
    for (const [label, pct] of Object.entries(area.ethnicity)) {
      const broad = label.startsWith('White:') ? 'White'
        : label.startsWith('Asian')            ? 'Asian'
        : label.startsWith('Black')            ? 'Black'
        : label.startsWith('Mixed')            ? 'Mixed'
        : 'Other';
      groups[broad] = (groups[broad] ?? 0) + pct;
    }
    const summary = Object.entries(groups).sort(([,a],[,b]) => b-a)
      .map(([k, v]) => `${k} ${Math.round(v)}%`).join(' · ');
    lines.push(`- Ethnicity (LSOA, Census 2021): ${summary}`);
  }

  // Qualifications — just the headline numbers
  const q = area.crystalRoof?.qualifications;
  if (q) {
    lines.push(`- Qualifications (OA, Census 2021): level 4+ ${q.level4AndAbove ?? '?'}% · no qualifications ${q.noQualifications ?? '?'}%`);
  }

  // Occupation — just the headline numbers
  const o = area.crystalRoof?.occupation;
  if (o) {
    lines.push(`- Occupation (OA, Census 2021): professional/managerial ${o.managerialProfessional ?? '?'}% · routine/manual ${o.routineAndManual ?? '?'}%`);
  }

  return lines.join('\n');
}

// ─── Build Branch 1 block (slim — used for prompt injection) ─────────────────
//
// Targets ~1,800 tokens vs ~5,700 for the detailed block (-68%).
// The detailed block is still produced by the debug script for human review.

function fmtSchoolEthnicitySlim(e) {
  if (!e) return '- _Not in DfE index_';
  const parts = [
    `White ${e.w}%`,
    `Mixed ${e.m}%`,
    `Asian ${e.a}%`,
    `Black ${e.b}%`,
    e.c ? `Chinese ${e.c}%` : null,
    e.o ? `Other ${e.o}%` : null,
    e.ns ? `Not stated ${e.ns}%` : null,
  ].filter(Boolean);
  return `- Pupil ethnicity (DfE ${e.yr}): ${parts.join(' · ')}`;
}

export function buildSlimBlock(school) {
  const { input, identity, ofsted, performance, financial, area, laPerf, schoolEthnicity, giasDetails, fees, subjectEntries, ks5SubjectEntries } = school;
  const name = identity?.officialName ?? input;
  const urn  = identity?.urn;

  // anyNsField: search all namespaces, preferring the most recent year suffix
  const anyNsField = (variable) => {
    const sorted = Object.entries(performance ?? {})
      .sort(([a], [b]) => (parseInt(b.match(/_(\d+)$/)?.[1] ?? '0', 10) - parseInt(a.match(/_(\d+)$/)?.[1] ?? '0', 10)))
      .flatMap(([, rows]) => rows);
    return sorted.find(r => r.variable === variable)?.value ?? null;
  };
  const lField     = (v) => performance?.L?.find(r => r.variable === v)?.value ?? null;
  const postcode   = anyNsField('PCODE');
  const ageLow     = lField('AGELOW');
  const ageHigh    = lField('AGEHIGH');
  const gender     = lField('GENDER');
  const relChar    = lField('RELCHAR');
  const admPol     = lField('ADMPOL');

  // Capacity from GIAS detail — the one field not available in the DfE CSV.
  // Fill rate = pupils on roll (NOR from CENSUS namespace) ÷ capacity × 100.
  const capacity = giasDetails?.capacity ?? null;
  const nor      = anyNsField('NOR');
  const fillRate = (capacity && nor)
    ? Math.round(parseInt(nor, 10) / parseInt(capacity.replace(/,/g, ''), 10) * 100)
    : null;
  const capacityNote = capacity
    ? ` · capacity: ${capacity}${fillRate != null ? ` (${nor} on roll — ${fillRate}% full)` : ''}`
    : '';

  const idLine = identity
    ? `${identity.officialName} · URN ${urn} · ${identity.type ?? '?'} · ${identity.phase ?? '?'}${ageLow && ageHigh ? ` (ages ${ageLow}–${ageHigh})` : ''} · LA: ${identity.la ?? '?'}${postcode ? ` · ${postcode}` : ''}${gender ? ` · ${gender}` : ''}${relChar && relChar !== 'Does not apply' ? ` · ${relChar}` : ''}${admPol && admPol !== 'Not applicable' ? ` · admissions: ${admPol}` : ''}${capacityNote}`
    : `"${input}" — URN not found`;

  const links = govLinks(urn).join(' · ');

  return `
---
## Pre-Fetched Government Data — ${name}

> **Use figures below directly. Do not re-search populated fields.**
> Fields marked "_Not retrieved_" → source via web search.

**School:** ${idLine}
**Links:** ${links}

### ${pa('A2')}
${fmtOfstedSlim(ofsted, identity?.isIndependent ?? false)}

### ${pa('improvement')}
${identity?.isIndependent ? (ofsted?.recommendations || ofsted?.nextSteps || '_Independent school — no improvement recommendations available._') : ofsted?.nextSteps ? ofsted.nextSteps : ofsted?.overall ? `_No improvement requirements stated. Ofsted grade: ${ofsted.overall}._` : '_Not retrieved — link to full Ofsted PDF if available._'}

### ${pa('A3')}
${fmtAcademicResultsSlim(performance, identity?.phase, identity?.numberOnRoll ?? null, laPerf ?? null, false, identity?.isIndependent ?? false, null, subjectEntries, ks5SubjectEntries)}

### ${pa('A4')}
${fmtCensusSlim(performance, schoolEthnicity)}

### ${pa('A5')}
${fmtAbsenceSlim(performance)}

### ${pa('A6')}
${fmtFinancial(financial, identity?.isIndependent ?? false)}
${fees ? `### School Fees\n- ${Object.entries(fees).filter(([k]) => k !== 'source' && k !== 'raw').map(([k,v]) => {
  if (typeof v === 'object' && v !== null) {
    const parts = [];
    if (v.min != null && v.max != null) parts.push(`£${v.min}–£${v.max}`);
    else if (v.amount != null) parts.push(`£${v.amount}`);
    if (v.period) parts.push(v.period);
    if (v.note) parts.push(`(${v.note})`);
    return `${k}: ${parts.join(' ')}`;
  }
  return `${k}: ${v}`;
}).join('\n- ')}` : ''}

### ${pa('A7')}
${fmtAreaDataSlim(area)}
---`.trim();
}

// ─── Pupil Census (A4) ──────────────────────────────────────────────────────

function fmtCensusSlim(performance, schoolEthnicity) {
  const anyNsField = (variable) => {
    const sorted = Object.entries(performance ?? {})
      .sort(([a], [b]) => (parseInt(b.match(/_(\d+)$/)?.[1] ?? '0', 10) - parseInt(a.match(/_(\d+)$/)?.[1] ?? '0', 10)))
      .flatMap(([, rows]) => rows);
    return sorted.find(r => r.variable === variable)?.value ?? null;
  };

  const nor  = anyNsField('NOR');
  const fsm  = anyNsField('PNUMFSMEVER');
  const eal  = anyNsField('PNUMEAL');
  const senK = anyNsField('PSENELK');
  const senE = anyNsField('PSENELSE');

  if (!nor && !fsm && !eal && !senK && !senE && !schoolEthnicity) return '_No census data available._';

  const lines = [];

  if (nor || fsm || eal || senK || senE) {
    lines.push('');
    lines.push('**Pupil numbers**');
    lines.push('| Category | School | National avg |');
    lines.push('|---|---:|---:|');
    if (nor)  lines.push(`| Pupils on roll | ${nor} | ~280 primary / ~1,000 secondary |`);
    if (fsm)  lines.push(`| FSM eligible (last 6 years) | ${fsm} | ~25% primary / ~20% secondary |`);
    if (eal)  lines.push(`| EAL pupils | ${eal} | — |`);
    if (senK) lines.push(`| SEN support | ${senK} | ~13% |`);
    if (senE) lines.push(`| EHC plans | ${senE} | ~4.5% |`);
  }

  // ── SEN & Inclusion sub-section ──────────────────────────────────────
  if (senK || senE) {
    lines.push('');
    lines.push('**SEN & Inclusion**');
    const senKnum = parseFloat(senK);
    const senEnum = parseFloat(senE);
    const totalSEN = (!isNaN(senKnum) ? senKnum : 0) + (!isNaN(senEnum) ? senEnum : 0);

    if (totalSEN > 30) {
      lines.push(`- **Very high SEN cohort** — ${Math.round(totalSEN)}% of pupils have SEN support or an EHC plan (national ~17.5%). Likely a school with a SEN unit or resourced provision — contact the SENCo for details on specialist support.`);
    } else if (totalSEN > 22) {
      lines.push(`- **Above-average SEN cohort** — ${Math.round(totalSEN)}% of pupils have SEN support or an EHC plan (national ~17.5%). This usually indicates strong, well-resourced SEN provision that attracts families with additional needs.`);
    } else if (totalSEN > 5) {
      lines.push(`- **Typical SEN profile** — ${Math.round(totalSEN)}% of pupils have SEN support or an EHC plan, broadly in line with national averages.`);
    } else {
      lines.push(`- **Low SEN cohort** — ${Math.round(totalSEN)}% of pupils have SEN support or an EHC plan (national ~17.5%). Parents of children with significant needs may wish to ask the SENCo about capacity.`);
    }

    const senEAbove = !isNaN(senEnum) && senEnum > 6;
    if (senEAbove) {
      lines.push(`- **Above-average proportion of pupils with EHC plans** (${senEnum}% vs national ~4.5%) — suggests the school has experience with high-need pupils and a dedicated SEN team.`);
    }

    if (totalSEN > 15) {
      lines.push('- **For parents of children with SEN:** Ask about the SENCo team size, TA-to-pupil ratio for 1:1 support, and whether the school has a specialist unit/resourced provision for your child\'s specific primary need.');
    }
  }

  if (schoolEthnicity) {
    const eth = schoolEthnicity;
    const totalPct = (eth.w || 0) + (eth.m || 0) + (eth.a || 0) + (eth.b || 0) + (eth.c || 0) + (eth.o || 0) + (eth.ns || 0);
    if (totalPct > 0) {
      lines.push('');
      lines.push('**Ethnicity**');
      lines.push('| Ethnic group | % of pupils |');
      lines.push('|---|---:|');
      if (eth.w  != null) lines.push(`| White | ${eth.w}% |`);
      if (eth.m  != null) lines.push(`| Mixed | ${eth.m}% |`);
      if (eth.a  != null) lines.push(`| Asian | ${eth.a}% |`);
      if (eth.b  != null) lines.push(`| Black | ${eth.b}% |`);
      if (eth.c  != null) lines.push(`| Chinese | ${eth.c}% |`);
      if (eth.o  != null) lines.push(`| Other | ${eth.o}% |`);
      if (eth.ns != null) lines.push(`| Not stated | ${eth.ns}% |`);
    }
  }

  return lines.join('\n');
}

// ─── Absence (A6) ───────────────────────────────────────────────────────────

function fmtAbsenceSlim(performance) {
  const anyNsField = (variable) => {
    const sorted = Object.entries(performance ?? {})
      .sort(([a], [b]) => (parseInt(b.match(/_(\d+)$/)?.[1] ?? '0', 10) - parseInt(a.match(/_(\d+)$/)?.[1] ?? '0', 10)))
      .flatMap(([, rows]) => rows);
    return sorted.find(r => r.variable === variable)?.value ?? null;
  };

  const abs   = anyNsField('PERCTOT');
  const pers  = anyNsField('PPERSABS10');
  const nat   = NATIONAL_AVG.ABSENCE;

  if (!abs && !pers) return '_No absence data available — independent schools do not report absence to DfE._';

  const lines = [
    '| Category | School | National avg |',
    '|---|---:|---:|',
  ];
  if (abs)  lines.push(`| Overall absence | ${abs}% | ${nat.PERCTOT}% |`);
  if (pers) lines.push(`| Persistent absence | ${pers}% | ${nat.PPERSABS10}% |`);
  return lines.join('\n');
}

// ─── Build Branch 1 block (detailed — debug script / human report only) ──────

function buildDetailedBlock(school) {
  const { input, identity, ofsted, performance, financial, area, schoolEthnicity, giasDetails } = school;
  const name = identity?.officialName ?? input;
  const urn  = identity?.urn;

  // Pull useful identity fields from DfE CSV.
  // L-namespace fields (GENDER, ADMPOL etc.) live in the L namespace.
  // PCODE lives in the phase-specific namespace (KS2_25, KS4_25 etc.) — search all namespaces.
  const lField     = (v) => performance?.L?.find(r => r.variable === v)?.value ?? null;
  const anyNsField = (v) => Object.values(performance ?? {}).flat().find(r => r.variable === v)?.value ?? null;
  const postcode  = anyNsField('PCODE');
  const gender    = lField('GENDER');
  const admPol    = lField('ADMPOL');
  const relChar   = lField('RELCHAR');
  const ageLow    = lField('AGELOW');
  const ageHigh   = lField('AGEHIGH');

  // Capacity from GIAS detail — only field not covered by DfE CSV.
  const capacity = giasDetails?.capacity ?? null;
  const nor      = anyNsField('NOR');
  const fillRate = (capacity && nor)
    ? Math.round(parseInt(nor, 10) / parseInt(capacity.replace(/,/g, ''), 10) * 100)
    : null;

  const identityLines = identity ? [
    `- Official name: ${identity.officialName}`,
    `- URN: ${urn}`,
    `- Type: ${identity.type ?? 'Unknown'}`,
    `- Phase: ${identity.phase ?? 'Unknown'}${ageLow && ageHigh ? ` (ages ${ageLow}–${ageHigh})` : ''}`,
    `- Local authority: ${identity.la ?? 'Unknown'}`,
    `- Independent: ${identity.isIndependent ? 'Yes' : 'No'}`,
    ...(postcode  ? [`- Postcode: ${postcode}`]                                                                                    : []),
    ...(capacity  ? [`- Capacity: ${capacity}${fillRate != null ? ` (${nor} on roll — ${fillRate}% full)` : ''}`]                  : []),
    ...(gender    ? [`- Gender: ${gender}`]                                                                                        : []),
    ...(relChar   ? [`- Religious character: ${relChar}`]                                                                          : []),
    ...(admPol    ? [`- Admissions policy: ${admPol}`]                                                                             : []),
  ] : [
    `- Search term used: "${input}"`,
    `- URN: _Not found — check school name spelling and search GIAS manually._`,
  ];

  identityLines.push('', '  Government profile links:', ...govLinks(urn).map(u => `  - ${u}`));

  return `
---
## Pre-Fetched Government Data — ${name}

> Retrieved automatically from UK government sources.
> **Use figures below directly — do not re-search populated fields.**
> Fields marked "_Not retrieved_" should be sourced via web search.

### School Identity (GIAS)
${identityLines.join('\n')}

### Academic Results (DfE)
${fmtAcademicResults(performance, identity?.phase)}

### Financial Benchmarking (FBIT)
${fmtFinancial(financial)}

### Inspection Outcomes (Ofsted)
${fmtOfsted(ofsted, identity?.isIndependent ?? false)}

### School Pupil Ethnicity (DfE Census)
${fmtSchoolEthnicitySlim(schoolEthnicity)}

### Surrounding Area (postcodes.io / ONS / Land Registry)
${fmtAreaData(area)}
---`.trim();
}

// ─── Build Branch 2 block (comparison table) ──────────────────────────────────

function buildComparisonBlock(schools) {
  if (!schools.length) return '';

  const names = schools.map(s => s.identity?.officialName ?? s.input);

  // Each row: [label, accessor fn]
  const rows = [
    ['Type',             s => s.identity?.type                             ?? '—'],
    ['URN',              s => s.identity?.urn                              ?? '—'],
    ['Independent',      s => s.identity ? (s.identity.isIndependent ? 'Yes' : 'No') : '—'],
    ['Ofsted overall',   s => s.identity?.isIndependent ? 'ISI (see web search)' : (s.ofsted?.overall   ?? '—')],
    ['Ofsted date',      s => s.identity?.isIndependent ? '—'             : (s.ofsted?.date             ?? '—')],
    ['Progress 8',       s => s.performance?.progress8                    ?? '—'],
    ['Attainment 8',     s => s.performance?.attainment8                  ?? '—'],
    ['Grade 5+ Eng+Ma',  s => s.performance?.grade5em                     ?? '—'],
    ['EBacc entry %',    s => s.performance?.ebacc                        ?? '—'],
    ['Overall absence',  s => s.performance?.absence                      ?? '—'],
    ['Income/pupil',     s => s.financial?.incomePerPupil                 ?? '—'],
    ['Staff costs %',    s => s.financial?.staffCostsPct                  ?? '—'],
    ['Revenue balance',  s => s.financial?.revenueBalance                 ?? '—'],
  ];

  const header = `| Metric | ${names.join(' | ')} |`;
  const sep    = `|${Array(names.length + 1).fill('---').join('|')}|`;
  const body   = rows
    .map(([label, fn]) => `| ${label} | ${schools.map(fn).join(' | ')} |`)
    .join('\n');

  const links = schools
    .filter(s => s.identity?.urn)
    .map(s => {
      const u = s.identity.urn;
      const n = s.identity.officialName;
      return `- **${n}**: [GIAS](https://www.get-information-schools.service.gov.uk/Establishments/Establishment/Details/${u}) | [Performance](https://www.compare-school-performance.service.gov.uk/school/${u}) | [Financial](https://financial-benchmarking-and-insights-tool.education.gov.uk/school/${u}) | [Ofsted](https://reports.ofsted.gov.uk/provider/21/${u})`;
    })
    .join('\n');

  const independentNote = schools.some(s => s.identity?.isIndependent)
    ? '\n> Independent schools: Ofsted not applicable — fetch ISI inspection data from isi.net via web search.\n'
    : '';

  return `
---
## Pre-Fetched Government Data — Comparison

> Use the figures below directly in your comparison table. Do not re-search populated fields.
> "—" means not retrieved; search the relevant source for those fields.
${independentNote}
${header}
${sep}
${body}

**Government profile links**
${links || '_No URNs resolved — verify school names and search GIAS manually._'}
---`.trim();
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Extracts school names from the question, fetches gov.uk data for each,
 * and returns a formatted markdown block ready to append to the AI prompt.
 *
 * Returns an empty string if no school names could be found or all fetches fail.
 */
export async function fetchGovDataForPrompt(question, branch, apiKey, baseUrl, model) {
  const detailed = true;
  const t0 = Date.now();

  const names = await extractSchoolNames(question, branch, apiKey, baseUrl, model);
  if (!names.length) {
    glog('govuk_no_names', { branch, question: question.slice(0, 120) });
    return { block: '', flags: {}, schools: [] };
  }

  // Extract location hints once from the question — passed to every URN lookup
  // so that schools with identical names are disambiguated by location context
  // (postcode area, borough name, city name).
  const locationHints = extractLocationHints(question, names);

  glog('govuk_start', { branch, names, locationHints });

  // Resolve all schools in parallel; within each school, URN lookup first,
  // then Ofsted / performance / financial in parallel.
  const schools = await Promise.all(
    names.map(async (name) => {
      let identity = await lookupSchoolURN(name, locationHints);

      // If GIAS can't resolve, try stripping the last word (fast local fix).
      if (!identity?.urn) {
        const words = name.trim().split(/\s+/);
        if (words.length >= 3) {
          const shorter = words.slice(0, -1).join(' ');
          identity = await lookupSchoolURN(shorter, locationHints);
          if (identity?.urn) glog('govuk_gias_shortened', { original: name, shorter, urn: identity.urn });
        }
      }

      const urn = identity?.urn ?? null;

      if (!urn) {
        return { input: name, identity: null, ofsted: null, performance: null, financial: null };
      }

      // Phase 1: Inspection data — Ofsted for state schools, ISI for independent
      let ofstedBase;
      if (identity.isIndependent && detailed) {
        ofstedBase = await getISIInspection(urn, identity.officialName);
      } else if (!identity.isIndependent) {
        ofstedBase = await getOfstedData(urn);
      } else {
        ofstedBase = null;
      }

      // Phase 2: performance + financial + Parent View + GIAS detail — all in parallel
      // Ofsted PDF fetch and sub-grade merge is now handled inside getOfstedData/getISIInspection.
      const [performance, financial, parentView, giasDetails] = await Promise.all([
        getPerformanceData(urn),
        identity.isIndependent ? Promise.resolve(null) : getFinancialData(urn),
        identity.isIndependent ? Promise.resolve(null) : fetchParentView(urn),
        getGIASDetails(urn),
      ]);

      // Phase 2b: Independent school fees (needs giasDetails from the parallel batch above)
      let feesResult = null;
      if (identity.isIndependent && detailed) {
        const d = giasDetails;
        const website = d?.website;
        feesResult = website
          ? await getIndependentFees(identity.officialName, website)
          : null;
      }

      // Phase 2c: KS4 subject entries for all schools with KS4 data
      const hasKS4 = Object.keys(performance ?? {}).some(k => k.startsWith('KS4'));
      const hasKS5 = Object.keys(performance ?? {}).some(k => k.startsWith('KS5'));
      const subjectEntries = hasKS4 ? fetchSubjectEntries(urn) : null;
      const ks5SubjectEntries = hasKS5 ? fetchKS5SubjectEntries(urn) : null;

      // Phase 3: area data — postcode comes from DfE CSV (PCODE in phase-specific namespace, e.g. KS2_25).
      // Fall back to identity.postcode (from GIAS search tile — always present when URN resolves)
      // for infant/nursery schools that have no KS2/KS4 namespace and thus no PCODE in the CSV.
      const postcode = Object.values(performance ?? {}).flat().find(r => r.variable === 'PCODE')?.value
        ?? identity?.postcode
        ?? null;
      const area = detailed && postcode ? await getAreaData(postcode) : null;

      // Phase 4: LA-level performance averages from EES API
      // Determined by what data the school actually has, not the phase label
      // (independent schools often have KS4 data but phase is "Not applicable")
      const hasKS2 = Object.keys(performance ?? {}).some(k => k.startsWith('KS2'));
      const laPerf = detailed && area?.laCode
        ? (hasKS2
            ? await getLAPerformanceKS2(area.laCode).catch(() => null)
            : hasKS4
              ? await getLAPerformanceKS4(area.laCode).catch(() => null)
              : null)
        : null;

      // Phase 4b: KS5 LA averages (separate EES datasets)
      const laPerfKS5 = (detailed && hasKS5 && area?.laCode)
        ? await getLAPerformanceKS5(area.laCode).catch(() => null)
        : null;

      // Ofsted object is now fully enriched by getOfstedData/getISIInspection.
      // Only add Parent View and clear gradedReportUrl (internal) from the result.
      const ofsted = ofstedBase ? {
        ...ofstedBase,
        parentView:                    parentView                           ?? null,
      } : null;

      // Bundled local data (zero-latency — no HTTP)
      const schoolEthnicity = urn ? getSchoolEthnicity(urn) : null;

      return { input: name, identity, ofsted, performance, financial, area, laPerf, laPerfKS5, schoolEthnicity, giasDetails, subjectEntries, ks5SubjectEntries };
    })
  );

  // ── Per-school data-coverage manifest (always logs — traceable journey) ──────
  // govuk_manifest shows exactly which data sources mapped into the output block.
  // Read govuk_manifest events to trace: Request → govuk.js → mapping → output.
  for (const s of schools) {
    const pdfParsed = !!(s.ofsted?.pupilExperience || s.ofsted?.nextSteps);
    glog('govuk_manifest', {
      input:           s.input,
      urn:             s.identity?.urn             ?? null,
      name:            s.identity?.officialName    ?? null,
      // Data sources → prompt block sections:
      identity:        !!s.identity,              // → School Identity / A1
      ofsted:          !!s.ofsted,                // → Inspection Outcomes / A2
      ofstedGrade:     s.ofsted?.overall          ?? null,
      pdfParsed,                                  // → A3 narrative + A4 next steps
      parentView:      !!s.ofsted?.parentView,    // → B1 Parent View
      performance:     !!s.performance,           // → Academic Results / A6
      financial:       !!s.financial,             // → Financial / A8
      area:            !!s.area,                  // → Area Profile / A9
      schoolEthnicity: !!s.schoolEthnicity,       // → Pupil Census / A5
    });
  }

  glog('govuk_done', {
    branch,
    ms: Date.now() - t0,
    schools: schools.length,
    resolved: schools.filter(s => s.identity).length,
  });

  if (!schools.length) return { block: '', flags: {}, schools: [] };

  const block = '\n\n' + (detailed
    ? schools.map(buildSlimBlock).join('\n\n')
    : buildComparisonBlock(schools) + '\n\n' + schools.map(buildSlimBlock).join('\n\n'));

  const flags = (detailed && schools.length === 1) ? computeFlags(schools[0]) : {};
  return { block, flags, schools };
}

// ─── Deterministic flag computation ──────────────────────────────────────────
//
// Derives traffic-light flags for all Part A sections from structured data.
// Called by fetchGovDataForPrompt and by renderPartA — single source of truth.

export function computeFlags(school) {
  const { ofsted, performance, financial, area, identity } = school;
  const flags = {};
  const allRows = Object.values(performance ?? {}).flat();
  const vv = (code) => allRows.find(r => r.variable === code)?.value ?? null;

  // A2 — Inspection Outcomes
  const overall = (ofsted?.overall ?? '').toLowerCase();
  if (/outstanding|exceptional/i.test(overall))              flags[paFlag('A2')] = 'green';
  else if (/requires improvement|inadequate/i.test(overall)) flags[paFlag('A2')] = 'red';

  // Improvement requirements (unnumbered)
  // ISI recommendations in independent schools are suggestions, not mandates → never red
  // State schools: red for formal Ofsted action points OR any sub-grade requiring improvement
  const isISI = /ISI/.test(overall);
  const ofstedNextSteps = ofsted?.nextSteps;
  const hasRIGrade = ofsted && Object.entries(ofsted).some(
    ([k, v]) => k !== 'overall' && typeof v === 'string' && /requires improvement|inadequate/i.test(v)
  );
  if ((ofstedNextSteps || hasRIGrade) && !isISI)
    flags[paFlag('improvement')] = 'red';
  else if (isISI || /outstanding|exceptional/i.test(overall) || (!ofstedNextSteps && !hasRIGrade))
    flags[paFlag('improvement')] = 'green';

  // A4 — Intake & Cohort: high FSM or EHC
  const fsmPct = parseFloat(vv('PNUMFSMEVER') ?? '');
  const ehcPct = parseFloat(vv('PSENELSE') ?? '');
  const isPrimary5 = /primary|junior|infant|middle.*primary/i.test(identity?.phase ?? '');
  if ((!isNaN(fsmPct) && fsmPct > (isPrimary5 ? 35 : 30)) ||
      (!isNaN(ehcPct) && ehcPct > 6)) {
    flags[paFlag('A4')] = 'red';
  }

  // A3 — Academic Performance
  const att8 = parseFloat(vv('ATT8SCR') ?? '');
  const p8   = parseFloat(vv('P8MEA') ?? '');
  const rwm  = parseFloat(vv('PTRWM_EXP') ?? '');
  const nat4 = NATIONAL_AVG.KS4;
  const nat2 = NATIONAL_AVG.KS2;
  if (!isNaN(att8) || !isNaN(p8) || !isNaN(rwm)) {
    if ((!isNaN(att8) && att8 > nat4.ATT8SCR + 10) ||
        (!isNaN(p8)   && p8 > 0.5) ||
        (!isNaN(rwm)  && rwm > nat2.PTRWM_EXP + 10)) {
      flags[paFlag('A3')] = 'green';
    } else if ((!isNaN(att8) && att8 < nat4.ATT8SCR - 10) ||
               (!isNaN(p8)   && p8 < -0.5) ||
               (!isNaN(rwm)  && rwm < nat2.PTRWM_EXP - 10)) {
      flags[paFlag('A3')] = 'red';
    }
  } else {
    // KS5-only schools — use VA band
    const ks5Band = parseInt(vv('PROGRESS_BAND_ALEV') ?? '', 10);
    if (ks5Band === 1)    flags[paFlag('A3')] = 'green';
    else if (ks5Band >= 4) flags[paFlag('A3')] = 'red';
  }

  // A5 — Absence & Engagement
  const absVal  = parseFloat(vv('PERCTOT') ?? '');
  const persVal = parseFloat(vv('PPERSABS10') ?? '');
  if (!isNaN(absVal) || !isNaN(persVal)) {
    if ((!isNaN(absVal) && absVal < 5) || (!isNaN(persVal) && persVal < 15))
      flags[paFlag('A5')] = 'green';
    else if ((!isNaN(absVal) && absVal > 8.6) || (!isNaN(persVal) && persVal > 23.3))
      flags[paFlag('A5')] = 'red';
  }

  // A6 — Financial Health: red if in-year deficit or QTS below comparator
  if (financial) {
    const balStr = String(financial.inYearBalance ?? '').trim();
    const isDeficit = balStr.startsWith('-');
    const qts    = parseFloat(String(financial.qualifiedTeachersPct  ?? '').replace('%', ''));
    const cmpQts = parseFloat(String(financial.comparatorQtsAvgPct   ?? '').replace('%', ''));
    if (isDeficit || (!isNaN(qts) && !isNaN(cmpQts) && qts < cmpQts))
      flags[paFlag('A6')] = 'red';
  }

  // A7 — Area Context: red if IMD 1–3 or mean household income below £35,000
  if (area) {
    const imdDecile = area.imd?.imdDecile;
    const incNum    = parseFloat(String(area.crystalRoof?.income?.meanAnnualHouseholdIncome ?? '').replace(/[£,]/g, ''));
    if ((imdDecile != null && imdDecile <= 3) || (!isNaN(incNum) && incNum < 35000))
      flags[paFlag('A7')] = 'red';
  }

  return flags;
}

// ─── Server-side deterministic Part A renderer ────────────────────────────────
//
// Returns an array of { heading, body, flag } objects for A1–A9.
// All content derived purely from structured data — no AI judgment.
// Observation sentences use template logic keyed to data thresholds.
//
// Exported so the Lambda handler can call it after fetchGovDataForPrompt resolves.


// ─── Server-rendered Part A comparison tables ───────────────────────────────

export function renderPartAComparison(schools) {
  if (!schools.length) return [];
  // If only 1 school resolved, pad with placeholder so tables still render
  if (schools.length < 2) {
    schools = [...schools, { identity: { officialName: 'Not resolved' }, ofsted: null, performance: {}, financial: null, giasDetails: null, area: null }];
  }

  let names = schools.map(s => s.identity?.officialName ?? s.input);

  const decodeHtml = (str) => {
    if (!str || typeof str !== 'string') return str;
    return str.replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  };

  const isState = (s) => _isState(s);
  const nsField = (s, v) => _nsField(s, v);
  const lField = (s, v) => _lField(s, v);
  const fmt = (v) => _fmtVal(v);
  const fmtPct = (v) => _fmtPct(v);
  const val = (fn, fallback) => { const v = fn(); return _val(v, fallback ?? '—'); };

  const hasKS2 = schools.some(s => Object.keys(s.performance ?? {}).some(k => k.slice(0,3) === 'KS2'));
  const hasKS4 = schools.some(s => Object.keys(s.performance ?? {}).some(k => k.slice(0,3) === 'KS4'));
  const hasKS5 = schools.some(s => Object.keys(s.performance ?? {}).some(k => k.slice(0,3) === 'KS5'));

  const nat2 = NATIONAL_AVG.KS2 ?? {};
  const nat4 = NATIONAL_AVG.KS4 ?? {};
  const nat5 = NATIONAL_AVG.KS5 ?? {};

  const buildTable4 = (lastCol, rows) => {
    return '| | ' + names.join(' | ') + ' | ' + lastCol + ' |\n' +
      '|---:|---:|---:|---:|\n' +
      rows.map(([label, fn, nat]) => '| ' + label + ' | ' + schools.map(fn).join(' | ') + ' | ' + (typeof nat === 'function' ? nat() : (nat ?? '—')) + ' |').join('\n');
  };

  const sections = [];

  // A1 — School Identity
  sections.push({
    heading: pa('A1'),
    body: '| | ' + names.join(' | ') + ' |\n' +
      '|---|---:|---:|\n' +
      [
        ['Official name', s => s.identity?.officialName ?? '—'],
        ['URN', s => s.identity?.urn ?? '—'],
        ['Type', s => s.identity?.type ?? '—'],
        ['Phase & age range', s => { const lo=lField(s,'AGELOW');const hi=lField(s,'AGEHIGH'); return (s.identity?.phase ?? '') + (lo&&hi ? ', ages '+lo+'–'+hi : ''); }],
        ['Gender', s => lField(s, 'GENDER') ?? '—'],
        ['Religious character', s => lField(s, 'RELCHAR') ?? '—'],
        ['Admissions policy', s => lField(s, 'ADMPOL') ?? '—'],
        ['Address', s => s.identity?.address?.replace(/,?\s*Not recorded/gi, '').replace(/\s{2,}/g, ' ').trim() || '—'],
        ['Pupils on roll', s => nsField(s, 'NOR') ?? '—'],
      ].map(([label, fn]) => '| ' + label + ' | ' + schools.map(fn).join(' | ') + ' |').join('\n'),
    flag: 'none',
  });

  // A2 — Inspection Grades
  if (schools.some(s => !s.identity?.isIndependent)) {
    sections.push({
      heading: pa('A2'),
      body: '| | ' + names.join(' | ') + ' |\n' +
        '|---|---:|---:|\n' +
        '| Overall grade | ' + schools.map(s => val(() => s.ofsted?.overall)).join(' | ') + ' |\n' +
        '| Inspection date | ' + schools.map(s => val(() => s.ofsted?.date)).join(' | ') + ' |',
      flag: 'none',
    });
  } else {
    sections.push({
      heading: pa('A2'),
      body: '| | ' + names.join(' | ') + ' |\n' +
        '|---|---:|---:|\n' +
        '| Overall (ISI) | ' + schools.map(s => val(() => s.ofsted?.overall)).join(' | ') + ' |\n' +
        '| Inspection date | ' + schools.map(s => val(() => s.ofsted?.date)).join(' | ') + ' |',
      flag: 'none',
    });
  }

  // A3 — Academic Performance (sub-sections vary by phase)
  // Sub-section naming matches the wiremock: A3.1. Attainment 8, etc.

  const buildTable3 = (rows) => {
    return '| | ' + names.join(' | ') + ' |\n' +
      '|---:|---:|---:|\n' +
      rows.map(([label, fn]) => '| ' + label + ' | ' + schools.map(fn).join(' | ') + ' |').join('\n');
  };

  // ── KS2 (primary) sub-sections ──────────────────────────────────────────────
  if (hasKS2) {
    // A3.1 — Cohort
    sections.push({
      heading: 'A3.1. Cohort',
      body: buildTable3([
        ['Eligible cohort', s => val(() => nsField(s, 'TELIG'))],
        ['% girls', s => val(() => fmtPct(nsField(s, 'PGELIG')))],
        ['% boys', s => val(() => fmtPct(nsField(s, 'PBELIG')))],
        ['% disadvantaged', s => val(() => fmtPct(nsField(s, 'PTFSM6CLA1A')))],
        ['% EAL', s => val(() => fmtPct(nsField(s, 'PTEALGRP2')))],
      ]),
      flag: 'none',
    });

    // A3.2 — Attainment (RWM)
    sections.push({
      heading: 'A3.2. Attainment — Reading, Writing & Maths',
      body: buildTable4('National', [
        ['% expected standard (RWM)', s => val(() => fmtPct(nsField(s, 'PTRWM_EXP'))), () => nat2.PTRWM_EXP ? nat2.PTRWM_EXP + '%' : '—'],
        ['% higher standard (RWM)', s => val(() => fmtPct(nsField(s, 'PTRWM_HIGH'))), () => nat2.PTRWM_HIGH ? nat2.PTRWM_HIGH + '%' : '—'],
      ]),
      flag: 'none',
    });

    // A3.3 — Scaled Scores
    sections.push({
      heading: 'A3.3. Scaled Scores',
      body: buildTable4('National', [
        ['Reading — avg scaled score', s => val(() => fmt(nsField(s, 'READ_AVERAGE'))), '105'],
        ['Maths — avg scaled score', s => val(() => fmt(nsField(s, 'MAT_AVERAGE'))), '104'],
        ['GPS — avg scaled score', s => val(() => fmt(nsField(s, 'GPS_AVERAGE'))), '105'],
      ]),
      flag: 'none',
    });

    // A3.4 — Per-subject: Expected Standard
    sections.push({
      heading: 'A3.4. Per-subject Attainment — Expected Standard',
      body: buildTable4('National', [
        ['Reading', s => val(() => fmtPct(nsField(s, 'PTREAD_EXP'))), () => nat2.PTREAD_EXP ? nat2.PTREAD_EXP + '%' : '—'],
        ['Writing (TA)', s => val(() => fmtPct(nsField(s, 'PTWRITTA_EXP'))), () => nat2.PTWRITTA_EXP ? nat2.PTWRITTA_EXP + '%' : '—'],
        ['Maths', s => val(() => fmtPct(nsField(s, 'PTMAT_EXP'))), () => nat2.PTMAT_EXP ? nat2.PTMAT_EXP + '%' : '—'],
        ['GPS', s => val(() => fmtPct(nsField(s, 'PTGPS_EXP'))), () => nat2.PTGPS_EXP ? nat2.PTGPS_EXP + '%' : '—'],
        ['Science (TA)', s => val(() => fmtPct(nsField(s, 'PTSCITA_EXP'))), () => nat2.PTSCITA_EXP ? nat2.PTSCITA_EXP + '%' : '—'],
      ]),
      flag: 'none',
    });

    // A3.5 — Per-subject: Higher Standard
    sections.push({
      heading: 'A3.5. Per-subject Attainment — Higher Standard',
      body: buildTable4('National', [
        ['Reading', s => val(() => fmtPct(nsField(s, 'PTREAD_HIGH'))), () => nat2.PTREAD_HIGH ? nat2.PTREAD_HIGH + '%' : '—'],
        ['Writing (TA)', s => val(() => fmtPct(nsField(s, 'PTWRITTA_HIGH'))), () => nat2.PTWRITTA_HIGH ? nat2.PTWRITTA_HIGH + '%' : '—'],
        ['Maths', s => val(() => fmtPct(nsField(s, 'PTMAT_HIGH'))), () => nat2.PTMAT_HIGH ? nat2.PTMAT_HIGH + '%' : '—'],
        ['GPS', s => val(() => fmtPct(nsField(s, 'PTGPS_HIGH'))), () => nat2.PTGPS_HIGH ? nat2.PTGPS_HIGH + '%' : '—'],
      ]),
      flag: 'none',
    });

    // A3.6 — Cohort Characteristics
    sections.push({
      heading: 'A3.6. Cohort Characteristics',
      body: buildTable3([
        ['% disadvantaged', s => val(() => fmtPct(nsField(s, 'PTFSM6CLA1A')))],
        ['% EAL', s => val(() => fmtPct(nsField(s, 'PTEALGRP2')))],
        ['% non-mobile', s => val(() => fmtPct(nsField(s, 'PTMOBN')))],
        ['% SEN with EHC plan', s => val(() => fmtPct(nsField(s, 'PSENELE')))],
        ['% SEN support', s => val(() => fmtPct(nsField(s, 'PSENELK')))],
      ]),
      flag: 'none',
    });

    // A3.7 — Disadvantage Gap
    sections.push({
      heading: 'A3.7. Disadvantage Gap',
      body: buildTable4('National', [
        ['RWM expected — gap vs national (pp)', s => val(() => fmt(nsField(s, 'DIFFN_RWM_EXP'))), '0'],
        ['RWM higher — gap vs national (pp)', s => val(() => fmt(nsField(s, 'DIFFN_RWM_HIGH'))), '0'],
      ]),
      flag: 'none',
    });

    // A3.8 — Test Participation
    const hasPart = schools.some(s => {
      const v = nsField(s, 'PTREAD_AT');
      return v != null && String(v).trim() !== '' && String(v).trim() !== '0';
    });
    if (hasPart) {
      sections.push({
        heading: 'A3.8. Test Participation',
        body: buildTable3([
          ['Reading — % absent from test', s => val(() => fmtPct(nsField(s, 'PTREAD_AT')))],
          ['Maths — % absent from test', s => val(() => fmtPct(nsField(s, 'PTMAT_AT')))],
          ['GPS — % absent from test', s => val(() => fmtPct(nsField(s, 'PTGPS_AT')))],
        ]),
        flag: 'none',
      });
    }

    // A3.9 — Progress (KS1 to KS2)
    sections.push({
      heading: 'A3.9. Progress — KS1 to KS2',
      body: buildTable4('National', [
        ['Reading progress', s => { const v = s.performance?.KS2_23?.find(r => r.variable === 'READPROG_23')?.value; const b = s.performance?.KS2_23?.find(r => r.variable === 'READPROG_23_DESCR_23')?.value; return v != null ? v + ' (' + (b || '—') + ')' : '—'; }, '0'],
        ['Writing progress', s => { const v = s.performance?.KS2_23?.find(r => r.variable === 'WRITPROG_23')?.value; const b = s.performance?.KS2_23?.find(r => r.variable === 'WRITPROG_23_DESCR_23')?.value; return v != null ? v + ' (' + (b || '—') + ')' : '—'; }, '0'],
        ['Maths progress', s => { const v = s.performance?.KS2_23?.find(r => r.variable === 'MATPROG_23')?.value; const b = s.performance?.KS2_23?.find(r => r.variable === 'MATPROG_23_DESCR_23')?.value; return v != null ? v + ' (' + (b || '—') + ')' : '—'; }, '0'],
      ]),
      flag: 'none',
    });

    // A3.10 — Results Over Time (KS2)
    sections.push({
      heading: 'A3.10. Results Over Time — KS2',
      body: buildTable4('National', [
        ['RWM expected 2023', s => val(() => fmtPct(nsField(s, 'PTRWM_EXP_23'))), '60%'],
        ['RWM expected 2024', s => val(() => fmtPct(nsField(s, 'PTRWM_EXP_24'))), '61%'],
        ['RWM expected 2025', s => val(() => fmtPct(nsField(s, 'PTRWM_EXP'))), () => nat2.PTRWM_EXP ? nat2.PTRWM_EXP + '%' : '—'],
        ['RWM higher 2023', s => val(() => fmtPct(nsField(s, 'PTRWM_HIGH_23'))), '8%'],
        ['RWM higher 2024', s => val(() => fmtPct(nsField(s, 'PTRWM_HIGH_24'))), '8%'],
        ['RWM higher 2025', s => val(() => fmtPct(nsField(s, 'PTRWM_HIGH'))), () => nat2.PTRWM_HIGH ? nat2.PTRWM_HIGH + '%' : '—'],
      ]),
      flag: 'none',
    });
  }

  // ── KS4 (secondary) sub-sections ────────────────────────────────────────────
  if (hasKS4) {
    // A3.1 — Attainment 8
    sections.push({
      heading: 'A3.1. Attainment 8',
      body: buildTable4('National', [
        ['Attainment 8 score', s => val(() => fmt(nsField(s, 'ATT8SCR'))), () => nat4.ATT8SCR != null ? String(nat4.ATT8SCR) : '—'],
        ['English element', s => val(() => fmt(nsField(s, 'ATT8SCRENG'))), () => nat4.ATT8_ENG != null ? String(nat4.ATT8_ENG) : '—'],
        ['Maths element', s => val(() => fmt(nsField(s, 'ATT8SCRMAT'))), () => nat4.ATT8_MAT != null ? String(nat4.ATT8_MAT) : '—'],
        ['EBacc element', s => val(() => fmt(nsField(s, 'ATT8SCREBAC'))), () => nat4.ATT8_EBACC != null ? String(nat4.ATT8_EBACC) : '—'],
        ['Open element', s => val(() => fmt(nsField(s, 'ATT8SCROPEN'))), () => nat4.ATT8_OPEN != null ? String(nat4.ATT8_OPEN) : '—'],
        ['Open — GCSE only', s => val(() => fmt(nsField(s, 'ATT8SCROPENG'))), () => nat4.ATT8_OPENG != null ? String(nat4.ATT8_OPENG) : '—'],
        ['Open — non-GCSE', s => val(() => fmt(nsField(s, 'ATT8SCROPENNG'))), () => nat4.ATT8_OPENNG != null ? String(nat4.ATT8_OPENNG) : '—'],
      ]),
      flag: 'none',
    });

    // A3.2 — Progress 8 (hidden for independents)
    const anyState = schools.some(s => isState(s));
    if (anyState) {
      sections.push({
        heading: 'A3.2. Progress 8',
        body: buildTable4('National', [
          ['Progress 8 score', s => isState(s) ? val(() => fmt(nsField(s, 'P8MEA'))) : '(indep)', '0'],
        ]),
        flag: 'none',
      });
    }

    // A3.3 — Cohort Characteristics
    sections.push({
      heading: 'A3.3. Cohort Characteristics',
      body: buildTable3([
        ['Pupils at end of KS4', s => val(() => nsField(s, 'TPUP'))],
        ['% disadvantaged', s => val(() => fmtPct(nsField(s, 'PTFSM6CLA1A')))],
        ['% EAL', s => val(() => fmtPct(nsField(s, 'PTEALGRP2')))],
        ['% non-mobile', s => val(() => fmtPct(nsField(s, 'PTNMOB')))],
        ['% SEN with EHC plan', s => val(() => fmtPct(nsField(s, 'PSENE4')))],
        ['% SEN total', s => val(() => fmtPct(nsField(s, 'PSEN_ALL4')))],
      ]),
      flag: 'none',
    });

    // A3.4 — Grade 5+ and 4+ English & Maths
    const hasGcse = schools.some(s => {
      const v = nsField(s, 'PTL2BASICS_95');
      return v != null && String(v).trim() !== '' && String(v).trim() !== '0.0' && String(v).trim() !== '0';
    });
    if (hasGcse) {
      sections.push({
        heading: 'A3.4. Grade 5+ and 4+ English & Maths',
        body: buildTable4('National', [
          ['% grade 5+ English & maths', s => val(() => fmtPct(nsField(s, 'PTL2BASICS_95'))), () => nat4.PTL2BASICS_95 != null ? nat4.PTL2BASICS_95 + '%' : '—'],
          ['% grade 4+ English & maths', s => val(() => fmtPct(nsField(s, 'PTL2BASICS_94'))), () => nat4.PTL2BASICS_94 != null ? nat4.PTL2BASICS_94 + '%' : '—'],
        ]),
        flag: 'none',
      });
    }

    // A3.5 — EBacc Entry by Subject
    const hasEbacc = schools.some(s => {
      const v = nsField(s, 'PTEBACC_E_PTQ_EE');
      return v != null && String(v).trim() !== '' && String(v).trim() !== '0';
    });
    if (hasEbacc) {
      sections.push({
        heading: 'A3.5. EBacc Entry by Subject',
        body: buildTable3([
          ['English', s => val(() => fmtPct(nsField(s, 'PTEBACENG_E_PTQ_EE')))],
          ['Maths', s => val(() => fmtPct(nsField(s, 'PTEBACMAT_E_PTQ_EE')))],
          ['Science', s => val(() => fmtPct(nsField(s, 'PTEBAC2SCI_E_PTQ_EE')))],
          ['Humanities', s => val(() => fmtPct(nsField(s, 'PTEBACHUM_E_PTQ_EE')))],
          ['Languages', s => val(() => fmtPct(nsField(s, 'PTEBACLAN_E_PTQ_EE')))],
        ]),
        flag: 'none',
      });
    }

    // A3.6 — Post-16 Destinations (state only)
    if (anyState) {
      const hasDest = schools.some(s => isState(s) && nsField(s, 'OVERALL_DESTPER') != null);
      if (hasDest) {
        sections.push({
          heading: 'A3.6. Post-16 Destinations (2023 leavers)',
          body: buildTable4('National', [
            ['% sustained education or employment', s => val(() => fmtPct(nsField(s, 'OVERALL_DESTPER'))), '—'],
            ['% in education', s => val(() => fmtPct(nsField(s, 'EDUCATIONPER'))), '—'],
            ['% further education', s => val(() => fmtPct(nsField(s, 'FEPER'))), '—'],
            ['% apprenticeships', s => val(() => fmtPct(nsField(s, 'APPRENPER'))), '—'],
            ['% not sustained', s => val(() => fmtPct(nsField(s, 'NOT_SUSTAINEDPER'))), '—'],
          ]),
          flag: 'none',
        });
      }
    }

    // A3.7 — Entry Volumes
    sections.push({
      heading: 'A3.7. Entry Volumes',
      body: buildTable3([
        ['Avg KS4 entries per pupil', s => val(() => fmt(nsField(s, 'TAVENT_E_3NG_PTQ_EE')))],
        ['Avg GCSE entries per pupil', s => val(() => fmt(nsField(s, 'TAVENT_G_PTQ_EE')))],
        ['% entering multiple languages', s => val(() => fmtPct(nsField(s, 'PTMULTILAN_E')))],
        ['% entering triple science', s => val(() => fmtPct(nsField(s, 'PTTRIPLESCI_E')))],
        ['% achieving any qualification', s => val(() => fmtPct(nsField(s, 'PTANYQ_PTQ_EE')))],
      ]),
      flag: 'none',
    });

    // A3.8 — EBacc Subject Achievement (9-4 and 9-5)
    const hasEbaccAch = schools.some(s => {
      const v = nsField(s, 'PTEBACENG_95');
      return v != null && String(v).trim() !== '' && String(v).trim() !== '0';
    });
    if (hasEbaccAch) {
      sections.push({
        heading: 'A3.8. EBacc Subject Achievement',
        body: '| Category | ' + names.join(' 9-5 | ') + ' 9-5 | National 9-5 | ' + names.join(' 9-4 | ') + ' 9-4 | National 9-4 |\n' +
          '|---:|---:|---:|---:|---:|---:|---:|\n' +
          ['English', 'Maths', 'Science', 'Humanities', 'Languages'].map(sub => {
            const eng95 = 'EBACC_' + sub.toUpperCase().slice(0,3) + '_95';
            const eng94 = 'EBACC_' + sub.toUpperCase().slice(0,3) + '_94';
            const v95 = sub === 'English' ? 'PTEBACENG_95' : sub === 'Maths' ? 'PTEBACMAT_95' : sub === 'Science' ? 'PTEBAC2SCI_95' : sub === 'Humanities' ? 'PTEBACHUM_95' : 'PTEBACLAN_95';
            const v94 = sub === 'English' ? 'PTEBACENG_94' : sub === 'Maths' ? 'PTEBACMAT_94' : sub === 'Science' ? 'PTEBAC2SCI_94' : sub === 'Humanities' ? 'PTEBACHUM_94' : 'PTEBACLAN_94';
            return '| ' + sub + ' | ' +
              schools.map(s => val(() => fmtPct(nsField(s, v95))) ?? '—').join(' | ') + ' | ' +
              (nat4[eng95] != null ? nat4[eng95] + '%' : '—') + ' | ' +
              schools.map(s => val(() => fmtPct(nsField(s, v94))) ?? '—').join(' | ') + ' | ' +
              (nat4[eng94] != null ? nat4[eng94] + '%' : '—') + ' |';
          }).join('\n'),
        flag: 'none',
      });
    }

    // A3.9 — Results Over Time (KS4)
    sections.push({
      heading: 'A3.9. Results Over Time — KS4',
      body: buildTable4('National', [
        ['Attainment 8 (2023)', s => val(() => fmt(nsField(s, 'ATT8SCR_PREV2'))), '—'],
        ['Attainment 8 (2024)', s => val(() => fmt(nsField(s, 'ATT8SCR_PREV'))), '—'],
        ['Attainment 8 (2025)', s => val(() => fmt(nsField(s, 'ATT8SCR'))), () => nat4.ATT8SCR != null ? String(nat4.ATT8SCR) : '—'],
      ].concat(anyState ? [
        ['Progress 8 (2023)', s => val(() => fmt(nsField(s, 'P8MEA_PREV2'))), '0'],
        ['Progress 8 (2024)', s => val(() => fmt(nsField(s, 'P8MEA_PREV'))), '0'],
        ['Progress 8 (2025)', s => val(() => fmt(nsField(s, 'P8MEA'))), '0'],
        ['Grade 5+ EM (2023)', s => val(() => fmtPct(nsField(s, 'PTL2BASICS_95_PREV2'))), '—'],
        ['Grade 5+ EM (2024)', s => val(() => fmtPct(nsField(s, 'PTL2BASICS_95_PREV'))), '—'],
        ['Grade 5+ EM (2025)', s => val(() => fmtPct(nsField(s, 'PTL2BASICS_95'))), () => nat4.PTL2BASICS_95 != null ? nat4.PTL2BASICS_95 + '%' : '—'],
      ] : [])),
      flag: 'none',
    });

    // A3.10 — Subjects Entered (KS4)
    if (schools.some(s => s.subjectEntries && s.subjectEntries.length)) {
      const topA = (schools[0]?.subjectEntries ?? []).slice(0, 8);
      const topB = (schools[1]?.subjectEntries ?? []).slice(0, 8);
      if (topA.length || topB.length) {
        const allNames = new Set([...topA.map(e => e.subject), ...topB.map(e => e.subject)]);
        const rows = [...allNames].slice(0, 12).map(sub => {
          const a = topA.find(e => e.subject === sub);
          const b = topB.find(e => e.subject === sub);
          return '| ' + sub + ' | ' +
            (a ? a.entries + ' entries' + (a.grade7PlusPct != null ? ' (' + a.grade7PlusPct + '% 7+)' : '') : '—') + ' | ' +
            (b ? b.entries + ' entries' + (b.grade7PlusPct != null ? ' (' + b.grade7PlusPct + '% 7+)' : '') : '—') + ' |';
        });
        sections.push({
          heading: 'A3.10. Subjects Entered — KS4',
          body: '| Subject | ' + names.join(' | ') + ' |\n' +
            '|---:|---:|---:|\n' + rows.join('\n'),
          flag: 'none',
        });
      }
    }
  }

  // ── KS5 (sixth form) sub-sections ────────────────────────────────────────────
  if (hasKS5) {
    // A3.11 — A-level Attainment
    sections.push({
      heading: 'A3.11. A-level Attainment',
      body: buildTable4('National', [
        ['A-level students', s => val(() => nsField(s, 'TALLPUP_ALEV_1618')), '—'],
        ['Average A-level grade', s => val(() => nsField(s, 'TALLPPEGRD_ALEV_1618')), () => nat5.AVG_GRADE ?? '—'],
        ['Average A-level points', s => val(() => fmt(nsField(s, 'TALLPPE_ALEV_1618'))), () => nat5.AVG_PTS != null ? String(nat5.AVG_PTS) : '—'],
        ['Best 3 A-levels — grade', s => val(() => nsField(s, 'TB3PTSE_GRD')), '—'],
      ]),
      flag: 'none',
    });

    // A3.12 — A-level Progress
    sections.push({
      heading: 'A3.12. A-level Progress',
      body: buildTable4('National', [
        ['Progress score (VA)', s => val(() => fmt(nsField(s, 'VA_INS_ALEV'))), '0'],
        ['Progress band', s => val(() => nsField(s, 'PROGRESS_BAND_ALEV')), '—'],
      ]),
      flag: 'none',
    });

    // A3.14 — Facilitating Subjects & Destinations
    sections.push({
      heading: 'A3.14. Facilitating Subjects & Destinations',
      body: buildTable4('National', [
        ['% AAB in ≥2 facilitating subjects', s => val(() => fmtPct(nsField(s, 'PTAAB_2FAC'))), '—'],
        ['% achieving advanced maths', s => val(() => fmtPct(nsField(s, 'L3M_PER'))), () => nat5.ADV_MATHS != null ? nat5.ADV_MATHS + '%' : '—'],
        ['% to higher education', s => val(() => fmtPct(nsField(s, 'TOT_HEPER'))), '—'],
        ['% to any sustained destination', s => val(() => fmtPct(nsField(s, 'ALL_PROGRESSED'))), '—'],
      ]),
      flag: 'none',
    });
  }

  // A4 — Intake & Cohort (available for all schools including independents)
  sections.push({
    heading: pa('A4'),
    body: buildTable4('National', [
      ['FSM eligible %', s => isState(s) ? val(() => fmtPct(nsField(s, 'PNUMFSMEVER'))) : '(indep — near 0%)', () => schools.some(s => (s.identity?.phase ?? '').toLowerCase().includes('secondary')) ? '~20%' : '~25%'],
      ['EAL %', s => val(() => fmtPct(nsField(s, 'PNUMEAL'))), '—'],
      ['SEN support %', s => val(() => fmtPct(nsField(s, 'PSENELK'))), '~13%'],
      ['EHC plan %', s => val(() => fmtPct(nsField(s, 'PSENELSE'))), '~4.5%'],
    ]),
    flag: 'none',
  });

  // A5 — Absence
  if (schools.some(s => isState(s) && nsField(s, 'PERCTOT'))) {
    sections.push({
      heading: pa('A5'),
      body: buildTable4('National', [
        ['Overall absence', s => isState(s) ? val(() => fmt(nsField(s, 'PERCTOT'))) + '%' : '(indep)', '6.6%'],
        ['Persistent absence', s => isState(s) ? val(() => fmt(nsField(s, 'PPERSABS10'))) + '%' : '(indep)', '21.3%'],
      ]),
      flag: 'none',
    });
  }

  // A6 — Financial Health (state schools only)
  if (schools.some(s => isState(s) && s.financial)) {
    sections.push({
      heading: pa('A6'),
      body: '| | ' + names.join(' | ') + ' | Comparator |\n' +
        '|---:|---:|---:|---:|\n' +
        '| Spend per pupil | ' + schools.map(s => { const n=_parseNum(s.financial?.totalSpendPerPupil); return !isNaN(n)?'£'+Number(n).toLocaleString():'—'; }).join(' | ') + ' | ' + schools.map(s => { const n=_parseNum(s.financial?.comparatorTotalPerPupil); return !isNaN(n)?'£'+Number(n).toLocaleString():'—'; }).join(' / ') + ' |\n' +
        '| In-year balance | ' + schools.map(s => { const n=_parseNum(s.financial?.inYearBalance); return !isNaN(n)?'£'+Number(n).toLocaleString():'—'; }).join(' | ') + ' | — |\n' +
        '| QTS % | ' + schools.map(s => { const n=_parseNum(s.financial?.qualifiedTeachersPct); return !isNaN(n)?n.toFixed(1)+'%':'—'; }).join(' | ') + ' | ' + schools.map(s => { const n=_parseNum(s.financial?.comparatorQtsAvgPct); return !isNaN(n)?n.toFixed(1)+'%':'—'; }).join(' / ') + ' |',
      flag: 'none',
    });
  }

  // A7 — Area Context
  if (schools.some(s => s.area?.imd?.imdDecile != null || s.area?.crystalRoof?.income?.meanAnnualHouseholdIncome != null || s.area?.pricePaid?.medianAllTypes != null)) {
    sections.push({
      heading: pa('A7'),
      body: '| | ' + names.join(' | ') + ' |\n' +
        '|---|---:|---:|\n' +
        '| IMD decile (1=most deprived) | ' + schools.map(s => val(() => s.area?.imd?.imdDecile + '/10')).join(' | ') + ' |\n' +
        '| Mean household income | ' + schools.map(s => { const v=s.area?.crystalRoof?.income?.meanAnnualHouseholdIncome; const n=_parseNum(v); if(!isNaN(n))return '£'+n.toLocaleString(); const v2=s.area?.income?.netAnnualHouseholdIncome; const n2=_parseNum(v2); return !isNaN(n2)?'£'+n2.toLocaleString():'—'; }).join(' | ') + ' |\n' +
        '| Median property price | ' + schools.map(s => { const v=s.area?.pricePaid?.medianAllTypes; const n=_parseNum(v); return !isNaN(n)?'£'+n.toLocaleString():'—'; }).join(' | ') + ' |\n' +
        '| % degree-level quals (area) | ' + schools.map(s => val(() => fmtPct(s.area?.crystalRoof?.qualifications?.level4AndAbove))).join(' | ') + ' |',
      flag: 'none',
    });
  }


  // ── Append deterministic analysis to each table ──────────────────────────
  // Pre-scan: find the last A3.x sub-section so we only append the analysis there
  let lastA3Idx = -1;
  for (let i = sections.length - 1; i >= 0; i--) {
    if (/^A3\.\d+\./.test(sections[i].heading || '')) { lastA3Idx = i; break; }
  }

  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const h = s.heading || '';
    let analysis = '';

    if (h.startsWith('A2.')) {
      const grades = schools.map(s => s.ofsted?.overall ?? null);
      const dates = schools.map(s => s.ofsted?.date ?? null);
      if (grades[0] && grades[1]) {
        if (grades[0] === grades[1]) {
          analysis = 'Both schools rated ' + grades[0] + ' — no inspection winner. ';
          if (dates[0] && dates[1]) {
            const d0 = new Date(dates[0]), d1 = new Date(dates[1]);
            analysis += d0 > d1 ? names[0] + ' has the more recent inspection (' + dates[0] + ' vs ' + dates[1] + ').'
              : names[1] + ' has the more recent inspection (' + dates[1] + ' vs ' + dates[0] + ').';
          }
        } else {
          const winner = (grades[0] === 'Outstanding' || grades[0] === 'Exceptional') ? names[0] :
                         (grades[1] === 'Outstanding' || grades[1] === 'Exceptional') ? names[1] : null;
          analysis = winner ? winner + ' wins on inspection (' + grades[0] + ' vs ' + grades[1] + ').'
            : names[0] + ': ' + grades[0] + ' vs ' + names[1] + ': ' + grades[1] + '.';
        }
      }
    }

    // Only append A3 analysis to the last sub-section (before A3 Observations)
    if (i === lastA3Idx) {
      // Compare Attainment 8 (secondary) or KS2 RWM (primary)
      const getVal = (s, v) => { const r = _nsField(s, v); return r != null ? parseFloat(String(r).replace(/%/g,'')) : null; };
      const a8a = getVal(schools[0], 'ATT8SCR'), a8b = getVal(schools[1], 'ATT8SCR');
      const p8a = getVal(schools[0], 'P8MEA'), p8b = getVal(schools[1], 'P8MEA');
      const rwma = getVal(schools[0], 'PTRWM_EXP'), rwmb = getVal(schools[1], 'PTRWM_EXP');
      const aleva = schools[0].performance ? _nsField(schools[0], 'TALLPPEGRD_ALEV_1618') : null;
      const alevb = schools[1].performance ? _nsField(schools[1], 'TALLPPEGRD_ALEV_1618') : null;

      if (a8a != null && a8b != null && !isNaN(a8a) && !isNaN(a8b)) {
        analysis = a8a > a8b ? names[0] + ' leads on Attainment 8 (' + a8a.toFixed(1) + ' vs ' + a8b.toFixed(1) + ').'
          : a8b > a8a ? names[1] + ' leads on Attainment 8 (' + a8b.toFixed(1) + ' vs ' + a8a.toFixed(1) + ').'
          : 'Attainment 8 is equal (' + a8a.toFixed(1) + ').';
      }
      if (p8a != null && p8b != null && !isNaN(p8a) && !isNaN(p8b)) {
        analysis += ' ' + (p8a > p8b ? names[0] + ' leads on Progress 8 (' + p8a.toFixed(1) + ' vs ' + p8b.toFixed(1) + ').'
          : p8b > p8a ? names[1] + ' leads on Progress 8 (' + p8b.toFixed(1) + ' vs ' + p8a.toFixed(1) + ').'
          : 'Progress 8 is equal.');
      }
      if (rwma != null && rwmb != null && !isNaN(rwma) && !isNaN(rwmb)) {
        analysis += ' ' + (rwma > rwmb ? names[0] + ' leads on KS2 RWM (' + rwma.toFixed(1) + '% vs ' + rwmb.toFixed(1) + '%).'
          : rwmb > rwma ? names[1] + ' leads on KS2 RWM (' + rwmb.toFixed(1) + '% vs ' + rwma.toFixed(1) + '%).'
          : 'KS2 RWM is equal.');
      }
      if (!analysis && aleva && alevb) {
        analysis = aleva !== alevb ? (aleva > alevb ? names[0] : names[1]) + ' leads on A-level grade (' + aleva + ' vs ' + alevb + ').'
          : 'A-level grades equal (' + aleva + ').';
      }
      if (!analysis) analysis = 'Academic comparison limited — some metrics not available for both schools.';
    }

    if (h.startsWith('A4.')) {
      const getPct = (s, v) => { const r = _nsField(s, v); if (!r) return null; const n = parseFloat(String(r).replace(/%/g,'')); return isNaN(n) ? null : n; };
      const fsma = getPct(schools[0], 'PNUMFSMEVER'), fsmb = getPct(schools[1], 'PNUMFSMEVER');
      const sena = getPct(schools[0], 'PSENELK'), senb = getPct(schools[1], 'PSENELK');
      if (fsma != null && fsmb != null) {
        analysis = fsmb > fsma ? names[1] + ' has a more disadvantaged intake (FSM ' + fsmb.toFixed(1) + '% vs ' + fsma.toFixed(1) + '%).'
          : fsma > fsmb ? names[0] + ' has a more disadvantaged intake (FSM ' + fsma.toFixed(1) + '% vs ' + fsmb.toFixed(1) + '%).'
          : 'FSM rates are equal (' + fsma.toFixed(1) + '%).';
      }
      if (sena != null && senb != null) {
        const diff = Math.abs(sena - senb);
        if (diff > 5) analysis += ' ' + (sena > senb ? names[0] : names[1]) + ' has a notably higher SEN support rate (' + Math.max(sena,senb).toFixed(1) + '% vs ' + Math.min(sena,senb).toFixed(1) + '%).';
      }
    }

    if (h.startsWith('A5.')) {
      const getAbs = (s, v) => { const r = _nsField(s, v); return r != null ? parseFloat(String(r)) : null; };
      const oaa = getAbs(schools[0], 'PERCTOT'), oab = getAbs(schools[1], 'PERCTOT');
      const paa = getAbs(schools[0], 'PPERSABS10'), pab = getAbs(schools[1], 'PPERSABS10');
      if (oaa != null && oab != null && !isNaN(oaa) && !isNaN(oab)) {
        const winner = oaa < oab ? names[0] : oab < oaa ? names[1] : null;
        analysis = winner ? winner + ' has better overall absence (' + Math.min(oaa,oab).toFixed(1) + '% vs ' + Math.max(oaa,oab).toFixed(1) + '%).'
          : 'Overall absence equal (' + oaa.toFixed(1) + '%).';
        if (paa != null && pab != null && !isNaN(paa) && !isNaN(pab)) {
          const pwinner = paa < pab ? names[0] : pab < paa ? names[1] : null;
          analysis += ' ' + (pwinner ? pwinner + ' also leads on persistent absence (' + Math.min(paa,pab).toFixed(1) + '% vs ' + Math.max(paa,pab).toFixed(1) + '%).'
            : 'Persistent absence equal.');
        }
      } else if (schools.every(s => !isState(s))) {
        analysis = 'Absence data not reported — independent schools do not report absence to DfE.';
      }
    }

    if (h.startsWith('A6.')) {
      const spendA = schools[0].financial?.inYearBalance != null ? _parseNum(schools[0].financial.inYearBalance) : null;
      const spendB = schools[1].financial?.inYearBalance != null ? _parseNum(schools[1].financial.inYearBalance) : null;
      if (spendA != null && spendB != null && !isNaN(spendA) && !isNaN(spendB)) {
        if (spendA < 0 && spendB >= 0) analysis = names[0] + ' is running a deficit while ' + names[1] + ' is in surplus.';
        else if (spendB < 0 && spendA >= 0) analysis = names[1] + ' is running a deficit while ' + names[0] + ' is in surplus.';
        else if (spendA < 0 && spendB < 0) analysis = 'Both schools running deficits.';
        else analysis = 'Both schools in surplus.';
      } else if (schools.every(s => !isState(s))) {
        analysis = 'Financial benchmarking not available — independent schools do not report to FBIT.';
      }
    }

    if (analysis) s.body += '\n\n' + analysis;
  }

  for (const s of sections) s.body = decodeHtml(s.body);
  return sections;
}


export function renderPartA(school, flags = {}) {
  const { identity, ofsted, performance, financial, area, schoolEthnicity, laPerf, giasDetails, subjectEntries, ks5SubjectEntries } = school;
  const isIndependent = identity?.isIndependent ?? false;

  // ── Lookup helpers ─────────────────────────────────────────────────────────
  const allRows = Object.entries(performance ?? {})
    .sort(([a], [b]) => (parseInt(b.match(/_(\d+)$/)?.[1] ?? '0', 10) - parseInt(a.match(/_(\d+)$/)?.[1] ?? '0', 10)))
    .flatMap(([, rows]) => rows);
  const v  = (code) => allRows.find(r => r.variable === code)?.value ?? null;
  const lv = (code) => performance?.L?.find(r => r.variable === code)?.value ?? null;
  const d  = (val)  => (val != null ? String(val) : '—');

  const sections = [];

  // ────────────────────────────────────────────────────────────────────────────
  // A1. School Identity
  // ────────────────────────────────────────────────────────────────────────────
  {
    const gender      = lv('GENDER');
    const relChar     = lv('RELCHAR');
    const ageLow      = lv('AGELOW');
    const ageHigh     = lv('AGEHIGH');
    const nor         = v('NOR');
    const capacity    = giasDetails?.capacity ?? null;
    const headteacher = giasDetails?.headteacher ?? null;
    // Address comes from the GIAS tile (street + town + postcode inline string).
    // GIAS sometimes includes "Not recorded" for missing address lines — strip those tokens.
    const address     = identity?.address
      ? identity.address.replace(/,?\s*Not recorded/gi, '').replace(/\s{2,}/g, ' ').replace(/^,\s*|,\s*$/g, '').trim() || null
      : null;

    const genderDisplay  = gender === 'Boys' ? 'Boys only' : gender === 'Girls' ? 'Girls only' : (gender ?? '—');
    const relDisplay     = (!relChar || relChar === 'Does not apply' || relChar === 'None') ? '—' : relChar;
    const phaseDisplay   = [identity?.phase, ageLow && ageHigh ? `(ages ${ageLow}–${ageHigh})` : null].filter(Boolean).join(' ');

    const lines = [
      '| Field | Value |',
      '|---|---|',
      `| Official name | ${d(identity?.officialName)} |`,
      `| URN | ${d(identity?.urn)} |`,
      `| Type | ${d(identity?.type)} |`,
      `| Phase and age range | ${phaseDisplay || '—'} |`,
      `| Local authority | ${d(identity?.la)} |`,
      `| Co-ed / single-sex | ${genderDisplay} |`,
      `| Religious character | ${relDisplay} |`,
      `| Admissions policy | ${d(lv('ADMPOL'))} |`,
    ];
    if (headteacher) lines.push(`| Headteacher | ${headteacher} |`);
    if (address)     lines.push(`| Address | ${address} |`);
    if (capacity) lines.push(`| Capacity | ${capacity}${nor ? ` (${nor} on roll)` : ''} |`);

    lines.push('');
    lines.push(`This is ${d(identity?.officialName)}${identity?.la ? ` in ${identity.la}` : ''}, the subject of this report.`);

    sections.push({ heading: pa('A1'), body: lines.join('\n'), flag: 'none' });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // A2. Inspection Outcomes
  // ────────────────────────────────────────────────────────────────────────────
  {
    let body;
    if (isIndependent && !ofsted?.overall) {
      body = 'Independent school — ISI inspection report not retrieved. See isi.net.';
    } else if (isIndependent && ofsted?.overall) {
      // ISI data available — render same table format as Ofsted
      const lines = [];
      if (ofsted.date)         lines.push(`Inspection date: ${ofsted.date}`);
      if (ofsted.framework)    lines.push(`\nFramework: ${ofsted.framework}`);
      if (ofsted.safeguarding) lines.push(`\nSafeguarding: ${ofsted.safeguarding}`);
      lines.push('');
      lines.push('| Area | Grade |', '|---|---|');
      lines.push(`| Overall | ${ofsted.overall} |`);
      if (ofsted.academicJudgment)
        lines.push(`| Academic achievement | ${ofsted.academicJudgment} |`);
      if (ofsted.personalJudgment)
        lines.push(`| Personal development | ${ofsted.personalJudgment} |`);
      body = lines.join('\n');
    } else if (!ofsted?.overall) {
      body = `_Not retrieved — check [reports.ofsted.gov.uk](https://reports.ofsted.gov.uk) by URN or school name._`;
    } else {
      const lines = [];
      if (ofsted.date)         lines.push(`Inspection date: ${ofsted.date}`);
      if (ofsted.framework)    lines.push(`\nFramework used: ${ofsted.framework}`);
      if (ofsted.safeguarding) lines.push(`\nSafeguarding status: ${ofsted.safeguarding}`);
      lines.push('');

      // Show all available sub-grades. The Ofsted framework determines which
      // labels to use, but when grades come from a mix of sources (HTML + old
      // PDF fallback), just display whatever we have using the most appropriate
      // labels.  Three frameworks: Nov-2025+, 2019–2024, pre-2019.
      const hasNewGrades = !!(ofsted.attendance || ofsted.curriculum);
      const hasMidGrades = !!(ofsted.qualityOfEducation || ofsted.behaviour || ofsted.personalDevelopment || ofsted.leadership || ofsted.sixthForm);
      lines.push('| Area | Grade |', '|---|---|');
      lines.push(`| Overall | ${ofsted.overall} |`);
      // Nov-2025+ areas
      if (ofsted.achievement && hasNewGrades)
        lines.push(`| Achievement | ${ofsted.achievement} |`);
      if (ofsted.attendance)
        lines.push(`| Attendance and Behaviour | ${ofsted.attendance} |`);
      if (ofsted.curriculum)
        lines.push(`| Curriculum and Teaching | ${ofsted.curriculum} |`);
      if (ofsted.inclusion)
        lines.push(`| Inclusion | ${ofsted.inclusion} |`);
      if (ofsted.leadershipGov)
        lines.push(`| Leadership and Governance | ${ofsted.leadershipGov} |`);
      if (ofsted.wellbeing)
        lines.push(`| Personal Development and Wellbeing | ${ofsted.wellbeing} |`);
      if (ofsted.post16)
        lines.push(`| Post-16 Provision | ${ofsted.post16} |`);
      // 2019–2024 areas (or pre-2019 mapped to these labels)
      if (ofsted.qualityOfEducation)
        lines.push(`| Quality of Education | ${ofsted.qualityOfEducation} |`);
      if (ofsted.behaviour)
        lines.push(`| Behaviour and Attitudes | ${ofsted.behaviour} |`);
      if (ofsted.personalDevelopment)
        lines.push(`| Personal Development | ${ofsted.personalDevelopment} |`);
      if (ofsted.leadership)
        lines.push(`| Leadership and Management | ${ofsted.leadership} |`);
      if (ofsted.sixthForm)
        lines.push(`| Sixth Form | ${ofsted.sixthForm} |`);
      if (ofsted.eduProgrammes)
        lines.push(`| Education programmes for young people | ${ofsted.eduProgrammes} |`);
      if (ofsted.highNeeds)
        lines.push(`| Provision for learners with high needs | ${ofsted.highNeeds} |`);
      // Pre-2019 "Outcomes for pupils" — shown as Achievement when no newer
      // framework grades are present
      if (ofsted.achievement && !hasNewGrades)
        lines.push(`| Achievement | ${ofsted.achievement} |`);

      // Deterministic verdict (old framework only — new framework uses different terminology)
      if (!hasNewGrades) {
        const RANK = { 'Outstanding': 4, 'Exceptional': 5, 'Good': 3, 'Requires Improvement': 2, 'Inadequate': 1 };
        const overallRank = RANK[ofsted.overall] ?? 3;
        const subGrades = [ofsted.qualityOfEducation, ofsted.behaviour, ofsted.personalDevelopment, ofsted.leadership, ofsted.sixth].filter(Boolean);
        if (subGrades.length >= 3) {
          // We have enough sub-grades to make a meaningful verdict
          const weaker   = subGrades.filter(g => (RANK[g] ?? 3) < overallRank);
          const standout = subGrades.filter(g => (RANK[g] ?? 3) > overallRank);
          lines.push('');
          if (weaker.length)
            lines.push(`Verdict: overall ${ofsted.overall}, with weaker sub-grade${weaker.length > 1 ? 's' : ''} — ${weaker.join(', ')}.`);
          else if (standout.length)
            lines.push(`Verdict: a clean overall picture at ${ofsted.overall}; standout sub-grade${standout.length > 1 ? 's' : ''} — ${standout.join(', ')}.`);
          else
            lines.push(`Verdict: overall ${ofsted.overall} — all sub-grades at or near the same level.`);
        }
      }

      body = lines.join('\n');
    }
    sections.push({ heading: 'A2. Inspection Outcomes', body, flag: flags['A2. Inspection Outcomes'] ?? 'none' });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // A3. What the School Needs to Improve  (was A4)
  // ────────────────────────────────────────────────────────────────────────────
  {
    let body;
    if (isIndependent && ofsted?.recommendations) {
      body = ofsted.recommendations;  // ISI recommendations
    } else if (isIndependent && ofsted?.nextSteps) {
      body = ofsted.nextSteps;  // ISI next steps (alt key)
    } else if (isIndependent) {
      body = '_Independent school — no improvement recommendations available._';
    } else if (ofsted?.nextSteps) {
      body = ofsted.nextSteps;
    } else if (ofsted?.overall) {
      body = `_No improvement requirements stated. Ofsted grade: ${ofsted.overall}._`;
    } else {
      body = `_Not retrieved.${ofsted?.reportUrl ? ` [View full report](${ofsted.reportUrl})` : ''}_`;
    }
    sections.push({ heading: pa('improvement'), body, flag: flags[paFlag('improvement')] ?? 'none' });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // A3. Academic Performance
  // ────────────────────────────────────────────────────────────────────────────
  {
    const body = fmtAcademicResultsSlim(performance, identity?.phase, null, laPerf ?? null, true, identity?.isIndependent ?? false, null, subjectEntries, ks5SubjectEntries);
    sections.push({ heading: pa('A3'), body, flag: flags[paFlag('A3')] ?? 'none' });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // A4. Intake & Cohort
  // ────────────────────────────────────────────────────────────────────────────
  {
    const nor  = v('NOR');
    const fsm  = v('PNUMFSMEVER');
    const eal  = v('PNUMEAL');
    const senK = v('PSENELK');
    const senE = v('PSENELSE');

    const lines = [
      '| Metric | School | National avg |',
      '|---|---:|---:|',
    ];
    if (nor)  lines.push(`| Pupils on roll | ${nor} | ~280 primary / ~1,000 secondary |`);
    if (fsm)  lines.push(`| Free School Meals (FSM) eligible — last 6 years | ${fsm} | ~25% primary / ~20% secondary |`);
    if (eal)  lines.push(`| English as Additional Language (EAL) pupils | ${eal} | — |`);
    if (senK) lines.push(`| Special Educational Needs (SEN) support | ${senK} | ~13% |`);
    if (senE) lines.push(`| Education, Health and Care (EHC) plans | ${senE} | ~4.5% |`);

    if (schoolEthnicity) {
      const eth = schoolEthnicity;
      const totalPct = (eth.w || 0) + (eth.m || 0) + (eth.a || 0) + (eth.b || 0) + (eth.c || 0) + (eth.o || 0) + (eth.ns || 0);
      if (totalPct > 0) {
        lines.push('');
        lines.push('| Ethnic group | % of pupils |');
        lines.push('|---|---:|');
        if (eth.w  != null) lines.push(`| White | ${eth.w}% |`);
        if (eth.m  != null) lines.push(`| Mixed | ${eth.m}% |`);
        if (eth.a  != null) lines.push(`| Asian | ${eth.a}% |`);
        if (eth.b  != null) lines.push(`| Black | ${eth.b}% |`);
        if (eth.c  != null) lines.push(`| Chinese | ${eth.c}% |`);
        if (eth.o  != null) lines.push(`| Other | ${eth.o}% |`);
        if (eth.ns != null) lines.push(`| Not stated | ${eth.ns}% |`);
      }
    }

    sections.push({ heading: pa('A4'), body: lines.join('\n'), flag: flags[paFlag('A4')] ?? 'none' });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // A5. Absence & Engagement
  // ────────────────────────────────────────────────────────────────────────────
  {
    const abs  = v('PERCTOT');
    const pers = v('PPERSABS10');
    const lines = [
      '| Metric | School | National avg |',
      '|---|---:|---:|',
      `| Overall absence | ${d(abs)} | 6.6% |`,
      `| Persistent absence (missed 10%+ of sessions) | ${d(pers)} | 21.3% |`,
    ];

    sections.push({ heading: pa('A5'), body: lines.join('\n'), flag: flags[paFlag('A5')] ?? 'none' });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // A6. Financial Health
  // ────────────────────────────────────────────────────────────────────────────
  {
    let body;
    if (isIndependent || !financial) {
      body = isIndependent
        ? '_Independent school — FBIT data not published for independent schools._'
        : '_Not retrieved — only available for state-funded schools._';
    } else {
      const lines = [
        '| Metric | School | Comparator avg |',
        '|---|---:|---:|',
        `| Spend per pupil | ${d(financial.totalSpendPerPupil)} | ${d(financial.comparatorTotalPerPupil)} |`,
        `| In-year balance | ${d(financial.inYearBalance)} | — |`,
        `| Revenue reserves | ${d(financial.revenueReserve)} | — |`,
        `| Qualified Teacher Status (QTS) % | ${d(financial.qualifiedTeachersPct)}${financial.comparatorQtsAvgPct ? ` | ${financial.comparatorQtsAvgPct}` : ' | —'} |`,
        `| Pupil:teacher ratio | ${financial.pupilTeacherRatio ? `${financial.pupilTeacherRatio}:1` : '—'} | — |`,
      ];

      body = lines.join('\n');
    }
    sections.push({ heading: pa('A6'), body, flag: flags[paFlag('A6')] ?? 'none' });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // A7. Area Context
  // ────────────────────────────────────────────────────────────────────────────
  {
    let body;
    if (!area) {
      body = '_Not retrieved — postcode lookup unavailable._';
    } else {
      const crInc = area.crystalRoof?.income;
      const pp    = area.pricePaid;
      const imd   = area.imd;
      const q     = area.crystalRoof?.qualifications;
      const o     = area.crystalRoof?.occupation;

      // Aggregate ethnicity to broad groups
      let ethSummary = '—';
      if (area.ethnicity && Object.keys(area.ethnicity).length) {
        const groups = {};
        for (const [label, pct] of Object.entries(area.ethnicity)) {
          const broad = label.startsWith('White:') ? 'White'
            : label.startsWith('Asian') ? 'Asian'
            : label.startsWith('Black') ? 'Black'
            : label.startsWith('Mixed') ? 'Mixed'
            : 'Other';
          groups[broad] = (groups[broad] ?? 0) + pct;
        }
        ethSummary = Object.entries(groups)
          .sort(([, a], [, b]) => b - a)
          .map(([k, pct]) => `${k} ${Math.round(pct)}%`).join(' · ');
      }

      const lines = [
        '| Metric | Value |',
        '|---|---|',
        `| Household income (mean gross, MSOA) | ${crInc?.meanAnnualHouseholdIncome ?? '—'} |`,
        `| Median property price (~800m radius) | ${pp?.medianAllTypes ?? '—'} |`,
        `| Deprivation — Index of Multiple Deprivation (IMD) decile (1=most deprived, 10=least) | ${imd?.imdDecile != null ? `${imd.imdDecile}/10` : '—'} |`,
        `| Ethnicity breakdown | ${ethSummary} |`,
      ];
      if (q) lines.push(`| Qualifications (% degree-level or above) | ${q.level4AndAbove ?? '—'}% |`);
      if (o) lines.push(`| Occupation (% professional/managerial) | ${o.managerialProfessional ?? '—'}% |`);

      body = lines.join('\n');
    }
    sections.push({ heading: pa('A7'), body, flag: flags[paFlag('A7')] ?? 'none' });
  }

  // A9. What It's Like to Be a Pupil is generated entirely by the AI
  // (Call 2 verdict).  No server placeholder needed — interleaveVerdicts
  // appends the AI-generated A9 section at the end of Part A.

  // Tag the first section with the Part A label so the UI renders the divider
  if (sections.length > 0) sections[0]._partLabel = 'Part A — Official Record';

  return sections;
}

// Debug helpers — exported so debug-govuk.mjs can print both blocks
export { buildDetailedBlock };
