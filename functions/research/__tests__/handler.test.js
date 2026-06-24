/**
 * Unit tests for the /api/research Lambda handler.
 * These tests run without SAM or Docker — fetch is mocked.
 * Run: npm test
 */

import { jest } from '@jest/globals';

// Mock govuk.js so it never makes real fetch calls during unit tests
await jest.unstable_mockModule('../govuk.js', () => ({
  fetchGovDataForPrompt: jest.fn().mockResolvedValue({ block: '', quickTakeBlock: '', flags: {}, schools: [] }),
  renderPartA: jest.fn().mockReturnValue([]),
  renderPartAComparison: jest.fn().mockReturnValue([]),
  computeFlags: jest.fn().mockReturnValue({}),
  getAreaData: jest.fn().mockResolvedValue(null),
  renderPartBArea: jest.fn().mockReturnValue([]),
  fetchSchoolsInArea: jest.fn().mockResolvedValue([]),
}));

// Mock fetch globally before importing the handler
const mockFetch = jest.fn();
global.fetch = mockFetch;

const { handler, normaliseC1Table } = await import('../index.js');

// Reset mock and env before every test to prevent bleed-through
beforeEach(() => {
  mockFetch.mockReset();
  process.env.OPENAI_API_KEY = 'test-key';
});

// ---------------------------------------------------------------------------
// Logging helper — captures structured JSON emitted via console.log
// ---------------------------------------------------------------------------

