/**
 * Debug script — fetches all gov.uk data for a school and prints:
 *   1. SLIM BLOCK       — exactly what gets injected into the AI prompt (~1,800 tokens)
 *   2. FULL REPORT      — complete human-readable data review (all raw fields)
 *   3. STRUCTURED SECTS — the backend-authored Part A sections (A1–A7)
 *
 * Does NOT need an OpenAI API key.
 * Run:  node debug-govuk.mjs
 */

import {
  lookupSchoolURN,
  getGIASDetails,
  getOfstedData,
  getPerformanceData,
  getFinancialData,
  getAreaData,
  fetchAndParseOfstedPdf,
  fetchParentView,
  buildDetailedBlock,
  buildSlimBlock,
  buildStructuredSections,
} from './govuk.js';
import { getSchoolEthnicity } from './local-data.js';

// ── Change these to test different schools ─────────────────────────────────
const SCHOOL_NAME = 'The Latymer School';
const BRANCH      = 'prompt_branch_1';   // 'prompt_branch_1' or 'prompt_branch_2'
// ──────────────────────────────────────────────────────────────────────────

// Inline buildStructuredSections so we can print structured sections too
// (avoids having to export it from govuk.js)
async function run() {
  const detailed = BRANCH === 'prompt_branch_1';

  console.log(`\n🔍 Looking up: "${SCHOOL_NAME}"\n`);

  const baseIdentity = await lookupSchoolURN(SCHOOL_NAME);
  if (!baseIdentity) { console.error('URN lookup failed'); process.exit(1); }
  const urn = baseIdentity.urn;
  console.log(`✅ Found: ${baseIdentity.officialName}  URN: ${urn}  (${baseIdentity.type ?? '?'})  independent: ${baseIdentity.isIndependent}`);

  // Phase 1: Ofsted HTML
  const ofstedBase = baseIdentity.isIndependent ? null : await getOfstedData(urn);
  if (ofstedBase) {
    console.log(`✅ Ofsted: ${ofstedBase.overall ?? 'no grade'}  (${ofstedBase.date ?? 'no date'})  PDF: ${ofstedBase.reportUrl ?? 'none'}`);
  } else {
    console.log(`ℹ️  No Ofsted data (independent or fetch failed)`);
  }

  // Phase 2: GIAS detail + PDF + performance + financial + Parent View — parallel
  const [giasDetails, pdfSections, performance, financial, parentView] = await Promise.all([
    getGIASDetails(urn),
    detailed && ofstedBase?.reportUrl ? fetchAndParseOfstedPdf(ofstedBase.reportUrl) : Promise.resolve(null),
    getPerformanceData(urn),
    getFinancialData(urn),
    baseIdentity.isIndependent ? Promise.resolve(null) : fetchParentView(urn),
  ]);

  if (giasDetails) {
    console.log(`✅ GIAS details: ${Object.keys(giasDetails).join(', ')}`);
  } else {
    console.log(`ℹ️  GIAS details: not retrieved`);
  }

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

  if (parentView) console.log(`✅ Parent View: ${parentView.totalResponses} responses  wouldRecommend=${parentView.wouldRecommend ?? '?'}%`);
  else console.log(`ℹ️  Parent View: not retrieved`);

  // Merge identity
  const identity = { ...baseIdentity, ...(giasDetails ?? {}) };

  // Phase 3: area data — prefer GIAS postcode, fall back to DfE CSV PCODE
  const postcode = identity.postcode
    ?? Object.values(performance ?? {}).flat().find(r => r.variable === 'PCODE')?.value
    ?? null;
  console.log(`\nPostcode: ${postcode ?? '(not found)'}`);
  const area = detailed && postcode ? await getAreaData(postcode) : null;
  if (area) {
    console.log(`✅ Area: district=${area.district}  IMD decile=${area.imd?.imdDecile ?? '?'}  income=${area.crystalRoof?.income?.meanAnnualHouseholdIncome ?? '?'}  price=${area.pricePaid?.medianAllTypes ?? '?'}`);
  } else {
    console.log(`ℹ️  Area: not retrieved`);
  }

  // Bundled local data
  const schoolEthnicity = getSchoolEthnicity(urn);
  console.log(`✅ School ethnicity (local): ${schoolEthnicity ? `${schoolEthnicity.yr}` : 'not found'}`);

  // Build merged ofsted object
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
    parentView:                    parentView                           ?? null,
  } : null;

  const school = { input: SCHOOL_NAME, identity, ofsted, performance, financial, area, schoolEthnicity };

  // ── 0. STRUCTURED SECTIONS — what the backend injects directly into the FE ──
  const structuredSections = buildStructuredSections(school);
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`STRUCTURED SECTIONS (A1–A8)  —  ${structuredSections.length} sections built`);
  console.log('═'.repeat(72));
  for (const s of structuredSections) {
    console.log(`\n--- ${s.heading} (flag: ${s.flag}) ---`);
    console.log(s.body);
  }

  // ── 1. SLIM BLOCK — what the AI model actually receives ────────────────────
  const slim = buildSlimBlock(school);
  const slimTokens = Math.ceil(slim.length / 4);
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`SLIM BLOCK (prompt injection)  —  ~${slim.length} chars / ~${slimTokens} tokens`);
  console.log('═'.repeat(72));
  console.log(slim);

  // ── 2. FULL REPORT — complete human-readable data review ───────────────────
  console.log(`\n\n${'═'.repeat(72)}`);
  console.log('FULL REPORT (human review — NOT injected into prompt)');
  console.log('═'.repeat(72));
  console.log(buildDetailedBlock(school));

  // ── 3. RAW IDENTITY OBJECT ─────────────────────────────────────────────────
  console.log(`\n\n${'═'.repeat(72)}`);
  console.log('RAW IDENTITY OBJECT (merged GIAS search tile + detail page)');
  console.log('═'.repeat(72));
  console.log(JSON.stringify(identity, null, 2));

  // ── 4. RAW PARENT VIEW ─────────────────────────────────────────────────────
  if (parentView) {
    console.log(`\n\n${'═'.repeat(72)}`);
    console.log('RAW PARENT VIEW DATA');
    console.log('═'.repeat(72));
    console.log(JSON.stringify(parentView, null, 2));
  }

  // ── 5. PERFORMANCE DATA DUMP (all namespaces, all variables) ──────────────
  if (performance) {
    console.log(`\n\n${'═'.repeat(72)}`);
    console.log('PERFORMANCE DATA — all namespaces');
    console.log('═'.repeat(72));
    for (const [ns, rows] of Object.entries(performance)) {
      console.log(`\n--- ${ns} (${rows.length} rows) ---`);
      for (const { variable, value, description } of rows) {
        console.log(`  ${variable.padEnd(35)} ${String(value).padEnd(15)} ${description?.slice(0, 80) ?? ''}`);
      }
    }
  }

  console.log('\n\nDone.\n');
}

run().catch(err => { console.error(err); process.exit(1); });
