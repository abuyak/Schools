/**
 * Unit tests for the govuk.js logging feature flag.
 *
 * Verifies the two-tier logging contract:
 *
 *   Always-log  — govuk_start, govuk_manifest, govuk_done, hard failures.
 *                 Fires regardless of GOVUK_VERBOSE_LOGS.
 *
 *   Verbose-log — per-URL HTTP events (fetch_text_fail, fetch_text_err, …),
 *                 per-school intermediate steps (govuk_gias_found, govuk_ofsted_ok, …).
 *                 Suppressed when GOVUK_VERBOSE_LOGS ≠ '1'.
 *
 * No SAM, no OpenAI, no real network calls — fetch is fully mocked.
 * Run: npm test -- --testPathPatterns=govuk-logging
 */

import { jest } from '@jest/globals';

// ── Shared fetch stub ──────────────────────────────────────────────────────────
// Returns HTTP 503 for every call.  Enough for the code to fail gracefully,
// log the right events, and return an empty/partial block without hanging.
function makeMockFetch() {
  return jest.fn().mockResolvedValue({
    ok:          false,
    status:      503,
    json:        async () => ({}),
    text:        async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
    headers:     { get: () => null },
  });
}

// ── Log capture ────────────────────────────────────────────────────────────────
// Same pattern as handler.test.js — returns structured JSON events only.
async function runAndCapture(fn) {
  const events = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((line) => {
    try { events.push(JSON.parse(line)); } catch { /* ignore non-JSON lines */ }
  });
  try   { await fn(); }
  finally { spy.mockRestore(); }
  return events;
}

