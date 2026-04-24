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

import { getSchoolEthnicity } from './local-data.js';

const FETCH_TIMEOUT_MS      =  8000;  // standard HTML / JSON fetches
const FETCH_TIMEOUT_LONG_MS = 20000;  // binary / ZIP downloads (FBIT census, DfE performance)

const GIAS_SEARCH   = 'https://www.get-information-schools.service.gov.uk/Establishments/Search';
const GIAS_DETAIL   = 'https://www.get-information-schools.service.gov.uk/Establishments/Establishment/Details';
const COMPARE_PERF  = 'https://www.compare-school-performance.service.gov.uk';
const FIN_BENCH     = 'https://financial-benchmarking-and-insights-tool.education.gov.uk';
const POSTCODES_IO  = 'https://api.postcodes.io/postcodes';

function glog(event, props = {}) {
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
    PTRWM_EXP:              61,   // % meeting expected standard in reading, writing and maths
    PTRWM_HIGH:              9,   // % achieving higher standard in RWM
    PTREAD_EXP:             74,   // % meeting expected in reading
    PTMAT_EXP:              73,   // % meeting expected in maths
    PTWRITTA_EXP:           72,   // % meeting expected in writing (teacher assessment)
    PTGPS_EXP:              75,   // % meeting expected in grammar, punctuation and spelling
    PTRWM_EXP_FSM6CLA1A:   46,   // % disadvantaged meeting expected in RWM
    PTREAD_EXP_FSM6CLA1A:  57,   // % disadvantaged meeting expected in reading
    PTMAT_EXP_FSM6CLA1A:   56,   // % disadvantaged meeting expected in maths
    READPROG:               0.0,  // progress score national average = 0 by definition
    WRITPROG:               0.0,
    MATPROG:                0.0,
  },
  // KS4 attainment 2024/25 (provisional, published Oct 2025)
  KS4: {
    P8MEA:              0.00,  // Progress 8 — national average = 0 by definition
    ATT8SCR:           46.4,   // Attainment 8 score
    PTL2BASICS_95:     45.9,   // % achieving grade 5+ in English and maths
    PTEBACC_E_PTQ_EE:  24.7,  // % entering EBacc
    P8MEA_FSM6CLA1A:  -0.58,  // Progress 8 for disadvantaged pupils
  },
  // Absence 2023/24 (most recent final data, published Jul 2024)
  ABSENCE: {
    PERCTOT:    6.6,   // overall absence %
    PPERSABS10: 21.3,  // persistent absence %
  },
};

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
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  };
  return withRetry(attempt);
}

