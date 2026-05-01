/**
 * independent.js
 *
 * Pre-fetches independent-school data that has no gov.uk source:
 * ISI inspection reports, fee schedules, and exam results.
 *
 * All functions return the same shapes as their govuk.js counterparts
 * so fmtOfstedSlim, renderPartA, and computeFlags mostly just work.
 *
 * Sources:
 *   - reports.isi.net  — ISI inspection PDFs
 *   - isi.net/reports/ — paginated SSR institution listing (for URN→slug lookup)
 *   - isc.co.uk        — Independent Schools Council (fees, exam results)
 *
 * Failures are non-fatal — null returns mean "tell the AI to web-search it."
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// pdf-parse's index.js has a debug block that tries to read a test file when
// !module.parent is true (always the case with ESM).  Import the parse function
// directly from the internal module to avoid that.
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const FETCH_TIMEOUT_MS = 20000;  // PDFs can be large

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── Bundled ISI index ────────────────────────────────────────────────────────
//
// Built by scripts/build-isi-index.mjs — run each term to refresh.
// Contains {slug, id, eqiUrl, eqiDate, rouUrl, rouDate} for ~1,400 schools.

let _isiIndex = null;

function loadISIIndex() {
  if (_isiIndex) return _isiIndex;
  try {
    const path = join(__dirname, 'sources', 'isi-institutions.json');
    _isiIndex = JSON.parse(readFileSync(path, 'utf8'));
    return _isiIndex;
  } catch {
    return null;  // index not built yet — live search will be used
  }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function glog(event, props = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), src: 'independent', ...props }));
}

// ─── Safe fetch ───────────────────────────────────────────────────────────────

async function safeFetch(url, timeout = FETCH_TIMEOUT_MS) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
      },
    });
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  }
}

async function safeFetchBuffer(url, timeout = FETCH_TIMEOUT_MS) {
  const res = await safeFetch(url, timeout);
  if (!res) return null;
  try { return Buffer.from(await res.arrayBuffer()); }
  catch { return null; }
}

// ─── ISI institution lookup ───────────────────────────────────────────────────
//
// ISI's /reports/ page is server-rendered and paginated alphabetically by
// school name.  We search the first few pages for a school-name match to
// extract the ISI slug (e.g. "abbey-college-7557").  From the slug we derive
// the numeric institution ID, which lets us construct report download URLs.
//
// In the future this should be replaced by a deploy-time index (TD-011).

const ISI_REPORTS_BASE = 'https://www.isi.net/reports/';

/**
 * Extracts institution {slug, id, name} entries from an ISI reports listing page.
 */
function parseISIListingPage(html) {
  const entries = [];
  // Institution links: institutions/school/{slug} (may or may not have leading /)
  const linkRe = /href="\/?institutions\/school\/([^"?]+)"/g;
  for (const m of html.matchAll(linkRe)) {
    const slug = m[1];
    const idMatch = slug.match(/-(\d+)$/);
    if (!idMatch) continue;
    const id = idMatch[1];
    // Extract the school name from the slug (slug-name → School Name)
    const namePart = slug.replace(/-+\d+$/, '').replace(/-+/g, ' ');
    if (!entries.some(e => e.id === id)) {
      entries.push({ slug, id, nameHint: namePart });
    }
  }
  return entries;
}

/**
 * Searches the ISI reports listing (paginated SSR) for a school by name.
 * Checks the first 5 pages — covers A–E alphabetically, which is where most
 * searched schools will be found.
 *
 * Returns { slug, id } or null.
 */
