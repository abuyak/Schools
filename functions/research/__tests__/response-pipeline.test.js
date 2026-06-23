/**
 * Unit tests for the AI-output-to-structured-response pipeline.
 *
 * These are the functions that transform a raw OpenAI API response into the
 * final structured output the UI renders. Every function here was involved in
 * at least one production bug — these tests freeze the fix.
 *
 * Test coverage:
 *   cleanBody       — search-marker stripping, whitespace normalisation
 *   cleanHeading    — markdown heading prefix stripping
 *   parseOpenAIResponse — JSON extraction, sources handling, heading/body cleanup
 *   interleaveVerdicts  — splicing AI observations after server-rendered sections
 *   enforceObservations — orphan stripping, placeholder insertion
 *   tagPartLabels   — Part A/B/C labelling
 *   normaliseComparisonTable — pipe-delimited table fixing for comparisons
 */

import { describe, it, expect } from '@jest/globals';
import {
  cleanBody,
  cleanHeading,
  parseOpenAIResponse,
  interleaveVerdicts,
  enforceObservations,
  tagPartLabels,
  normaliseComparisonTable,
} from '../index.js';

// ---------------------------------------------------------------------------
// cleanBody
// ---------------------------------------------------------------------------

describe('cleanBody', () => {
  it('strips turn0search markers', () => {
    expect(cleanBody('turn0search2 some content')).toBe('some content');
  });

  it('strips turn1view markers', () => {
    expect(cleanBody('turn1view0 more content')).toBe('more content');
  });

  it('strips markers with leading dot', () => {
    expect(cleanBody('.turn0search2 prefixed with dot')).toBe('prefixed with dot');
  });

  it('strips multiple markers', () => {
    expect(cleanBody('turn0search2 turn1view0 double trouble')).toBe('double trouble');
  });

  it('collapses multiple spaces', () => {
    expect(cleanBody('hello    world  again')).toBe('hello world again');
  });

  it('trims leading and trailing whitespace', () => {
    expect(cleanBody('  padded  ')).toBe('padded');
  });

  it('handles null', () => {
    expect(cleanBody(null)).toBe('');
  });

  it('handles undefined', () => {
    expect(cleanBody(undefined)).toBe('');
  });

  it('handles empty string', () => {
    expect(cleanBody('')).toBe('');
  });

  it('passes through clean text unchanged', () => {
    const text = 'This is a normal paragraph with no markers.';
    expect(cleanBody(text)).toBe(text);
  });

  it('is case-insensitive for markers', () => {
    expect(cleanBody('TURN0SEARCH2 upper case')).toBe('upper case');
    expect(cleanBody('Turn0Search2 mixed case')).toBe('mixed case');
  });
});

// ---------------------------------------------------------------------------
// cleanHeading
// ---------------------------------------------------------------------------

