/**
 * debug-govuk.mjs — end-to-end traceability for a single school.
 *
 * Shows the full lineage:
 *   Request → API calls → data fetched → section mapping → prompt block
 *
 * Run:  node debug-govuk.mjs
 * Or:   GOVUK_VERBOSE_LOGS=1 node debug-govuk.mjs  (to see per-URL fetch detail)
 */

import {
  lookupSchoolURN,
  getGIASDetails,
  getOfstedData,
  fetchAndParseOfstedPdf,
  getPerformanceData,
  getFinancialData,
  getAreaData,
  getLAPerformanceKS2,
  buildSlimBlock,
  extractLocationHints,
} from './govuk.js';
import { getSchoolEthnicity } from './local-data.js';

// ── Change this to test different schools ─────────────────────────────────
// Write the question exactly as a parent would — including postcode, borough,
// or area name. The debug tool mirrors the real pipeline: it extracts the
// school name via regex, extracts location hints, then calls lookupSchoolURN
// with both — so you'll catch wrong-school disambiguation bugs here.
const QUESTION = 'Riverside Primary School SE16 Bermondsey';
// ──────────────────────────────────────────────────────────────────────────

// Replicate the name-extraction step that fetchGovDataForPrompt performs.
// Regex pulls the school name; anything else (postcode, area) stays as location hints.
const NAME_PATTERN =
  /\b([A-Z][a-zA-Z'-]+(?:\s+(?:of|the|and|&|St\.?|Saint|de|la|les|upon|at)?\s*[A-Z][a-zA-Z'-]+){0,6}\s+(?:School|College|Academy|Grammar|Primary|Secondary|Prep|Preparatory|Infant|Junior|Senior|High|Upper|Lower|Middle|Foundation|Free\s+School|Sixth\s+Form|Nursery|Convent))\b/g;
const extractedNames = [...new Set([...QUESTION.matchAll(NAME_PATTERN)].map(m => m[1].trim()))];
const SCHOOL_NAME    = extractedNames[0] ?? QUESTION;   // fallback to full string if regex misses
const locationHints  = extractLocationHints(QUESTION);

console.log(`\nExtracted name : "${SCHOOL_NAME}"`);
console.log(`Location hints : ${locationHints.length ? locationHints.join(', ') : '(none)'}`);

const hr  = (ch = '─', n = 72) => ch.repeat(n);
const ok  = (msg) => console.log(`  ✅  ${msg}`);
const nil = (msg) => console.log(`  —   ${msg}`);
const err = (msg) => console.log(`  ❌  ${msg}`);

function val(v, fallback = '—') {
  return v != null ? String(v) : fallback;
}

