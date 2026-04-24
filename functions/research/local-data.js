/**
 * local-data.js
 *
 * Bundled DfE data lookups — fast, zero-latency, no HTTP calls.
 *
 * Each dataset is a pre-processed JSON file built from an annual DfE publication
 * and committed to the repo. The build scripts live in /scripts/ and should be
 * re-run each year when DfE publishes new data.
 *
 * ── Datasets ─────────────────────────────────────────────────────────────────
 *
 * dfe-school-ethnicity.json
 *   Source : DfE "Schools, pupils and their characteristics" (annual, ~June)
 *   Build  : node scripts/build-ethnicity-index.mjs
 *   Columns: w (White%), m (Mixed%), a (Asian%), b (Black%), c (Chinese%),
 *            o (Other%), ns (Not stated%), yr (academic year)
 *   Update : Run build script after each DfE release; commit updated JSON.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Ethnicity index ───────────────────────────────────────────────────────────

let _ethnicityIndex = null;

function loadEthnicityIndex() {
  if (_ethnicityIndex) return _ethnicityIndex;
  const path = join(__dirname, 'sources', 'dfe-school-ethnicity.json');
  _ethnicityIndex = JSON.parse(readFileSync(path, 'utf8'));
  return _ethnicityIndex;
}

/**
 * Returns DfE pupil ethnicity percentages for a school by URN.
 *
 * Returns an object with:
 *   w  — White %
 *   m  — Mixed %
 *   a  — Asian %
 *   b  — Black %
 *   c  — Chinese %
 *   o  — Other %
 *   ns — Not stated %
 *   yr — academic year (e.g. "2024/25")
 *
 * Returns null if the URN is not in the index.
 */
export function getSchoolEthnicity(urn) {
  if (!urn) return null;
  const index = loadEthnicityIndex();
  return index[String(urn)] ?? null;
}

/**
 * Returns the academic year of the currently bundled ethnicity data.
 */
export function getEthnicityDataYear() {
  const index = loadEthnicityIndex();
  return index._meta?.academicYear ?? null;
}
