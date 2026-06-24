#!/usr/bin/env node
/**
 * build-gias-index.mjs
 *
 * Downloads the GIAS (Get Information About Schools) full register CSV,
 * filters to open schools, converts OSGB36 easting/northing to WGS84 lat/lon,
 * and writes a compact JSON index bundled with the Lambda.
 *
 * Run:  node scripts/build-gias-index.mjs
 *        → writes functions/research/sources/gias-schools-by-urn.json
 *
 * Update: annually (~June), or when schools open/close frequently.
 * The download URL embeds a date stamp — update the date below or fetch
 * the latest from the API.
 */

import { createWriteStream, readFileSync, writeFileSync, existsSync } from 'fs';
import { get } from 'https';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Configuration ─────────────────────────────────────────────────────────

const DOWNLOAD_URL = 'https://ea-edubase-api-prod.azurewebsites.net/edubase/downloads/public/edubasealldata20260624.csv';
const OUTPUT = join(ROOT, 'functions', 'research', 'sources', 'gias-schools-by-urn.json');
const CACHE_CSV = join(ROOT, '.tmp', 'edubasealldata.csv');

// Fields we extract from the CSV (by header name)
const KEEP = new Set([
  'URN', 'EstablishmentName', 'TypeOfEstablishment (name)',
  'PhaseOfEducation (name)', 'EstablishmentStatus (name)',
  'StatutoryLowAge', 'StatutoryHighAge', 'Gender (name)',
  'LA (name)', 'Postcode', 'Easting', 'Northing',
  'SchoolCapacity', 'NumberOfPupils',
  'TrustSchoolFlag (name)', 'AdmissionsPolicy (name)',
]);

// ── OSGB36 → WGS84 conversion (Helmert transformation) ─────────────────────

function osgb36ToWGS84(easting, northing) {
  // Convert OSGB36 easting/northing to lat/lon on the Airy 1830 ellipsoid
  const a = 6377563.396;       // Airy 1830 semi-major axis
  const b = 6356256.909;       // Airy 1830 semi-minor axis
  const e2 = 1 - (b * b) / (a * a);
  const n0 = -100000;          // Northing of true origin
  const e0 = 400000;           // Easting of true origin
  const lat0 = 49 * Math.PI / 180;  // Latitude of true origin
  const lon0 = -2 * Math.PI / 180;  // Longitude of true origin
  const f0 = 0.9996012717;     // Scale factor on central meridian

  const N = northing;
  const E = easting;

  // Initial approximation
  let lat = lat0;
  let M = 0;
  for (let i = 0; i < 10; i++) {
    const n = (a - b) / (a + b);
    const n2 = n * n, n3 = n2 * n;
    const phi = lat;
    M = b * f0 * (
      (1 + n + 1.25 * n2 + 1.25 * n3) * (phi - lat0)
      - (3 * n + 3 * n2 + 2.625 * n3) * Math.sin(phi - lat0) * Math.cos(phi + lat0)
      + (1.875 * n2 + 1.875 * n3) * Math.sin(2 * (phi - lat0)) * Math.cos(2 * (phi + lat0))
      - (35 / 24) * n3 * Math.sin(3 * (phi - lat0)) * Math.cos(3 * (phi + lat0))
    );
    lat = lat + (N - n0 - M) / (a * f0);
    if (Math.abs(N - n0 - M) < 0.0001) break;
  }

  const nu = a * f0 / Math.sqrt(1 - e2 * Math.sin(lat) * Math.sin(lat));
  const rho = a * f0 * (1 - e2) / Math.pow(1 - e2 * Math.sin(lat) * Math.sin(lat), 1.5);
  const eta2 = nu / rho - 1;

  const tanLat = Math.tan(lat);
  const secLat = 1 / Math.cos(lat);
  const dE = E - e0;

  const lat_osgb = lat
    - (tanLat / (2 * rho * nu)) * dE * dE
    + (tanLat / (24 * rho * nu * nu * nu)) * (5 + 3 * tanLat * tanLat + eta2 - 9 * tanLat * tanLat * eta2) * Math.pow(dE, 4)
    - (tanLat / (720 * rho * Math.pow(nu, 5))) * (61 + 90 * tanLat * tanLat + 45 * Math.pow(tanLat, 4)) * Math.pow(dE, 6);

  const lon_osgb = lon0
    + (secLat / nu) * dE
    - (secLat / (6 * nu * nu * nu)) * (nu / rho + 2 * tanLat * tanLat) * Math.pow(dE, 3)
    + (secLat / (120 * Math.pow(nu, 5))) * (5 + 28 * tanLat * tanLat + 24 * Math.pow(tanLat, 4)) * Math.pow(dE, 5);

  // Helmert transformation (OSGB36 → WGS84)
  const lat_rad = lat_osgb;
  const lon_rad = lon_osgb;
  const h = 0; // height in meters

  const tx = -446.448, ty = 125.157, tz = -542.060;  // translation (meters)
  const rx = -0.1502, ry = -0.2470, rz = -0.8421;     // rotation (arc-seconds)
  const s = 20.4894;                                    // scale (ppm)

  const rx_rad = rx * Math.PI / (180 * 3600);
  const ry_rad = ry * Math.PI / (180 * 3600);
  const rz_rad = rz * Math.PI / (180 * 3600);
  const s_factor = 1 + s / 1_000_000;

  const sinLat = Math.sin(lat_rad), cosLat = Math.cos(lat_rad);
  const sinLon = Math.sin(lon_rad), cosLon = Math.cos(lon_rad);

  // ECEF for OSGB36
  const a_airy = 6377563.396, b_airy = 6356256.909;
  const e2_airy = 1 - (b_airy * b_airy) / (a_airy * a_airy);
  const N_airy = a_airy / Math.sqrt(1 - e2_airy * sinLat * sinLat);
  const X = (N_airy + h) * cosLat * cosLon;
  const Y = (N_airy + h) * cosLat * sinLon;
  const Z = (N_airy * (1 - e2_airy) + h) * sinLat;

  // Apply Helmert
  const X2 = tx + s_factor * (X + rz_rad * Y - ry_rad * Z);
  const Y2 = ty + s_factor * (-rz_rad * X + Y + rx_rad * Z);
  const Z2 = tz + s_factor * (ry_rad * X - rx_rad * Y + Z);

  // ECEF back to lat/lon on WGS84
  const a_wgs = 6378137.0, b_wgs = 6356752.3142;
  const e2_wgs = 1 - (b_wgs * b_wgs) / (a_wgs * a_wgs);
  const p = Math.sqrt(X2 * X2 + Y2 * Y2);
  let lat_wgs = Math.atan2(Z2, p * (1 - e2_wgs));
  let N_wgs;
  for (let i = 0; i < 10; i++) {
    N_wgs = a_wgs / Math.sqrt(1 - e2_wgs * Math.sin(lat_wgs) * Math.sin(lat_wgs));
    const h_wgs = p / Math.cos(lat_wgs) - N_wgs;
    lat_wgs = Math.atan2(Z2, p * (1 - e2_wgs * N_wgs / (N_wgs + h_wgs)));
  }
  const lon_wgs = Math.atan2(Y2, X2);

  return {
    lat: Number((lat_wgs * 180 / Math.PI).toFixed(6)),
    lon: Number((lon_wgs * 180 / Math.PI).toFixed(6)),
  };
}

