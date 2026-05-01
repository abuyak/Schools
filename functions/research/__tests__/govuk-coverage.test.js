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

// Expected rendered content per school type — the contract
// Format: { label: [text strings that MUST appear in slim block] }
const EXPECTED = {
  'state-infant':             ['Academic Results', 'Pupil Census', 'Absence', 'Financial Benchmarking', 'Inspection Outcomes', 'Surrounding Area'],
  'state-junior':             ['Key Stage 2', 'Cohort', 'Attainment', 'Scaled scores', 'Per-subject attainment', 'Cohort characteristics', 'Disadvantage gap', 'Test participation', 'Progress (KS1 to KS2)', 'Results over time', 'Pupil Census', 'Absence'],
  'state-primary':            ['Key Stage 2', 'Cohort', 'Attainment', 'Scaled scores', 'Per-subject attainment', 'Cohort characteristics', 'Disadvantage gap', 'Test participation', 'Progress (KS1 to KS2)', 'Results over time', 'Pupil Census', 'Absence'],
  'state-secondary':          ['Key Stage 4', 'Attainment 8', 'Grade 5+', 'Grade 4+', 'EBacc entry', 'EBacc achievement', 'EBacc subject achievement', 'Pupil Census', 'Absence'],
  'state-sixth-form':         ['Key Stage 5', 'A-level attainment', 'A-level progress', 'Absence'],
  'state-secondary-sixth':    ['Key Stage 4', 'Attainment 8', 'Key Stage 5', 'A-level attainment', 'EBacc', 'Pupil Census', 'Absence'],
  'independent-primary':      ['Academic Results', 'Pupil Census', 'Surrounding Area'],
  'independent-secondary':    ['Key Stage 4', 'Attainment 8', 'Key Stage 5', 'EBacc', 'Pupil Census', 'Absence'],
  'independent-all-through':  ['Key Stage 4', 'Attainment 8', 'Key Stage 5', 'EBacc', 'Pupil Census', 'Absence'],
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