export async function findISIInstitution(schoolName) {
  const nameLower = schoolName.toLowerCase().trim();
  const nameWords = nameLower.split(/\s+/).filter(w => w.length > 2);
  // Also try with apostrophes/special chars replaced by spaces (handles
  // "Alleyn's" → "alleyn s" matching index key "alleyn s school").
  const nameNormalised = nameLower.replace(/[''`’]/g, ' ').replace(/\s+/g, ' ').trim();
  const nameWordsNorm = nameNormalised.split(/\s+/).filter(w => w.length > 2);

  // ── Try bundled index first (zero latency) ─────────────────────────────────
  const index = loadISIIndex();
  if (index?.byName) {
    // Exact match (try original then normalised)
    let entry = index.byName[nameLower] ?? index.byName[nameNormalised];
    if (entry) {
      return { slug: entry.slug, id: entry.id, nameHint: entry.nameHint };
    }
    // Fuzzy match: find the entry with the most word overlap.
    // Try original words first, then normalised words.
    let best = null;
    let bestScore = 0;
    for (const [key, entry2] of Object.entries(index.byName)) {
      if (key.startsWith('_id:')) continue;
      const matchedOrig = nameWords.filter(w => key.includes(w)).length;
      const matchedNorm = nameWordsNorm.filter(w => key.includes(w)).length;
      const matched = Math.max(matchedOrig, matchedNorm);
      if (matched > bestScore && matched >= Math.min(2, nameWords.length)) {
        bestScore = matched;
        best = entry2;
      }
    }
    if (best) {
      glog('isi_found_index', { schoolName, slug: best.slug, id: best.id });
      return { slug: best.slug, id: best.id, nameHint: best.nameHint };
    }
  }

  // ── Fall back to live search (first 5 pages) ──────────────────────────────
  for (let page = 1; page <= 5; page++) {
    const url = page === 1 ? ISI_REPORTS_BASE : `${ISI_REPORTS_BASE}?p=${page}`;
    const res = await safeFetch(url, 8000);
    if (!res) continue;

    const html = await res.text();
    const entries = parseISIListingPage(html);

    for (const entry of entries) {
      const hintLower = entry.nameHint.toLowerCase();
      // Direct match on name
      if (hintLower === nameLower) {
        glog('isi_found_exact', { schoolName, slug: entry.slug, id: entry.id, page });
        return entry;
      }
      // Word-overlap match (at least 2 distinctive words)
      const matchedWords = nameWords.filter(w => hintLower.includes(w));
      if (matchedWords.length >= Math.min(2, nameWords.length)) {
        glog('isi_found_fuzzy', { schoolName, slug: entry.slug, id: entry.id, matchedWords, page });
        return entry;
      }
    }
  }

  glog('isi_not_found', { schoolName });
  return null;
}

// ─── ISI report URL construction ──────────────────────────────────────────────

/**
 * Given an ISI institution slug (e.g. "abbey-college-7557"), fetches the
 * institution page with ?results=true (SSR mode) and extracts all inspection
 * report download URLs, returning the most recent.
 *
 * Report URLs follow the pattern:
 *   https://reports.isi.net/DownloadReport.aspx?t=c&r={TYPE}{ID}_{DATE}.pdf&s={ID}
 *
 * Report type codes observed:
 *   EQI — Educational Quality Inspection (full graded inspection)
 *   ROU — Routine inspection (full inspection, newer framework)
 *   FCI — Focused Compliance and Educational Quality Inspection
 *   ADD — Additional / compliance-only inspection
 *   INT — Interim / monitoring inspection
 *   GRT — ?? (older format)
 *
 * EQI and ROU are the "main" inspections — the ones parents care about.
 */
export async function getISIReportUrl(isiSlug) {
  // ── Try bundled index first (zero latency) ─────────────────────────────────
  const index = loadISIIndex();
  if (index?.byName) {
    // Find the entry by slug
    const entry = Object.values(index.byName).find(e => e.slug === isiSlug);
    if (entry) {
      // Prefer EQI/FCI (graded) over ROU (compliance)
      const url = entry.eqiUrl ?? entry.rouUrl ?? null;
      if (url) {
        glog('isi_report_url_from_index', { slug: isiSlug, url, hasEqi: !!entry.eqiUrl });
        return url;
      }
    }
  }

  // ── Fall back to live fetch ───────────────────────────────────────────────
  const url = `https://www.isi.net/institutions/school/${isiSlug}?results=true`;
  const res = await safeFetch(url, 8000);
  if (!res) return null;

  const html = await res.text();

  // Extract all report download URLs and parse their details
  const reportRe = /DownloadReport\.aspx\?t=c(?:%26|&)r=([A-Z]+)(\d+)_(\d{8})\.pdf(?:%26|&)s=\2/g;
  const reports = [];
  for (const m of html.matchAll(reportRe)) {
    const type = m[1];
    const date = m[3]; // YYYYMMDD
    const url  = `https://reports.isi.net/DownloadReport.aspx?t=c&r=${type}${m[2]}_${date}.pdf&s=${m[2]}`;
    // Avoid duplicates (the page has both encoded and unencoded versions)
    if (!reports.some(r => r.url === url)) {
      reports.push({ type, date, url });
    }
  }

  if (!reports.length) return null;

  // Sort by date descending — latest first
  reports.sort((a, b) => b.date.localeCompare(a.date));

  // Prefer graded inspections (EQI, FCI) over compliance-only (ROU, ADD, INT).
  // EQI/FCI reports have quality judgments (Excellent/Good/Sound/Unsatisfactory).
  // ROU reports are compliance-only (meets/does not meet standards).
  const GRADED_TYPES = ['EQI', 'FCI'];
  const COMPLIANCE_TYPES = ['ROU'];
  const gradedReports = reports.filter(r => GRADED_TYPES.includes(r.type));
  const complianceReports = reports.filter(r => COMPLIANCE_TYPES.includes(r.type));
  const mainReports = gradedReports.length ? gradedReports
    : complianceReports.length ? complianceReports
    : reports;
  const best = (mainReports.length ? mainReports : reports)[0];

  glog('isi_report_url_found', {
    slug: isiSlug,
    url: best.url,
    type: best.type,
    date: best.date,
    totalReports: reports.length,
  });
  return best.url;
}

// ─── ISI PDF parsing ──────────────────────────────────────────────────────────
//
// ISI reports use the "Educational Quality Inspection" (EQI) or "Focused
// Compliance and Educational Quality" (FCI) framework.  Structure:
//
//   3. Educational Quality Inspection
//     Preface  — explains ISI descriptors (Excellent/Good/Sound/Unsatisfactory)
//     Key findings (3.1–3.2):
//       "The quality of the pupils' academic and other achievements is [judgment]."
//       "The quality of the pupils' personal development is [judgment]."
//     Recommendations (3.3)  — what the school should improve
//     Detailed narrative:
//       "The quality of the pupils' academic and other achievements" (3.4+)
//       "The quality of the pupils' personal development" (later)
//
// Grades: Excellent, Good, Sound, Unsatisfactory

const ISI_GRADES = ['Excellent', 'Good', 'Sound', 'Unsatisfactory'];
const ISI_GRADE_RE = /(Excellent|Good|Sound|Unsatisfactory)/i;

/**
 * Finds the start of the EQI/FCI section (the SECOND occurrence of the
 * Educational Quality Inspection heading — the first is always the TOC).
 */
function findEQISectionStart(text) {
  // First occurrence is the TOC entry; second is the real section
  let idx = text.search(/Educational Quality Inspection\s*\d*\s*\n\s*©/);
  if (idx >= 0) {
    // This is a page header — find "3.Educational Quality Inspection" after it
    const after = text.indexOf('3.Educational Quality Inspection', idx);
    if (after >= 0) return after;
    // Or the FCI variant
    const after2 = text.indexOf('3.Focused Compliance', idx);
    if (after2 >= 0) return after2;
  }
  // Fallback: find the second "Educational Quality Inspection" that contains "Preface" after it
  const first = text.indexOf('Educational Quality Inspection');
  if (first >= 0) {
    const second = text.indexOf('Educational Quality Inspection', first + 100);
    if (second >= 0) return second;
  }
  return null;
}

/**
 * Extracts the ISI judgment for a specific dimension.
 * Pattern: "The quality of the pupils' [dimension] is [judgment]."
 */
function extractISIJudgment(text, dimension) {
  const re = new RegExp(
    `quality of the pupils['’\\s]+${dimension}[^.]*?\\b(${ISI_GRADES.join('|')})\\b`,
    'i'
  );
  const m = text.match(re);
  if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return null;
}

/**
 * Extracts a numbered section body from the ISI report.
 * Sections start with a numbered heading (e.g. "3.4The quality...") and run
 * until the next numbered heading or section boundary.
 */
function extractISINumberedSection(text, startPattern, maxChars = 6000) {
  // Find the section heading
  const headingRe = new RegExp(
    `(?:\\d+\\.)?\\d+\\s*${startPattern}[^\\n]*\\n`,
    'i'
  );
  const m = text.match(headingRe);
  if (!m) return null;

  const startIdx = m.index + m[0].length;

  // Extract text until the next numbered section or major boundary
  const endRe = /\n\s*(?:\d+\.\d+\s|[A-Z][a-z]+\s+\d+\n|4\.Inspection Evidence|Inspectors\b|©|Educational Quality Inspection)/;
  const remaining = text.slice(startIdx);
  const endMatch = remaining.match(endRe);

  let content;
  if (endMatch) {
    content = remaining.slice(0, endMatch.index).trim();
  } else {
    content = remaining.slice(0, maxChars).trim();
  }

  if (!content) return null;

  return content.length > maxChars
    ? content.slice(0, maxChars).replace(/\s+\S*$/, '') + ' …_(truncated)_'
    : content;
}

/**
 * Extracts the Key Findings paragraph (3.1–3.2) from the EQI section.
 */
function extractISIKeyFindings(text) {
  // Key findings start at "Key findings\n3.1" in the EQI section
  const kfStart = text.search(/Key findings\s*\n\s*3\.1/);
  if (kfStart < 0) return null;

  // End at Recommendation(s) or the next major section
  const kfEnd = text.indexOf('Recommendation', kfStart);
  const raw = kfEnd < 0 ? text.slice(kfStart, kfStart + 1500) : text.slice(kfStart, kfEnd);

  return raw
    .replace(/^Key findings\s*\n?/im, '')   // Strip "Key findings" heading
    .replace(/\b\d+\.\d+\s*/g, '')          // Strip paragraph numbers like "3.1"
    .replace(/[-]/g, '')                 // Strip PDF Private Use Area bullet glyphs
    .replace(/\n{3,}/g, '\n\n')             // Collapse multiple blank lines
    .replace(/[ \t]+$/gm, '')               // Trim trailing whitespace per line
    .replace(/([^\n])\n([^\n])/g, '$1 $2')  // Rejoin broken lines within paragraphs
    .replace(/[ \t]{2,}/g, ' ')             // Collapse multiple spaces
    .trim();
}

/**
 * Extracts the Recommendations section (3.3) from the EQI section.
 */
function extractISIRecommendations(text) {
  const recStart = text.search(/Recommendations?\s*\n\s*3\.\d/);
  if (recStart < 0) return null;

  // End at "The quality of the pupils'" (first detailed section)
  const recEnd = text.indexOf('The quality of the pupils', recStart + 20);
  const raw = recEnd < 0 ? text.slice(recStart, recStart + 2000) : text.slice(recStart, recEnd);

  return raw
    .replace(/^Recommendation\s*\n?/im, '')  // Strip "Recommendation" heading
    .replace(/\b\d+\.\d+\s*/g, '')            // Strip paragraph numbers like "3.3"
    .replace(/[-]/g, '')                   // Strip PDF Private Use Area bullet glyphs
    .replace(/\n{3,}/g, '\n\n')               // Collapse multiple blank lines
    .replace(/[ \t]+$/gm, '')                 // Trim trailing whitespace per line
    .replace(/([^\n])\n([^\n])/g, '$1 $2')    // Rejoin broken lines within paragraphs
    .replace(/[ \t ]{2,}/g, ' ')         // Collapse multiple spaces (incl. non-breaking)
    .trim();
}

/**
 * Downloads and parses an ISI inspection report PDF.
 *
 * Returns an object with the same shape as getOfstedData() +
 * fetchAndParseOfstedPdf() combined, so formatters work unchanged:
 *   { overall, date, reportUrl, safeguarding, pupilExperience,
 *     qualityOfEducation, behaviour, personalDevelopment, leadership,
 *     achievement, nextSteps, recommendations }
 */
/**
 * Parses a Regulatory Compliance (ROU) report.
 * These are compliance-only — no quality judgments.  Structure:
 *   SUMMARY OF INSPECTION FINDINGS  →  brief overview
 *   THE EXTENT TO WHICH THE SCHOOL MEETS THE STANDARDS  →  compliance summary
 *   RECOMMENDED NEXT STEPS  →  actionable improvements
 *   SECTIONS 1-4  →  detailed compliance findings by area
 */
function parseROUReport(text) {
  // Summary findings
  const summaryMatch = text.match(
    /SUMMARY OF INSPECTION FINDINGS\s*\n+([\s\S]*?)(?:\n\s*THE EXTENT TO WHICH|$)/i
  );
  const summary = summaryMatch ? summaryMatch[1].trim().slice(0, 2000) : null;

  // Compliance verdict
  const standardsMatch = text.match(
    /THE EXTENT TO WHICH THE SCHOOL MEETS THE STANDARDS\s*\n+([\s\S]*?)(?:\n\s*RECOMMENDED|$)/i
  );
  const complianceSummary = standardsMatch ? standardsMatch[1].trim().slice(0, 1500) : null;

  // Recommended next steps
  const recMatch = text.match(
    /RECOMMENDED NEXT STEPS\s*\n+([\s\S]*?)(?:\n\s*SECTION \d|$)/i
  );
  const nextSteps = recMatch ? recMatch[1].trim().slice(0, 2000) : null;

  // Extract detailed findings from sections 1-4
  const sections = [];
  for (const secNum of [1, 2, 3, 4]) {
    const secMatch = text.match(new RegExp(
      `SECTION ${secNum}:\\s*([^\\n]+)\\n([\\s\\S]*?)(?:\\n\\s*SECTION ${secNum + 1}|\\n\\s*${secNum + 1}\\.|$)`, 'i'
    ));
    if (secMatch) {
      sections.push({ heading: secMatch[1].trim(), body: secMatch[2].trim().slice(0, 3000) });
    }
  }

  return {
    isComplianceOnly: true,
    summary,
    complianceSummary,
    nextSteps,
    sections,
  };
}

export async function fetchAndParseISIPdf(reportUrl) {
  const t0 = Date.now();

  const buf = await safeFetchBuffer(reportUrl, 25000);
  if (!buf) { glog('isi_pdf_fetch_fail', { reportUrl }); return null; }

  let data;
  try {
    data = await pdfParse(buf);
  } catch (err) {
    glog('isi_pdf_parse_fail', { reportUrl, err: String(err.message ?? err).slice(0, 120) });
    return null;
  }

  const text = data.text;
  if (!text?.trim()) { glog('isi_pdf_empty', { reportUrl }); return null; }

  // Detect report type: ROU (compliance-only) vs EQI/FCI (graded)
  const isComplianceOnly = /SUMMARY OF INSPECTION FINDINGS/.test(text)
    && !/Educational Quality Inspection/.test(text);

  if (isComplianceOnly) {
    const rou = parseROUReport(text);
    const dateMatch = text.match(
      /\n((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\s*\n/
    ) || text.match(/(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/);

    glog('isi_pdf_parsed_rou', {
      reportUrl: reportUrl.slice(0, 80),
      ms: Date.now() - t0,
      textLen: text.length,
      date: dateMatch?.[0] ?? null,
    });

    return {
      overall: null,  // ROU reports have no grades
      date: dateMatch ? dateMatch[0].trim() : null,
      reportUrl,
      framework: 'ISI Regulatory Compliance Inspection',
      safeguarding: rou.complianceSummary,
      pupilExperience: rou.sections?.find(s => /PHYSICAL.*MENTAL.*HEALTH|WELLBEING/i.test(s.heading))?.body ?? null,
      qualityOfEducation: rou.sections?.find(s => /EDUCATION/i.test(s.heading))?.body ?? null,
      behaviour: null,
      personalDevelopment: rou.sections?.find(s => /SOCIAL|ECONOMIC|CONTRIBUTION/i.test(s.heading))?.body ?? null,
      leadership: rou.sections?.find(s => /LEADERSHIP|MANAGEMENT|GOVERNANCE/i.test(s.heading))?.body ?? null,
      achievement: null,
      nextSteps: rou.nextSteps,
      isIndependent: true,
      isComplianceOnly: true,
      keyFindings: rou.summary,
      recommendations: rou.nextSteps,
      academicJudgment: null,
      personalJudgment: null,
      rouSections: rou.sections,
    };
  }

  // ── EQI/FCI (graded) report parsing ──────────────────────────────────────

  // ── Find the EQI section (skip TOC, use real content) ──────────────────────
  const eqiStart = findEQISectionStart(text);
  const eqiText = eqiStart ? text.slice(eqiStart) : text;

  // ── Extract inspection date ─────────────────────────────────────────────────
  // ISI reports show the date in the title page: "Abbey College Manchester\nMarch 2023"
  const dateMatch = text.match(
    /Inspection dates?\s*(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i
  ) || text.match(
    /\n((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\s*\n/
  );
  const date = dateMatch ? dateMatch[0].trim() : null;

  // ── Judgments (from the Key findings section 3.1–3.2) ───────────────────────
  const academicJudgment = extractISIJudgment(eqiText, 'academic\\s+and\\s+other\\s+achievements');
  const personalJudgment = extractISIJudgment(eqiText, 'personal\\s+development');
  const overall = academicJudgment;

  // ── Key findings paragraph ──────────────────────────────────────────────────
  const keyFindings = extractISIKeyFindings(eqiText);

  // ── Recommendations (3.3) ───────────────────────────────────────────────────
  const recommendations = extractISIRecommendations(eqiText);

  // ── Detailed narrative sections (3.4+) ──────────────────────────────────────
  const achievement = extractISINumberedSection(
    eqiText,
    "The quality of the pupils['’]?\\s*academic\\s+and\\s+other\\s+achievements"
  );
  const personalDevelopment = extractISINumberedSection(
    eqiText,
    "The quality of the pupils['’]?\\s*personal\\s+development"
  );

  // ── Safeguarding / compliance ───────────────────────────────────────────────
  const safeguardingMatch = text.match(
    /PART\s*3\s*[–-]\s*Welfare,\s*health\s+and\s+safety[^.]*?(meet|do not meet)/i
  );
  const safeguarding = safeguardingMatch
    ? `Compliance: welfare standards ${safeguardingMatch[1]}` : null;

  glog('isi_pdf_parsed', {
    reportUrl: reportUrl.slice(0, 80),
    ms: Date.now() - t0,
    textLen: text.length,
    overall,
    personalJudgment,
    hasAchievement: !!achievement,
    hasPersonalDev: !!personalDevelopment,
    hasRecommendations: !!recommendations,
  });

  return {
    // Standard Ofsted-shaped fields (for fmtOfstedSlim / renderPartA compat)
    overall:  overall ? `ISI: ${overall}` : null,
    date,
    reportUrl,
    framework: 'ISI Educational Quality Inspection',
    safeguarding,

    // Narrative sections (same keys as fetchAndParseOfstedPdf output)
    pupilExperience:         personalDevelopment,
    qualityOfEducation:      achievement,
    behaviour:               null,  // ISI doesn't split these out
    personalDevelopment:     personalDevelopment,
    leadership:              null,
    achievement,
    nextSteps:               recommendations,

    // ISI-specific fields
    isIndependent:           true,
    keyFindings,
    recommendations,
    academicJudgment,
    personalJudgment,
  };
}

// ─── Fees ─────────────────────────────────────────────────────────────────────

/**
 * Attempts to find current fee information for an independent school.
 *
 * Strategy:
 *   1. Try the school website (from GIAS) — search for fee page
 *   2. Try ISC website — school profile pages often include fee ranges
 *   3. Return null if nothing found — AI handles via web search
 *
 * Returns { day, boarding, perTerm, perAnnum, bursaries, source } or null.
 */
export async function getIndependentFees(schoolName, websiteUrl) {
  // Strategy 1: If we have the school website, try to find a fees page
  if (websiteUrl) {
    try {
      const base = websiteUrl.replace(/\/$/, '');
      const feePaths = ['/fees', '/admissions/fees', '/school-fees', '/tuition-fees'];
      for (const path of feePaths) {
        const res = await safeFetch(`${base}${path}`, 6000);
        if (!res) continue;
        const html = await res.text();

        // Look for currency amounts (£) — typical fee pages have multiple
        const amounts = [...html.matchAll(/£([\d,]+(?:\.\d{2})?)/g)];
        if (amounts.length >= 2) {
          // Found a page with multiple £ amounts — likely a fee schedule
          const perTerm = [];
          for (const m of amounts) {
            const val = parseInt(m[1].replace(/[,]/g, ''), 10);
            if (val > 100) perTerm.push(val);
          }
          if (perTerm.length >= 2) {
            const result = {
              day:       { min: Math.min(...perTerm), max: Math.max(...perTerm), period: 'per term' },
              source:    `${base}${path}`,
            };
            glog('fees_found_website', { schoolName, source: result.source });
            return result;
          }
        }
      }
    } catch { /* continue */ }
  }

  // Strategy 2: ISC website
  // ISC school pages follow the pattern isc.co.uk/schools/{slug}/
  // But the site is JS-rendered — skip for now.

  return null;
}

// ─── Full inspection fetch (convenience — same shape as getOfstedData result) ──

/**
 * Fetches ISI inspection data for a school.
 * Combines institution lookup + report URL discovery + PDF parsing.
 *
 * Returns the same shape as getOfstedData() from govuk.js so the
 * slim-block formatter and Part A renderer work unchanged.
 */
export async function getISIInspection(urn, schoolName, postcode) {
  // Step 1: Find the ISI institution
  const inst = await findISIInstitution(schoolName);
  if (!inst) { glog('isi_inspection_no_institution', { urn, schoolName }); return null; }

  // Step 2: Get the latest report URL using the slug
  const reportUrl = await getISIReportUrl(inst.slug);
  if (!reportUrl) { glog('isi_inspection_no_report_url', { urn, isiId: inst.id, slug: inst.slug }); return null; }

  // Step 3: Download and parse the PDF
  const parsed = await fetchAndParseISIPdf(reportUrl);
  if (!parsed) { glog('isi_inspection_parse_failed', { urn, reportUrl }); return null; }

  return parsed;
}
