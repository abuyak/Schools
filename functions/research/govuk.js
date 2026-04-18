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

const GIAS_SEARCH  = 'https://www.get-information-schools.service.gov.uk/Establishments/Search';
const COMPARE_PERF = 'https://www.compare-school-performance.service.gov.uk';
const FIN_BENCH      = 'https://financial-benchmarking-and-insights-tool.education.gov.uk';

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
    const parser = new PDFParse({ url: reportUrl });
    await parser.load();
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

    // End at next heading-like line (all-caps or title-case short line) or 1500 chars
    const chunk = text.slice(start, start + 2000);
    const nextHeading = chunk.search(/\n[A-Z][A-Za-z ,'\-]{5,60}\n/);
    const end = nextHeading > 100 ? nextHeading : Math.min(chunk.length, 1500);

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

    tiles.push({ urn, officialName: tileName, type, phase, la: null, isIndependent, isOpen });
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
  glog('govuk_gias_found', { name, urn: best.urn, officialName: best.officialName, type: best.type, isIndependent: best.isIndependent });
  return best;
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

  // ── PDF extraction (server-side, so the model never needs to fetch it) ──────
  const pdfSections = finalReport ? await fetchAndParseOfstedPdf(finalReport) : null;

  const result = {
    overall: finalOverall, date: finalDate,
    qualityOfEducation, behaviour, personalDevelopment, leadership, sixthForm,
    achievement, attendance, curriculum, inclusion, leadershipGov, wellbeing, post16,
    safeguarding, reportUrl: finalReport,
    pupilExperience: pdfSections?.pupilExperience ?? null,
    nextSteps:       pdfSections?.nextSteps       ?? null,
  };

  glog('govuk_ofsted_ok', { urn, overall: finalOverall, date: finalDate, pdfParsed: !!pdfSections });
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

  // Pure admin/identifier fields — already captured in the GIAS identity block
  const SKIP_VARS = new Set([
    'URN', 'LA', 'LEA', 'ESTAB', 'LAESTAB', 'URN_AC',
    'RECTYPE', 'ALPHAIND', 'EDITION', 'YEAR',
    'ADDRESS1', 'ADDRESS2', 'ADDRESS3', 'TOWN', 'PCODE', 'TELNUM',
    'PCON_CODE', 'PCON_NAME', 'ICLOSE', 'TAB15', 'TAB1618',
    'SCHNAME', 'LANAME',
  ]);

  // Skip the L namespace — it's school identity, handled by GIAS.
  // Keep a handful of useful L fields that GIAS doesn't give us.
  const L_KEEP = new Set(['GENDER', 'ADMPOL', 'RELCHAR', 'AGELOW', 'AGEHIGH', 'ISPRIMARY', 'ISSECONDARY', 'ISPOST16']);

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
 * Tries known API patterns for the DfE financial benchmarking tool.
 * Falls back to HTML scraping (works only if the page is server-rendered).
 * Returns null when neither approach yields data.
 */
export async function getFinancialData(urn) {
  // Probe common REST-style endpoints the tool might expose internally
  const apiCandidates = [
    `${FIN_BENCH}/api/school/${urn}`,
    `${FIN_BENCH}/api/establishment/${urn}`,
    `${FIN_BENCH}/api/schools/${urn}/summary`,
  ];

  for (const url of apiCandidates) {
    const data = await safeFetchJson(url);
    if (data) {
      glog('govuk_fin_api_ok', { urn, url });
      return extractFinancialFromJson(data);
    }
  }

  // Fallback: scrape the school detail page (may be a React SPA — often empty)
  const html = await safeFetchText(`${FIN_BENCH}/school/${urn}`);
  if (!html) { glog('govuk_fin_fail', { urn }); return null; }

  const result = extractFinancialFromHtml(html);
  if (result) glog('govuk_fin_html_ok', { urn });
  else glog('govuk_fin_no_data', { urn });
  return result;
}

function extractFinancialFromJson(data) {
  const pick = (obj, ...keys) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return obj[k];
    }
    return null;
  };
  return {
    incomePerPupil:      pick(data, 'incomePerPupil', 'income_per_pupil', 'TotalIncomePerPupil'),
    expenditurePerPupil: pick(data, 'expenditurePerPupil', 'expenditure_per_pupil', 'TotalExpenditurePerPupil'),
    staffCostsPct:       pick(data, 'staffCostsAsPct', 'staff_costs_pct', 'StaffCostsPercentage'),
    revenueBalance:      pick(data, 'revenueBalancePerPupil', 'revenue_balance_per_pupil', 'RevenueBalancePerPupil'),
    totalIncome:         pick(data, 'totalIncome', 'total_income', 'TotalIncome'),
  };
}