describe('cleanHeading', () => {
  it('strips ## prefix', () => {
    expect(cleanHeading('## A2. Observations')).toBe('A2. Observations');
  });

  it('strips ### prefix', () => {
    expect(cleanHeading('### A3. Observations')).toBe('A3. Observations');
  });

  it('strips # prefix', () => {
    expect(cleanHeading('# Title')).toBe('Title');
  });

  it('strips #### prefix', () => {
    expect(cleanHeading('#### Deeply nested')).toBe('Deeply nested');
  });

  it('passes through headings without prefix', () => {
    expect(cleanHeading('A2. Observations')).toBe('A2. Observations');
  });

  it('handles null', () => {
    expect(cleanHeading(null)).toBe('');
  });

  it('handles undefined', () => {
    expect(cleanHeading(undefined)).toBe('');
  });

  it('handles empty string', () => {
    expect(cleanHeading('')).toBe('');
  });

  it('does not strip # in the middle of a heading', () => {
    expect(cleanHeading('A1. School #1 Identity')).toBe('A1. School #1 Identity');
  });

  it('handles heading with leading whitespace (trimmed after strip)', () => {
    // The regex ^#{1,4}\s+ anchors at position 0, so leading whitespace
    // means the # isn't matched. trim() at the end cleans up what's left.
    // In practice the AI never outputs "  ## heading" — this is defensive.
    expect(cleanHeading('  ## A4. Observations')).toBe('## A4. Observations');
  });

  it('handles heading that is only a prefix', () => {
    expect(cleanHeading('## ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// parseOpenAIResponse
// ---------------------------------------------------------------------------

describe('parseOpenAIResponse', () => {
  // -- Basic extraction -------------------------------------------------------

  it('extracts from output_text field', () => {
    const result = parseOpenAIResponse({
      output_text: JSON.stringify({
        title: 'Test Report',
        summary: 'A test summary.',
        scorecard: [],
        sections: [],
      }),
    });
    expect(result.status).toBe('completed');
    expect(result.title).toBe('Test Report');
    expect(result.summary).toBe('A test summary.');
  });

  it('extracts from output[].content[].text array', () => {
    const result = parseOpenAIResponse({
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                title: 'From Content Array',
                summary: 'Array path.',
                scorecard: [],
                sections: [],
              }),
            },
          ],
        },
      ],
    });
    expect(result.status).toBe('completed');
    expect(result.title).toBe('From Content Array');
  });

  it('joins multiple content fragments with newlines', () => {
    const result = parseOpenAIResponse({
      output: [
        {
          content: [
            { text: '{"title": "Part 1",' },
            { text: '"summary": "Joined.", "scorecard": [], "sections": []}' },
          ],
        },
      ],
    });
    expect(result.status).toBe('completed');
    expect(result.title).toBe('Part 1');
    expect(result.summary).toBe('Joined.');
  });

  // -- Empty / missing output -------------------------------------------------

  it('returns error for null output_text and no output array', () => {
    const result = parseOpenAIResponse({});
    expect(result.status).toBe('upstream_invalid_format');
    expect(result.httpStatus).toBe(502);
    expect(result.sections).toEqual([]);
  });

  it('returns error for empty output_text', () => {
    const result = parseOpenAIResponse({ output_text: '   ' });
    expect(result.status).toBe('upstream_invalid_format');
    expect(result.httpStatus).toBe(502);
  });

  // -- Markdown fence stripping -----------------------------------------------

  it('strips ```json fences', () => {
    const result = parseOpenAIResponse({
      output_text: '```json\n{"title":"Fenced","summary":"x","scorecard":[],"sections":[]}\n```',
    });
    expect(result.status).toBe('completed');
    expect(result.title).toBe('Fenced');
  });

  it('strips ``` fences without json marker', () => {
    const result = parseOpenAIResponse({
      output_text: '```\n{"title":"Plain Fence","summary":"x","scorecard":[],"sections":[]}\n```',
    });
    expect(result.status).toBe('completed');
    expect(result.title).toBe('Plain Fence');
  });

  // -- Non-JSON prefix trimming -----------------------------------------------

  it('trims non-JSON prefix before the first {', () => {
    const result = parseOpenAIResponse({
      output_text: 'Here is your report:\n{"title":"Trimmed","summary":"x","scorecard":[],"sections":[]}',
    });
    expect(result.status).toBe('completed');
    expect(result.title).toBe('Trimmed');
  });

  it('returns error for completely malformed JSON', () => {
    const result = parseOpenAIResponse({
      output_text: 'This is not JSON at all, just some prose.',
    });
    expect(result.status).toBe('upstream_invalid_format');
    expect(result.httpStatus).toBe(502);
  });

  // -- Sources renaming -------------------------------------------------------

  it('renames "Sources" section to "Primary Sources"', () => {
    const result = parseOpenAIResponse({
      output_text: JSON.stringify({
        title: 'T', summary: 'S', scorecard: [],
        sections: [
          { heading: 'Sources', body: 'https://example.com', flag: 'none' },
        ],
      }),
    });
    expect(result.sections[0].heading).toBe('Primary Sources');
  });

  it('renames case-insensitively', () => {
    const result = parseOpenAIResponse({
      output_text: JSON.stringify({
        title: 'T', summary: 'S', scorecard: [],
        sections: [
          { heading: 'sources', body: 'url', flag: 'none' },
        ],
      }),
    });
    expect(result.sections[0].heading).toBe('Primary Sources');
  });

  // -- Secondary sources -----------------------------------------------------

  it('appends Secondary Sources section from web_search_call items', () => {
    const result = parseOpenAIResponse({
      output_text: JSON.stringify({
        title: 'T', summary: 'S', scorecard: [],
        sections: [{ heading: 'A1.', body: 'data', flag: 'none' }],
      }),
      output: [
        {
          type: 'web_search_call',
          action: {
            sources: [
              { title: 'Example Site', url: 'https://example.com' },
            ],
          },
        },
      ],
    });
    const secondary = result.sections.find(s => s.heading === 'Secondary Sources');
    expect(secondary).toBeDefined();
    expect(secondary.body).toContain('[Example Site](https://example.com)');
  });

  it('deduplicates secondary sources already cited in section bodies', () => {
    const result = parseOpenAIResponse({
      output_text: JSON.stringify({
        title: 'T', summary: 'S', scorecard: [],
        sections: [
          { heading: 'A1.', body: 'See https://example.com for more', flag: 'none' },
        ],
      }),
      output: [
        {
          type: 'web_search_call',
          action: {
            sources: [
              { title: 'Already Cited', url: 'https://example.com' },
              { title: 'Not Cited', url: 'https://other.com' },
            ],
          },
        },
      ],
    });
    const secondary = result.sections.find(s => s.heading === 'Secondary Sources');
    expect(secondary.body).not.toContain('example.com');
    expect(secondary.body).toContain('other.com');
  });

  it('does not add Secondary Sources when all are already cited', () => {
    const result = parseOpenAIResponse({
      output_text: JSON.stringify({
        title: 'T', summary: 'S', scorecard: [],
        sections: [
          { heading: 'A1.', body: 'https://example.com', flag: 'none' },
        ],
      }),
      output: [
        {
          type: 'web_search_call',
          action: {
            sources: [
              { title: 'Cited', url: 'https://example.com' },
            ],
          },
        },
      ],
    });
    const secondary = result.sections.find(s => s.heading === 'Secondary Sources');
    expect(secondary).toBeUndefined();
  });

  // -- cleanHeading integration -----------------------------------------------

  it('strips ## prefix from all section headings', () => {
    const result = parseOpenAIResponse({
      output_text: JSON.stringify({
        title: 'T', summary: 'S', scorecard: [],
        sections: [
          { heading: '## A2. Observations', body: 'bullet points', flag: 'none' },
          { heading: '## B1. Pupil Experience', body: 'text', flag: 'none' },
        ],
      }),
    });
    expect(result.sections[0].heading).toBe('A2. Observations');
    expect(result.sections[1].heading).toBe('B1. Pupil Experience');
  });

  // -- cleanBody integration --------------------------------------------------

  it('strips search markers from all section bodies', () => {
    const result = parseOpenAIResponse({
      output_text: JSON.stringify({
        title: 'T', summary: 'S', scorecard: [],
        sections: [
          { heading: 'A2.', body: 'turn0search2 Clean content here', flag: 'none' },
        ],
      }),
    });
    expect(result.sections[0].body).toBe('Clean content here');
  });
});

