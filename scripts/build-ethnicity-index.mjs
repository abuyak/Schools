/**
 * build-ethnicity-index.mjs
 *
 * Downloads the DfE "Schools, pupils and their characteristics" CSV and
 * builds a compact JSON index of pupil ethnicity by school URN.
 *
 * Output: functions/research/sources/dfe-school-ethnicity.json
 *
 * Run manually when a new DfE release is published (typically each June
 * for the preceding January census):
 *
 *   node scripts/build-ethnicity-index.mjs
 *
 * ── Updating the source URL ──────────────────────────────────────────────────
 *
 * The DfE publishes a new release of "Schools, pupils and their characteristics"
 * each year (~June). To update:
 *
 * 1. Go to: https://explore-education-statistics.service.gov.uk/find-statistics/school-pupils-and-their-characteristics
 * 2. Click "Download all data (ZIP)" or find the school-level CSV file.
 * 3. Update SOURCE_URL and ACADEMIC_YEAR below.
 * 4. Run this script: node scripts/build-ethnicity-index.mjs
 * 5. Commit the updated JSON: git add functions/research/sources/dfe-school-ethnicity.json
 *
 * The Release ID embedded in the URL changes each year. The file ID may also change.
 * Check the data-guidance page for the latest URLs if the download fails.
 *
 * ── Source ───────────────────────────────────────────────────────────────────
 * Dataset: Schools, pupils and their characteristics (school level underlying data)
 * Publisher: Department for Education
 * URL: https://explore-education-statistics.service.gov.uk/find-statistics/school-pupils-and-their-characteristics
 * Licence: Open Government Licence v3.0
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

// ── UPDATE THESE EACH YEAR ────────────────────────────────────────────────────
const SOURCE_URL    = 'https://content.explore-education-statistics.service.gov.uk/api/releases/63491b17-2037-4533-b719-d3656aaf6ed5/files/3dc88c32-da52-4aff-b6d0-0126de016844';
const ACADEMIC_YEAR = '2024/25';
// ─────────────────────────────────────────────────────────────────────────────

const OUTPUT_PATH = join(ROOT, 'functions', 'research', 'sources', 'dfe-school-ethnicity.json');

// Ethnicity columns → high-level group mapping
// Uses "number of pupils classified as X" columns from the DfE CSV
const ETHNIC_GROUPS = {
  white: [
    'number of pupils classified as white British ethnic origin',
    'number of pupils classified as Irish ethnic origin',
    'number of pupils classified as traveller of Irish heritage ethnic origin',
    'number of pupils classified as Gypsy/Roma ethnic origin',
    'number of pupils classified as any other white background ethnic origin',
  ],
  mixed: [
    'number of pupils classified as white and black Caribbean ethnic origin',
    'number of pupils classified as white and black African ethnic origin',
    'number of pupils classified as white and Asian ethnic origin',
    'number of pupils classified as any other mixed background ethnic origin',
  ],
  asian: [
    'number of pupils classified as Indian ethnic origin',
    'number of pupils classified as Pakistani ethnic origin',
    'number of pupils classified as Bangladeshi ethnic origin',
    'number of pupils classified as any other Asian background ethnic origin',
  ],
  black: [
    'number of pupils classified as Caribbean ethnic origin',
    'number of pupils classified as African ethnic origin',
    'number of pupils classified as any other black background ethnic origin',
  ],
  chinese: [
    'number of pupils classified as Chinese ethnic origin',
  ],
  other: [
    'number of pupils classified as any other ethnic group ethnic origin',
  ],
  notStated: [
    'number of pupils unclassified',
  ],
};

/**
 * RFC 4180-compliant CSV row parser.
 * Handles quoted fields that contain commas (e.g. "Redriff Primary, City of London Academy").
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

function parseNum(val) {
  if (!val || val === 'z' || val === 'x' || val === 'c' || val === ':') return 0;
  const n = parseFloat(val.replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function pct(count, total) {
  if (!total) return 0;
  return Math.round(count / total * 100);
}

console.log('Downloading DfE school characteristics CSV...');
const t0 = Date.now();
const res = await fetch(SOURCE_URL, {
  headers: { 'User-Agent': 'SchoolScanner/1.0 (data pipeline; contact: schools.statistics@education.gov.uk)' },
  signal: AbortSignal.timeout(120000),
});
if (!res.ok) throw new Error(`HTTP ${res.status} from source URL`);
const csv = await res.text();
console.log(`Downloaded ${(csv.length / 1024 / 1024).toFixed(1)} MB in ${Date.now() - t0}ms`);

const lines = csv.split('\n').filter(Boolean);
const headers = parseCSVRow(lines[0]);
console.log(`Rows: ${lines.length - 1} | Columns: ${headers.length}`);

const urnIdx   = headers.indexOf('urn');
const totalIdx = headers.indexOf('headcount of pupils');
if (urnIdx === -1 || totalIdx === -1) throw new Error('Could not find urn or headcount column');

// Pre-resolve column indices for each ethnicity sub-group
const groupIndices = {};
for (const [group, cols] of Object.entries(ETHNIC_GROUPS)) {
  groupIndices[group] = cols.map(col => {
    const idx = headers.indexOf(col);
    if (idx === -1) console.warn(`  ⚠ Column not found: "${col}"`);
    return idx;
  }).filter(i => i !== -1);
}

const index = {};
let skipped = 0;

for (let i = 1; i < lines.length; i++) {
  const cells = parseCSVRow(lines[i]);
  const urn   = cells[urnIdx]?.trim();
  if (!urn || !/^\d{6}$/.test(urn)) { skipped++; continue; }

  const total = parseNum(cells[totalIdx]);
  if (!total) { skipped++; continue; }

  const counts = {};
  for (const [group, idxs] of Object.entries(groupIndices)) {
    counts[group] = idxs.reduce((sum, idx) => sum + parseNum(cells[idx]), 0);
  }

  index[urn] = {
    w:  pct(counts.white,     total),  // White
    m:  pct(counts.mixed,     total),  // Mixed
    a:  pct(counts.asian,     total),  // Asian
    b:  pct(counts.black,     total),  // Black
    c:  pct(counts.chinese,   total),  // Chinese
    o:  pct(counts.other,     total),  // Other
    ns: pct(counts.notStated, total),  // Not stated
    yr: ACADEMIC_YEAR,
  };
}

console.log(`Indexed ${Object.keys(index).length} schools (skipped ${skipped} rows)`);

// Write output
mkdirSync(join(ROOT, 'functions', 'research', 'sources'), { recursive: true });
const json = JSON.stringify({ _meta: { source: SOURCE_URL, academicYear: ACADEMIC_YEAR, built: new Date().toISOString(), schools: Object.keys(index).length }, ...index });
writeFileSync(OUTPUT_PATH, json, 'utf8');
const kb = (json.length / 1024).toFixed(0);
console.log(`\n✓ Written to ${OUTPUT_PATH} (${kb} KB)`);
console.log(`  Academic year: ${ACADEMIC_YEAR}`);
console.log(`  Schools indexed: ${Object.keys(index).length}`);
