/**
 * govuk-fixtures.test.js
 *
 * Structural regression tests for buildSlimBlock — one test per reference school type.
 *
 * These tests load saved JSON fixtures (created by capture-fixtures.mjs) and verify
 * that buildSlimBlock produces output that matches the expected shape for each school type.
 * They do NOT hit real APIs — everything runs offline from fixtures.
 *
 * Run:  npm test  (included in default Jest suite)
 *
 * When fixtures are missing, tests are skipped so CI doesn't fail before
 * a developer has run capture-fixtures.mjs at least once.
 *
 * When you change the rendering logic in govuk.js, run capture-fixtures.mjs first
 * (or just the affected URNs), then re-run tests to accept the new snapshots.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildSlimBlock, renderPartA, renderPartAComparison, computeFlags } from '../govuk.js';

const __dir       = dirname(fileURLToPath(import.meta.url));
const FIXTURES    = join(__dir, 'fixtures');
const SNAPSHOTS   = join(__dir, 'snapshots');

// ── Registry — must match capture-fixtures.mjs ─────────────────────────────
const SCHOOLS = [
  { urn: 124987, label: 'state-infant',           phase: 'Primary'    },
  { urn: 125068, label: 'state-junior',           phase: 'Primary'    },
  { urn: 137648, label: 'state-primary',          phase: 'Primary'    },
  { urn: 145217, label: 'state-secondary',        phase: 'Secondary'  },
  { urn: 145005, label: 'state-sixth-form',       phase: '16 Plus'    },
  { urn: 102055, label: 'state-secondary-sixth',  phase: 'Secondary'  },
  { urn: 125357, label: 'independent-primary',    phase: 'Primary',   independent: true },
  { urn: 125427, label: 'independent-secondary',  phase: 'Secondary', independent: true },
  { urn: 100065, label: 'independent-all-through',phase: 'All-through',independent: true },
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function loadFixture(urn) {
  const path = join(FIXTURES, `${urn}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadSnapshot(urn) {
  const path = join(SNAPSHOTS, `${urn}.slim.md`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

// ── Per-school structural expectations ──────────────────────────────────────
// These check that sections appropriate to a school type are present / absent.
// Deliberately loose so minor wording changes don't break the tests.

const EXPECTATIONS = {
  'state-infant': {
    shouldContain:    ['A2. Inspection Outcomes', 'What the School Needs to Improve', 'A3. Academic Performance', 'A4. Intake & Cohort', 'A5. Absence & Engagement', 'A6. Financial Health', 'A7. Area Context'],
    shouldNotContain: ['Key Stage 2', 'Key Stage 4', 'Key Stage 5', 'Attainment 8', 'ISI:'],
  },
  'state-junior': {
    shouldContain:    ['A2. Inspection Outcomes', 'Key Stage 2', 'RWM', 'A4. Intake & Cohort', 'A5. Absence & Engagement', 'A6. Financial Health', 'A7. Area Context'],
    shouldNotContain: ['Key Stage 4', 'Key Stage 5', 'Attainment 8', 'ISI:'],
  },
  'state-primary': {
    shouldContain:    ['A2. Inspection Outcomes', 'Key Stage 2', 'RWM', 'A4. Intake & Cohort', 'A5. Absence & Engagement', 'A6. Financial Health', 'A7. Area Context'],
    shouldNotContain: ['Key Stage 4', 'Key Stage 5', 'Attainment 8', 'ISI:'],
  },
  'state-secondary': {
    shouldContain:    ['A2. Inspection Outcomes', 'Key Stage 4', 'Attainment 8', 'Progress 8', 'Post-16 destinations', 'A4. Intake & Cohort', 'A5. Absence & Engagement', 'A6. Financial Health', 'A7. Area Context'],
    shouldNotContain: ['Key Stage 2', 'Key Stage 5', 'ISI:'],
  },
  'state-sixth-form': {
    shouldContain:    ['A2. Inspection Outcomes', 'Key Stage 5', '16–18', 'A6. Financial Health', 'A7. Area Context'],
    shouldNotContain: ['Key Stage 2', 'Key Stage 4', 'Attainment 8', 'ISI:'],
  },
  'state-secondary-sixth': {
    shouldContain:    ['A2. Inspection Outcomes', 'Key Stage 4', 'Key Stage 5', 'Attainment 8', 'Progress 8', 'Post-16 destinations', 'A4. Intake & Cohort', 'A5. Absence & Engagement', 'A6. Financial Health', 'A7. Area Context'],
    shouldNotContain: ['Key Stage 2', 'ISI:'],
  },
  'independent-primary': {
    shouldContain:    ['A2. Inspection Outcomes', 'ISI:', 'A3. Academic Performance', '_No performance data', 'A4. Intake & Cohort', 'A5. Absence & Engagement', 'A6. Financial Health', 'A7. Area Context'],
    shouldNotContain: ['Key Stage 2', 'Key Stage 4', 'Key Stage 5', 'Progress 8', 'Post-16 destinations'],
  },
  'independent-secondary': {
    shouldContain:    ['A2. Inspection Outcomes', 'ISI:', 'Key Stage 4', 'Key Stage 5', 'Attainment 8', 'A4. Intake & Cohort', 'A5. Absence & Engagement', 'A6. Financial Health', 'A7. Area Context'],
    shouldNotContain: ['Key Stage 2', 'Progress 8', 'Post-16 destinations'],
  },
  'independent-all-through': {
    shouldContain:    ['A2. Inspection Outcomes', 'ISI:', 'Key Stage 4', 'Key Stage 5', 'Attainment 8', 'A4. Intake & Cohort', 'A5. Absence & Engagement', 'A6. Financial Health', 'A7. Area Context'],
    shouldNotContain: ['Key Stage 2', 'Progress 8', 'Post-16 destinations'],
  },
};

// ── Test suite ───────────────────────────────────────────────────────────────
describe('buildSlimBlock — reference school fixtures', () => {

  for (const school of SCHOOLS) {
    const { urn, label } = school;
    const exp = EXPECTATIONS[label];

    describe(`${label} (URN ${urn})`, () => {

      let fixture;
      let slim;

      beforeAll(() => {
        fixture = loadFixture(urn);
        if (fixture) {
          slim = buildSlimBlock(fixture);
        }
      });

      test('fixture file exists', () => {
        if (!fixture) {
          console.warn(`  ⚠  Fixture missing for ${label} (URN ${urn}) — run capture-fixtures.mjs`);
        }
        // Skip rather than fail if fixture is missing — developer needs to capture first
        if (!fixture) return;
        expect(fixture).not.toBeNull();
      });

      test('buildSlimBlock does not throw', () => {
        if (!fixture) return; // skip
        expect(() => buildSlimBlock(fixture)).not.toThrow();
      });

      test('output is a non-empty string', () => {
        if (!fixture) return;
        expect(typeof slim).toBe('string');
        expect(slim.length).toBeGreaterThan(100);
      });

      test('School Identity section is present', () => {
        if (!fixture) return;
        expect(slim).toMatch(/## School Identity|URN/i);
      });

      if (exp?.shouldContain?.length) {
        test(`contains expected sections: ${exp.shouldContain.join(', ')}`, () => {
          if (!fixture) return;
          for (const phrase of exp.shouldContain) {
            expect(slim).toContain(phrase);
          }
        });
      }

      if (exp?.shouldNotContain?.length) {
        test(`does not contain out-of-scope sections: ${exp.shouldNotContain.join(', ')}`, () => {
          if (!fixture) return;
          for (const phrase of exp.shouldNotContain) {
            expect(slim).not.toContain(phrase);
          }
        });
      }

      test('snapshot matches saved golden file (or creates it)', () => {
        if (!fixture) return;

        const snapshotPath = join(SNAPSHOTS, `${urn}.slim.md`);
        const saved = loadSnapshot(urn);

        if (!saved) {
          // First run — no snapshot yet. Write the current output as the baseline.
          // Developer should inspect it and commit if it looks correct.
          const content = `<!-- ${label} · URN ${urn} · auto-created by test -->\n\n${slim}\n`;
          writeFileSync(snapshotPath, content);
          console.warn(`  ⚠  Snapshot created for ${label} — inspect and commit: ${snapshotPath}`);
          return;
        }

        // Strip comment header line before comparing
        const savedSlim = saved.replace(/^<!--.*-->\n\n/, '').trimEnd();
        const currentSlim = slim.trimEnd();

        if (savedSlim !== currentSlim) {
          // Provide a useful diff hint rather than a raw string comparison failure
          const savedLines   = savedSlim.split('\n');
          const currentLines = currentSlim.split('\n');
          const firstDiff = savedLines.findIndex((l, i) => l !== currentLines[i]);
          const hint = firstDiff >= 0
            ? `First diff at line ${firstDiff + 1}:\n  saved:   ${savedLines[firstDiff]}\n  current: ${currentLines[firstDiff]}`
            : `Line count differs: saved ${savedLines.length} vs current ${currentLines.length}`;

          throw new Error(
            `Slim block snapshot mismatch for ${label} (URN ${urn}).\n` +
            `${hint}\n\n` +
            `If this change is intentional, re-run capture-fixtures.mjs for URN ${urn} ` +
            `(or delete the snapshot and re-run tests to regenerate).`
          );
        }
      });

    });
  }

});

// ── Part A section order contract ────────────────────────────────────────────
// Verifies that renderPartA outputs sections in the correct A1–A7 sequence,
// with unnumbered "What the School Needs to Improve" between A2 and A3.
// This is the structural contract that the AI observations interleave against.

const PART_A_ORDER = [
  'A1. School Identity',
  'A2. Inspection Outcomes',
  'What the School Needs to Improve',
  'A3. Academic Performance',
  'A4. Intake & Cohort',
  'A5. Absence & Engagement',
  'A6. Financial Health',
  'A7. Area Context',
];

describe('renderPartA — section order contract', () => {

  for (const school of SCHOOLS) {
    const { urn, label } = school;

    describe(`${label} (URN ${urn})`, () => {

      let fixture;
      let sections;

      beforeAll(() => {
        fixture = loadFixture(urn);
        if (!fixture) return;
        const flags = computeFlags(fixture);
        sections = renderPartA(fixture, flags);
      });

      test('fixture exists and produces sections', () => {
        if (!fixture) return;
        expect(sections.length).toBeGreaterThanOrEqual(1);
      });

      test('section headings follow the A1–A7 contract in order', () => {
        if (!fixture) return;
        const headings = sections.map(s => s.heading);

        // Check that every expected heading appears in order
        let expectedIdx = 0;
        for (const h of headings) {
          if (expectedIdx < PART_A_ORDER.length && h === PART_A_ORDER[expectedIdx]) {
            expectedIdx++;
          }
        }
        if (expectedIdx < PART_A_ORDER.length) {
          throw new Error(
            `Missing section "${PART_A_ORDER[expectedIdx]}" at position ${expectedIdx + 1}.\n` +
            `Got headings: ${JSON.stringify(headings)}`
          );
        }
      });

      test('no unexpected numbered A-sections', () => {
        if (!fixture) return;
        const headings = sections.map(s => s.heading);
        const valid = new Set([...PART_A_ORDER]);
        for (const h of headings) {
          if (/^A\d+\./.test(h) && !valid.has(h)) {
            throw new Error(`Unexpected numbered section: "${h}"`);
          }
        }
      });

      test('A-sections are in ascending numeric order', () => {
        if (!fixture) return;
        const nums = sections
          .map(s => s.heading?.match(/^A(\d+)\./)?.[1])
          .filter(Boolean)
          .map(Number);
        for (let i = 1; i < nums.length; i++) {
          if (nums[i] < nums[i-1]) {
            throw new Error(`A-sections out of order: A${nums[i-1]} before A${nums[i]}`);
          }
        }
      });

    });
  }

});

// ── renderPartAComparison — section structure contract ───────────────────────
// Verifies that comparison tables are produced in the correct format with
// A3 broken into sub-sections matching the wiremock spec.

describe('renderPartAComparison — section structure', () => {

  // Build comparison pairs from the fixture school registry.
  // Each pair is two schools of the same type to test the comparison table layout.

  const stateSecondaryA   = SCHOOLS.find(s => s.label === 'state-secondary');
  const stateSecondaryB   = SCHOOLS.find(s => s.label === 'state-secondary-sixth');
  const statePrimaryA     = SCHOOLS.find(s => s.label === 'state-primary');
  const statePrimaryB     = SCHOOLS.find(s => s.label === 'state-junior');
  const indepSecondaryA   = SCHOOLS.find(s => s.label === 'independent-secondary');
  const indepSecondaryB   = SCHOOLS.find(s => s.label === 'independent-all-through');
  const stateSecondary    = SCHOOLS.find(s => s.label === 'state-secondary');
  const indepSecondary    = SCHOOLS.find(s => s.label === 'independent-secondary');

  describe('state secondary comparison (KS4 only)', () => {
    let sections;
    const pair = loadPair(stateSecondaryA?.urn, stateSecondaryB?.urn);

    beforeAll(() => {
      if (!pair) return;
      sections = renderPartAComparison(pair);
    });

    test('fixtures loaded', () => {
      if (!pair) console.warn('  ⚠  Skipping — pair fixtures missing');
      expect(pair).not.toBeNull();
    });

    test('starts with A1. School Identity', () => {
      if (!pair) return;
      expect(sections[0].heading).toBe('A1. School Identity');
    });

    test('has A2. Inspection Outcomes', () => {
      if (!pair) return;
      const headings = sections.map(s => s.heading);
      expect(headings).toContain('A2. Inspection Outcomes');
    });

    test('A3 subsections follow order: A3.1 through A3.9 (no KS5)', () => {
      if (!pair) return;
      const a3Headings = sections.map(s => s.heading).filter(h => /^A3\.\d+\./.test(h));
      const nums = a3Headings.map(h => parseFloat(h.match(/A3\.(\d+)\./)?.[1] ?? '0'));
      // Must start with A3.1
      expect(nums[0]).toBe(1);
      // Must be ascending
      for (let i = 1; i < nums.length; i++) {
        if (nums[i] <= nums[i-1]) throw new Error(`A3 sub-sections out of order: ${nums[i-1]} before ${nums[i]}`);
      }
    });

    test('every A3 sub-section has heading matching A3.N. pattern', () => {
      if (!pair) return;
      for (const s of sections) {
        if (s.heading?.startsWith('A3.')) {
          expect(/^A3\.\d+\./.test(s.heading)).toBe(true);
        }
      }
    });

    test('side-by-side tables have valid markdown table separators', () => {
      if (!pair) return;
      const tableSections = sections.filter(s => s.body?.includes('|---'));
      expect(tableSections.length).toBeGreaterThan(0);
      for (const s of tableSections) {
        const lines = s.body.split('\n');
        const sepLine = lines.find(l => /^\|[-:| ]+\|/.test(l));
        expect(sepLine).toBeDefined();
        // Each column separator should have at least 3 dashes
        const cols = sepLine.split('|').filter(c => c.trim());
        expect(cols.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('state primary comparison (KS2)', () => {
    let sections;
    const pair = loadPair(statePrimaryA?.urn, statePrimaryB?.urn);

    beforeAll(() => {
      if (!pair) return;
      sections = renderPartAComparison(pair);
    });

    test('fixtures loaded', () => {
      if (!pair) console.warn('  ⚠  Skipping — pair fixtures missing');
      expect(pair).not.toBeNull();
    });

    test('A3 subsections include KS2-specific headings', () => {
      if (!pair) return;
      const headings = sections.map(s => s.heading);
      expect(headings.some(h => /Reading.*Writing.*Maths/i.test(h))).toBe(true);
      expect(headings.some(h => /Scaled Scores/i.test(h))).toBe(true);
      expect(headings.some(h => /Progress/i.test(h))).toBe(true);
    });

    test('has A5 Absence section (state schools)', () => {
      if (!pair) return;
      const headings = sections.map(s => s.heading);
      expect(headings).toContain('A5. Absence & Engagement');
    });

    test('has A6 Financial section (state schools)', () => {
      if (!pair) return;
      const headings = sections.map(s => s.heading);
      expect(headings).toContain('A6. Financial Health');
    });
  });

  describe('independent secondary comparison', () => {
    let sections;
    const pair = loadPair(indepSecondaryA?.urn, indepSecondaryB?.urn);

    beforeAll(() => {
      if (!pair) return;
      sections = renderPartAComparison(pair);
    });

    test('fixtures loaded', () => {
      if (!pair) console.warn('  ⚠  Skipping — pair fixtures missing');
      expect(pair).not.toBeNull();
    });

    test('Progress 8 is hidden for independent schools', () => {
      if (!pair) return;
      const headings = sections.map(s => s.heading);
      expect(headings.filter(h => h?.includes('Progress 8')).length).toBe(0);
    });

    test('A2 heading references ISI', () => {
      if (!pair) return;
      const a2 = sections.find(s => s.heading?.startsWith('A2.'));
      expect(a2?.body).toContain('ISI');
    });

    test('A5 and A6 sections are absent for independent schools', () => {
      if (!pair) return;
      const headings = sections.map(s => s.heading);
      expect(headings).not.toContain('A5. Absence & Engagement');
      expect(headings).not.toContain('A6. Financial Health');
    });
  });

  describe('state vs independent cross-type comparison', () => {
    let sections;
    const pair = loadPair(stateSecondary?.urn, indepSecondary?.urn);

    beforeAll(() => {
      if (!pair) return;
      sections = renderPartAComparison(pair);
    });

    test('fixtures loaded', () => {
      if (!pair) console.warn('  ⚠  Skipping — pair fixtures missing');
      expect(pair).not.toBeNull();
    });

    test('Progress 8 table shows (indep) for independent school', () => {
      if (!pair) return;
      const p8 = sections.find(s => s.heading?.startsWith('A3.2.'));
      if (p8) {
        expect(p8.body).toContain('(indep)');
      }
    });

    test('A4 table has independent FSM note', () => {
      if (!pair) return;
      const a4 = sections.find(s => s.heading?.startsWith('A4.'));
      if (a4) {
        expect(a4.body).toMatch(/indep|near 0%/i);
      }
    });

    test('A5 is present (at least one state school has absence data)', () => {
      if (!pair) return;
      const headings = sections.map(s => s.heading);
      expect(headings).toContain('A5. Absence & Engagement');
    });
  });

});

// ── Parent View comparison — server-rendered table contract ──────────────────
// Verifies the deterministic Parent View section is rendered correctly when
// data is present, and absent when no school has parentView data.

// ── Helper: build a comparison pair from fixture URNs ─────────────────────────
function loadPair(urnA, urnB) {
  const a = loadFixture(urnA);
  const b = loadFixture(urnB);
  return (a && b) ? [a, b] : null;
}

describe('renderPartAComparison — Parent View', () => {

  const secA = SCHOOLS.find(s => s.label === 'state-secondary');
  const secB = SCHOOLS.find(s => s.label === 'state-secondary-sixth');
  const secondaryPair = loadPair(secA?.urn, secB?.urn);

  describe('with parentView data present', () => {
    let sections;
    let pair;

    beforeAll(() => {
      if (!secondaryPair) return;
      // Deep-clone so mock data doesn't leak into other tests
      pair = secondaryPair.map(s => JSON.parse(JSON.stringify(s)));
      pair[0].ofsted.parentView = {
        totalResponses: 124, academicYear: '2024/2025',
        wouldRecommend: 92, childHappy: 95, childSafe: 94,
        wellBehaved: 88, bullyingHandled: 72, communication: 85,
        concernsHandled: 78, bestInterests: 90, rightSupport: 87, sendSupport: 65
      };
      pair[1].ofsted.parentView = {
        totalResponses: 89, academicYear: '2024/2025',
        wouldRecommend: 78, childHappy: 93, childSafe: 88,
        wellBehaved: 85, bullyingHandled: 65, communication: 80,
        concernsHandled: 71, bestInterests: 86, rightSupport: 83, sendSupport: 58
      };
      sections = renderPartAComparison(pair);
    });

    test('fixtures loaded', () => {
      if (!secondaryPair) console.warn('  ⚠  Skipping — pair fixtures missing');
      expect(secondaryPair).not.toBeNull();
    });

    test('Parent View section exists', () => {
      if (!secondaryPair) return;
      const pv = sections.find(s => s.heading?.startsWith('A8. Parent View'));
      expect(pv).toBeDefined();
    });

    test('heading includes academic year', () => {
      if (!secondaryPair) return;
      const pv = sections.find(s => s.heading?.startsWith('A8. Parent View'));
      expect(pv.heading).toContain('2024/2025');
    });

    test('placed after A7 in section order', () => {
      if (!secondaryPair) return;
      const pvIdx = sections.findIndex(s => s.heading?.startsWith('A8. Parent View'));
      const a7Idx = sections.findIndex(s => s.heading?.startsWith('A7.'));
      expect(pvIdx).toBeGreaterThan(a7Idx);
    });

    test('total responses is plain number (no % suffix)', () => {
      if (!secondaryPair) return;
      const pv = sections.find(s => s.heading?.startsWith('A8. Parent View'));
      expect(pv.body).toContain('124');
      expect(pv.body).not.toMatch(/124%/);
    });

    test('percentage values have % suffix', () => {
      if (!secondaryPair) return;
      const pv = sections.find(s => s.heading?.startsWith('A8. Parent View'));
      expect(pv.body).toContain('92%');
      expect(pv.body).toContain('95%');
      expect(pv.body).toContain('93%');
    });

    test('below-threshold values are flagged', () => {
      if (!secondaryPair) return;
      const pv = sections.find(s => s.heading?.startsWith('A8. Parent View'));
      // 78% < 80% threshold for "Would recommend"
      expect(pv.body).toContain('78% ⚠️');
      // 65% < 70% threshold for "Bullying dealt with well"
      expect(pv.body).toContain('65% ⚠️');
      // 71% < 75% threshold for "Concerns dealt with properly"
      expect(pv.body).toContain('71% ⚠️');
    });

    test('above-threshold values are NOT flagged', () => {
      if (!secondaryPair) return;
      const pv = sections.find(s => s.heading?.startsWith('A8. Parent View'));
      // 72% is above 70% threshold for bullying
      expect(pv.body).not.toMatch(/72% ⚠️/);
      // 92% is above 80% threshold for would recommend
      expect(pv.body).not.toMatch(/92% ⚠️/);
    });

    test('footer explains threshold markers', () => {
      if (!secondaryPair) return;
      const pv = sections.find(s => s.heading?.startsWith('A8. Parent View'));
      expect(pv.body).toMatch(/⚠️ = below threshold/);
      expect(pv.body).toMatch(/Fewer than 20/);
    });

    test('both school names appear in header', () => {
      if (!secondaryPair) return;
      const pv = sections.find(s => s.heading?.startsWith('A8. Parent View'));
      const nameA = pair[0].identity?.officialName;
      const nameB = pair[1].identity?.officialName;
      expect(pv.body).toContain(nameA.split(',')[0]); // first part of name
      expect(pv.body).toContain(nameB.split(' ')[0]); // first word of name
    });
  });

  describe('without parentView data', () => {
    let sections;

    beforeAll(() => {
      if (!secondaryPair) return;
      const clean = secondaryPair.map(s => JSON.parse(JSON.stringify(s)));
      clean[0].ofsted.parentView = null;
      clean[1].ofsted.parentView = null;
      sections = renderPartAComparison(clean);
    });

    test('Parent View section is absent when no data', () => {
      if (!secondaryPair) return;
      const pv = sections.find(s => s.heading?.startsWith('A8. Parent View'));
      expect(pv).toBeUndefined();
    });
  });

});

// ── Branch 2 prompt section contract ─────────────────────────────────────────
// Verifies that the prompt file specifies all expected Part B and Part C
// sections. This is a contract test — the AI output must match these headings
// for interleaveVerdicts and tagPartLabels to work correctly.

const PART_B_HEADINGS = [
  'B1. Pupil Experience',
  'B2. Admissions',
  'B3. Extracurricular & Clubs',
  'B4. What Parents Say',
  'B5. Where Pupils Go Next',
];

const PART_C_HEADINGS = [
  'C1. Head-to-Head Verdict',
  'C2. Which Child Thrives Where',
  'C3. Tradeoffs',
  'C4. Best Next Move',
  'C5. Sources',
];

describe('branch 2 prompt — section contract', () => {
  const promptPath = join(__dir, '..', '.md', 'prompt_branch_2_compare_schools_v2.md');
  let promptText;

  beforeAll(() => {
    promptText = existsSync(promptPath) ? readFileSync(promptPath, 'utf8') : '';
  });

  test('prompt file exists', () => {
    expect(promptText.length).toBeGreaterThan(100);
  });

  for (const heading of PART_B_HEADINGS) {
    test(`prompt specifies "${heading}" in output schema`, () => {
      const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(promptText).toMatch(new RegExp(escaped));
    });
  }

  for (const heading of PART_C_HEADINGS) {
    test(`prompt specifies "${heading}" in output schema`, () => {
      const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(promptText).toMatch(new RegExp(escaped));
    });
  }

  test('prompt defines web search queries per section', () => {
    expect(promptText).toMatch(/admissions criteria/);
    expect(promptText).toMatch(/open day/);
    expect(promptText).toMatch(/clubs activities extracurricular/);
  });

  test('prompt defines anti-fabrication rule', () => {
    expect(promptText).toMatch(/fabrication/i);
  });

  test('prompt references pre-fetched data as ground truth', () => {
    expect(promptText).toMatch(/pre-fetched/);
  });
});