// ── CSV parsing ────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
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

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // 1. Download CSV if not cached
  if (!existsSync(CACHE_CSV)) {
    console.log('Downloading GIAS CSV (64 MB)...');
    const tmpDir = join(ROOT, 'functions', 'research', '.tmp');
    if (!existsSync(tmpDir)) {
      const { mkdirSync } = await import('fs');
      mkdirSync(tmpDir, { recursive: true });
    }
    await new Promise((resolve, reject) => {
      const file = createWriteStream(CACHE_CSV);
      get(DOWNLOAD_URL, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          // Follow redirect
          get(response.headers.location, (redirectRes) => {
            pipeline(redirectRes, file).then(resolve, reject);
          });
          return;
        }
        pipeline(response, file).then(resolve, reject);
      }).on('error', reject);
    });
    console.log('Downloaded.');
  } else {
    console.log('Using cached CSV.');
  }

  // 2. Parse CSV
  console.log('Parsing CSV...');
  const csv = readFileSync(CACHE_CSV, 'utf8');
  const lines = csv.split(/\r?\n/);
  if (lines.length < 2) throw new Error('CSV too short');

  const headers = parseCSVLine(lines[0]);
  const colIndex = {};
  for (let i = 0; i < headers.length; i++) {
    colIndex[headers[i]] = i;
  }

  // Verify required columns exist
  for (const field of ['URN', 'Easting', 'Northing', 'EstablishmentStatus (name)']) {
    if (colIndex[field] === undefined) {
      throw new Error(`Missing required column: ${field}`);
    }
  }

  // 3. Filter and transform
  console.log(`Processing ${lines.length - 1} rows...`);
  const index = { _meta: { built: new Date().toISOString(), source: DOWNLOAD_URL, totalRows: 0, openSchools: 0 } };
  let total = 0, open = 0, skippedNoCoords = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    total++;

    const fields = parseCSVLine(line);

    // Filter: open schools only
    const status = fields[colIndex['EstablishmentStatus (name)']] || '';
    if (status !== 'Open') continue;
    open++;

    // Required: coordinates
    const easting = parseFloat(fields[colIndex['Easting']]);
    const northing = parseFloat(fields[colIndex['Northing']]);
    if (isNaN(easting) || isNaN(northing)) { skippedNoCoords++; continue; }

    const urn = fields[colIndex['URN']];

    // Convert coordinates
    const { lat, lon } = osgb36ToWGS84(easting, northing);

    // Extract kept fields
    const entry = { urn, lat, lon };
    for (const [name, idx] of Object.entries(colIndex)) {
      if (KEEP.has(name) && name !== 'URN' && name !== 'Easting' && name !== 'Northing') {
        const val = (fields[idx] || '').trim();
        if (val) entry[name] = val;
      }
    }

    index[urn] = entry;

    if (open % 5000 === 0) {
      console.log(`  ${open} open schools processed...`);
    }
  }

  index._meta.totalRows = total;
  index._meta.openSchools = open;
  index._meta.skippedNoCoords = skippedNoCoords;

  // 4. Write JSON
  console.log(`Writing index: ${open} open schools (${skippedNoCoords} skipped — no coordinates)`);
  writeFileSync(OUTPUT, JSON.stringify(index), 'utf8');

  const { statSync } = await import('fs');
  const sizeMB = (statSync(OUTPUT).size / (1024 * 1024)).toFixed(2);
  console.log(`Done. ${OUTPUT} (${sizeMB} MB)`);
}

main().catch(err => { console.error(err); process.exit(1); });
