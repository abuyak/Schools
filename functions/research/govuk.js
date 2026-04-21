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
 *
 * All failures are non-fatal. Missing data is noted in the output block so
 * the AI knows to fetch it via web search rather than silently omitting it.
 */

const FETCH_TIMEOUT_MS = 8000;

const GIAS_SEARCH   = 'https://www.get-information-schools.service.gov.uk/Establishments/Search';
const GIAS_DETAIL   = 'https://www.get-information-schools.service.gov.uk/Establishments/Establishment/Details';
const COMPARE_PERF  = 'https://www.compare-school-performance.service.gov.uk';
const FIN_BENCH     = 'https://financial-benchmarking-and-insights-tool.education.gov.uk';
const POSTCODES_IO  = 'https://api.postcodes.io/postcodes';

function glog(event, props = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), src: 'govuk', ...props }));
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

// Government sites block non-browser User-Agents; use a realistic one.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function safeFetchText(url, extraHeaders = {}) {
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
}

async function safeFetchJson(url, extraHeaders = {}) {
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
    pupilExperience: extractSection(text, [
      /what\s+is\s+it\s+like\s+to\s+attend\s+this\s+school/i,
      /what\s+it['']s\s+like\s+to\s+be\s+a\s+pupil/i,
      /what\s+it\s+is\s+like\s+to\s+be\s+a\s+pupil/i,
    ]),
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
 * then returns the text up to the next heading (capitalised line) or 1 500 chars.
 */
function extractSection(text, patterns) {
  for (const pattern of patterns) {
    const match = text.search(pattern);
    if (match === -1) continue;

    // Start after the heading line
    const afterHeading = text.indexOf('\n', match);
    if (afterHeading === -1) continue;
    const start = afterHeading + 1;

    // End at next heading-like line (all-caps or title-case short line) or 3000 chars
    const chunk = text.slice(start, start + 4000);
    const nextHeading = chunk.search(/\n[A-Z][A-Za-z ,'\-]{5,60}\n/);
    const end = nextHeading > 100 ? nextHeading : Math.min(chunk.length, 3000);

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
  const lsoa  = r.codes?.lsoa  ?? r.lsoa  ?? null;
  const msoa  = r.codes?.msoa  ?? r.msoa  ?? null;
  const lsoa11 = r.codes?.lsoa11 ?? r.lsoa11 ?? null;
  const district = r.admin_district ?? null;
  const region   = r.region ?? null;

  if (!lsoa && !msoa) { glog('govuk_area_no_codes', { postcode }); return null; }

  // Step 2 — fetch area data in parallel (all non-fatal)
  // Ethnicity: Nomis Census 2021 TS021 — now at LSOA level (~0.5 mile radius, ~400-1,200 households)
  // IMD:       MHCLG Indices of Multiple Deprivation 2019 — LSOA level
  // HPI:       HM Land Registry UK House Price Index — district level (finest grain available)
  // Income:    ONS Small Area Income Estimates FYE 2018 — MSOA level (finest ONS grain available)
  const [ethnicityData, hpiData, incomeData, imdData] = await Promise.allSettled([
    fetchNomisEthnicity(lsoa),   // LSOA for tight local focus
    fetchHPI(district),
    fetchONSIncome(msoa),        // income only published at MSOA level
    fetchIMD(lsoa),
  ]);

  const result = {
    postcode: r.postcode,
    district,
    region,
    lsoa,
    msoa,
    ethnicity:   ethnicityData.status === 'fulfilled' ? ethnicityData.value : null,
    housePrices: hpiData.status       === 'fulfilled' ? hpiData.value       : null,
    income:      incomeData.status    === 'fulfilled' ? incomeData.value    : null,
    imd:         imdData.status       === 'fulfilled' ? imdData.value       : null,
  };

  glog('govuk_area_ok', {
    postcode,
    district,
    hasEthnicity:   !!result.ethnicity,
    hasHousePrices: !!result.housePrices,
    hasIncome:      !!result.income,
    hasIMD:         !!result.imd,
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
 * Fetches house price index data from the HM Land Registry UKHPI endpoint.
 *
 * Uses the local authority (district) slug derived from the postcodes.io
 * admin_district field. Tries the last 4 months in reverse order since
 * HPI data is published ~3 months behind the reference date.
 */
async function fetchHPI(districtName) {
  if (!districtName) return null;

  const slug = districtName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  // Try the last 4 months (HPI data is ~3 months behind)
  const now = new Date();
  const months = [];
  for (let i = 3; i <= 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  for (const month of months) {
    const url = `https://landregistry.data.gov.uk/data/ukhpi/region/${slug}/month/${month}.json`;
    const data = await safeFetchJson(url);
    const pt = data?.result?.primaryTopic;
    if (!pt?.averagePrice) continue;

    return {
      district:                districtName,
      refMonth:                pt.refMonth ?? month,
      averagePrice:            `£${Math.round(pt.averagePrice).toLocaleString('en-GB')}`,
      averagePriceFlat:        pt.averagePriceFlatMaisonette ? `£${Math.round(pt.averagePriceFlatMaisonette).toLocaleString('en-GB')}` : null,
      averagePriceTerraced:    pt.averagePriceTerraced       ? `£${Math.round(pt.averagePriceTerraced).toLocaleString('en-GB')}` : null,
      averagePriceFirstTimeBuyer: pt.averagePriceFirstTimeBuyer ? `£${Math.round(pt.averagePriceFirstTimeBuyer).toLocaleString('en-GB')}` : null,
      annualChangePercent:     pt.percentageAnnualChange ?? null,
      source: 'HM Land Registry UK House Price Index',
    };
  }
  return null;
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
    pupilExperience: null,
    nextSteps:       null,
  };

  glog('govuk_ofsted_ok', { urn, overall: finalOverall, date: finalDate });
  return result;
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
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': BROWSER_UA, ...extraHeaders },
    });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
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
 * Downloads the FBIT census ZIP export and parses the row for this school.
 * The ZIP contains a single CSV with workforce and pupil metrics for the
 * school and its comparator set.
 */
async function fetchFBITCensus(urn) {
  const buf = await safeFetchBuffer(`${FIN_BENCH}/school/${urn}/census/download`);
  const csv = await unzipFirst(buf);
  if (!csv) return null;

  const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  // Strip BOM, split headers
  const headers = lines[0].replace(/^\uFEFF/, '').split(',').map(h => h.trim());
  const urnIdx  = headers.findIndex(h => /^URN$/i.test(h));
  if (urnIdx === -1) return null;

  // Find the row for this school
  const row = lines.slice(1).find(l => l.split(',')[urnIdx]?.trim() === String(urn));
  if (!row) return null;

  const cells = row.split(',');
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
  const qtsIdx = headers.findIndex(h => h === 'PercentTeacherWithQualifiedStatus');
  const comparatorQtsValues = lines.slice(1)
    .map(l => parseFloat(l.split(',')[qtsIdx]))
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

  // PDF content extracted server-side
  if (ofsted.pupilExperience) {
    lines.push(`\n**What it's like to be a pupil (from inspection report)**\n${ofsted.pupilExperience}`);
  }
  if (ofsted.nextSteps) {
    lines.push(`\n**Next steps (from inspection report)**\n${ofsted.nextSteps}`);
  }
  if (!ofsted.pupilExperience && !ofsted.nextSteps && ofsted.reportUrl) {
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

  // ── Household income (MSOA — finest ONS grain published) ─────────────────
  if (area.income) {
    const inc = area.income;
    lines.push('');
    lines.push(`**Household Income — ${inc.year}, MSOA${inc.msoaName ? ` (${inc.msoaName})` : ''}**`);
    lines.push('| Measure | Annual |');
    lines.push('|---|---|');
    if (inc.netAnnualHouseholdIncome)  lines.push(`| Net household income | ${inc.netAnnualHouseholdIncome} |`);
    if (inc.totalAnnualHouseholdIncome) lines.push(`| Total household income (before housing costs) | ${inc.totalAnnualHouseholdIncome} |`);
    if (inc.afterHousingCostsIncome)   lines.push(`| Net income after housing costs | ${inc.afterHousingCostsIncome} |`);
    if (inc.netEquivalisedIncome)      lines.push(`| Net equivalised income (per capita) | ${inc.netEquivalisedIncome} |`);
    lines.push(`_Source: ${inc.source}_`);
  } else {
    lines.push('');
    lines.push('**Household Income:** _Not retrieved_');
  }

  // ── House prices (district — finest Land Registry HPI grain) ─────────────
  if (area.housePrices) {
    const hp = area.housePrices;
    lines.push('');
    lines.push(`**House Prices — ${hp.district}, ${hp.refMonth}**`);
    lines.push('| Property type | Average price |');
    lines.push('|---|---|');
    lines.push(`| All properties | ${hp.averagePrice} |`);
    if (hp.averagePriceTerraced)       lines.push(`| Terraced | ${hp.averagePriceTerraced} |`);
    if (hp.averagePriceFlat)           lines.push(`| Flat / maisonette | ${hp.averagePriceFlat} |`);
    if (hp.averagePriceFirstTimeBuyer) lines.push(`| First-time buyer | ${hp.averagePriceFirstTimeBuyer} |`);
    if (hp.annualChangePercent != null) lines.push(`| Annual change (YoY) | ${hp.annualChangePercent > 0 ? '+' : ''}${hp.annualChangePercent}% |`);
    lines.push(`_Source: ${hp.source}_`);
  } else {
    lines.push('');
    lines.push('**House Prices:** _Not retrieved_');
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
    lines.push(`**Ethnic Profile — LSOA, Census 2021** (${broadSummary})`);
    lines.push('| Group | % |');
    lines.push('|---|---|');
    for (const [label, pct] of sorted) {
      lines.push(`| ${label} | ${pct}% |`);
    }
  } else {
    lines.push('');
    lines.push('**Ethnicity:** _Not retrieved_');
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

// ─── Build Branch 1 block (detailed) ─────────────────────────────────────────

function buildDetailedBlock(school) {
  const { input, identity, ofsted, performance, financial, area } = school;
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

      const ofsted = ofstedBase
        ? { ...ofstedBase, pupilExperience: pdfSections?.pupilExperience ?? null, nextSteps: pdfSections?.nextSteps ?? null }
        : null;

      return { input: name, identity, ofsted, performance, financial, area };
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
    ? schools.map(buildDetailedBlock).join('\n\n')
    : buildComparisonBlock(schools));
}

// Debug helper — exported so debug-govuk.mjs can print the formatted block
export { buildDetailedBlock };
