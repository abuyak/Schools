/**
 * Debug script — fetches all gov.uk data for a school and prints:
 *   1. SLIM BLOCK  — exactly what gets injected into the AI prompt (~1,800 tokens)
 *   2. FULL REPORT — complete human-readable data review (all raw fields)
 *
 * Does NOT need an OpenAI API key.
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
  buildSlimBlock,
} from './govuk.js';

// ── Change these to test different schools ─────────────────────────────────
const SCHOOL_NAME = 'Alfred Salter School';
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
  console.log(`✅ Performance namespaces: ${nsByCount}`);
} else {
  console.log(`ℹ️  Performance: not retrieved`);
}

if (financial) console.log(`✅ Financial: spend/pupil=${financial.totalSpendPerPupil ?? '?'}  PTR=${financial.pupilTeacherRatio ?? '?'}:1`);
else console.log(`ℹ️  Financial: not retrieved`);

// Phase 3: area data
const postcode = Object.values(performance ?? {}).flat().find(r => r.variable === 'PCODE')?.value ?? null;
console.log(`\nPostcode from DfE CSV: ${postcode ?? '(not found)'}`);
const area = detailed && postcode ? await getAreaData(postcode) : null;
if (area) {
  console.log(`✅ Area: district=${area.district}  IMD decile=${area.imd?.imdDecile ?? '?'}  income=${area.crystalRoof?.income?.meanAnnualHouseholdIncome ?? '?'}  price=${area.pricePaid?.medianAllTypes ?? '?'}`);
} else {
  console.log(`ℹ️  Area: not retrieved`);
}

// Build full ofsted object (grades + PDF sections merged)
const ofstedFull = ofstedBase ? {
  ...ofstedBase,
  pupilExperience:         pdfSections?.pupilExperience         ?? null,
  qualityOfEducation:      pdfSections?.qualityOfEducation      ?? null,
  behaviourAndAttitudes:   pdfSections?.behaviourAndAttitudes   ?? null,
  personalDevelopment:     pdfSections?.personalDevelopment     ?? null,
  leadershipAndManagement: pdfSections?.leadershipAndManagement ?? null,
  achievement:             pdfSections?.achievement             ?? null,
  inclusion:               pdfSections?.inclusion               ?? null,
  nextSteps:               pdfSections?.nextSteps               ?? null,
} : null;

const school = { input: SCHOOL_NAME, identity, ofsted: ofstedFull, performance, financial, area };

// ── 1. SLIM BLOCK — what the AI model actually receives ───────────────────
const slim = buildSlimBlock(school);
const slimTokens = Math.ceil(slim.length / 4);
console.log(`\n${'═'.repeat(72)}`);
console.log(`SLIM BLOCK (prompt injection)  —  ~${slim.length} chars / ~${slimTokens} tokens`);
console.log('═'.repeat(72));
console.log(slim);

// ── 2. FULL REPORT — complete human-readable data review ──────────────────
console.log(`\n\n${'═'.repeat(72)}`);
console.log('FULL REPORT (human review — NOT injected into prompt)');
console.log('═'.repeat(72));
console.log(buildDetailedBlock(school));

console.log('\n\nDone.\n');