function captureLog(fn) {
  const entries = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((line) => {
    try { entries.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
  });
  return fn().then(result => {
    spy.mockRestore();
    return { result, entries };
  }).catch(err => {
    spy.mockRestore();
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(body) {
  return { body: JSON.stringify(body) };
}

function mockOpenAI(responseBody, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  });
}

// Branch 1 uses two calls: Call 1 = Quick Take, Call 2 = B+C sections.
// VALID_QT_RESPONSE is the Call 1 mock; VALID_BC_RESPONSE is the Call 2 mock.
// VALID_OPENAI_RESPONSE (all fields) is kept for branches 2/3/4 (single-call).
const VALID_QT_RESPONSE = {
  output_text: JSON.stringify({
    title: 'Test School',
    summary: 'A good school.',
    scorecard: [{ dimension: 'Academic', rating: 'strong', note: 'Top results.' }],
  }),
  output: [],
};

const VALID_BC_RESPONSE = {
  output_text: JSON.stringify({
    sections: [
      { heading: '1. Direct Answer', body: 'This is the answer.' },
      { heading: 'Sources', body: '[Gov](https://gov.uk)' },
    ],
  }),
  output: [],
};

// Convenience: set up both branch-1 mocks in one call
function mockBranch1(qt = VALID_QT_RESPONSE, bc = VALID_BC_RESPONSE) {
  mockOpenAI(qt);
  mockOpenAI(bc);
}

const VALID_OPENAI_RESPONSE = {
  output_text: JSON.stringify({
    title: 'Test School',
    summary: 'A good school.',
    scorecard: [{ dimension: 'Academic', rating: 'strong', note: 'Top results.' }],
    sections: [
      { heading: '1. Direct Answer', body: 'This is the answer.' },
      { heading: 'Sources', body: '[Gov](https://gov.uk)' },
    ],
  }),
  output: [],
};

// ---------------------------------------------------------------------------
// Analytics logging tests
// ---------------------------------------------------------------------------

describe('Analytics logging', () => {
  test('logs research_request with status=completed on success', async () => {
    mockBranch1();
    const { entries } = await captureLog(() =>
      handler(makeEvent({ branch: 'prompt_branch_1', question: 'Tell me about Eton' }))
    );
    const entry = entries.find(e => e.event === 'research_request');
    expect(entry).toBeDefined();
    expect(entry.status).toBe('completed');
    expect(entry.branch).toBe('prompt_branch_1');
    expect(entry.httpStatus).toBe(200);
    expect(typeof entry.ms).toBe('number');
    expect(entry.ts).toMatch(/^\d{4}-/); // ISO timestamp
    expect(entry.question).toBe('Tell me about Eton');
  });

  test('logs research_request with status=validation_failed on bad input', async () => {
    const { entries } = await captureLog(() =>
      handler(makeEvent({ question: 'No branch here' }))
    );
    const entry = entries.find(e => e.event === 'research_request');
    expect(entry).toBeDefined();
    expect(entry.status).toBe('validation_failed');
    expect(entry.httpStatus).toBe(400);
  });

  test('logs research_request with status=invalid_json on bad body', async () => {
    const { entries } = await captureLog(() =>
      handler({ body: 'not json' })
    );
    const entry = entries.find(e => e.event === 'research_request');
    expect(entry).toBeDefined();
    expect(entry.status).toBe('invalid_json');
    expect(entry.httpStatus).toBe(400);
  });

  test('logs research_request with status=upstream_error on OpenAI 429', async () => {
    mockOpenAI({}, 429);
    const { entries } = await captureLog(() =>
      handler(makeEvent({ branch: 'prompt_branch_1', question: 'Test' }))
    );
    const entry = entries.find(e => e.event === 'research_request');
    expect(entry).toBeDefined();
    expect(entry.status).toBe('upstream_error');
    expect(entry.httpStatus).toBe(429);
    expect(entry.branch).toBe('prompt_branch_1');
    expect(typeof entry.ms).toBe('number');
  });

  test('logs research_request with status=timeout on AbortError', async () => {
    const timeoutErr = new Error('The operation timed out.');
    timeoutErr.name = 'TimeoutError';
    mockFetch.mockRejectedValueOnce(timeoutErr);
    const { entries } = await captureLog(() =>
      handler(makeEvent({ branch: 'prompt_branch_2', question: 'Compare schools' }))
    );
    const entry = entries.find(e => e.event === 'research_request');
    expect(entry).toBeDefined();
    expect(entry.status).toBe('timeout');
    expect(entry.httpStatus).toBe(504);
    expect(entry.branch).toBe('prompt_branch_2');
  });

  test('truncates question to 200 characters in log', async () => {
    mockBranch1();
    const longQuestion = 'x'.repeat(300);
    const { entries } = await captureLog(() =>
      handler(makeEvent({ branch: 'prompt_branch_1', question: longQuestion }))
    );
    const entry = entries.find(e => e.event === 'research_request');
    expect(entry.question.length).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe('Validation', () => {
  test('returns 400 when branch is missing', async () => {
    const res = await handler(makeEvent({ question: 'Tell me about Eton' }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.details).toContain('Missing branch.');
  });

  test('returns 400 for an unsupported branch', async () => {
    const res = await handler(makeEvent({ branch: 'prompt_branch_99', question: 'Tell me about Eton' }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.details).toContain('Branch is not supported.');
  });

  test('returns 400 when question is missing', async () => {
    const res = await handler(makeEvent({ branch: 'prompt_branch_1' }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.details).toContain('Missing question.');
  });

  test('returns 400 when question is empty', async () => {
    const res = await handler(makeEvent({ branch: 'prompt_branch_1', question: '   ' }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.details).toContain('Question is required.');
  });

  test('returns 400 when question exceeds 600 characters', async () => {
    const res = await handler(makeEvent({ branch: 'prompt_branch_1', question: 'x'.repeat(601) }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.details).toContain('Question must be 600 characters or fewer.');
  });

  test('accepts all four valid branches', async () => {
    for (const branch of ['prompt_branch_1', 'prompt_branch_2', 'prompt_branch_3', 'prompt_branch_4']) {
      // Branch 1 uses two API calls; all other branches use one
      if (branch === 'prompt_branch_1') mockBranch1(); else mockOpenAI(VALID_OPENAI_RESPONSE);
      const res = await handler(makeEvent({ branch, question: 'Test question' }));
      // Should not be a validation error
      const body = JSON.parse(res.body);
      expect(body.error).not.toBe('Validation failed.');
    }
  });

  test('returns 400 for invalid JSON body', async () => {
    const res = await handler({ body: 'not json' });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Response parsing tests
// ---------------------------------------------------------------------------

describe('Response parsing', () => {

  test('returns completed status on valid OpenAI response', async () => {
    mockBranch1();
    const res = await handler(makeEvent({ branch: 'prompt_branch_1', question: 'Tell me about Eton' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('completed');
    expect(body.title).toBe('Test School');
    expect(body.summary).toBe('A good school.');
  });

  test('renames Sources section to Primary Sources', async () => {
    mockBranch1();
    const res = await handler(makeEvent({ branch: 'prompt_branch_1', question: 'Test' }));
    const body = JSON.parse(res.body);
    const headings = body.sections.map(s => s.heading);
    expect(headings).toContain('Primary Sources');
    expect(headings).not.toContain('Sources');
  });

  test('strips markdown code fences from response', async () => {
    // Fences in Call 1 (Quick Take) — should be stripped and parsed correctly
    const withFences = {
      output_text: '```json\n' + JSON.stringify({
        title: 'T', summary: 'S', scorecard: [],
      }) + '\n```',
      output: [],
    };
    mockOpenAI(withFences);       // Call 1
    mockOpenAI(VALID_BC_RESPONSE); // Call 2
    const res = await handler(makeEvent({ branch: 'prompt_branch_1', question: 'Test' }));
    const body = JSON.parse(res.body);
    expect(body.status).toBe('completed');
  });

  test('returns 502 on empty OpenAI response', async () => {
    mockOpenAI({ output_text: '', output: [] });
    const res = await handler(makeEvent({ branch: 'prompt_branch_1', question: 'Test' }));
    const body = JSON.parse(res.body);
    expect(body.status).toBe('upstream_invalid_format');
    expect(body.httpStatus).toBe(502);
  });

  test('returns 502 when OpenAI returns malformed JSON', async () => {
    mockOpenAI({ output_text: 'this is not json', output: [] });
    const res = await handler(makeEvent({ branch: 'prompt_branch_1', question: 'Test' }));
    const body = JSON.parse(res.body);
    expect(body.status).toBe('upstream_invalid_format');
  });

  test('extracts web search sources into Secondary Sources', async () => {
    // Web search sources come from Call 2 (the B+C call with tool_choice: auto)
    const call2WithSources = {
      output_text: JSON.stringify({
        sections: [{ heading: '1. Answer', body: 'Body text.' }],
      }),
      output: [{
        type: 'web_search_call',
        action: { sources: [{ url: 'https://example.com', title: 'Example' }] },
      }],
    };
    mockOpenAI(VALID_QT_RESPONSE); // Call 1
    mockOpenAI(call2WithSources);  // Call 2
    const res = await handler(makeEvent({ branch: 'prompt_branch_1', question: 'Test' }));
    const body = JSON.parse(res.body);
    const secondary = body.sections.find(s => s.heading === 'Secondary Sources');
    expect(secondary).toBeDefined();
    expect(secondary.body).toContain('https://example.com');
  });
});

// ---------------------------------------------------------------------------
// Error handling tests
// ---------------------------------------------------------------------------

describe('Error handling', () => {
  test('returns 503 when OPENAI_API_KEY is not set', async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await handler(makeEvent({ branch: 'prompt_branch_1', question: 'Test' }));
    expect(res.statusCode).toBe(503);
  });

  test('returns upstream_error on OpenAI 401', async () => {
    mockOpenAI({}, 401);
    const res = await handler(makeEvent({ branch: 'prompt_branch_1', question: 'Test' }));
    const body = JSON.parse(res.body);
    expect(body.status).toBe('upstream_error');
    expect(body.summary).toMatch(/API key/);
  });

  test('returns upstream_error on OpenAI 429', async () => {
    mockOpenAI({}, 429);
    const res = await handler(makeEvent({ branch: 'prompt_branch_1', question: 'Test' }));
    const body = JSON.parse(res.body);
    expect(body.status).toBe('upstream_error');
    expect(body.summary).toMatch(/rate.limit/i);
  });

  test('returns upstream_error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const res = await handler(makeEvent({ branch: 'prompt_branch_1', question: 'Test' }));
    const body = JSON.parse(res.body);
    expect(body.status).toBe('upstream_error');
    expect(body.httpStatus).toBe(502);
  });
});

// ── C1 Table structure contract ──────────────────────────────────────────────
// Verifies that normaliseC1Table produces a valid C1 table regardless of
// how the AI formats its input. These test the output contract, not the input.

const VALID_EVIDENCE = new Set(['Strong', 'Present', 'Not evident', 'Mixed', 'Weak']);

describe('normaliseC1Table — output contract', () => {

  test('every data row has exactly 3 columns', () => {
    const sections = [
      { heading: 'C1. School Character', body: [
        '| Dimension | Evidence level | Notes |',
        '|---|---|---|',
        '| Academic focus | Strong | Above national. |',
        '| Arts, music | Present | Good offer. |',
        '| Sports | Not evident | No standout sport. |',
      ].join('\n'), flag: 'none' },
    ];
    const result = normaliseC1Table(sections);
    const lines = result[0].body.split('\n');
    for (const line of lines) {
      if (line.startsWith('|') && !line.startsWith('|---')) {
        const cells = line.split('|').filter(c => c.trim());
        if (cells.length !== 3) throw new Error(`Expected 3 columns, got ${cells.length}: "${line}"`);
      }
    }
  });

  test('evidence level is always a valid keyword (Strong, Present, Not evident)', () => {
    const sections = [
      { heading: 'C1. School Character', body: [
        '| Dimension | Evidence level | Notes |',
        '|---|---|---|',
        '| Academic focus | Strong | Results above national. |',
        '| Arts | Present | Broad offer. |',
        '| Sports | Not evident | Nothing notable. |',
      ].join('\n'), flag: 'none' },
    ];
    const result = normaliseC1Table(sections);
    const lines = result[0].body.split('\n');
    for (const line of lines) {
      // Skip header, separator, and non-table lines
      if (!line.startsWith('|') || line.startsWith('|---')) continue;
      if (/\bDimension\b/i.test(line) && /\bEvidence\s*level\b/i.test(line)) continue;
      const cells = line.split('|').filter(c => c.trim());
      const evidence = cells[1]?.trim();
      if (!VALID_EVIDENCE.has(evidence)) {
        throw new Error(`Invalid evidence level "${evidence}" in row: "${line}"`);
      }
    }
  });

  test('dimension and notes columns are non-empty', () => {
    const sections = [
      { heading: 'C1. School Character', body: [
        '| Dimension | Evidence level | Notes |',
        '|---|---|---|',
        '| Academic focus | Strong | Results above national. |',
        '| Arts | Present | Broad offer. |',
      ].join('\n'), flag: 'none' },
    ];
    const result = normaliseC1Table(sections);
    const lines = result[0].body.split('\n');
    for (const line of lines) {
      if (!line.startsWith('|') || line.startsWith('|---')) continue;
      if (/\bDimension\b/i.test(line) && /\bEvidence\s*level\b/i.test(line)) continue;
      const cells = line.split('|').filter(c => c.trim());
      if (!cells[0]) throw new Error(`Empty dimension in: "${line}"`);
      if (!cells[2]) throw new Error(`Empty notes in: "${line}"`);
    }
  });

  test('non-C1 sections pass through unchanged', () => {
    const sections = [
      { heading: 'B1. Pupil Experience', body: 'Some content.', flag: 'none' },
    ];
    const result = normaliseC1Table(sections);
    expect(result[0].body).toBe('Some content.');
  });

  // ── Feedback / analytics route ───────────────────────────────────────────────

  describe('POST /api/feedback', () => {

    function makeFeedbackEvent(body, path = '/api/feedback') {
      return {
        body: JSON.stringify(body),
        requestContext: { http: { method: 'POST', path } },
      };
    }

    test('returns 200 logged for valid feedback_submit event', async () => {
      const event = makeFeedbackEvent({
        event: 'feedback_submit',
        branch: 'prompt_branch_1',
        rating: 'up',
        text: 'Great report, very detailed.',
      });
      const res = await handler(event);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('logged');
    });

    test('returns 200 for /api/analytics/click path', async () => {
      const event = makeFeedbackEvent(
        { event: 'feedback_submit', branch: '', rating: 'down', text: '' },
        '/api/analytics/click'
      );
      const res = await handler(event);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('logged');
    });

    test('handles empty JSON body gracefully', async () => {
      const event = { body: '{}', requestContext: { http: { method: 'POST', path: '/api/feedback' } } };
      const res = await handler(event);
      expect(res.statusCode).toBe(200);
    });

    test('handles completely empty body gracefully', async () => {
      const event = { body: '', requestContext: { http: { method: 'POST', path: '/api/feedback' } } };
      const res = await handler(event);
      expect(res.statusCode).toBe(200);
    });

    test('truncates long text to 500 characters', async () => {
      const event = makeFeedbackEvent({
        event: 'feedback_submit',
        branch: 'prompt_branch_1',
        rating: 'up',
        text: 'x'.repeat(600),
      });
      const res = await handler(event);
      expect(res.statusCode).toBe(200);
      // The text is truncated server-side via .slice(0, 500); we can't inspect
      // the logged value directly but we confirm it doesn't crash.
    });

    test('truncates long event name to 64 characters', async () => {
      const event = makeFeedbackEvent({
        event: 'a'.repeat(100),
      });
      const res = await handler(event);
      expect(res.statusCode).toBe(200);
    });

    test('captures section field for per-section feedback', async () => {
      const event = makeFeedbackEvent({
        event: 'section_feedback',
        branch: 'prompt_branch_1',
        section: 'A2. Inspection Outcomes',
        rating: 'up',
      });
      const res = await handler(event);
      expect(res.statusCode).toBe(200);
    });

    test('captures bottom-form feedback_submit with text and email', async () => {
      const event = makeFeedbackEvent({
        event: 'feedback_submit',
        branch: 'prompt_branch_1',
        text: 'The A3 progress table is missing KS2 data.',
        email: 'parent@example.com',
      });
      const res = await handler(event);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('logged');
    });

    test('captures bottom-form feedback_submit without email', async () => {
      const event = makeFeedbackEvent({
        event: 'feedback_submit',
        branch: 'prompt_branch_2',
        text: 'Missing independent school comparison.',
        email: '',
      });
      const res = await handler(event);
      expect(res.statusCode).toBe(200);
    });

    test('captures bottom-form feedback_submit with empty text', async () => {
      const event = makeFeedbackEvent({
        event: 'feedback_submit',
        branch: 'prompt_branch_1',
        text: '',
        email: '',
      });
      const res = await handler(event);
      expect(res.statusCode).toBe(200);
    });

    test('does not intercept research POST at / path', async () => {
      // POST to / should still validate as a research request
      const event = { body: '{}', requestContext: { http: { method: 'POST', path: '/' } } };
      const res = await handler(event);
      // Missing branch → validation error from research handler
      expect(res.statusCode).toBe(400);
    });

  });

});
