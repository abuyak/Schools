/**
 * Live integration test — requires SAM to be running on port 3000.
 * Run: npm run test:live
 *
 * Confirms the Lambda returns a valid structured response end-to-end.
 * Uses a real OpenAI API call so costs ~$0.05 per run.
 */

const SAM_URL = 'http://127.0.0.1:3000/api/research';
const TIMEOUT = 90_000; // OpenAI web search can be slow

describe('Live SAM integration', () => {
  test('returns a completed research response for a real question', async () => {
    const res = await fetch(SAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ branch: 'prompt_branch_1', question: 'Tell me about Eton College' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe('completed');
    expect(typeof body.title).toBe('string');
    expect(body.title.length).toBeGreaterThan(0);
    expect(typeof body.summary).toBe('string');
    expect(Array.isArray(body.scorecard)).toBe(true);
    expect(body.scorecard.length).toBeGreaterThan(0);
    expect(Array.isArray(body.sections)).toBe(true);
    expect(body.sections.length).toBeGreaterThan(0);

    // Each scorecard item has required fields
    for (const item of body.scorecard) {
      expect(item).toHaveProperty('dimension');
      expect(item).toHaveProperty('rating');
      expect(['strong', 'good', 'mixed', 'weak', 'unknown']).toContain(item.rating);
      expect(item).toHaveProperty('note');
    }

    // Each section has heading and body
    for (const section of body.sections) {
      expect(section).toHaveProperty('heading');
      expect(section).toHaveProperty('body');
    }
  }, TIMEOUT);
});
