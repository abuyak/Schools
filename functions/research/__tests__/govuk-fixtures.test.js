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
import { buildSlimBlock, renderPartA, computeFlags } from '../govuk.js';

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