// ---------------------------------------------------------------------------
// interleaveVerdicts
// ---------------------------------------------------------------------------

describe('interleaveVerdicts', () => {
  const partAData = [
    { heading: 'A1. School Identity', body: '...', flag: 'none' },
    { heading: 'A2. Inspection Outcomes', body: '...', flag: 'none' },
    { heading: 'A3. Academic Performance', body: '...', flag: 'none' },
    { heading: 'A4. Intake & Cohort', body: '...', flag: 'none' },
    { heading: 'A5. Absence & Engagement', body: '...', flag: 'none' },
    { heading: 'A6. Financial Health', body: '...', flag: 'none' },
    { heading: 'A7. Area Context', body: '...', flag: 'none' },
  ];

  it('splices A-verdict after its matching data section', () => {
    const call2 = [
      { heading: 'A2. Observations', body: 'Inspection analysis', flag: 'none' },
    ];
    const result = interleaveVerdicts(partAData, call2);

    // A2. Observations should come right after A2. Inspection Outcomes
    const a2DataIdx = result.findIndex(s => s.heading === 'A2. Inspection Outcomes');
    const a2ObsIdx = result.findIndex(s => s.heading === 'A2. Observations');
    expect(a2ObsIdx).toBe(a2DataIdx + 1);
  });

  it('inserts multiple A-verdicts at their correct positions', () => {
    const call2 = [
      { heading: 'A4. Observations', body: 'Intake analysis', flag: 'none' },
      { heading: 'A2. Observations', body: 'Inspection analysis', flag: 'none' },
    ];
    const result = interleaveVerdicts(partAData, call2);

    // Should be sorted: A2 obs after A2 data, A4 obs after A4 data
    const a2Idx = result.findIndex(s => s.heading === 'A2. Observations');
    const a4Idx = result.findIndex(s => s.heading === 'A4. Observations');
    expect(a2Idx).toBeLessThan(a4Idx);
    expect(result[a2Idx - 1].heading).toBe('A2. Inspection Outcomes');
    expect(result[a4Idx - 1].heading).toBe('A4. Intake & Cohort');
  });

  it('appends B and C sections after all data + verdicts', () => {
    const call2 = [
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
      { heading: 'C1. Head-to-Head Verdict', body: '...', flag: 'none' },
    ];
    const result = interleaveVerdicts(partAData, call2);

    const lastIdx = result.length - 1;
    expect(result[lastIdx].heading).toBe('C1. Head-to-Head Verdict');
    expect(result[lastIdx - 1].heading).toBe('B1. Pupil Experience');
  });

  it('returns data sections + B/C when there are no verdicts', () => {
    const call2 = [
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
    ];
    const result = interleaveVerdicts(partAData, call2);

    expect(result.length).toBe(partAData.length + 1);
    expect(result[result.length - 1].heading).toBe('B1. Pupil Experience');
  });

  it('handles empty call2Sections', () => {
    const result = interleaveVerdicts(partAData, []);
    expect(result).toEqual(partAData);
  });

  it('appends verdict with no matching data section before B sections', () => {
    const call2 = [
      { heading: 'A8. Observations', body: 'No data for A8', flag: 'none' },
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
    ];
    const result = interleaveVerdicts(partAData, call2);

    const a8Idx = result.findIndex(s => s.heading === 'A8. Observations');
    const b1Idx = result.findIndex(s => s.heading === 'B1. Pupil Experience');
    expect(a8Idx).toBeLessThan(b1Idx);
  });

  it('handles verdict with no numeric prefix at all', () => {
    const call2 = [
      { heading: 'Observations', body: 'Unprefixed', flag: 'none' },
    ];
    const result = interleaveVerdicts(partAData, call2);
    // Should be appended (not match any data section)
    expect(result.some(s => s.heading === 'Observations')).toBe(true);
  });

  it('preserves data section order', () => {
    const call2 = [
      { heading: 'A6. Observations', body: '...', flag: 'none' },
      { heading: 'A3. Observations', body: '...', flag: 'none' },
    ];
    const result = interleaveVerdicts(partAData, call2);

    const headings = result.map(s => s.heading);
    expect(headings.indexOf('A1. School Identity')).toBeLessThan(headings.indexOf('A2. Inspection Outcomes'));
    expect(headings.indexOf('A2. Inspection Outcomes')).toBeLessThan(headings.indexOf('A3. Academic Performance'));
    expect(headings.indexOf('A5. Absence & Engagement')).toBeLessThan(headings.indexOf('A6. Financial Health'));
    expect(headings.indexOf('A6. Financial Health')).toBeLessThan(headings.indexOf('A7. Area Context'));
  });

  it('handles multi-digit section numbers (A10, A11)', () => {
    const data = [
      { heading: 'A9. Section Nine', body: '...', flag: 'none' },
      { heading: 'A10. Section Ten', body: '...', flag: 'none' },
      { heading: 'A11. Section Eleven', body: '...', flag: 'none' },
    ];
    const call2 = [
      { heading: 'A10. Observations', body: 'Ten obs', flag: 'none' },
      { heading: 'A11. Observations', body: 'Eleven obs', flag: 'none' },
    ];
    const result = interleaveVerdicts(data, call2);

    const a9Idx = result.findIndex(s => s.heading === 'A9. Section Nine');
    const a10Idx = result.findIndex(s => s.heading === 'A10. Observations');
    const a11Idx = result.findIndex(s => s.heading === 'A11. Observations');
    expect(a9Idx).toBeLessThan(a10Idx);
    expect(a10Idx).toBeLessThan(a11Idx);
  });

  // -- Regression: the ## prefix bug ------------------------------------------
  // Before the fix, AI headings like "## A2. Observations" didn't match the
  // /^A\d+\./ regex, so they were treated as B/C sections and dumped at the end.

  it('handles verdicts with ## prefix (stripped before reaching interleaveVerdicts)', () => {
    // parseOpenAIResponse now strips ## prefixes, so by the time
    // interleaveVerdicts runs, headings should be clean. This test
    // verifies that the clean form works correctly.
    const call2 = [
      { heading: 'A2. Observations', body: 'Now clean', flag: 'none' },
      { heading: 'A3. Observations', body: 'Also clean', flag: 'none' },
    ];
    const result = interleaveVerdicts(partAData, call2);

    const obsHeadings = result
      .filter(s => s.heading?.endsWith('Observations'))
      .map(s => s.heading);
    expect(obsHeadings).toEqual(['A2. Observations', 'A3. Observations']);
  });

  it('still correctly buckets verdicts with ## prefix (defence in depth)', () => {
    // Even if cleanHeading somehow misses a ##, interleaveVerdicts
    // should still handle it — the /^A\d+\./ regex won't match ## A2
    // so it falls through to B/C. This tests the bad path.
    const call2 = [
      { heading: '## A2. Observations', body: 'Dirty heading', flag: 'none' },
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
    ];
    const result = interleaveVerdicts(partAData, call2);

    // "## A2. Observations" won't match /^A\d+\./ so it goes to bcSections
    // and ends up at the end alongside B1
    const lastTwo = result.slice(-2).map(s => s.heading);
    expect(lastTwo).toContain('## A2. Observations');
    expect(lastTwo).toContain('B1. Pupil Experience');
  });
});

