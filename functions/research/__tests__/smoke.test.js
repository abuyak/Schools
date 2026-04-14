/**
 * Smoke tests — hit the real deployed Lambda and verify response shape.
 * Uses a real OpenAI call, so costs ~$0.01-0.05 per run.
 *
 * Run locally:  npm run test:smoke
 * Run in CI:    set LAMBDA_URL env var, then npm run test:smoke
 */

const LAMBDA_URL =
  process.env.LAMBDA_URL ||
  'https://ep6az35owvnis2c6n6wcl7axyy0elrlh.lambda-url.eu-west-2.on.aws/';

const TIMEOUT_MS = 120_000; // Lambda can take up to 110s

/** Retry a fetch-based call up to maxAttempts times on 5xx responses. */
async function fetchWithRetry(url, options, { maxAttempts = 3, delayMs = 3000 } = {}) {
  let lastRes;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastRes = await fetch(url, options);
    if (lastRes.status < 500) return lastRes;
    if (attempt < maxAttempts) {
      console.warn(`Attempt ${attempt} got ${lastRes.status} — retrying in ${delayMs}ms…`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return lastRes;
}

describe('Smoke — deployed Lambda', () => {

  test('returns a completed research response with valid structure', async () => {
    const res = await fetchWithRetry(LAMBDA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch: 'prompt_branch_1',
        question: 'Tell me about Eton College in one sentence.',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('completed');
    expect(typeof body.title).toBe('string');
    expect(body.title.length).toBeGreaterThan(0);
    expect(typeof body.summary).toBe('string');
    expect(body.summary.length).toBeGreaterThan(0);
    expect(Array.isArray(body.scorecard)).toBe(true);
    expect(Array.isArray(body.sections)).toBe(true);
    expect(body.sections.length).toBeGreaterThan(0);
  }, TIMEOUT_MS);

  test('returns 400 for a missing branch', async () => {
    const res = await fetch(LAMBDA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Tell me about Eton' }),
      signal: AbortSignal.timeout(10_000),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details).toContain('Missing branch.');
  }, 15_000);

  test('returns 400 for an unsupported branch', async () => {
    const res = await fetch(LAMBDA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'prompt_branch_99', question: 'Test' }),
      signal: AbortSignal.timeout(10_000),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.details).toContain('Branch is not supported.');
  }, 15_000);

});
