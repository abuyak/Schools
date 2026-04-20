/**
 * Debug script — calls gov.uk fetches directly and prints the formatted block.
 * Does NOT need an OpenAI API key (name extraction done manually below).
 *
 * Run:  node debug-govuk.mjs
 */

import {
  lookupSchoolURN,
  getOfstedData,
  getPerformanceData,
  getFinancialData,
  getAreaData,
  fetchAndParseOfstedPdf,
  buildDetailedBlock,
} from './govuk.js';

// ── Change these to test different schools ─────────────────────────────────
const SCHOOL_NAME = 'St James the Great Catholic Primary School';
const BRANCH      = 'prompt_branch_1';   // 'prompt_branch_1' or 'prompt_branch_2'
// ──────────────────────────────────────────────────────────────────────────

const detailed = BRANCH === 'prompt_branch_1';

console.log(`\n🔍 Looking up: "${SCHOOL_NAME}"\n`);

const identity = await lookupSchoolURN(SCHOOL_NAME);
if (!identity) { console.error('URN lookup failed'); process.exit(1); }
console.log(`✅ Found: ${identity.officialName}  URN: ${identity.urn}  (${identity.type ?? '?'})`);

const urn = identity.urn;

// Phase 1: Ofsted
const ofstedBase = identity.isIndependent ? null : await getOfstedData(urn);
if (ofstedBase) {
  console.log(`✅ Ofsted: ${ofstedBase.overall ?? 'no grade'}  (${ofstedBase.date ?? 'no date'})  PDF: ${ofstedBase.reportUrl ?? 'none'}`);
} else {
  console.log(`ℹ️  No Ofsted data (independent or fetch failed)`);
}

// Phase 2: PDF + performance + financial in parallel
const [pdfSections, performance, financial] = await Promise.all([
  detailed && ofstedBase?.reportUrl
    ? fetchAndParseOfstedPdf(ofstedBase.reportUrl)
    : Promise.resolve(null),
  getPerformanceData(urn),
  getFinancialData(urn),
]);

if (pdfSections) console.log(`✅ PDF extracted: pupilExperience=${!!pdfSections.pupilExperience}  nextSteps=${!!pdfSections.nextSteps}`);
else console.log(`ℹ️  PDF: not extracted`);

if (performance) {
  const nsByCount = Object.entries(performance).map(([ns, rows]) => `${ns}(${rows.length})`).join(', ');
  console.log(`✅ Performance: ${nsByCount}`);
} else {
  console.log(`ℹ️  Performance: not retrieved`);
}

if (financial) console.log(`✅ Financial:`, financial);
else console.log(`ℹ️  Financial: not retrieved`);

// Phase 3: area data
const postcode = Object.values(performance ?? {}).flat().find(r => r.variable === 'PCODE')?.value ?? null;
console.log(`\nPostcode from DfE CSV: ${postcode ?? '(not found)'}`);
const area = detailed && postcode ? await getAreaData(postcode) : null;
if (area) console.log(`✅ Area data:`, JSON.stringify(area, null, 2));
else console.log(`ℹ️  Area data: not retrieved`);

// ── Print the full performance data ───────────────────────────────────────
if (performance) {
  console.log('\n\n=== PERFORMANCE DATA (all namespaces) ===');
  for (const [ns, rows] of Object.entries(performance)) {
    console.log(`\n--- ${ns} ---`);
    for (const { variable, value, description } of rows) {
      console.log(`  ${variable}: ${value}  (${description})`);
    }
  }
}

// ── Print the Ofsted data object ───────────────────────────────────────────
if (ofstedBase || pdfSections) {
  const ofsted = ofstedBase ? { ...ofstedBase, pupilExperience: pdfSections?.pupilExperience ?? null, nextSteps: pdfSections?.nextSteps ?? null } : null;
  console.log('\n\n=== OFSTED DATA ===');
  console.log(JSON.stringify(ofsted, null, 2));
}

// ── Print the full formatted govuk block (exactly what gets injected into the prompt) ──
const ofstedFull = ofstedBase
  ? { ...ofstedBase, pupilExperience: pdfSections?.pupilExperience ?? null, nextSteps: pdfSections?.nextSteps ?? null }
  : null;

const school = { input: SCHOOL_NAME, identity, ofsted: ofstedFull, performance, financial, area };
console.log('\n\n=== FULL GOVUK BLOCK (injected into prompt) ===\n');
console.log(buildDetailedBlock(school));

console.log('\n\nDone.\n');