// ---------------------------------------------------------------------------
// enforceObservations
// ---------------------------------------------------------------------------

describe('enforceObservations', () => {
  const fullDataSections = [
    { heading: 'A1. School Identity', body: '...', flag: 'none' },
    { heading: 'A2. Inspection Outcomes', body: '...', flag: 'none' },
    { heading: 'A3. Academic Performance', body: '...', flag: 'none' },
    { heading: 'A4. Intake & Cohort', body: '...', flag: 'none' },
    { heading: 'A5. Absence & Engagement', body: '...', flag: 'none' },
    { heading: 'A6. Financial Health', body: '...', flag: 'none' },
    { heading: 'A7. Area Context', body: '...', flag: 'none' },
  ];

  it('strips orphan observations (prefix with no matching data section)', () => {
    const sections = [
      { heading: 'A1. School Identity', body: '...', flag: 'none' },
      { heading: 'A2. Inspection Outcomes', body: '...', flag: 'none' },
      { heading: 'A8. Observations', body: 'Orphan — no A8 data section', flag: 'none' },
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
    ];
    const dataSections = [
      { heading: 'A1. School Identity' },
      { heading: 'A2. Inspection Outcomes' },
    ];
    const result = enforceObservations(sections, dataSections);
    expect(result.some(s => s.heading === 'A8. Observations')).toBe(false);
  });

  it('inserts placeholder for A2-A7 data sections missing observations', () => {
    const sections = [
      { heading: 'A1. School Identity', body: '...', flag: 'none' },
      { heading: 'A2. Inspection Outcomes', body: '...', flag: 'none' },
      // A3 data but no A3 observation
      { heading: 'A3. Academic Performance', body: '...', flag: 'none' },
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
    ];
    const dataSections = [
      { heading: 'A1. School Identity' },
      { heading: 'A2. Inspection Outcomes' },
      { heading: 'A3. Academic Performance' },
    ];
    const result = enforceObservations(sections, dataSections);

    const a3Obs = result.find(s => s.heading === 'A3. Observations');
    expect(a3Obs).toBeDefined();
    expect(a3Obs.body).toBe('_Analysis not available for this section._');
    expect(a3Obs.flag).toBe('none');
  });

  it('does NOT insert placeholder for A1', () => {
    const sections = [
      { heading: 'A1. School Identity', body: '...', flag: 'none' },
    ];
    const dataSections = [
      { heading: 'A1. School Identity' },
    ];
    const result = enforceObservations(sections, dataSections);
    expect(result.some(s => s.heading === 'A1. Observations')).toBe(false);
  });

  it('preserves existing observations when present', () => {
    const sections = [
      { heading: 'A2. Inspection Outcomes', body: '...', flag: 'none' },
      { heading: 'A2. Observations', body: 'Real analysis here', flag: 'green' },
    ];
    const dataSections = [
      { heading: 'A2. Inspection Outcomes' },
    ];
    const result = enforceObservations(sections, dataSections);

    const obs = result.filter(s => s.heading === 'A2. Observations');
    expect(obs).toHaveLength(1);
    expect(obs[0].body).toBe('Real analysis here');
  });

  it('preserves non-A sections (B, C) unchanged', () => {
    const sections = [
      { heading: 'A2. Inspection Outcomes', body: '...', flag: 'none' },
      { heading: 'B1. Pupil Experience', body: 'B content', flag: 'none' },
      { heading: 'C1. Head-to-Head Verdict', body: 'C content', flag: 'green' },
    ];
    const dataSections = [
      { heading: 'A2. Inspection Outcomes' },
    ];
    const result = enforceObservations(sections, dataSections);

    expect(result.find(s => s.heading === 'B1. Pupil Experience').body).toBe('B content');
    expect(result.find(s => s.heading === 'C1. Head-to-Head Verdict').body).toBe('C content');
  });

  it('handles partial observation coverage (some present, some missing)', () => {
    const sections = [
      { heading: 'A2. Inspection Outcomes', body: '...', flag: 'none' },
      { heading: 'A2. Observations', body: 'Present', flag: 'none' },
      { heading: 'A3. Academic Performance', body: '...', flag: 'none' },
      // A3 observation missing
      { heading: 'A4. Intake & Cohort', body: '...', flag: 'none' },
      { heading: 'A4. Observations', body: 'Also present', flag: 'none' },
    ];
    const dataSections = [
      { heading: 'A2. Inspection Outcomes' },
      { heading: 'A3. Academic Performance' },
      { heading: 'A4. Intake & Cohort' },
    ];
    const result = enforceObservations(sections, dataSections);

    // A2 and A4 observations should be the original ones
    expect(result.find(s => s.heading === 'A2. Observations').body).toBe('Present');
    expect(result.find(s => s.heading === 'A4. Observations').body).toBe('Also present');

    // A3 should have a placeholder inserted
    const a3Obs = result.find(s => s.heading === 'A3. Observations');
    expect(a3Obs).toBeDefined();
    expect(a3Obs.body).toBe('_Analysis not available for this section._');
  });

  it('preserves section order after insertion', () => {
    const sections = [
      { heading: 'A1. School Identity', body: '...', flag: 'none' },
      { heading: 'A2. Inspection Outcomes', body: '...', flag: 'none' },
      // A2 observation missing — placeholder should go here
      { heading: 'A3. Academic Performance', body: '...', flag: 'none' },
      // A3 observation missing — placeholder should go here
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
    ];
    const dataSections = [
      { heading: 'A1. School Identity' },
      { heading: 'A2. Inspection Outcomes' },
      { heading: 'A3. Academic Performance' },
    ];
    const result = enforceObservations(sections, dataSections);

    const headings = result.map(s => s.heading);
    expect(headings).toEqual([
      'A1. School Identity',
      'A2. Inspection Outcomes',
      'A2. Observations',
      'A3. Academic Performance',
      'A3. Observations',
      'B1. Pupil Experience',
    ]);
  });

  // -- Regression: the duplicate observation bug ------------------------------
  // The AI was outputting "## A2. Observations" headings. cleanHeading (now
  // in parseOpenAIResponse) strips the ## prefix. But before that fix was
  // deployed, enforceObservations saw the clean data sections from renderPartA
  // but the AI headings had ## prefixes. The /^A\d+\./ regex didn't match
  // "## A2. Observations", so enforceObservations thought there were NO
  // observations at all and inserted _Analysis not available_ placeholders —
  // while the real observations (with ## prefixes) were still in the array,
  // creating duplicates.

  it('handles the post-fix scenario: clean headings match correctly (no duplicates)', () => {
    const sections = [
      { heading: 'A2. Inspection Outcomes', body: '...', flag: 'none' },
      { heading: 'A2. Observations', body: 'Real inspection analysis', flag: 'none' },
      { heading: 'A3. Academic Performance', body: '...', flag: 'none' },
      { heading: 'A3. Observations', body: 'Real academic analysis', flag: 'none' },
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
    ];
    const dataSections = [
      { heading: 'A2. Inspection Outcomes' },
      { heading: 'A3. Academic Performance' },
    ];
    const result = enforceObservations(sections, dataSections);

    // Only one of each observation — no duplicates
    expect(result.filter(s => s.heading === 'A2. Observations')).toHaveLength(1);
    expect(result.filter(s => s.heading === 'A3. Observations')).toHaveLength(1);

    // The existing observations should be preserved, not replaced
    expect(result.find(s => s.heading === 'A2. Observations').body).toBe('Real inspection analysis');
    expect(result.find(s => s.heading === 'A3. Observations').body).toBe('Real academic analysis');
  });
});