async function safeFetchJson(url, extraHeaders = {}) {
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
      if (!res.ok) return null;
      return await res.json();
    } catch {
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

  let fullText;
  try {
    const { PDFParse } = await import('pdf-parse');
    // pdf-parse's internal fetch has no timeout — race it against a 12 s deadline
    const parser = new PDFParse({ url: reportUrl });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('PDF fetch timeout')), 12000)
    );
    await Promise.race([parser.load(), timeoutPromise]);
    const result = await parser.getText();
    fullText = result?.pages?.map(p => p.text).join('\n') ?? null;
  } catch (err) {
    glog('govuk_pdf_parse_fail', { url: reportUrl, error: err.message });
    return null;
  }

  if (!fullText) { glog('govuk_pdf_empty', { url: reportUrl }); return null; }

  // Normalise whitespace
  const text = fullText.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');

  return {
    // ── Present in all report types ───────────────────────────────────────
    // "What it's like to be a pupil / attend this school" — the introductory
    // narrative paragraph(s). For monitoring visits this often flows straight
    // into the "What does the school do well" content without a sub-heading.
    pupilExperience: extractSection(text, [
      /what\s+is\s+it\s+like\s+to\s+attend\s+this\s+school/i,
      /what\s+it['']s\s+like\s+to\s+be\s+a\s+pupil/i,
      /what\s+it\s+is\s+like\s+to\s+be\s+a\s+pupil/i,
    ], 5000),   // larger window: monitoring visits have no sub-headings so the
                // whole narrative sits in this one section

    // ── Old framework (pre-Nov 2025) graded inspection sub-sections ───────
    qualityOfEducation: extractSection(text, [
      /^quality\s+of\s+education\s*$/im,
      /^curriculum\s+and\s+teaching\s*$/im,   // new format alias
    ]),
    behaviourAndAttitudes: extractSection(text, [
      /^behaviour\s+and\s+attitudes?\s*$/im,
      /^attendance\s+and\s+behaviour\s*$/im,  // new format alias
    ]),
    personalDevelopment: extractSection(text, [
      /^personal\s+development\s*$/im,
      /^personal\s+development\s+and\s+wellbeing\s*$/im,
    ]),
    leadershipAndManagement: extractSection(text, [
      /^leadership\s+and\s+management\s*$/im,
      /^leadership\s+and\s+governance\s*$/im,
    ]),

    // ── New Nov-2025 format sections (not present in older reports) ────────
    achievement: extractSection(text, [/^achievement\s*$/im]),
    inclusion:   extractSection(text, [/^inclusion\s*$/im]),

    // ── Improvement flags ─────────────────────────────────────────────────
    // "Next steps" is an explicit section in the new Nov-2025 format.
    // Older reports embed improvements in the narrative — nextSteps will be null for those.
    nextSteps: extractSection(text, [
      /^next\s+steps\s*$/im,
      /^what\s+does\s+the\s+school\s+need\s+to\s+do\s+to\s+improve/im,
      /^areas\s+for\s+improvement\s*$/im,
    ]),
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

// ─── School name extraction ───────────────────────────────────────────────────

/**
 * Regex-based extraction. Matches title-cased word sequences that end in a
 * recognised school-type suffix. Fast but misses short-form names ("Eton").
 */
function extractNamesRegex(question) {
  const pattern =
    /\b([A-Z][a-zA-Z'-]+(?:\s+(?:of|the|and|&|St\.?|Saint|de|la|les|upon|at)?\s*[A-Z][a-zA-Z'-]+){0,6}\s+(?:School|College|Academy|Grammar|Primary|Secondary|Prep|Preparatory|Infant|Junior|Senior|High|Upper|Lower|Middle|Foundation|Free\s+School|Sixth\s+Form|Nursery|Convent))\b/g;

  const matches = [...question.matchAll(pattern)];
  return [...new Set(matches.map(m => m[1].trim()))];
}

/**
 * AI-assisted extraction via a minimal preflight call to the Responses API.
 * Used as a fallback when regex returns zero results, or for branch 2 where
 * short-form names are common ("Eton vs Winchester").
 */
