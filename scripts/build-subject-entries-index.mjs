/**
 * build-subject-entries-index.mjs
 *
 * Reads the EES KS4 subject school CSV (human-readable names) and produces a
 * JSON lookup keyed by URN:
 *   { [urn]: [{ subject, qualification, entries, grade7Plus?, grade7PlusPct? }] }
 *
 * The CSV is downloaded manually from explore-education-statistics.service.gov.uk:
 *   Key stage 4 performance → Data sets → Subject school all exam entries/grades
 *
 * Output: functions/research/sources/subject-entries-by-urn.json
 *
 * Run: node scripts/build-subject-entries-index.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

const CSV_PATH = join(ROOT, 'docs', 'EES', 'KS4', 'data',
  '202425_subject_school_all_exam_entriesgrades_final.csv');

const OUTPUT_PATH = join(ROOT, 'functions', 'research', 'sources',
  'subject-entries-by-urn.json');

// ── Subject name cleanup ──────────────────────────────────────────────────────

// Prefer the plain subject name.  Only use subject_discount_group when subject
// is a catch-all like "Other Modern Languages" or needs disambiguation (Music).
const GENERIC_SUBJECTS = new Set([
  'Other Modern Languages',
]);

// Map ugly discount-group names back to clean names
const NAME_CLEANUP = {
  'Maths (General)':           'Mathematics',
  'Chemistry (General)':       'Chemistry',
  'Physics (General)':         'Physics',
  'French Language':           'French',
  'D & T':                     'Design & Technology',
  'Speech & Drama':            'Drama',
  'Sports Studies':            'Physical Education',
  'Music Studies (General)':   'Music',
  'Music Performance: Group':  'Music Performance: Group',
  'Additional Maths (FSMQ)':   'Additional Mathematics',
  'Greek (Classic)':           'Classical Greek',
  'German Language':           'German',
  'Spanish Language':          'Spanish',
  'Italian Language':          'Italian',
};

function cleanName(subject, discountGroup) {
  if (GENERIC_SUBJECTS.has(subject)) {
    return NAME_CLEANUP[discountGroup] || discountGroup || subject;
  }
  // Music has two discount groups — use the specific one
  if (subject === 'Music' && discountGroup && discountGroup !== subject) {
    return NAME_CLEANUP[discountGroup] || discountGroup;
  }
  return NAME_CLEANUP[subject] || subject;
}

// ── Parse CSV ────────────────────────────────────────────────────────────────

console.log('Reading CSV...');
const csv = readFileSync(CSV_PATH, 'utf8');
const lines = csv.split(/\r?\n/);
const header = lines[0].split(',');

const col = (name) => header.indexOf(name);

const URN_IDX      = col('school_urn');
const SUBJECT_IDX  = col('subject');
const DISCOUNT_IDX = col('discount_code');
const DISCOUNT_GRP = col('subject_discount_group');
const QUAL_IDX     = col('qualification_detailed');
const GRADE_IDX    = col('grade');
const COUNT_IDX    = col('number_achieving');

if ([URN_IDX, SUBJECT_IDX, QUAL_IDX, GRADE_IDX, COUNT_IDX].some(i => i < 0)) {
  console.error('Missing expected columns in CSV');
  console.error('Header:', header.join(', '));
  process.exit(1);
}

// Key includes discount_code to split generic labels like "Other Modern Languages"
// and "Music" into individual subjects.
const keyFor = (urn, sub, discount) => `${urn}|${sub}|${discount}`;
const byUrnRaw = new Map();

for (let i = 1; i < lines.length; i++) {
  const cols = lines[i].split(',');
  const grade   = cols[GRADE_IDX];
  const isTotal = grade === 'Total exam entries';

  const urn      = cols[URN_IDX];
  const subject  = cols[SUBJECT_IDX];
  const discount = cols[DISCOUNT_IDX] || '';
  const qual     = cols[QUAL_IDX] || 'GCSE';
  const count    = parseInt(cols[COUNT_IDX], 10);
  if (!count || !urn) continue;

  const key = keyFor(urn, subject, discount);
  if (!byUrnRaw.has(key)) {
    byUrnRaw.set(key, {
      urn, subject, qualification: qual, grades: new Map(), totalEntries: 0,
      displaySubject: cleanName(subject, cols[DISCOUNT_GRP]),
    });
  }
  const entry = byUrnRaw.get(key);

  if (isTotal) {
    entry.totalEntries = count;
  } else {
    entry.grades.set(grade, (entry.grades.get(grade) || 0) + count);
  }
}

// ── Aggregate ─────────────────────────────────────────────────────────────────

const byUrn = new Map();

for (const entry of byUrnRaw.values()) {
  const { urn, qualification, grades, totalEntries, displaySubject } = entry;

  // Total from the Total row; fall back to summing per-grade rows
  const total = totalEntries || [...grades.values()].reduce((s, c) => s + c, 0);
  if (!total) continue;

  // GCSE (9-1): grades 7, 8, 9
  // Vocational: Level 2 distinction / distinction star
  let top = 0;
  for (const [grade, count] of grades) {
    if (grade === '7' || grade === '8' || grade === '9') {
      top += count;
    } else if (grade.startsWith('Level 2 distinction')) {
      top += count;
    }
  }

  const result = { subject: displaySubject, qualification, entries: total };
  if (grades.size > 0 && top > 0) {
    result.grade7Plus = top;
    result.grade7PlusPct = Math.round(top / total * 100);
  }

  if (!byUrn.has(urn)) byUrn.set(urn, []);
  byUrn.get(urn).push(result);
}

// Sort each school's subjects by entries descending
for (const entries of byUrn.values()) {
  entries.sort((a, b) => b.entries - a.entries);
}

// ── Write output ──────────────────────────────────────────────────────────────

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

const output = Object.fromEntries(byUrn);
writeFileSync(OUTPUT_PATH, JSON.stringify(output));

const schoolCount = Object.keys(output).length;
const totalEntries = Object.values(output).reduce((s, e) => s + e.length, 0);
console.log(`Wrote ${OUTPUT_PATH}`);
console.log(`${schoolCount} schools, ${totalEntries} subject entries`);
console.log('Done.');
