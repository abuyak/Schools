/**
 * test-govuk.mjs
 * Usage:
 *   node test-govuk.mjs "Fortismere School"
 *   node test-govuk.mjs "Eton College" "Winchester College"
 */

import {
  lookupSchoolURN,
  getOfstedData,
  getPerformanceData,
  getFinancialData,
} from './functions/research/govuk.js';

const DIVIDER = '─'.repeat(60);

function printAcademicResults(perf) {
  if (!perf) { console.log('  Not retrieved.'); return; }
  for (const [namespace, rows] of Object.entries(perf)) {
    console.log(`  ${namespace}`);
    for (const { variable, value, description } of rows) {
      const desc = description ? ` (${description})` : '';
      console.log(`    ${variable}: ${value}${desc}`);
    }
  }
}

function printInspectionOutcomes(ofsted, isIndependent) {
  if (isIndependent) {
    console.log('  Independent school — ISI inspected, not Ofsted. Fetch ISI report from isi.net.');
    return;
  }
  if (!ofsted) { console.log('  Not retrieved.'); return; }

  console.log(`  Overall: ${ofsted.overall ?? '—'} (${ofsted.date ?? '—'})`);

  // New Nov-2025 report card areas
  if (ofsted.achievement)   console.log(`  Achievement:                   ${ofsted.achievement}`);
  if (ofsted.attendance)    console.log(`  Attendance & Behaviour:        ${ofsted.attendance}`);
  if (ofsted.curriculum)    console.log(`  Curriculum & Teaching:         ${ofsted.curriculum}`);
  if (ofsted.inclusion)     console.log(`  Inclusion:                     ${ofsted.inclusion}`);
  if (ofsted.leadershipGov) console.log(`  Leadership & Governance:       ${ofsted.leadershipGov}`);
  if (ofsted.wellbeing)     console.log(`  Personal Dev & Wellbeing:      ${ofsted.wellbeing}`);
  if (ofsted.post16)        console.log(`  Post-16:                       ${ofsted.post16}`);

  // Old framework grades
  if (!ofsted.achievement) {
    if (ofsted.qualityOfEducation)  console.log(`  Quality of Education:          ${ofsted.qualityOfEducation}`);
    if (ofsted.behaviour)           console.log(`  Behaviour & Attitudes:         ${ofsted.behaviour}`);
    if (ofsted.personalDevelopment) console.log(`  Personal Development:          ${ofsted.personalDevelopment}`);
    if (ofsted.leadership)          console.log(`  Leadership & Management:       ${ofsted.leadership}`);
    if (ofsted.sixthForm)           console.log(`  Sixth Form:                    ${ofsted.sixthForm}`);
  }

  if (ofsted.safeguarding) console.log(`  Safeguarding:                  ${ofsted.safeguarding}`);
  if (ofsted.reportUrl)    console.log(`  Report PDF: ${ofsted.reportUrl}`);
}

async function testSchool(name) {
  console.log(`\n${DIVIDER}`);
  console.log(`School: ${name}`);
  console.log(DIVIDER);

  const t0 = Date.now();

  const identity = await lookupSchoolURN(name);
  if (!identity) {
    console.log(`  [GIAS]  ✗  Not found (${Date.now() - t0}ms)`);
    return;
  }
  console.log(`  [GIAS]  ✓  ${identity.officialName} — URN ${identity.urn} — ${identity.type} — ${identity.phase} — ${identity.laName ?? ''} — Independent: ${identity.isIndependent} (${Date.now() - t0}ms)`);

  const t1 = Date.now();
  const [ofsted, perf] = await Promise.all([
    identity.isIndependent ? Promise.resolve(null) : getOfstedData(identity.urn),
    getPerformanceData(identity.urn),
  ]);
  console.log(`  [parallel fetch: ${Date.now() - t1}ms]\n`);

  console.log('  ── 1. Academic Results ──────────────────────────────');
  printAcademicResults(perf);

  console.log('\n  ── 2. Latest Inspection Outcomes ────────────────────');
  printInspectionOutcomes(ofsted, identity.isIndependent);

  console.log(`\n  Total: ${Date.now() - t0}ms`);
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : ['Fortismere School'];
for (const name of names) await testSchool(name);
console.log(`\n${DIVIDER}\nDone.`);