// ── Module loader helper ───────────────────────────────────────────────────────
// GOVUK_VERBOSE is a `const` captured once at module-load time.
// jest.isolateModulesAsync gives each call a fresh module registry so the
// env var set immediately before the import is the one the module sees.
async function loadGovuk({ verbose = false } = {}) {
  process.env.GOVUK_VERBOSE_LOGS = verbose ? '1' : '0';

  let mod;
  await jest.isolateModulesAsync(async () => {
    // local-data.js bundles DfE ethnicity JSON — mock it so we don't read disk
    await jest.unstable_mockModule('../local-data.js', () => ({
      getSchoolEthnicity: jest.fn().mockReturnValue(null),
    }));
    mod = await import('../govuk.js');
  });

  return mod;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const QUESTION = 'Tell me about Redriff Primary, City of London Academy';
const BRANCH    = 'prompt_branch_1';
const DUMMY_KEY = 'sk-test';
const DUMMY_URL = 'https://api.openai.com/v1';
const DUMMY_MDL = 'gpt-4o-mini';

// =============================================================================
// Quiet mode (GOVUK_VERBOSE_LOGS=0) — production default
// =============================================================================

describe('GOVUK_VERBOSE_LOGS=0 — always-log events fire', () => {
  let fetchGovDataForPrompt;

  beforeAll(async () => {
    global.fetch = makeMockFetch();
    ({ fetchGovDataForPrompt } = await loadGovuk({ verbose: false }));
  });

  afterAll(() => {
    delete process.env.GOVUK_VERBOSE_LOGS;
  });

  test('govuk_start fires with branch and school names', async () => {
    const events = await runAndCapture(() =>
      fetchGovDataForPrompt(QUESTION, BRANCH, DUMMY_KEY, DUMMY_URL, DUMMY_MDL)
    );

    const e = events.find(e => e.event === 'govuk_start');
    expect(e).toBeDefined();
    expect(e.branch).toBe(BRANCH);
    expect(Array.isArray(e.names)).toBe(true);
    expect(e.names.length).toBeGreaterThan(0);
    expect(e.src).toBe('govuk');
    expect(typeof e.ts).toBe('string');
  });

  test('govuk_manifest fires with correct data-source fields', async () => {
    const events = await runAndCapture(() =>
      fetchGovDataForPrompt(QUESTION, BRANCH, DUMMY_KEY, DUMMY_URL, DUMMY_MDL)
    );

    const e = events.find(e => e.event === 'govuk_manifest');
    expect(e).toBeDefined();

    // Each field maps directly to a prompt block section
    expect(e).toHaveProperty('input');       // raw name from question
    expect(e).toHaveProperty('urn');         // → A1 identity
    expect(e).toHaveProperty('name');        // → A1 identity
    expect(e).toHaveProperty('identity');    // → A1 School Identity
    expect(e).toHaveProperty('ofsted');      // → A2 Inspection Outcomes
    expect(e).toHaveProperty('ofstedGrade'); // → A2 grade string
    expect(e).toHaveProperty('pdfParsed');   // → A3 narrative + A4 next steps
    expect(e).toHaveProperty('parentView');  // → B1 Parent View
    expect(e).toHaveProperty('performance'); // → A6 Academic Results
    expect(e).toHaveProperty('financial');   // → A8 Financial
    expect(e).toHaveProperty('area');        // → A9 Area Profile
    expect(e).toHaveProperty('schoolEthnicity'); // → A5 Pupil Census
  });

  test('govuk_manifest fields are booleans (false when fetches fail)', async () => {
    const events = await runAndCapture(() =>
      fetchGovDataForPrompt(QUESTION, BRANCH, DUMMY_KEY, DUMMY_URL, DUMMY_MDL)
    );

    const e = events.find(e => e.event === 'govuk_manifest');
    // All fetches return 503 → all boolean fields should be false
    expect(typeof e.identity).toBe('boolean');
    expect(typeof e.ofsted).toBe('boolean');
    expect(typeof e.pdfParsed).toBe('boolean');
    expect(typeof e.parentView).toBe('boolean');
    expect(typeof e.performance).toBe('boolean');
    expect(typeof e.financial).toBe('boolean');
    expect(typeof e.area).toBe('boolean');
    expect(typeof e.schoolEthnicity).toBe('boolean');
  });

  test('govuk_done fires with ms and school counts', async () => {
    const events = await runAndCapture(() =>
      fetchGovDataForPrompt(QUESTION, BRANCH, DUMMY_KEY, DUMMY_URL, DUMMY_MDL)
    );

    const e = events.find(e => e.event === 'govuk_done');
    expect(e).toBeDefined();
    expect(typeof e.ms).toBe('number');
    expect(typeof e.schools).toBe('number');
    expect(typeof e.resolved).toBe('number');
    expect(e.branch).toBe(BRANCH);
  });

  test('govuk_gias_fail fires when GIAS returns non-OK (hard failure)', async () => {
    const events = await runAndCapture(() =>
      fetchGovDataForPrompt(QUESTION, BRANCH, DUMMY_KEY, DUMMY_URL, DUMMY_MDL)
    );

    // GIAS returns 503 → govuk_gias_fail must fire (always-log hard failure)
    const e = events.find(e => e.event === 'govuk_gias_fail');
    expect(e).toBeDefined();
  });

  test('event order is govuk_start → govuk_manifest → govuk_done', async () => {
    const events = await runAndCapture(() =>
      fetchGovDataForPrompt(QUESTION, BRANCH, DUMMY_KEY, DUMMY_URL, DUMMY_MDL)
    );

    const names = events.map(e => e.event);
    const iStart    = names.indexOf('govuk_start');
    const iManifest = names.indexOf('govuk_manifest');
    const iDone     = names.indexOf('govuk_done');

    expect(iStart).toBeGreaterThanOrEqual(0);
    expect(iManifest).toBeGreaterThan(iStart);
    expect(iDone).toBeGreaterThan(iManifest);
  });
});

// =============================================================================
// Quiet mode — verbose-only events are suppressed
// =============================================================================

describe('GOVUK_VERBOSE_LOGS=0 — verbose-only events suppressed', () => {
  let fetchGovDataForPrompt;

  beforeAll(async () => {
    global.fetch = makeMockFetch();
    ({ fetchGovDataForPrompt } = await loadGovuk({ verbose: false }));
  });

  afterAll(() => {
    delete process.env.GOVUK_VERBOSE_LOGS;
  });

  // These events are verbose-only — they must not appear in quiet mode.
  const VERBOSE_ONLY_EVENTS = [
    'fetch_text_fail',
    'fetch_text_err',
    'fetch_json_fail',
    'fetch_json_err',
    'fetch_buffer_ok',
    'fetch_buffer_fail',
    'fetch_buffer_err',
    'govuk_gias_found',
    'govuk_gias_no_result',
    'govuk_gias_detail_ok',
    'govuk_gias_detail_empty',
    'govuk_gias_detail_fail',
    'govuk_ofsted_ok',
    'govuk_ofsted_no_data',
    'govuk_pdf_attempt_fail',
    'govuk_area_ok',
    'govuk_area_no_codes',
    'govuk_parentview_ok',
    'govuk_parentview_fail',
    'govuk_perf_ok',
    'govuk_perf_no_data',
    'govuk_fin_ok',
    'govuk_fin_no_data',
  ];

  test('no verbose-only events appear in the log', async () => {
    const events = await runAndCapture(() =>
      fetchGovDataForPrompt(QUESTION, BRANCH, DUMMY_KEY, DUMMY_URL, DUMMY_MDL)
    );

    const emitted = new Set(events.map(e => e.event));
    const leaked  = VERBOSE_ONLY_EVENTS.filter(name => emitted.has(name));

    expect(leaked).toEqual([]);
  });
});

// =============================================================================
// govuk_no_names — fires and is all that fires when question has no school name
// =============================================================================

describe('govuk_no_names — fires when no school name can be extracted', () => {
  let fetchGovDataForPrompt;

  beforeAll(async () => {
    global.fetch = makeMockFetch();
    ({ fetchGovDataForPrompt } = await loadGovuk({ verbose: false }));
  });

  afterAll(() => {
    delete process.env.GOVUK_VERBOSE_LOGS;
  });

  test('govuk_no_names fires and block is empty', async () => {
    const events = await runAndCapture(() =>
      fetchGovDataForPrompt('What should I look for in a school?', BRANCH, DUMMY_KEY, DUMMY_URL, DUMMY_MDL)
    );

    const e = events.find(e => e.event === 'govuk_no_names');
    expect(e).toBeDefined();
    expect(e.branch).toBe(BRANCH);
  });

  test('govuk_start does not fire when no names found', async () => {
    const events = await runAndCapture(() =>
      fetchGovDataForPrompt('What should I look for in a school?', BRANCH, DUMMY_KEY, DUMMY_URL, DUMMY_MDL)
    );

    expect(events.find(e => e.event === 'govuk_start')).toBeUndefined();
  });
});

// =============================================================================
// Verbose mode (GOVUK_VERBOSE_LOGS=1) — verbose-only events appear
// =============================================================================

describe('GOVUK_VERBOSE_LOGS=1 — verbose events are emitted', () => {
  let fetchGovDataForPrompt;

  beforeAll(async () => {
    global.fetch = makeMockFetch();
    ({ fetchGovDataForPrompt } = await loadGovuk({ verbose: true }));
  });

  afterAll(() => {
    delete process.env.GOVUK_VERBOSE_LOGS;
  });

  test('fetch_text_fail fires when GIAS returns non-OK', async () => {
    // fetch returns 503 for all calls → fetch_text_fail should appear
    const events = await runAndCapture(() =>
      fetchGovDataForPrompt(QUESTION, BRANCH, DUMMY_KEY, DUMMY_URL, DUMMY_MDL)
    );

    const e = events.find(e => e.event === 'fetch_text_fail');
    expect(e).toBeDefined();
    expect(e.status).toBe(503);
  });

  test('always-log events still fire in verbose mode', async () => {
    const events = await runAndCapture(() =>
      fetchGovDataForPrompt(QUESTION, BRANCH, DUMMY_KEY, DUMMY_URL, DUMMY_MDL)
    );

    const emitted = new Set(events.map(e => e.event));
    expect(emitted.has('govuk_start')).toBe(true);
    expect(emitted.has('govuk_manifest')).toBe(true);
    expect(emitted.has('govuk_done')).toBe(true);
  });
});