async function extractNamesAI(question, branch, apiKey, baseUrl, model) {
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
    const text = (data.output_text ?? '').trim();
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
async function extractSchoolNames(question, branch, apiKey, baseUrl, model) {
  const regexNames = extractNamesRegex(question);
  const isComparison = branch === 'prompt_branch_2';

  // Regex is sufficient when it found results and this isn't a comparison
  if (regexNames.length >= 1 && !isComparison) return regexNames;
  // For comparisons we want ≥2; fall through to AI if we have fewer
  if (regexNames.length >= 2 && isComparison) return regexNames;

  const aiNames = await extractNamesAI(question, branch, apiKey, baseUrl, model);
  // Return whichever set is larger / non-empty
  return aiNames.length >= regexNames.length ? aiNames : regexNames;
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
export async function lookupSchoolURN(name) {
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

    tiles.push({ urn, officialName: tileName, type, phase, la, isIndependent, isOpen });
  }

  if (!tiles.length) { glog('govuk_gias_no_result', { name }); return null; }

  // Score tiles by name similarity — higher is better.
  // Open schools get a +200 bonus so a closed school is never preferred
  // over an open one with an equal or similar name match.
  const nameLower = name.toLowerCase().trim();
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
    return s;
  }

  const best = tiles.reduce((a, b) => score(a) >= score(b) ? a : b);
  glog('govuk_gias_found', { name, urn: best.urn, officialName: best.officialName, type: best.type, la: best.la, isIndependent: best.isIndependent });
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
    'postcode':                         'postcode',
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
export async function getOfstedData(urn) {
  let html = await safeFetchText(`https://reports.ofsted.gov.uk/provider/23/${urn}`);
  if (!html) html = await safeFetchText(`https://reports.ofsted.gov.uk/provider/21/${urn}`);
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
  // <div class="subjudgements__rates__item">
  //   <p>Quality of education:</p>
  //   <strong>Good</strong>
  // </div>
  const subGrades = {};
  for (const m of html.matchAll(/<div[^>]*class="[^"]*subjudgements__rates__item[^"]*"[^>]*>\s*<p>([^<]+)<\/p>\s*<strong>([^<]+)<\/strong>/gi)) {
    const label = m[1].replace(/:$/, '').trim().toLowerCase();
    subGrades[label] = m[2].trim();
  }

  const g = (key) => subGrades[key] ?? null;

  // Old framework (pre-Nov 2025)
  const qualityOfEducation  = g('quality of education');
  const behaviour           = g('behaviour and attitudes');
  const personalDevelopment = g('personal development');
  const leadership          = g('leadership and management');
  const sixthForm           = g('sixth form provision');

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

  const finalOverall = overall ?? timelineOverall;
  const finalDate    = date    ?? timelineDate;
  const finalReport  = reportUrl ?? timelineUrl;

  if (!finalOverall && !finalDate) {
    glog('govuk_ofsted_no_data', { urn });
    return null;
  }

  const result = {
    overall: finalOverall, date: finalDate,
    qualityOfEducation, behaviour, personalDevelopment, leadership, sixthForm,
    achievement, attendance, curriculum, inclusion, leadershipGov, wellbeing, post16,
    safeguarding, reportUrl: finalReport,
    parentViewUrl,
    pupilExperience: null,
    nextSteps:       null,
  };

  glog('govuk_ofsted_ok', { urn, overall: finalOverall, date: finalDate });
  return result;
}

// ─── Ofsted Parent View ───────────────────────────────────────────────────────

/**
 * Fetches aggregated Parent View survey results for a school.
 *
 * Parent View (parentview.ofsted.gov.uk) publishes the % of parents who agree
 * with each survey question. The API is public and unauthenticated.
 *
 * Returns null for independent schools (not covered by Ofsted Parent View)
 * or when no responses have been submitted.
 */
async function fetchParentView(urn) {
  if (!urn) return null;
  const raw = await safeFetchJson(`https://parentview.ofsted.gov.uk/api/search/result?urn=${urn}`);
  if (!raw) return null;

  const total = raw.totalResponses ?? raw.total_responses ?? 0;
  if (!total) return null;

  // Map survey questions to friendly keys by matching question text substrings.
  // Question wording varies slightly between survey versions.
  const questions = raw.questions ?? [];
  const findPct = (...substrings) => {
    const q = questions.find(q =>
      substrings.some(s => q.text?.toLowerCase().includes(s.toLowerCase()))
    );
    return q?.percentageAgree ?? q?.percentage_agree ?? null;
  };

  return {
    totalResponses:  total,
    wouldRecommend:  findPct('recommend'),
    childHappy:      findPct('happy at this school', 'happy here'),
    childSafe:       findPct('feels safe', 'feel safe', 'child is safe'),
    wellBehaved:     findPct('well behaved', 'good behaviour'),
    wellLed:         findPct('well led', 'well-led', 'leadership'),
    concernsHandled: findPct('concerns', 'worries are dealt'),
  };
}

// ─── School performance data ──────────────────────────────────────────────────

/**
 * Attempts to retrieve performance metrics from the compare-school-performance
 * download endpoint. Falls back to scraping the school profile page.
 */
export async function getPerformanceData(urn) {
  const text = await safeFetchText(
    `${COMPARE_PERF}/download-school-data?urn=${urn}`,
    { Accept: 'text/csv,text/html,*/*' },
  );
  if (!text) { glog('govuk_perf_fail', { urn }); return null; }

  const result = parsePerformanceCsv(text);
  if (result) { glog('govuk_perf_ok', { urn }); return result; }

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
  const attempt = async () => {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_LONG_MS),
        headers: { 'User-Agent': BROWSER_UA, ...extraHeaders },
      });
      if (!res.ok) return null;
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch {
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
  const csv = await unzipFirst(buf);
  if (!csv) return null;

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
  }
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
    allowed = ns => /^(KS2|ABS|CENSUS|L)/.test(ns);
  } else if (/secondary|all.through|middle.*secondary/i.test(ph)) {
    allowed = ns => /^(KS4|KS5|ABS|CENSUS|L)/.test(ns);
  } else if (/16.plus/i.test(ph)) {
    allowed = ns => /^(KS5|ABS|CENSUS|L)/.test(ns);
  } else {
    allowed = () => true; // unknown phase — pass everything through
  }

  // Friendly section headings
  const NS_LABELS = {
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

function fmtFinancial(fin) {
  if (!fin) return '- _Not retrieved_';
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
function fmtAcademicResultsSlim(perf, phase) {
  if (!perf) return '_Not retrieved_';

  // Fast lookup across all namespaces by variable code
  const allRows = Object.values(perf).flat();
  const v = (code) => allRows.find(r => r.variable === code)?.value ?? null;

  const ph  = (phase ?? '').toLowerCase();
  const lines = [];

  // ── KS2 (primary) ─────────────────────────────────────────────────────────
  if (/primary|middle.*primary/i.test(ph) || v('PTRWM_EXP')) {
    const rwm   = v('PTRWM_EXP');
    const rwmH  = v('PTRWM_HIGH');
    const rwm24 = v('PTRWM_EXP_24');
    const rwm23 = v('PTRWM_EXP_23');
    const read  = v('PTREAD_EXP');  const readSc = v('READ_AVERAGE');
    const mat   = v('PTMAT_EXP');   const matSc  = v('MAT_AVERAGE');
    const writ  = v('PTWRITTA_EXP');
    const gps   = v('PTGPS_EXP');
    const sci   = v('PTSCITA_EXP');

    if (rwm || read || mat) {
      const trend = [rwm23, rwm24, rwm].filter(Boolean);
      const nat = NATIONAL_AVG.KS2;
      const n = (val, key) => val != null && nat[key] != null ? ` _(nat: ${nat[key]}%)_` : '';
      lines.push('**Key Stage 2 (2024/25)**');
      lines.push('| Metric | Value |');
      lines.push('|---|---|');
      if (rwm)  lines.push(`| RWM expected standard | ${rwm}${n(rwm,'PTRWM_EXP')}${trend.length > 1 ? ` _(3-yr: ${trend.join(' → ')})_` : ''} |`);
      if (rwmH) lines.push(`| RWM high standard | ${rwmH}${n(rwmH,'PTRWM_HIGH')} |`);
      if (read) lines.push(`| Reading expected | ${read}${n(read,'PTREAD_EXP')}${readSc ? ` (avg score: ${readSc})` : ''} |`);
      if (mat)  lines.push(`| Maths expected | ${mat}${n(mat,'PTMAT_EXP')}${matSc ? ` (avg score: ${matSc})` : ''} |`);
      if (writ) lines.push(`| Writing expected | ${writ}${n(writ,'PTWRITTA_EXP')} |`);
      if (gps)  lines.push(`| GPS expected | ${gps}${n(gps,'PTGPS_EXP')} |`);
      if (sci)  lines.push(`| Science expected | ${sci} |`);

      // Disadvantaged gap
      const cohortDisadv  = v('PTFSM6CLA1A');
      const rwmDisadv     = v('PTRWM_EXP_FSM6CLA1A');
      const rwmNonDisadv  = v('PTRWM_EXP_NOTFSM6CLA1A');
      const gapNat        = v('DIFFN_RWM_EXP');
      const readDisadv    = v('PTREAD_EXP_FSM6CLA1A');  // per-subject FSM breakdown
      const matDisadv     = v('PTMAT_EXP_FSM6CLA1A');   // per-subject FSM breakdown
      if (cohortDisadv || rwmDisadv) {
        lines.push(`| Disadvantaged share of KS2 cohort | ${cohortDisadv ?? '—'} |`);
        if (rwmDisadv)    lines.push(`| RWM expected — disadvantaged | ${rwmDisadv}${nat.PTRWM_EXP_FSM6CLA1A ? ` _(nat: ${nat.PTRWM_EXP_FSM6CLA1A}%)_` : ''} |`);
        if (rwmNonDisadv) lines.push(`| RWM expected — non-disadvantaged | ${rwmNonDisadv} |`);
        if (gapNat)       lines.push(`| Gap vs national non-disadvantaged | ${gapNat}pp |`);
        if (readDisadv)   lines.push(`| Reading expected — disadvantaged | ${readDisadv}${nat.PTREAD_EXP_FSM6CLA1A ? ` _(nat: ${nat.PTREAD_EXP_FSM6CLA1A}%)_` : ''} |`);
        if (matDisadv)    lines.push(`| Maths expected — disadvantaged | ${matDisadv}${nat.PTMAT_EXP_FSM6CLA1A ? ` _(nat: ${nat.PTMAT_EXP_FSM6CLA1A}%)_` : ''} |`);
      }

      // Group 4: Gender gap at high standard — can diverge sharply from overall high figure
      const rwmHighB = v('PTRWM_HIGH_B');
      const rwmHighG = v('PTRWM_HIGH_G');
      if (rwmHighB != null || rwmHighG != null) {
        if (rwmHighB != null) lines.push(`| RWM high standard — boys | ${rwmHighB} |`);
        if (rwmHighG != null) lines.push(`| RWM high standard — girls | ${rwmHighG} |`);
      }

      // Group 7: Cohort size — governs statistical significance of every percentage above
      const cohort = v('TELIG');
      if (cohort) lines.push(`| KS2 eligible cohort | ${cohort} pupils |`);

      // Group 3: Absent from tests — headline % only includes pupils who sat; absence inflates results
      const readAt = v('PTREAD_AT');
      const matAt  = v('PTMAT_AT');
      const gpsAt  = v('PTGPS_AT');
      if (readAt || matAt || gpsAt) {
        const absentParts = [];
        if (readAt) absentParts.push(`reading ${readAt}`);
        if (matAt)  absentParts.push(`maths ${matAt}`);
        if (gpsAt)  absentParts.push(`GPS ${gpsAt}`);
        lines.push(`| Absent from KS2 tests | ${absentParts.join(' · ')} |`);
      }

      // Group 6: Progress scores with CIs + DfE descriptor — CIs are critical for small cohorts
      const PROG_DESCR = { '1': 'well above', '2': 'above', '3': 'average', '4': 'below', '5': 'well below' };
      const fmtProg = (val, lo, hi, d) => {
        let s = val ?? '—';
        if (lo && hi) s += ` (CI: ${lo} to ${hi})`;
        if (d)        s += ` — ${PROG_DESCR[String(d)] ?? d}`;
        return s;
      };
      const rProg = v('READPROG_23'); const rLo = v('READPROG_LOWER_23'); const rHi = v('READPROG_UPPER_23'); const rD = v('READPROG_DESCR_23');
      const wProg = v('WRITPROG_23'); const wLo = v('WRITPROG_LOWER_23'); const wHi = v('WRITPROG_UPPER_23'); const wD = v('WRITPROG_DESCR_23');
      const mProg = v('MATPROG_23');  const mLo = v('MATPROG_LOWER_23');  const mHi = v('MATPROG_UPPER_23');  const mD = v('MATPROG_DESCR_23');
      if (rProg || wProg || mProg) {
        lines.push(`| Progress: reading (2022/23) | ${fmtProg(rProg, rLo, rHi, rD)} |`);
        lines.push(`| Progress: writing (2022/23) | ${fmtProg(wProg, wLo, wHi, wD)} |`);
        lines.push(`| Progress: maths (2022/23) | ${fmtProg(mProg, mLo, mHi, mD)} |`);
      }
    }
  }

  // ── KS4 (secondary) ───────────────────────────────────────────────────────
  if (/secondary|all.through/i.test(ph) || v('P8MEA')) {
    const p8    = v('P8MEA');
    const p8lo  = v('P8LOWER');
    const p8hi  = v('P8UPPER');
    const att8  = v('ATT8SCR');
    const g5em  = v('PTL2BASICS_95');
    const ebacc = v('PTEBACC_E_PTQ_EE');
    const p8dis = v('P8MEA_FSM6CLA1A');
    const cohortDisadv = v('PTFSM6CLA1A');

    if (p8 || att8 || g5em) {
      const nat4 = NATIONAL_AVG.KS4;
      lines.push('');
      lines.push('**Key Stage 4 (2024/25)**');
      lines.push('| Metric | Value |');
      lines.push('|---|---|');
      if (p8)    lines.push(`| Progress 8 | ${p8}${p8lo && p8hi ? ` (CI: ${p8lo} to ${p8hi})` : ''} _(nat: ${nat4.P8MEA})_ |`);
      if (att8)  lines.push(`| Attainment 8 | ${att8} _(nat: ${nat4.ATT8SCR})_ |`);
      if (g5em)  lines.push(`| Grade 5+ English & Maths | ${g5em} _(nat: ${nat4.PTL2BASICS_95}%)_ |`);
      if (ebacc) lines.push(`| EBacc entry | ${ebacc} _(nat: ${nat4.PTEBACC_E_PTQ_EE}%)_ |`);
      if (cohortDisadv) lines.push(`| Disadvantaged share of KS4 cohort | ${cohortDisadv} |`);
      if (p8dis) lines.push(`| Progress 8 — disadvantaged | ${p8dis} _(nat: ${nat4.P8MEA_FSM6CLA1A})_ |`);
    }
  }

  // ── Pupil census ──────────────────────────────────────────────────────────
  const nor = v('NOR');
  const eal = v('PNUMEAL');
  const fsm = v('PNUMFSMEVER');
  const sen = v('PSENELK');
  const ehc = v('PSENELSE');

  if (nor || eal || fsm) {
    lines.push('');
    lines.push('**Pupil Profile (Census 2025)**');
    lines.push('| Metric | Value |');
    lines.push('|---|---|');
    if (nor) lines.push(`| On roll | ${nor} |`);
    if (fsm) lines.push(`| FSM-eligible (last 6 years) | ${fsm} |`);
    if (eal) lines.push(`| EAL pupils | ${eal} |`);
    if (sen) lines.push(`| SEN support | ${sen} |`);
    if (ehc) lines.push(`| EHC plans | ${ehc} |`);
  }

  // ── Absence ───────────────────────────────────────────────────────────────
  const abs  = v('PERCTOT');
  const pers = v('PPERSABS10');
  if (abs || pers) {
    const natA = NATIONAL_AVG.ABSENCE;
    const parts = [];
    if (abs)  parts.push(`overall ${abs}% _(nat: ${natA.PERCTOT}%)_`);
    if (pers) parts.push(`persistent absentees ${pers}% _(nat: ${natA.PPERSABS10}%)_`);
    lines.push('');
    lines.push(`**Absence (2023/24):** ${parts.join(' · ')}`);
  }

  return lines.length ? lines.join('\n') : '_No performance data available._';
}

/**
 * Slim Ofsted: grades on one line each, narrative capped at 1,500 chars.
 * The AI model can fetch the full PDF from reportUrl if it needs more.
 */
function fmtOfstedSlim(ofsted, isIndependent) {
  if (isIndependent) return '- Independent school — fetch ISI report from isi.net via web search.';
  if (!ofsted?.overall) return '- _Not retrieved — search reports.ofsted.gov.uk_';

  const lines = [`- Overall: **${ofsted.overall}**${ofsted.date ? ` (${ofsted.date})` : ''}`];

  // Sub-grades (whichever framework was used)
  const addGrade = (label, val) => { if (val) lines.push(`- ${label}: ${val}`); };
  addGrade('Quality of Education',          ofsted.qualityOfEducation);
  addGrade('Behaviour and Attitudes',       ofsted.behaviour);
  addGrade('Personal Development',          ofsted.personalDevelopment);
  addGrade('Leadership and Management',     ofsted.leadership);
  addGrade('Achievement',                   ofsted.achievement);
  addGrade('Attendance and Behaviour',      ofsted.attendance);
  addGrade('Curriculum and Teaching',       ofsted.curriculum);
  addGrade('Inclusion',                     ofsted.inclusion);
  addGrade('Leadership and Governance',     ofsted.leadershipGov);
  addGrade('Personal Development/Wellbeing',ofsted.wellbeing);
  if (ofsted.safeguarding) lines.push(`- Safeguarding: ${ofsted.safeguarding}`);

  // Parent View — data is JS-rendered so we pass the URL for the AI to fetch
  if (ofsted.parentViewUrl) {
    lines.push(`- Parent View survey results: ${ofsted.parentViewUrl}`);
  }

  // Narrative — cap at 3,000 chars (raised from 1,500 to avoid cutting SEN/SEND commentary).
  // Each section is capped independently so a long quality-of-education section
  // doesn't crowd out safeguarding or SEND observations lower in the report.
  const NARRATIVE_CAP = 3000;
  const addNarrative = (heading, text) => {
    if (!text) return;
    const snippet = text.length > NARRATIVE_CAP
      ? text.slice(0, NARRATIVE_CAP).replace(/\s+\S*$/, '') + ' …_(truncated — full PDF: ' + (ofsted.reportUrl ?? 'see Ofsted site') + ')_'
      : text;
    lines.push(`\n**${heading}**\n${snippet}`);
  };
  addNarrative("What it's like to be a pupil", ofsted.pupilExperience);
  addNarrative('Quality of Education (detail)', ofsted.qualityOfEducationDetail?.length      > 100 ? ofsted.qualityOfEducationDetail      : null);
  addNarrative('Behaviour and Attitudes (detail)', ofsted.behaviourAndAttitudesDetail?.length > 100 ? ofsted.behaviourAndAttitudesDetail   : null);
  addNarrative('Personal Development (detail)', ofsted.personalDevelopmentDetail?.length     > 100 ? ofsted.personalDevelopmentDetail     : null);
  addNarrative('Leadership and Management (detail)', ofsted.leadershipAndManagementDetail?.length > 100 ? ofsted.leadershipAndManagementDetail : null);
  addNarrative('Achievement (detail)', ofsted.achievementDetail?.length                      > 100 ? ofsted.achievementDetail             : null);
  addNarrative('Inclusion (detail)', ofsted.inclusionDetail?.length                          > 100 ? ofsted.inclusionDetail               : null);
  addNarrative('What the school needs to improve', ofsted.nextSteps);

  if (!ofsted.pupilExperience && !ofsted.nextSteps && ofsted.reportUrl) {
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

function buildSlimBlock(school) {
  const { input, identity, ofsted, performance, financial, area, schoolEthnicity } = school;
  const name = identity?.officialName ?? input;
  const urn  = identity?.urn;

  const anyNsField = (v) => Object.values(performance ?? {}).flat().find(r => r.variable === v)?.value ?? null;
  const lField     = (v) => performance?.L?.find(r => r.variable === v)?.value ?? null;
  const postcode   = anyNsField('PCODE');
  const ageLow     = lField('AGELOW');
  const ageHigh    = lField('AGEHIGH');
  const gender     = lField('GENDER');
  const relChar    = lField('RELCHAR');
  const admPol     = lField('ADMPOL');

  const idLine = identity
    ? `${identity.officialName} · URN ${urn} · ${identity.type ?? '?'} · ${identity.phase ?? '?'}${ageLow && ageHigh ? ` (ages ${ageLow}–${ageHigh})` : ''} · LA: ${identity.la ?? '?'}${postcode ? ` · ${postcode}` : ''}${gender ? ` · ${gender}` : ''}${relChar && relChar !== 'Does not apply' ? ` · ${relChar}` : ''}${admPol && admPol !== 'Not applicable' ? ` · admissions: ${admPol}` : ''}`
    : `"${input}" — URN not found`;

  const links = govLinks(urn).join(' · ');

  return `
---
## Pre-Fetched Government Data — ${name}

> **Use figures below directly. Do not re-search populated fields.**
> Fields marked "_Not retrieved_" → source via web search.

**School:** ${idLine}
**Links:** ${links}

### Academic Results (DfE)
${fmtAcademicResultsSlim(performance, identity?.phase)}

### Financial Benchmarking (FBIT)
${fmtFinancial(financial)}

### Inspection Outcomes (Ofsted)
${fmtOfstedSlim(ofsted, identity?.isIndependent ?? false)}

### School Pupil Ethnicity (DfE Census)
${fmtSchoolEthnicitySlim(schoolEthnicity)}

### Surrounding Area
${fmtAreaDataSlim(area)}
---`.trim();
}

// ─── Build Branch 1 block (detailed — debug script / human report only) ──────

function buildDetailedBlock(school) {
  const { input, identity, ofsted, performance, financial, area, schoolEthnicity } = school;
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

  const identityLines = identity ? [
    `- Official name: ${identity.officialName}`,
    `- URN: ${urn}`,
    `- Type: ${identity.type ?? 'Unknown'}`,
    `- Phase: ${identity.phase ?? 'Unknown'}${ageLow && ageHigh ? ` (ages ${ageLow}–${ageHigh})` : ''}`,
    `- Local authority: ${identity.la ?? 'Unknown'}`,
    `- Independent: ${identity.isIndependent ? 'Yes' : 'No'}`,
    ...(postcode        ? [`- Postcode: ${postcode}`]              : []),
    ...(gender          ? [`- Gender: ${gender}`]                  : []),
    ...(relChar         ? [`- Religious character: ${relChar}`]    : []),
    ...(admPol          ? [`- Admissions policy: ${admPol}`]       : []),
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
  const detailed = branch === 'prompt_branch_1';
  const t0 = Date.now();

  const names = await extractSchoolNames(question, branch, apiKey, baseUrl, model);
  if (!names.length) {
    glog('govuk_no_names', { branch, question: question.slice(0, 120) });
    return '';
  }

  glog('govuk_start', { branch, names });

  // Resolve all schools in parallel; within each school, URN lookup first,
  // then Ofsted / performance / financial in parallel.
  const schools = await Promise.all(
    names.map(async (name) => {
      const identity = await lookupSchoolURN(name);
      const urn = identity?.urn ?? null;

      if (!urn) {
        return { input: name, identity: null, ofsted: null, performance: null, financial: null };
      }

      // Phase 1: Ofsted HTML scrape (fast, no PDF)
      const ofstedBase = identity.isIndependent ? null : await getOfstedData(urn);

      // Phase 2: PDF + performance + financial — all in parallel
      const [pdfSections, performance, financial] = await Promise.all([
        detailed && ofstedBase?.reportUrl
          ? fetchAndParseOfstedPdf(ofstedBase.reportUrl)
          : Promise.resolve(null),
        getPerformanceData(urn),
        getFinancialData(urn),
      ]);

      // Phase 3: area data — postcode comes from DfE CSV (PCODE in phase-specific namespace, e.g. KS2_25)
      const postcode = Object.values(performance ?? {}).flat().find(r => r.variable === 'PCODE')?.value ?? null;
      const area = detailed && postcode ? await getAreaData(postcode) : null;

      // IMPORTANT: PDF narrative fields are stored under *Detail keys to avoid
      // clobbering the grade strings of the same name on ofstedBase.
      const ofsted = ofstedBase ? {
        ...ofstedBase,
        pupilExperience:               pdfSections?.pupilExperience         ?? null,
        qualityOfEducationDetail:      pdfSections?.qualityOfEducation      ?? null,
        behaviourAndAttitudesDetail:   pdfSections?.behaviourAndAttitudes   ?? null,
        personalDevelopmentDetail:     pdfSections?.personalDevelopment     ?? null,
        leadershipAndManagementDetail: pdfSections?.leadershipAndManagement ?? null,
        achievementDetail:             pdfSections?.achievement             ?? null,
        inclusionDetail:               pdfSections?.inclusion               ?? null,
        nextSteps:                     pdfSections?.nextSteps               ?? null,
      } : null;

      // Bundled local data (zero-latency — no HTTP)
      const schoolEthnicity = urn ? getSchoolEthnicity(urn) : null;

      return { input: name, identity, ofsted, performance, financial, area, schoolEthnicity };
    })
  );

  glog('govuk_done', {
    branch,
    ms: Date.now() - t0,
    schools: schools.length,
    resolved: schools.filter(s => s.identity).length,
  });

  if (!schools.length) return '';

  return '\n\n' + (detailed
    ? schools.map(buildSlimBlock).join('\n\n')   // slim block for prompt injection
    : buildComparisonBlock(schools));
}

// Debug helpers — exported so debug-govuk.mjs can print both blocks
export { buildDetailedBlock, buildSlimBlock };
