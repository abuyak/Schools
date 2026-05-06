/**
 * build-ks5-subject-entries-index.mjs
 *
 * Reads the EES KS5 institution subject results CSV and produces a JSON lookup
 * keyed by URN:
 *   { [urn]: [{ subject, qualification, entries, aToBPct? }] }
 *
 * The CSV is downloaded manually from explore-education-statistics.service.gov.uk:
 *   A level and other 16 to 18 results → Institution subject and qualification results
 *
 * Output: functions/research/sources/ks5-subject-entries-by-urn.json
 *
 * Run: node scripts/build-ks5-subject-entries-index.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

const CSV_PATH = join(ROOT, 'docs', 'EES', 'KS5', 'data',
  'institution_subject_and_qualification_results_202425_API.csv');

const OUTPUT_PATH = join(ROOT, 'functions', 'research', 'sources',
  'ks5-subject-entries-by-urn.json');

// ── CSV helpers ───────────────────────────────────────────────────────────────

function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = [];
    let inQ = false, col = '';
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cols.push(col.trim()); col = ''; continue; }
      col += ch;
    }
    cols.push(col.trim());
    rows.push(cols);
  }
  return rows;
}

// ── Parse ─────────────────────────────────────────────────────────────────────

console.log('Reading CSV...');
const csv = readFileSync(CSV_PATH, 'utf8');
const rows = parseCSV(csv);
const header = rows[0];

const URN_IDX   = header.indexOf('school_urn');
const COHORT    = header.indexOf('exam_cohort');
const QUAL_IDX  = header.indexOf('qualification_detailed');
const SUBJ_IDX  = header.indexOf('subject');
const GRADE_IDX = header.indexOf('grade');
const COUNT_IDX = header.indexOf('entries_count');

if ([URN_IDX, QUAL_IDX, SUBJ_IDX, GRADE_IDX, COUNT_IDX].some(i => i < 0)) {
  console.error('Missing expected columns');
  console.error('Header:', header.join(', '));
  process.exit(1);
}

// Key: URN|subject|qualification|cohort to differentiate A-level vs BTEC etc.
const keyFor = (urn, subject, qual, cohort) =>
  `${urn}|${subject}|${qual}|${cohort}`;

const byUrnRaw = new Map();

for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const grade   = r[GRADE_IDX];
  const isTotal = grade === 'Total exam entries';

  const urn     = r[URN_IDX];
  const subject = r[SUBJ_IDX];
  const qual    = r[QUAL_IDX];
  const cohort  = r[COHORT];
  const count   = parseInt(r[COUNT_IDX], 10);

  if (!count || !urn || subject === 'All subjects') continue;

  const key = keyFor(urn, subject, qual, cohort);
  if (!byUrnRaw.has(key)) {
    byUrnRaw.set(key, { urn, subject, qualification: qual, cohort, grades: new Map(), totalEntries: 0 });
  }
  const entry = byUrnRaw.get(key);

  if (isTotal) {
    entry.totalEntries = count;
  } else if (grade !== 'Suppressed' && grade !== 'No result / X' && grade !== 'Fail') {
    entry.grades.set(grade, (entry.grades.get(grade) || 0) + count);
  }
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

// A-level: grades A*, A, B = A–B (top grades)
// BTEC/vocational double: Distinction*-Distinction*, Distinction*-Distinction, Distinction-Distinction
// BTEC/vocational single: Distinction*, Distinction
function isAToBGrade(grade) {
  if (grade === 'A*' || grade === 'A' || grade === 'B') return true;
  if (grade === 'Distinction*' || grade === 'Distinction') return true;
  if (grade === 'Distinction*-Distinction*' || grade === 'Distinction*-Distinction' ||
      grade === 'Distinction-Distinction') return true;
  return false;
}

const byUrn = new Map();

for (const entry of byUrnRaw.values()) {
  const { urn, subject, qualification, cohort, grades, totalEntries } = entry;

  // Total from Total row; fall back to summing per-grade rows
  const total = totalEntries || [...grades.values()].reduce((s, c) => s + c, 0);
  if (!total) continue;

  let aToB = 0;
  for (const [grade, count] of grades) {
    if (isAToBGrade(grade)) aToB += count;
  }

  const result = { subject, qualification, entries: total };
  if (grades.size > 0 && aToB > 0) {
    result.aToB = aToB;
    result.aToBPct = Math.round(aToB / total * 100);
  }

  if (!byUrn.has(urn)) byUrn.set(urn, []);
  byUrn.get(urn).push(result);
}

// Sort each school's subjects by entries descending
for (const entries of byUrn.values()) {
  entries.sort((a, b) => b.entries - a.entries);
}

// ── Write ─────────────────────────────────────────────────────────────────────

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
const output = Object.fromEntries(byUrn);
writeFileSync(OUTPUT_PATH, JSON.stringify(output));

const schoolCount = Object.keys(output).length;
const totalEntries = Object.values(output).reduce((s, e) => s + e.length, 0);
console.log(`Wrote ${OUTPUT_PATH}`);
console.log(`${schoolCount} schools, ${totalEntries} subject entries`);
console.log('Done.');