function extractFinancialFromHtml(html) {
  const out = {};
  const grab = (pattern) => { const m = html.match(pattern); return m ? m[1].trim() : null; };

  const inc = grab(/income\s+per\s+pupil[^£\d]*[£]?([\d,]+)/i);
  if (inc) out.incomePerPupil = '£' + inc;

  const staff = grab(/staff\s+costs?[^%\d]*(\d+\.?\d*)%/i);
  if (staff) out.staffCostsPct = staff + '%';

  const bal = grab(/revenue\s+balance[^£\d]*[£]?([\d,]+)/i);
  if (bal) out.revenueBalance = '£' + bal;

  const exp = grab(/expenditure\s+per\s+pupil[^£\d]*[£]?([\d,]+)/i);
  if (exp) out.expenditurePerPupil = '£' + exp;

  return Object.keys(out).length ? out : null;
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
 * namespaces only. Descriptions are omitted — variable names + namespace names
 * are sufficient for the model to interpret values.
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

  const blocks = [];
  for (const [namespace, rows] of Object.entries(perf)) {
    if (!allowed(namespace)) continue;
    const lines = rows.map(({ variable, value }) => `- ${variable}: ${value}`);
    blocks.push(`**${namespace}**\n${lines.join('\n')}`);
  }
  return blocks.length ? blocks.join('\n\n') : '_No performance data available._';
}

function fmtFinancial(fin) {
  if (!fin) return '- _Not retrieved — financial benchmarking tool may require JavaScript rendering._';
  const lines = [];
  if (fin.incomePerPupil)      lines.push(`- Income per pupil: ${fin.incomePerPupil}`);
  if (fin.expenditurePerPupil) lines.push(`- Expenditure per pupil: ${fin.expenditurePerPupil}`);
  if (fin.staffCostsPct)       lines.push(`- Staff costs as % of expenditure: ${fin.staffCostsPct}`);
  if (fin.revenueBalance)      lines.push(`- Revenue balance per pupil: ${fin.revenueBalance}`);
  if (fin.totalIncome)         lines.push(`- Total income: ${fin.totalIncome}`);
  return lines.length ? lines.join('\n') : '- _No financial figures parsed._';
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
  const { input, identity, ofsted, performance, financial } = school;
  const name = identity?.officialName ?? input;
  const urn  = identity?.urn;

  const identityBlock = identity
    ? [
        `- Official name: ${identity.officialName}`,
        `- URN: ${urn}`,
        `- Type: ${identity.type ?? 'Unknown'}`,
        `- Phase / age range: ${identity.phase ?? 'Unknown'}`,
        `- Local authority: ${identity.la ?? performance?.laName ?? 'Unknown'}`,
        `- Independent school: ${identity.isIndependent ? 'Yes' : 'No'}`,
        '',
        '  Government profile links:',
        ...govLinks(urn).map(u => `  - ${u}`),
      ].join('\n')
    : `- Search term used: "${input}"\n- URN: _Not found — check the school name spelling and search GIAS manually._`;

  return `
---
## Pre-Fetched Government Data — ${name}

> These fields were retrieved automatically from UK government sources before this research call.
> **Use the figures below directly.** Do not re-search sources where data is already populated.
> Where a field shows "_Not retrieved_", include that source in your web search steps.

### School Identity (GIAS)
${identityBlock}

### 1. Academic Results
${fmtAcademicResults(performance, identity?.phase)}

**Financial benchmarking** (financial-benchmarking-and-insights-tool.education.gov.uk)
${fmtFinancial(financial)}

### 2. Latest Inspection Outcomes
${fmtOfsted(ofsted, identity?.isIndependent ?? false)}
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

      const [ofsted, performance, financial] = await Promise.all([
        identity.isIndependent ? Promise.resolve(null) : getOfstedData(urn),
        getPerformanceData(urn),
        getFinancialData(urn),
      ]);

      return { input: name, identity, ofsted, performance, financial };
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