// ── Helper: search performance namespaces for a variable ──────────────────
function perfVar(performance, code) {
  if (!performance) return null;
  const sorted = Object.entries(performance)
    .sort(([a], [b]) => (parseInt(b.match(/_(\d+)$/)?.[1] ?? '0', 10) - parseInt(a.match(/_(\d+)$/)?.[1] ?? '0', 10)))
    .flatMap(([, rows]) => rows);
  return sorted.find(r => r.variable === code)?.value ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${hr('═')}`);
console.log(`  GOVUK DEBUG — "${SCHOOL_NAME}"`);
console.log(`${hr('═')}\n`);

// ══════════════════════════════════════════════════════════════════════════════
// 1 — API CALLS
// ══════════════════════════════════════════════════════════════════════════════
console.log(`${hr()}\n  1. API CALLS\n${hr()}\n`);

// GIAS URN lookup
console.log('GIAS URN lookup:');
const identity = await lookupSchoolURN(SCHOOL_NAME, locationHints);
if (identity) {
  ok(`"${identity.officialName}"  URN ${identity.urn}  ${identity.type ?? '?'}  ${identity.phase ?? '?'}  LA: ${identity.la ?? '?'}  independent: ${identity.isIndependent}`);
} else {
  err('URN not found — check spelling or try the full official name');
  process.exit(1);
}
const urn = identity.urn;

// GIAS detail page (capacity — only field not in DfE CSV)
console.log('\nGIAS detail page:');
const giasDetails = await getGIASDetails(urn);
if (giasDetails) {
  ok(`capacity: ${val(giasDetails.capacity)}  postcode: ${val(giasDetails.postcode)}`);
} else {
  nil('not retrieved');
}

// Ofsted grades
console.log('\nOfsted inspection page:');
const ofstedBase = identity.isIndependent ? null : await getOfstedData(urn);
if (ofstedBase) {
  ok(`grade: ${val(ofstedBase.overall)}  date: ${val(ofstedBase.date)}  safeguarding: ${val(ofstedBase.safeguarding)}`);
  ok(`PDF: ${ofstedBase.reportUrl ?? 'no link found'}`);
} else if (identity.isIndependent) {
  nil('independent school — Ofsted not applicable');
} else {
  err('fetch failed');
}

// Ofsted PDF
console.log('\nOfsted PDF parse:');
const pdfSections = (ofstedBase?.reportUrl)
  ? await fetchAndParseOfstedPdf(ofstedBase.reportUrl)
  : null;
if (pdfSections) {
  ok(`pupilExperience: ${pdfSections.pupilExperience ? `${pdfSections.pupilExperience.length} chars` : 'not found'}`);
  ok(`nextSteps: ${pdfSections.nextSteps ? `${pdfSections.nextSteps.length} chars` : 'not found'}`);
  ok(`qualityOfEducation: ${pdfSections.qualityOfEducation ? 'found' : 'not found'}`);
  ok(`behaviourAndAttitudes: ${pdfSections.behaviourAndAttitudes ? 'found' : 'not found'}`);
  ok(`personalDevelopment: ${pdfSections.personalDevelopment ? 'found' : 'not found'}`);
  ok(`leadershipAndManagement: ${pdfSections.leadershipAndManagement ? 'found' : 'not found'}`);
} else {
  nil('not extracted (no report URL, or parse failed)');
}

// DfE performance CSV
console.log('\nDfE performance CSV:');
const performance = await getPerformanceData(urn);
if (performance) {
  const summary = Object.entries(performance)
    .map(([ns, rows]) => `${ns}(${rows.length} vars)`)
    .join('  ');
  ok(summary);
} else {
  err('not retrieved');
}

// FBIT financial
console.log('\nFBIT financial:');
const financial = await getFinancialData(urn);
if (financial) {
  ok(`spend/pupil: ${val(financial.totalSpendPerPupil)}  PTR: ${val(financial.pupilTeacherRatio)}:1  QTS: ${val(financial.qualifiedTeachersPct)}  balance: ${val(financial.inYearBalance)}`);
} else {
  nil('not retrieved');
}

// Area data
const postcode = perfVar(performance, 'PCODE');
console.log(`\nArea data  (postcode: ${postcode ?? 'not in DfE CSV'}):`);
const area = postcode ? await getAreaData(postcode) : null;
if (area) {
  ok(`district: ${val(area.district)}  IMD decile: ${val(area.imd?.imdDecile)}/10  income: ${val(area.crystalRoof?.income?.meanAnnualHouseholdIncome)}  median price: ${val(area.pricePaid?.medianAllTypes)}`);
  ok(`ethnicity: ${area.ethnicity ? Object.keys(area.ethnicity).length + ' groups' : 'not retrieved'}`);
} else {
  nil('not retrieved — no postcode or postcode lookup failed');
}

// LA performance (KS2) via EES API
const isPrimary = /primary|junior|infant|middle.*primary/i.test(identity.phase ?? '');
const laCode = area?.laCode ?? null;
console.log(`\nLA performance KS2  (laCode: ${laCode ?? 'not available'}, isPrimary: ${isPrimary}):`);
const laPerf = isPrimary && laCode ? await getLAPerformanceKS2(laCode).catch(e => { console.error('  ❌ ', e.message); return null; }) : null;
if (laPerf) {
  const subjects = Object.entries(laPerf).map(([k, v]) => `${k}: exp ${v.expected ?? '—'}%`).join('  ');
  ok(subjects);
} else if (!isPrimary) {
  nil('not a primary school — LA KS2 averages not applicable');
} else {
  nil('not retrieved');
}

// Local DfE ethnicity index (zero-latency)
console.log('\nDfE school ethnicity (local index):');
const schoolEthnicity = getSchoolEthnicity(urn);
if (schoolEthnicity) {
  ok(`White ${schoolEthnicity.w}%  Asian ${schoolEthnicity.a}%  Black ${schoolEthnicity.b}%  Mixed ${schoolEthnicity.m}%  (${schoolEthnicity.yr})`);
} else {
  nil('URN not in bundled index');
}

// ══════════════════════════════════════════════════════════════════════════════
// 2 — SECTION MAPPING (which data populates which prompt section)
// ══════════════════════════════════════════════════════════════════════════════
console.log(`\n${hr()}\n  2. SECTION MAPPING  (Request → data → prompt section)\n${hr()}\n`);

const pv = (code) => perfVar(performance, code);

const sections = [
  {
    section: 'A1. School Identity',
    source:  'GIAS',
    status:  !!identity,
    detail:  identity
      ? `URN ${identity.urn} · ${identity.type ?? '?'} · ${identity.phase ?? '?'} · LA: ${identity.la ?? '?'} · capacity: ${val(giasDetails?.capacity)}`
      : 'not resolved',
  },
  {
    section: 'A2. Ofsted Inspection Grades',
    source:  'Ofsted inspection page',
    status:  !!ofstedBase,
    detail:  ofstedBase
      ? `Overall: ${val(ofstedBase.overall)} · QoE: ${val(ofstedBase.qualityOfEducation)} · B&A: ${val(ofstedBase.behaviour)} · PD: ${val(ofstedBase.personalDevelopment)} · L&M: ${val(ofstedBase.leadership)}`
      : 'not retrieved',
  },
  {
    section: 'A3. What It\'s Like to Be a Pupil',
    source:  'Ofsted PDF',
    status:  !!pdfSections?.pupilExperience,
    detail:  pdfSections?.pupilExperience
      ? `${pdfSections.pupilExperience.length} chars extracted`
      : 'not extracted',
  },
  {
    section: 'A4. What the School Needs to Improve',
    source:  'Ofsted PDF',
    status:  !!pdfSections?.nextSteps,
    detail:  pdfSections?.nextSteps
      ? `${pdfSections.nextSteps.length} chars extracted`
      : pdfSections ? 'section not found in PDF' : 'PDF not parsed',
  },
  {
    section: 'A5. Pupil Census',
    source:  'DfE CSV (CENSUS namespace) + DfE ethnicity index',
    status:  !!(performance?.CENSUS_25 || performance?.CENSUS_24 || schoolEthnicity),
    detail:  [
      pv('NOR')          ? `NOR: ${pv('NOR')}`                     : null,
      pv('PNUMFSMEVER')  ? `FSM: ${pv('PNUMFSMEVER')}`              : null,
      pv('PEALGRP')      ? `EAL: ${pv('PEALGRP')}`                 : null,
      pv('PSENELK')      ? `SEN support: ${pv('PSENELK')}`         : null,
      pv('PSENELSE')     ? `EHC plan: ${pv('PSENELSE')}`           : null,
      schoolEthnicity    ? `ethnicity index: ✅`                    : `ethnicity index: —`,
    ].filter(Boolean).join('  ·  ') || 'not retrieved',
  },
  {
    section: 'A6. Academic Performance',
    source:  'DfE CSV (KS2 / KS4 / KS5 namespaces)',
    status:  !!(pv('PTRWM_EXP') || pv('ATT8SCR') || pv('P8MEA')),
    detail:  [
      pv('PTRWM_EXP') ? `KS2 RWM: ${pv('PTRWM_EXP')}%`            : null,
      pv('ATT8SCR')   ? `Att8: ${pv('ATT8SCR')}`                   : null,
      pv('P8MEA')     ? `P8: ${pv('P8MEA')}`                       : null,
      pv('PTL2BASICS_95') ? `Gr5+ E&M: ${pv('PTL2BASICS_95')}%`   : null,
    ].filter(Boolean).join('  ·  ') || 'not retrieved',
  },
  {
    section: 'A7. Absence',
    source:  'DfE CSV (CENSUS namespace)',
    status:  !!(pv('PERCTOT') || pv('PPERSABS10')),
    detail:  [
      pv('PERCTOT')    ? `overall: ${pv('PERCTOT')}%`              : null,
      pv('PPERSABS10') ? `persistent: ${pv('PPERSABS10')}%`        : null,
    ].filter(Boolean).join('  ·  ') || 'not retrieved',
  },
  {
    section: 'A8. Financial Position and Staffing',
    source:  'FBIT (spending page + census ZIP)',
    status:  !!financial,
    detail:  financial
      ? `spend/pupil: ${val(financial.totalSpendPerPupil)} · PTR: ${val(financial.pupilTeacherRatio)}:1 · QTS: ${val(financial.qualifiedTeachersPct)} · balance: ${val(financial.inYearBalance)}`
      : 'not retrieved',
  },
  {
    section: 'A9. Area Profile',
    source:  'postcodes.io → ONS / Land Registry / IMD / CrystalRoof',
    status:  !!area,
    detail:  area
      ? `IMD decile: ${val(area.imd?.imdDecile)}/10 · income: ${val(area.crystalRoof?.income?.meanAnnualHouseholdIncome)} · price: ${val(area.pricePaid?.medianAllTypes)} · ethnicity groups: ${area.ethnicity ? Object.keys(area.ethnicity).length : '—'}`
      : 'not retrieved',
  },
];

const colW = 38;
for (const s of sections) {
  const icon   = s.status ? '✅' : '—  ';
  const label  = s.section.padEnd(colW);
  console.log(`  ${icon}  ${label}  ← ${s.source}`);
  console.log(`         ${''.padEnd(colW)}  ${s.detail}`);
  console.log();
}

// ══════════════════════════════════════════════════════════════════════════════
// 3 — SLIM BLOCK (exactly what is injected into the AI prompt)
// ══════════════════════════════════════════════════════════════════════════════
console.log(`${hr()}\n  3. SLIM BLOCK — what the AI model receives\n${hr()}\n`);

const ofstedFull = ofstedBase ? {
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

const school = { input: SCHOOL_NAME, identity, ofsted: ofstedFull, performance, financial, area, laPerf, schoolEthnicity, giasDetails };
const slim = buildSlimBlock(school);
console.log(slim);
console.log(`\n~${slim.length} chars  /  ~${Math.ceil(slim.length / 4)} tokens`);
console.log(`\n${hr('═')}\n`);
