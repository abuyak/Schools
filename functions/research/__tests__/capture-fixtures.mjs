/**
 * capture-fixtures.mjs
 *
 * Fetches real data from government APIs for each reference school and saves:
 *   __tests__/fixtures/{urn}.json     — raw school data object (passed to buildSlimBlock)
 *   __tests__/snapshots/{urn}.slim.md — rendered slim block output (golden reference)
 *
 * Run manually whenever the reference schools need refreshing:
 *   node functions/research/__tests__/capture-fixtures.mjs
 *
 * This script hits real APIs — do NOT run in CI. It runs in parallel but
 * will take 30–90 seconds per school depending on PDF download speed.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  lookupSchoolURN,
  extractLocationHints,
  getGIASDetails,
  getOfstedData,
  getPerformanceData,
  getFinancialData,
  getAreaData,
  getLAPerformanceKS2,
  getLAPerformanceKS4,
  buildSlimBlock,
} from '../govuk.js';

import { getSchoolEthnicity } from '../local-data.js';
import { getISIInspection } from '../independent.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR  = join(__dir, 'fixtures');
const SNAPSHOTS_DIR = join(__dir, 'snapshots');
mkdirSync(FIXTURES_DIR,  { recursive: true });
mkdirSync(SNAPSHOTS_DIR, { recursive: true });

// ── Reference school registry ──────────────────────────────────────────────
// Each entry: { urn, name, postcode, label }
// label = short slug used in test assertions
const SCHOOLS = [
  {
    urn:      124987,
    name:     'Earlswood Infant and Nursery School',
    postcode: 'RH1 6DZ',
    label:    'state-infant',
    note:     'KS1 only — no KS2/KS4/KS5 data expected',
  },
  {
    urn:      125068,
    name:     'Earlswood Junior School',
    postcode: 'RH1 6JX',
    label:    'state-junior',
    note:     'KS2 only — no KS1 or KS4',
  },
  {
    urn:      137648,
    name:     'Redriff Primary',
    postcode: 'SE16 5LQ',
    label:    'state-primary',
    note:     'KS1 + KS2 — largest data set for primary',
  },
  {
    urn:      145217,
    name:     'Reigate School',
    postcode: 'RH2 7NT',
    label:    'state-secondary',
    note:     'KS4 only — Attainment 8, Progress 8, EBacc',
  },
  {
    urn:      145005,
    name:     'Reigate College',
    postcode: 'RH2 0SD',
    label:    'state-sixth-form',
    note:     'KS5 only — no KS2 or KS4',
  },
  {
    urn:      102055,
    name:     'The Latymer School',
    postcode: 'N9 9TN',
    label:    'state-secondary-sixth',
    note:     'KS4 + KS5 — grammar with sixth form',
  },
  {
    urn:      125357,
    name:     'Micklefield School',
    postcode: 'RH2 9DU',
    label:    'independent-primary',
    note:     'Independent — no Ofsted, no DfE performance; ISI expected',
  },
  {
    urn:      125427,
    name:     'Caterham School',
    postcode: 'CR3 6YA',
    label:    'independent-secondary',
    note:     'Independent secondary — fees, ISI, no DfE data',
  },
  {
    urn:      100065,
    name:     'University College School',
    postcode: 'NW3 6XH',
    label:    'independent-all-through',
    note:     'Independent all-through — broadest independent case',
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────
const hr = (n = 60) => '─'.repeat(n);
const ok  = (m) => console.log(`  ✅  ${m}`);
const nil = (m) => console.log(`  —   ${m}`);
const err = (m) => console.error(`  ❌  ${m}`);

async function captureOne(school) {
  const { urn, name, postcode, label } = school;
  console.log(`\n${hr()}\n  ${label.toUpperCase()} — URN ${urn} — ${name}\n${hr()}\n`);

  // 1. URN lookup with postcode hint for disambiguation
  const locationHints = extractLocationHints(`${name} ${postcode}`);
  const identity = await lookupSchoolURN(name, locationHints);

  if (!identity) {
    err(`URN lookup failed for "${name}"`);
    return;
  }
  if (String(identity.urn) !== String(urn)) {
    err(`URN MISMATCH — expected ${urn}, got ${identity.urn} (${identity.officialName})`);
    err('Fix the school name or postcode hint and re-run.');
    return;
  }
  ok(`${identity.officialName} · URN ${identity.urn} · ${identity.phase ?? '?'} · ${identity.la ?? '?'}`);

  // 2. GIAS detail
  const giasDetails = await getGIASDetails(urn).catch(() => null);
  if (giasDetails) ok(`GIAS: capacity ${giasDetails.capacity ?? '—'}`);
  else nil('GIAS detail not retrieved');

  // 3. Inspection data — Ofsted for state, ISI for independent
  let ofstedBase = null;
  if (identity.isIndependent) {
    ofstedBase = await getISIInspection(urn, identity.officialName).catch(() => null);
    if (ofstedBase) ok(`ISI: ${ofstedBase.overall} (${ofstedBase.date})`);
    else nil('ISI inspection not retrieved');
  } else {
    ofstedBase = await getOfstedData(urn).catch(() => null);
    if (ofstedBase) ok(`Ofsted: ${ofstedBase.overall} (${ofstedBase.date})`);
    else nil('Ofsted not retrieved');
  }

  // 4. Performance + financial — in parallel
  // Ofsted PDF fetch and sub-grade merge is now handled inside getOfstedData/getISIInspection.
  const [performance, financial] = await Promise.all([
    getPerformanceData(urn).catch(() => null),
    identity.isIndependent ? Promise.resolve(null) : getFinancialData(urn).catch(() => null),
  ]);

  if (identity.isIndependent) {
    if (ofstedBase?.keyFindings) ok(`ISI key findings: ${ofstedBase.keyFindings.length} chars`);
    else nil('ISI key findings not extracted');
  } else if (ofstedBase?.pupilExperience) {
    ok(`PDF: pupilExperience ${ofstedBase.pupilExperience.length} chars`);
  } else {
    nil('PDF not parsed');
  }
  if (performance) ok(`Performance: ${Object.keys(performance).join(', ')}`);
  else nil('Performance not retrieved');
  if (identity.isIndependent) nil('Financial: not available for independent schools');
  else if (financial) ok(`Financial: spend/pupil ${financial.totalSpendPerPupil ?? '—'}`);
  else nil('Financial not retrieved');

  // 5. Area data — postcode from DfE CSV, falling back to identity.postcode (GIAS search tile)
  // for infant/nursery schools that have no KS2/KS4 namespace and thus no PCODE in the CSV.
  const csvPostcode = Object.values(performance ?? {}).flat().find(r => r.variable === 'PCODE')?.value
    ?? identity?.postcode
    ?? null;
  const area = csvPostcode ? await getAreaData(csvPostcode).catch(() => null) : null;
  if (area) ok(`Area: IMD ${area.imd?.imdDecile ?? '—'}/10 · income £${area.crystalRoof?.income?.meanAnnualHouseholdIncome ?? '—'}`);
  else nil(`Area not retrieved (postcode: ${csvPostcode ?? 'not in CSV'})`);

  // 6. LA performance KS2 (primary schools only)
  const isPrimary = /primary|junior|infant|middle.*primary/i.test(identity.phase ?? '');
  const isSecondary = /secondary|all.through/i.test(identity.phase ?? '');
  const laCode = area?.laCode ?? null;
  const laPerf = isPrimary && laCode
    ? await getLAPerformanceKS2(laCode).catch(() => null)
    : isSecondary && laCode
      ? await getLAPerformanceKS4(laCode).catch(() => null)
      : null;
  if (laPerf) {
    if (laPerf.att8 !== undefined) ok(`LA KS4: att8 ${laPerf.att8 ?? '—'}  p8 ${laPerf.p8 ?? '—'}  grade5Em ${laPerf.grade5Em ?? '—'}`);
    else if (laPerf.rwm) ok(`LA KS2: RWM exp ${laPerf.rwm?.expected ?? '—'}%  higher ${laPerf.rwm?.higher ?? '—'}%`);
  } else if (isPrimary || isSecondary) {
    nil(`LA ${isPrimary ? 'KS2' : 'KS4'}: not retrieved (laCode: ${laCode ?? 'missing'})`);
  } else {
    nil('LA: not a primary or secondary school');
  }

  // 9. Local ethnicity index
  const schoolEthnicity = getSchoolEthnicity(urn);
  if (schoolEthnicity) ok(`Ethnicity index: W${schoolEthnicity.w}% A${schoolEthnicity.a}% B${schoolEthnicity.b}%`);
  else nil('Ethnicity index: URN not in bundle');

  // 8. Ofsted object is now fully enriched by getOfstedData/getISIInspection.
  const ofsted = identity.isIndependent
    ? ofstedBase  // ISI data is self-contained (enriched inside getISIInspection)
    : ofstedBase; // Ofsted data is already enriched with PDFs inside getOfstedData

  const schoolObj = { input: name, identity, ofsted, performance, financial, area, laPerf, schoolEthnicity, giasDetails };

  // 10. Render slim block
  const slim = buildSlimBlock(schoolObj);
  ok(`Slim block: ${slim.length} chars / ~${Math.ceil(slim.length / 4)} tokens`);

  // 11. Save fixture (JSON) — strip non-serialisable bits
  const fixtureData = {
    _meta: {
      urn,
      label,
      capturedAt: new Date().toISOString(),
      note: school.note,
    },
    input: name,
    identity,
    ofsted,
    performance,
    financial,
    area,
    laPerf,
    schoolEthnicity,
    giasDetails,
  };

  writeFileSync(
    join(FIXTURES_DIR, `${urn}.json`),
    JSON.stringify(fixtureData, null, 2),
  );
  ok(`Saved fixtures/${urn}.json`);

  // 12. Save snapshot (slim block output)
  writeFileSync(
    join(SNAPSHOTS_DIR, `${urn}.slim.md`),
    `<!-- ${label} · URN ${urn} · captured ${new Date().toISOString()} -->\n\n${slim}\n`,
  );
  ok(`Saved snapshots/${urn}.slim.md`);
}

// ── Run ────────────────────────────────────────────────────────────────────
// Default: capture all schools. Pass URNs as args to capture specific ones.
const targetUrns = process.argv.slice(2).map(Number).filter(Boolean);
const toCapture  = targetUrns.length
  ? SCHOOLS.filter(s => targetUrns.includes(s.urn))
  : SCHOOLS;

console.log(`\nCapturing ${toCapture.length} school(s)…`);

for (const school of toCapture) {
  await captureOne(school).catch(e => {
    console.error(`\n  ❌  FATAL for URN ${school.urn}: ${e.message}`);
    console.error(e.stack);
  });
}

console.log(`\n${'═'.repeat(60)}\nDone.\n`);
