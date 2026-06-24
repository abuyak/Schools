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

// ── GIAS school index ────────────────────────────────────────────────────────

let _giasIndex = null;
let _giasList = null; // pre-computed array for proximity search

function loadGiasIndex() {
  if (_giasIndex) return _giasIndex;
  const path = join(__dirname, 'sources', 'gias-schools-by-urn.json');
  _giasIndex = JSON.parse(readFileSync(path, 'utf8'));
  // Pre-compute a flat list for proximity search
  _giasList = [];
  for (const [urn, entry] of Object.entries(_giasIndex)) {
    if (urn === '_meta') continue;
    if (entry.lat != null && entry.lon != null) {
      _giasList.push({ urn, ...entry });
    }
  }
  return _giasIndex;
}

/**
 * Haversine distance in miles between two lat/lon points.
 */
function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Returns schools within `radiusMiles` of (lat, lon), sorted by distance.
 * Returns up to `limit` results (default 50).
 */
export function findSchoolsNear(lat, lon, radiusMiles = 3, limit = 50) {
  const index = loadGiasIndex();
  if (!_giasList) return [];

  const results = [];
  for (const school of _giasList) {
    const dist = haversineMiles(lat, lon, school.lat, school.lon);
    if (dist <= radiusMiles) {
      results.push({ ...school, distanceMiles: Number(dist.toFixed(2)) });
    }
  }

  results.sort((a, b) => a.distanceMiles - b.distanceMiles);
  return results.slice(0, limit);
}

/**
 * Fast lookup of a school by URN from the bundled GIAS index.
 * Returns null if not found.
 */
export function getGiasSchool(urn) {
  if (!urn) return null;
  const index = loadGiasIndex();
  const entry = index[String(urn)];
  if (!entry) return null;
  return { urn: String(urn), ...entry };
}

/**
 * Returns metadata about the bundled GIAS index (build date, count).
 */
export function getGiasMeta() {
  const index = loadGiasIndex();
  return index._meta ?? null;
}
