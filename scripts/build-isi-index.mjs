/**
 * build-isi-index.mjs
 *
 * Scrapes the ISI reports listing (paginated, SSR) and builds a compact JSON
 * index of all independent schools with their ISI institution IDs and report URLs.
 *
 * Output: functions/research/sources/isi-institutions.json
 *
 * Run manually (once per term — ISI data changes slowly):
 *
 *   node scripts/build-isi-index.mjs
 *
 * ── What it does ──────────────────────────────────────────────────────────────
 *
 * Phase 1 — Scrape listing pages
 *   Fetches isi.net/reports/?p=1 through ?p=N, extracts institution slugs,
 *   IDs, and name hints.  ~140 pages, ~10 schools each → ~1,400 schools.
 *   Runs with concurrency=8, completes in ~30 seconds.
 *
 * Phase 2 — Fetch report URLs (optional, on by default)
 *   For each institution, fetches the ?results=true page (which has SSR report
 *   download links) and extracts the latest EQI/FCI and ROU report URLs.
 *   Runs with concurrency=4, completes in ~8 minutes.
 *   Skip with --no-reports if you just need the institution index.
 *
 * ── Updating ──────────────────────────────────────────────────────────────────
 *
 * Run this script each term (January, April, September) to capture newly
 * inspected schools and updated report URLs.  Commit the updated JSON:
 *
 *   git add functions/research/sources/isi-institutions.json
 *   git commit -m "chore: update ISI institution index <term>"
 *
 * ── Output format ─────────────────────────────────────────────────────────────
 *
 * {
 *   "_meta": { "built": "2026-04-28T...", "totalSchools": 1401 },
 *   "byName": {
 *     "reigate grammar school": {
 *       "slug": "reigate-grammar-school-6831",
 *       "id": "6831",
 *       "nameHint": "reigate grammar school",
 *       "eqiUrl": "https://reports.isi.net/...",
 *       "eqiDate": "20260203",
 *       "rouUrl": null,
 *       "rouDate": null
 *     },
 *     ...
 *   }
 * }
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const OUTPUT_PATH = join(PROJECT_ROOT, 'functions', 'research', 'sources', 'isi-institutions.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ISI_BASE = 'https://www.isi.net';
const LISTING_BASE = `${ISI_BASE}/reports/`;
const FETCH_TIMEOUT_MS = 15000;
const LISTING_CONCURRENCY = 8;
const REPORT_CONCURRENCY = 4;
const FETCH_DELAY_MS = 250;  // polite delay between requests

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const SKIP_REPORTS = args.includes('--no-reports');
const RESUME = args.includes('--resume');
const MAX_PAGES = parseInt(args.find(a => a.startsWith('--max-pages='))?.split('=')[1] ?? '0', 10) || Infinity;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeFetch(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.9' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ─── Phase 1: Scrape listing pages ────────────────────────────────────────────

function parseListingPage(html) {
  const entries = [];
  const linkRe = /href="\/?institutions\/school\/([^"?]+)"/g;
  const seen = new Set();
  for (const m of html.matchAll(linkRe)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const idMatch = slug.match(/-(\d+)$/);
    if (!idMatch) continue;
    const id = idMatch[1];
    const nameHint = slug.replace(/-+\d+$/, '').replace(/-+/g, ' ').trim();
    entries.push({ slug, id, nameHint });
  }
  return entries;
}

async function scrapeListingPages() {
  log('Phase 1: Scraping ISI listing pages...');

  // First, find the total number of pages
  const firstPage = await safeFetch(LISTING_BASE);
  if (!firstPage) { log('ERROR: Could not fetch first page. Aborting.'); process.exit(1); }

  // Extract pagination — look for the last page number
  const pageMatches = [...firstPage.matchAll(/\/reports\/\?p=(\d+)/g)];
  const lastPage = pageMatches.length
    ? Math.max(...pageMatches.map(m => parseInt(m[1], 10)))
    : 138; // fallback

  log(`  Total pages: ${lastPage} (estimated ~${lastPage * 10} schools)`);

  const allEntries = [];
  const pagesToFetch = Math.min(lastPage, MAX_PAGES);

  // Parse page 1 (already fetched)
  allEntries.push(...parseListingPage(firstPage));
  log(`  Page 1/${pagesToFetch}: ${allEntries.length} schools so far`);

  // Fetch remaining pages with concurrency control
  const queue = Array.from({ length: pagesToFetch - 1 }, (_, i) => i + 2); // pages 2..N

  async function worker() {
    while (queue.length) {
      const page = queue.shift();
      const html = await safeFetch(`${LISTING_BASE}?p=${page}`);
      if (html) {
        const entries = parseListingPage(html);
        allEntries.push(...entries);
        if (page % 20 === 0 || page === pagesToFetch) {
          log(`  Page ${page}/${pagesToFetch}: ${allEntries.length} schools so far`);
        }
      } else {
        log(`  Page ${page}/${pagesToFetch}: FAILED`);
      }
      await sleep(FETCH_DELAY_MS);
    }
  }

  const workers = Array.from({ length: LISTING_CONCURRENCY }, () => worker());
  await Promise.all(workers);

  // Deduplicate by ID
  const seen = new Set();
  const unique = allEntries.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  log(`Phase 1 complete: ${unique.length} unique schools found.`);
  return unique;
}

// ─── Phase 2: Fetch report URLs ───────────────────────────────────────────────

function parseReportUrls(html) {
  const reportRe = /DownloadReport\.aspx\?t=c(?:%26|&)r=([A-Z]+)(\d+)_(\d{8})\.pdf(?:%26|&)s=\2/g;
  const reports = [];
  for (const m of html.matchAll(reportRe)) {
    const type = m[1];
    const id = m[2];
    const date = m[3]; // YYYYMMDD
    const url = `https://reports.isi.net/DownloadReport.aspx?t=c&r=${type}${id}_${date}.pdf&s=${id}`;
    if (!reports.some(r => r.url === url)) {
      reports.push({ type, date, url });
    }
  }
  reports.sort((a, b) => b.date.localeCompare(a.date));
  return reports;
}

async function fetchReportUrls(institutions) {
  log(`Phase 2: Fetching report URLs for ${institutions.length} schools...`);
  log('  (skip with --no-reports)');

  const results = new Map(); // id → { eqiUrl, eqiDate, rouUrl, rouDate }
  const queue = [...institutions];
  let completed = 0;

  async function worker() {
    while (queue.length) {
      const inst = queue.shift();
      const html = await safeFetch(`${ISI_BASE}/institutions/school/${inst.slug}?results=true`);
      if (html) {
        const reports = parseReportUrls(html);
        const eqi = reports.find(r => r.type === 'EQI');
        const fci = reports.find(r => r.type === 'FCI');
        const rou = reports.find(r => r.type === 'ROU');
        results.set(inst.id, {
          eqiUrl:  (eqi || fci)?.url  ?? null,
          eqiDate: (eqi || fci)?.date ?? null,
          rouUrl:  rou?.url  ?? null,
          rouDate: rou?.date ?? null,
        });
      }
      completed++;
      if (completed % 100 === 0) {
        log(`  ${completed}/${institutions.length} schools processed`);
      }
      await sleep(FETCH_DELAY_MS);
    }
  }

  const workers = Array.from({ length: REPORT_CONCURRENCY }, () => worker());
  await Promise.all(workers);

  log(`Phase 2 complete: ${results.size} schools with report URLs.`);
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('ISI Index Builder — starting');
  log(`  Output: ${OUTPUT_PATH}`);
  log(`  Skip reports: ${SKIP_REPORTS}`);
  log(`  Resume: ${RESUME}`);
  log('');

  // Check for resume file
  let existingInstitutions = [];
  if (RESUME && existsSync(OUTPUT_PATH)) {
    log('Resume: loading existing index...');
    const existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
    existingInstitutions = Object.values(existing.byName ?? {});
    log(`  ${existingInstitutions.length} schools already indexed.`);
  }

  // Phase 1: Scrape listing
  const institutions = existingInstitutions.length
    ? existingInstitutions
    : await scrapeListingPages();

  if (!institutions.length) {
    log('ERROR: No schools found. Aborting.');
    process.exit(1);
  }

  // Phase 2: Fetch report URLs (optional)
  let reportData = new Map();
  if (!SKIP_REPORTS) {
    reportData = await fetchReportUrls(institutions);
  }

  // Build output
  const byName = {};
  for (const inst of institutions) {
    const key = inst.nameHint.toLowerCase();
    const reports = reportData.get(inst.id) ?? {};
    byName[key] = {
      slug: inst.slug,
      id: inst.id,
      nameHint: inst.nameHint,
      ...reports,
    };

    // Also index by ID for direct lookup
    byName[`_id:${inst.id}`] = { slug: inst.slug, nameHint: inst.nameHint, ...reports };
  }

  const output = {
    _meta: {
      built: new Date().toISOString(),
      totalSchools: institutions.length,
      hasReportUrls: !SKIP_REPORTS,
    },
    byName,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  log('');
  log(`Done. Wrote ${institutions.length} schools to ${OUTPUT_PATH}`);
  log(`Next: git add ${OUTPUT_PATH} && git commit -m "chore: update ISI index"`);
}

main().catch(err => { console.error(err); process.exit(1); });