// ---------------------------------------------------------------------------
// tagPartLabels
// ---------------------------------------------------------------------------

describe('tagPartLabels', () => {
  it('tags A1 with Part A label', () => {
    const sections = [
      { heading: 'A1. School Identity', body: '...', flag: 'none' },
    ];
    const result = tagPartLabels(sections);
    expect(result[0]._partLabel).toBe('Part A — Official Record');
  });

  it('tags B1 with Part B label', () => {
    const sections = [
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
    ];
    const result = tagPartLabels(sections);
    expect(result[0]._partLabel).toBe('Part B — Independent Research');
  });

  it('tags C1 with Part C label', () => {
    const sections = [
      { heading: 'C1. Head-to-Head Verdict', body: '...', flag: 'none' },
    ];
    const result = tagPartLabels(sections);
    expect(result[0]._partLabel).toBe('Part C — Verdict & Synthesis');
  });

  it('does not tag A2, A3, B2, C2', () => {
    const sections = [
      { heading: 'A2. Inspection Outcomes', body: '...', flag: 'none' },
      { heading: 'A3. Academic Performance', body: '...', flag: 'none' },
      { heading: 'B2. Admissions', body: '...', flag: 'none' },
      { heading: 'C2. Which Child Thrives Where', body: '...', flag: 'none' },
    ];
    const result = tagPartLabels(sections);
    for (const s of result) {
      expect(s._partLabel).toBeUndefined();
    }
  });

  it('tags only the first section of each part', () => {
    const sections = [
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
      { heading: 'B2. Admissions', body: '...', flag: 'none' },
      { heading: 'B3. Extracurricular & Clubs', body: '...', flag: 'none' },
    ];
    const result = tagPartLabels(sections);
    expect(result[0]._partLabel).toBe('Part B — Independent Research');
    expect(result[1]._partLabel).toBeUndefined();
    expect(result[2]._partLabel).toBeUndefined();
  });

  it('handles empty sections array', () => {
    const result = tagPartLabels([]);
    expect(result).toEqual([]);
  });

  it('handles sections with no recognisable part prefix', () => {
    const sections = [
      { heading: 'Introduction', body: '...', flag: 'none' },
    ];
    const result = tagPartLabels(sections);
    expect(result[0]._partLabel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normaliseComparisonTable
// ---------------------------------------------------------------------------

describe('normaliseComparisonTable', () => {
  it('returns sections unchanged when no school names provided', () => {
    const sections = [
      { heading: 'C1.', body: '| Dimension | Winner |', flag: 'none' },
    ];
    const result = normaliseComparisonTable(sections, null);
    expect(result).toBe(sections);
  });

  it('returns sections unchanged when fewer than 2 school names', () => {
    const sections = [{ heading: 'C1.', body: 'text', flag: 'none' }];
    const result = normaliseComparisonTable(sections, ['One School']);
    expect(result).toBe(sections);
  });

  it('passes through already-pipe-delimited tables', () => {
    const sections = [
      {
        heading: 'C1. Head-to-Head Verdict',
        body: '| Dimension | Winner | By how much |\n|---|---|---|\n| Inspection | School A | Clear gap |',
        flag: 'none',
      },
    ];
    const result = normaliseComparisonTable(sections, ['Redriff Primary', 'Earlswood Junior']);
    expect(result[0].body).toContain('| Dimension | Winner | By how much |');
  });

  it('strips preamble lines before pipe table', () => {
    const sections = [
      {
        heading: 'C1.',
        body: 'Based on the analysis above:\n| Dimension | Winner |\n|---|---|',
        flag: 'none',
      },
    ];
    const result = normaliseComparisonTable(sections, ['School A', 'School B']);
    expect(result[0].body).not.toContain('Based on');
    expect(result[0].body).toContain('| Dimension | Winner |');
  });

  it('splits long last cell into separate paragraph (overflow fix)', () => {
    const longText = 'This is a very long verdict paragraph that got appended to the last table row and should be split out because it is over 80 characters in length.';
    const sections = [
      {
        heading: 'C1.',
        body: `| Dimension | Winner | By how much |\n|---|---|---|\n| Academic | School A | ${longText} |`,
        flag: 'none',
      },
    ];
    const result = normaliseComparisonTable(sections, ['School A', 'School B']);

    // Should NOT have the long text inside a table cell
    expect(result[0].body).not.toContain(`| Academic | School A | ${longText} |`);
    // Should have the long text as a separate paragraph after the table
    expect(result[0].body).toContain(longText);
  });

  it('handles non-pipe line inside a pipe table (ends table, pushes as paragraph)', () => {
    const sections = [
      {
        heading: 'C1.',
        body: '| Dimension | Winner |\n|---|---|\n| Academic | School A |\nThis is commentary added mid-table.\n| Community | School B |',
        flag: 'none',
      },
    ];
    const result = normaliseComparisonTable(sections, ['School A', 'School B']);

    // The commentary should be separated from the table
    expect(result[0].body).toContain('This is commentary added mid-table');
  });

  it('converts whitespace-separated comparison table to pipe format', () => {
    // The function detects comparison tables by checking if the header line
    // contains "Dimension" AND one of the school short names. C1 verdict
    // tables (Dimension + Winner, no school names) are detected but the
    // conversion logic requires the school-name path to trigger inTable.
    const sections = [
      {
        heading: 'C1. Head-to-Head Verdict',
        body: 'Dimension  School A  School B\nAcademic  Strong  Mixed',
        flag: 'none',
      },
    ];
    const result = normaliseComparisonTable(sections, ['School A', 'School B']);

    expect(result[0].body).toContain('| Dimension | School A | School B |');
  });
});

// ---------------------------------------------------------------------------
// Full pipeline integration — parseOpenAIResponse → final tagged sections
// ---------------------------------------------------------------------------

describe('full pipeline — section delimiters (Part A/B/C)', () => {

  const partAData = [
    { heading: 'A1. School Identity', body: '...', flag: 'none' },
    { heading: 'A2. Inspection Outcomes', body: '...', flag: 'none' },
    { heading: 'A3. Academic Performance', body: '...', flag: 'none' },
    { heading: 'A4. Intake & Cohort', body: '...', flag: 'none' },
    { heading: 'A5. Absence & Engagement', body: '...', flag: 'none' },
    { heading: 'A6. Financial Health', body: '...', flag: 'none' },
    { heading: 'A7. Area Context', body: '...', flag: 'none' },
  ];

  function runPipeline(aiResponseSections, dataSections = partAData) {
    const parsed = parseOpenAIResponse({
      output_text: JSON.stringify({
        title: 'Test', summary: 'Test', scorecard: [],
        sections: aiResponseSections,
      }),
    });
    if (parsed.status !== 'completed') throw new Error('parse failed: ' + parsed.status);
    const interleaved = interleaveVerdicts(dataSections, parsed.sections);
    const enforced = enforceObservations(interleaved, dataSections);
    return tagPartLabels(enforced);
  }

  function partLabels(sections) {
    return sections
      .filter(s => s._partLabel)
      .map(s => ({ heading: s.heading, label: s._partLabel }));
  }

  // -- Happy path: all three parts present ------------------------------------

  it('produces Part A, B, and C delimiters for a complete response', () => {
    const aiSections = [
      { heading: 'A2. Observations', body: 'Inspection analysis.', flag: 'none' },
      { heading: 'A3. Observations', body: 'Academic analysis.', flag: 'none' },
      { heading: 'A4. Observations', body: 'Intake analysis.', flag: 'none' },
      { heading: 'A5. Observations', body: 'Absence analysis.', flag: 'none' },
      { heading: 'A6. Observations', body: 'Financial analysis.', flag: 'none' },
      { heading: 'A7. Observations', body: 'Area analysis.', flag: 'none' },
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
      { heading: 'B2. Admissions', body: '...', flag: 'none' },
      { heading: 'C1. Head-to-Head Verdict', body: '...', flag: 'none' },
    ];

    const result = runPipeline(aiSections);
    const labels = partLabels(result);

    expect(labels).toEqual([
      { heading: 'A1. School Identity', label: 'Part A — Official Record' },
      { heading: 'B1. Pupil Experience', label: 'Part B — Independent Research' },
      { heading: 'C1. Head-to-Head Verdict', label: 'Part C — Verdict & Synthesis' },
    ]);
  });

  // -- Part A delimiter always present (server-rendered A1 always exists) -----

  it('always has Part A delimiter (A1 is server-rendered)', () => {
    const aiSections = [
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
    ];
    const result = runPipeline(aiSections);
    const labels = partLabels(result);
    expect(labels[0].label).toBe('Part A — Official Record');
  });

  // -- Only A1 gets Part A label, not A2/A3/etc ------------------------------

  it('only tags A1 with Part A label — not A2, A3, etc.', () => {
    const aiSections = [
      { heading: 'A2. Observations', body: '...', flag: 'none' },
      { heading: 'A3. Observations', body: '...', flag: 'none' },
    ];
    const result = runPipeline(aiSections);
    const aLabels = result.filter(s => s._partLabel && s._partLabel.startsWith('Part A'));
    expect(aLabels).toHaveLength(1);
    expect(aLabels[0].heading).toBe('A1. School Identity');
  });

  // -- No delimiter between A-sections (A2, A3, etc.) ------------------------

  it('has no delimiters between A-sections (A2, A3, ...)', () => {
    const aiSections = [
      { heading: 'A2. Observations', body: '...', flag: 'none' },
      { heading: 'A3. Observations', body: '...', flag: 'none' },
      { heading: 'A4. Observations', body: '...', flag: 'none' },
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
    ];
    const result = runPipeline(aiSections);

    // Check that between A1 and B1 there are no _partLabel tags
    const b1Idx = result.findIndex(s => s.heading === 'B1. Pupil Experience');
    const aSectionsBeforeB = result.slice(0, b1Idx);
    const innerLabels = aSectionsBeforeB.filter(s => s._partLabel);
    // Only A1 should have a label
    expect(innerLabels).toHaveLength(1);
    expect(innerLabels[0].heading).toBe('A1. School Identity');
  });

  // -- Part B delimiter only if B1 exists ------------------------------------

  it('has no Part B delimiter when AI omits B1', () => {
    // Regression test for TD-020 — KS5-only schools missing Part B delimiter
    const aiSections = [
      { heading: 'A2. Observations', body: '...', flag: 'none' },
      { heading: 'C1. Head-to-Head Verdict', body: '...', flag: 'none' },
    ];
    const result = runPipeline(aiSections);
    const labels = partLabels(result);

    expect(labels).toEqual([
      { heading: 'A1. School Identity', label: 'Part A — Official Record' },
      { heading: 'C1. Head-to-Head Verdict', label: 'Part C — Verdict & Synthesis' },
    ]);
  });

  // -- Part C delimiter only if C1 exists -------------------------------------

  it('has no Part C delimiter when AI omits C1', () => {
    const aiSections = [
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
    ];
    const result = runPipeline(aiSections);
    const labels = partLabels(result);

    expect(labels).toEqual([
      { heading: 'A1. School Identity', label: 'Part A — Official Record' },
      { heading: 'B1. Pupil Experience', label: 'Part B — Independent Research' },
    ]);
  });

  // -- AI doesn't produce its own "Part A" heading as a section ---------------

  it('does not produce duplicate Part labels when AI outputs its own part headings', () => {
    // The OUTPUT_CONSTRAINTS say: "Do NOT create separate section objects
    // for structural part headers like 'Part A — Official Record'."
    // But if the AI disobeys, tagPartLabels only tags the FIRST section
    // with each prefix (A1., B1., C1.). This test verifies we don't
    // accidentally tag an AI-generated fake part header.
    const aiSections = [
      { heading: 'Part A — Official Record', body: 'Some AI preamble.', flag: 'none' },
      { heading: 'A2. Observations', body: '...', flag: 'none' },
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
    ];
    const result = runPipeline(aiSections);
    const labels = partLabels(result);

    // "Part A — Official Record" does NOT start with "A1." — so no Part A label on it
    // A1. School Identity gets Part A label
    // B1. Pupil Experience gets Part B label
    expect(labels).toEqual([
      { heading: 'A1. School Identity', label: 'Part A — Official Record' },
      { heading: 'B1. Pupil Experience', label: 'Part B — Independent Research' },
    ]);
  });

  // -- Section ordering: delimiters appear at correct positions ---------------

  it('places sections in order: Part A → observations → Part B → Part C', () => {
    // AI outputs in the prompt's schema order: A observations, then B, then C.
    // interleaveVerdicts preserves bcSections order as-is from the AI response.
    const aiSections = [
      { heading: 'A2. Observations', body: '...', flag: 'none' },
      { heading: 'B1. Pupil Experience', body: '...', flag: 'none' },
      { heading: 'B2. Admissions', body: '...', flag: 'none' },
      { heading: 'C1. Head-to-Head Verdict', body: '...', flag: 'none' },
    ];
    const result = runPipeline(aiSections);

    const a1Idx = result.findIndex(s => s.heading === 'A1. School Identity');
    const a2ObsIdx = result.findIndex(s => s.heading === 'A2. Observations');
    const b1Idx = result.findIndex(s => s.heading === 'B1. Pupil Experience');
    const c1Idx = result.findIndex(s => s.heading === 'C1. Head-to-Head Verdict');

    expect(a1Idx).toBeLessThan(a2ObsIdx);   // Part A heading before its observation
    expect(a2ObsIdx).toBeLessThan(b1Idx);    // A observations before Part B
    expect(b1Idx).toBeLessThan(c1Idx);       // Part B before Part C
  });

  // -- Empty AI response — only Part A exists ---------------------------------

  it('produces only Part A delimiter when AI returns no sections', () => {
    const result = runPipeline([]);
    const labels = partLabels(result);
    expect(labels).toEqual([
      { heading: 'A1. School Identity', label: 'Part A — Official Record' },
    ]);
  });
});
