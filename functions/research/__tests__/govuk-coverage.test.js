/**
 * DfE variable coverage tests.
 *
 * For each reference school fixture, verifies that key DfE variables
 * appear in the rendered slim block output.  Freezes the format.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dir, 'fixtures');

// ── Reference schools ────────────────────────────────────────────────────────

const SCHOOLS = [
  { urn: '124987', label: 'state-infant' },
  { urn: '125068', label: 'state-junior' },
  { urn: '137648', label: 'state-primary' },
  { urn: '145217', label: 'state-secondary' },
  { urn: '145005', label: 'state-sixth-form' },
  { urn: '102055', label: 'state-secondary-sixth' },
  { urn: '125357', label: 'independent-primary' },
  { urn: '125427', label: 'independent-secondary' },
  { urn: '100065', label: 'independent-all-through' },
];

// Expected rendered content per school type — the contract.
// Every string must appear literally in the slim block output.
// Based on wiremock specs in docs/mocks/.
const EXPECTED = {
  // KS1 — A1 Identity, A2 Inspection, A3 Needs to Improve, A4 no perf data, A5 Census, A6 Absence, A7 Financial, A8 Area
  'state-infant': [
    'Pre-Fetched Government Data',
    'A2. Inspection Outcomes',
    'What the School Needs to Improve',
    'A3. Academic Performance',       // (no data)
    'A4. Intake & Cohort',
    'A5. Absence & Engagement',
    'A6. Financial Health',
    'A7. Area Context',
  ],
  // KS2 — A1–A8 with A4.1–A4.10 sub-sections
  'state-junior': [
    'Pre-Fetched Government Data',
    'A2. Inspection Outcomes',
    'What the School Needs to Improve',
    'A3. Academic Performance',
    'Key Stage 2',
    'Cohort',                         // A4.1
    'Attainment',                     // A4.2
    'Scaled scores',                  // A4.3
    'Per-subject attainment',         // A4.4 + A4.5
    'Cohort characteristics',         // A4.6
    'Disadvantage gap',               // A4.7
    'Test participation',             // A4.8
    'Progress (KS1 to KS2)',          // A4.9
    'Results over time',              // A4.10
    'A4. Intake & Cohort',
    'A5. Absence & Engagement',
    'A6. Financial Health',
    'A7. Area Context',
  ],
  // KS1+KS2 combined — same as KS2 (no KS1 SATs data)
  'state-primary': [
    'Pre-Fetched Government Data',
    'A2. Inspection Outcomes',
    'What the School Needs to Improve',
    'A3. Academic Performance',
    'Key Stage 2',
    'Cohort',
    'Attainment',
    'Scaled scores',
    'Per-subject attainment',
    'Cohort characteristics',
    'Disadvantage gap',
    'Test participation',
    'Progress (KS1 to KS2)',
    'Results over time',
    'A4. Intake & Cohort',
    'A5. Absence & Engagement',
    'A6. Financial Health',
    'A7. Area Context',
  ],
  // KS4 only — A1–A8 with A4.1–A4.10 (no KS5)
  'state-secondary': [
    'Pre-Fetched Government Data',
    'A2. Inspection Outcomes',
    'What the School Needs to Improve',
    'A3. Academic Performance',
    'Key Stage 4',
    'Attainment 8',                   // A4.1
    'Progress 8',                     // A4.2
    'Cohort characteristics',         // A4.3
    'Grade 5+',                       // A4.4
    'Grade 4+',                       // A4.4
    'EBacc entry by subject',         // A4.5
    'Post-16 destinations',           // A4.6
    'Entry volumes',                  // A4.7
    'EBacc subject achievement',      // A4.8
    'Results over time',              // A4.9
    'Subjects entered (KS4)',         // A4.10
    'A4. Intake & Cohort',
    'A5. Absence & Engagement',
    'A6. Financial Health',
    'A7. Area Context',
  ],
  // KS5 only (sixth form college)
  'state-sixth-form': [
    'Pre-Fetched Government Data',
    'A2. Inspection Outcomes',
    'What the School Needs to Improve',
    'A3. Academic Performance',
    'Key Stage 5',
    'A-level attainment',             // A4.11
    'A-level progress',               // A4.12
    'Facilitating subjects',          // A4.14
    'Results over time',              // A4.16
    'A-level / Level 3 subjects entered', // A4.17
    'A4. Intake & Cohort',            // (no data)
    'A5. Absence & Engagement',       // (no data)
    'A6. Financial Health',
    'A7. Area Context',
  ],
  // KS4+KS5 state — A1–A8 with A4.1–A4.17
  'state-secondary-sixth': [
    'Pre-Fetched Government Data',
    'A2. Inspection Outcomes',
    'What the School Needs to Improve',
    'A3. Academic Performance',
    'Key Stage 4',
    'Attainment 8',
    'Progress 8',
    'Cohort characteristics',
    'Grade 5+',
    'Grade 4+',
    'EBacc entry by subject',
    'Post-16 destinations',
    'Entry volumes',
    'EBacc subject achievement',
    'Key Stage 5',
    'A-level attainment',
    'A-level progress',
    'Facilitating subjects',
    'Results over time',
    'Subjects entered (KS4)',
    'A-level / Level 3 subjects entered',
    'A4. Intake & Cohort',
    'A5. Absence & Engagement',
    'A6. Financial Health',
    'A7. Area Context',
  ],
  // Independent primary — A1–A8, ISI, no performance data, sparse census, no absence, no FBIT
  'independent-primary': [
    'Pre-Fetched Government Data',
    'A2. Inspection Outcomes',
    'ISI:',
    'What the School Needs to Improve',
    'A3. Academic Performance',
    '_No performance data',
    'A4. Intake & Cohort',
    'A5. Absence & Engagement',
    'No absence data',
    'A6. Financial Health',
    'Not available for independent',
    'A7. Area Context',
  ],
  // Independent secondary — A1–A8, ISI, KS4+KS5 stripped
  'independent-secondary': [
    'Pre-Fetched Government Data',
    'A2. Inspection Outcomes',
    'ISI:',
    'What the School Needs to Improve',
    'A3. Academic Performance',
    'Key Stage 4',
    'Attainment 8',
    'Cohort characteristics',
    'EBacc entry by subject',
    'Entry volumes',
    'EBacc subject achievement',
    'Subjects entered (KS4)',
    'Key Stage 5',
    'A-level attainment',
    'A-level progress',
    'Facilitating subjects',
    'A-level / Level 3 subjects entered',
    'Results over time',
    'A4. Intake & Cohort',
    'A5. Absence & Engagement',
    'No absence data',
    'A6. Financial Health',
    'Not available for independent',
    'A7. Area Context',
  ],
  // Independent all-through — same as independent-secondary
  'independent-all-through': [
    'Pre-Fetched Government Data',
    'A2. Inspection Outcomes',
    'ISI:',
    'What the School Needs to Improve',
    'A3. Academic Performance',
    'Key Stage 4',
    'Attainment 8',
    'Cohort characteristics',
    'EBacc entry by subject',
    'Entry volumes',
    'EBacc subject achievement',
    'Subjects entered (KS4)',
    'Key Stage 5',
    'A-level attainment',
    'A-level progress',
    'Facilitating subjects',
    'A-level / Level 3 subjects entered',
    'Results over time',
    'A4. Intake & Cohort',
    'A5. Absence & Engagement',
    'No absence data',
    'A6. Financial Health',
    'Not available for independent',
    'A7. Area Context',
  ],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

describe('DfE variable coverage', () => {
  for (const school of SCHOOLS) {
    const expected = EXPECTED[school.label];
    if (!expected) { test.skip(school.label + ': no contract defined', () => {}); continue; }

    test(school.label + ': all expected variables present', async () => {
      // Load fixture
      const fixPath = join(FIXTURES_DIR, school.urn + '.json');
      let fixture;
      try {
        fixture = JSON.parse(readFileSync(fixPath, 'utf8'));
      } catch {
        throw new Error('Fixture not found: ' + fixPath);
      }

      // Build school object from fixture
      const schoolObj = {
        input: fixture.input,
        identity: fixture.identity,
        ofsted: fixture.ofsted,
        performance: fixture.performance,
        financial: fixture.financial,
        area: fixture.area,
        laPerf: fixture.laPerf,
        schoolEthnicity: fixture.schoolEthnicity,
        giasDetails: fixture.giasDetails,
        fees: fixture.fees,
        subjectEntries: fixture.subjectEntries,
        ks5SubjectEntries: fixture.ks5SubjectEntries,
      };

      // Render slim block
      const { buildSlimBlock } = await import('../govuk.js');
      const slim = buildSlimBlock(schoolObj);

      // Check each expected content string is present
      const missing = [];
      for (const v of expected) {
        if (!slim.includes(v)) missing.push(v);
      }

      if (missing.length) {
        throw new Error(
          missing.length + ' expected sections MISSING from ' + school.label + ':\n  ' +
          missing.join(', ') +
          '\n\nSlim block length: ' + slim.length + ' chars'
        );
      }
    }, 30000);
  }
});
