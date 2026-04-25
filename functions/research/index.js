import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchGovDataForPrompt } from './govuk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the .md prompt directory — co-located with the function code
const MD_ROOT = join(__dirname, '.md');

const ALLOWED_BRANCHES = [
  'prompt_branch_1',
  'prompt_branch_2',
  'prompt_branch_3',
  'prompt_branch_4',
];

const BRANCH_FILES = {
  prompt_branch_1: 'prompt_branch_1_specific_school_v2.md',
  prompt_branch_2: 'prompt_branch_2_compare_schools.md',
  prompt_branch_3: 'prompt_branch_3_postcode_or_area.md',
  prompt_branch_4: 'prompt_branch_4_admissions_strategy.md',
};

const OUTPUT_CONSTRAINTS = `
---
## Output Constraints (do not override)
- Never ask the user clarifying questions. The user has paid for this query. Instead, make the most reasonable assumptions given the question, state them briefly at the start of the Direct Answer section, and produce a complete answer based on those assumptions. If the question is genuinely unanswerable (e.g. no matching schools exist), say so clearly and redirect to the closest useful answer.
- Return valid JSON only. No markdown fences, no prose outside the JSON object.
- Populate the scorecard array with 4-6 key dimensions. Each item: dimension (label), rating (strong|good|mixed|weak|unknown), note (one short sentence). Do not repeat scorecard content verbatim in the sections.
- Cite each fact inline using markdown link format: [source name](url).
- For fee-paying schools always search for current fees. If not found on first search, try "[school name] fees" as a dedicated search.
- Within each section body, use \\n to separate paragraphs. Use \\n- item for bullet points and \\n1. item for numbered lists. Never write a section body as one long unbroken paragraph.
- Use the exact section identifiers from the prompt as the heading field value. For Branch 1: "Quick Take", then "A1. School Identity", "A2. Ofsted Inspection Grades" … "B1. Parent View" … "C1. School Character" etc. Do NOT create separate section objects for the part headers "Part A — Official Record", "Part B — Independent Research", or "Part C — Verdict & Synthesis" — these are structural labels in the prompt only, not output sections. Do NOT add sequential numeric prefixes like "1.", "2.", "2.1" to any heading.
- CRITICAL: Never repeat the section heading text inside the body field. The heading is rendered separately by the UI. The body must begin with content, never with the heading repeated.
- Numbered lists (1. 2. 3.) must only be used when ORDER genuinely matters, e.g. step-by-step instructions or a ranked priority list. Use bullets (-) for options, alternatives, and unordered items. Never number sub-points under a numbered item; use indented bullets instead.
- For sections that list options (e.g. "Main Routes Or Fallback Options"): use a bold-only bullet (- **Option name**) for each option header; follow it with regular bullets for the sub-points (Why realistic / Upside / Downside). Do NOT create a numbered list for options.
- When a topic has a colon label (e.g. "11+ mechanics:", "Timing:", "Upside:"), write the label as a plain text line (no leading -) and put the details as bullet sub-points on the following lines. Never merge a label and its content into a single bullet.
- For any comparison table section, write the body as a markdown table using | col | col | syntax with a separator row of |---|---|.
- Every section object MUST include a "flag" field set to exactly one of: "red", "green", or "none". Apply the traffic-light rules below. When in doubt, use "none".

## Traffic Light Rules

Only sections A1–B5 receive red or green flags. Quick Take and all C sections (C1, C2, C3, C4) must always be "none".

**"red"** — set for the following A/B sections only when the trigger condition is met:
- A2: Ofsted overall grade Requires Improvement or Inadequate; any sub-grade Inadequate; safeguarding not met
- A4: Any improvement requirements are present in the pre-fetched block (content = red by definition)
- A5: EHC plan % above 6%; FSM above 35% (primary) or 30% (secondary) without strong support evidence
- A6: Any progress score descriptor "below" or "well below" national; attainment more than 10pp below national average
- A7: Overall absence above 8.6%; persistent absence above 23.3%
- A8: Negative in-year balance; revenue reserves below one month's spend; QTS% below comparator average
- A9: IMD decile 1–3; mean household income below £35,000
- B1: Any Parent View metric flagged ⚠️ in the pre-fetched table
- B4: Safeguarding concerns; sudden leadership changes; supply teacher reliance

**"green"** — set for the following A/B sections only when the trigger condition is met:
- A2: Overall grade Outstanding or Exceptional; clean sweep of top sub-grades
- A4: Section is empty — school received Outstanding with no improvement requirements
- A6: Progress score "well above" national; attainment more than 10pp above national average across core subjects
- A7: Overall absence below 5%; persistent absence below 15%
- A8: Healthy reserves (more than 3 months spend); QTS% above comparator average
- B1: All Parent View metrics above thresholds; more than 100 responses
- B3: Exceptionally broad extracurricular programme

**"none"** — everything else, including any section not listed above, and all of: Quick Take, C1, C2, C3, C4.

## C2 Linkage Rule
The C2 (Pros and Cons) section MUST reference every section flagged "red" as a concern and every section flagged "green" as a strength. Do not introduce new concerns or strengths in C2 that were not flagged in A1–B5.
`;


const RESPONSE_SCHEMA = {
  type: 'json_schema',
  name: 'school_scanner_answer',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      summary: { type: 'string' },
      scorecard: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dimension: { type: 'string' },
            rating: { type: 'string', enum: ['strong', 'good', 'mixed', 'weak', 'unknown'] },
            note: { type: 'string' },
          },
          required: ['dimension', 'rating', 'note'],
        },
      },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            heading: { type: 'string' },
            body: { type: 'string' },
            flag: { type: 'string', enum: ['red', 'green', 'none'] },
          },
          required: ['heading', 'body', 'flag'],
        },
      },
    },
    required: ['title', 'summary', 'scorecard', 'sections'],
  },
};

function validatePayload(body) {
  const errors = [];

  if (!body.branch) {
    errors.push('Missing branch.');
  } else if (!ALLOWED_BRANCHES.includes(body.branch)) {
    errors.push('Branch is not supported.');
  }

  if (!body.question) {
    errors.push('Missing question.');
  } else if (typeof body.question !== 'string' || body.question.trim() === '') {
    errors.push('Question is required.');
  } else if (body.question.length > 600) {
    errors.push('Question must be 600 characters or fewer.');
  }

  return errors;
}

function getBranchInstructions(branch, promptFile) {
  // If a specific file is requested (admin test), validate and use it.
  // Otherwise fall back to the branch default.
  let file;
  if (promptFile) {
    // Security: allow only safe filenames (no path traversal)
    if (!/^[\w\s()-]+\.md$/.test(promptFile)) throw new Error('Invalid prompt file name.');
    file = promptFile;
  } else {
    file = BRANCH_FILES[branch];
    if (!file) throw new Error(`Unknown branch: ${branch}`);
  }
  const prompt = readFileSync(join(MD_ROOT, file), 'utf8');
  return prompt + OUTPUT_CONSTRAINTS;
}

function parseOpenAIResponse(apiResponse) {
  // Extract text from output_text or output[].content[].text
  let outputText = apiResponse.output_text ?? null;

  if (!outputText && Array.isArray(apiResponse.output)) {
    const fragments = [];
    for (const item of apiResponse.output) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.text?.trim()) fragments.push(c.text);
          else if (c.output_text?.trim()) fragments.push(c.output_text);
        }
      }
    }
    if (fragments.length) outputText = fragments.join('\n');
  }

  if (!outputText?.trim()) {
    return { status: 'upstream_invalid_format', httpStatus: 502, title: 'Unexpected upstream response', summary: 'The research provider returned an empty response where structured JSON was expected.', scorecard: [], sections: [] };
  }

  // Strip markdown fences the model sometimes wraps around JSON
  let clean = outputText.trim();
  if (/^```(?:json)?\s*\n/.test(clean)) {
    clean = clean.replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
  }
  if (!clean.startsWith('{')) {
    const brace = clean.indexOf('{');
    if (brace >= 0) clean = clean.slice(brace);
  }

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return { status: 'upstream_invalid_format', httpStatus: 502, title: 'Unexpected upstream response', summary: 'The research provider returned a response that did not match the expected JSON format.', scorecard: [], sections: [{ heading: 'Raw output (first 400 chars)', body: outputText.slice(0, 400), flag: 'none' }] };
  }

  // Collect web search sources
  const sources = [];
  for (const item of (apiResponse.output ?? [])) {
    if (item.type === 'web_search_call' && item.action?.sources) {
      for (const s of item.action.sources) {
        if (s.url) sources.push({ heading: s.title || s.url, body: s.url });
      }
    }
  }

  // Rename model's "Sources" section to "Primary Sources"
  const sections = (parsed.sections ?? []).map(s => ({ ...s }));

  let primarySourcesBody = null;
  for (const s of sections) {
    if (/^sources?$/i.test(s.heading)) {
      s.heading = 'Primary Sources';
      primarySourcesBody = s.body;
      break;
    }
  }

  // Append secondary sources not already cited
  if (sources.length) {
    const secondary = sources
      .filter(s => !primarySourcesBody || !primarySourcesBody.includes(s.body))
      .map(s => `[${s.heading}](${s.body})`);
    if (secondary.length) {
      sections.push({ heading: 'Secondary Sources', body: secondary.join('\n'), flag: 'none' });
    }
  }

  return {
    status: 'completed',
    httpStatus: 200,
    title: parsed.title ?? '',
    summary: parsed.summary ?? '',
    scorecard: parsed.scorecard ?? [],
    sections,
  };
}

function errorResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function okResponse(body) {
  return {
    statusCode: body.httpStatus ?? 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function log(event, props = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...props }));
}

export const handler = async (event) => {
  const t0 = Date.now();

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    log('research_request', { status: 'invalid_json', httpStatus: 400 });
    return errorResponse(400, { error: 'Invalid JSON payload.' });
  }

  // Validate
  const errors = validatePayload(body);
  if (errors.length) {
    log('research_request', { status: 'validation_failed', httpStatus: 400, branch: body.branch ?? null });
    return errorResponse(400, { error: 'Validation failed.', details: errors });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log('research_request', { status: 'misconfigured', httpStatus: 503, branch: body.branch });
    return errorResponse(503, { error: 'OPENAI_API_KEY is not configured.' });
  }

  // Admin overrides — only honoured when _adminKey matches ADMIN_KEY env var
  const adminKey = process.env.ADMIN_KEY;
  const isAdmin  = adminKey && body._adminKey === adminKey;
  const model     = (isAdmin && body._model)      ? body._model      : (process.env.OPENAI_MODEL ?? 'o4-mini');
  const promptFile= (isAdmin && body._promptFile) ? body._promptFile : null;

  const baseUrl = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');

  // ── Debug mode: return raw govuk block without AI call (admin only) ──────────
  if (isAdmin && body._debugGovuk) {
    try {
      const govukResult = await fetchGovDataForPrompt(
        body.question,
        body.branch ?? 'prompt_branch_1',
        apiKey,
        baseUrl,
        model,
      );
      const block = typeof govukResult === 'string' ? govukResult : (govukResult?.block ?? '');
      const flags = typeof govukResult === 'string' ? {} : (govukResult?.flags ?? {});
      return okResponse({ status: 'debug_govuk', block, flags });
    } catch (err) {
      return okResponse({ status: 'debug_govuk_error', error: err.message });
    }
  }

  let instructions = getBranchInstructions(body.branch, promptFile);

  // Pre-fetch gov.uk data for branches 1 (detailed) and 2 (comparison summary)
  let govukBlock = '';
  let govukFlags = {};   // deterministic flag overrides keyed by section heading
  let govukMs    = 0;
  if (body.branch === 'prompt_branch_1' || body.branch === 'prompt_branch_2') {
    try {
      const govukT0 = Date.now();
      const govukResult = await fetchGovDataForPrompt(
        body.question,
        body.branch,
        apiKey,
        baseUrl,
        model,
      );
      // fetchGovDataForPrompt now returns { block, flags } — handle both shapes
      // for safety in case a cached/old version returns a plain string.
      if (typeof govukResult === 'string') {
        govukBlock = govukResult ?? '';
      } else {
        govukBlock = govukResult?.block ?? '';
        govukFlags = govukResult?.flags ?? {};
      }
      govukMs = Date.now() - govukT0;
      if (govukBlock) instructions += govukBlock;
    } catch (err) {
      log('govuk_inject_error', { branch: body.branch, error: err.message });
      // Non-fatal — continue with the unaugmented prompt
    }
  }

  // Call OpenAI
  const isReasoningModel = /^o\d/i.test(model);

  let apiResponse;
  let openaiMs = 0;
  try {
    const openaiT0 = Date.now();
    const requestPayload = {
      model,
      tools: [{
        type: 'web_search',
        user_location: { type: 'approximate', country: 'GB', city: 'London', region: 'London', timezone: 'Europe/London' },
        external_web_access: true,
      }],
      // web_search_preview only supports tool_choice: 'auto' — 'required' now
      // causes a 400 from the Responses API. The model uses search anyway because
      // the prompt explicitly requires it for Part B sections.
      tool_choice: 'auto',
      include: ['web_search_call.action.sources'],
      instructions,
      input: body.question,
      max_output_tokens: parseInt(process.env.OPENAI_MAX_TOKENS ?? '8000', 10),
      text: { format: RESPONSE_SCHEMA },
    };
    if (isReasoningModel) {
      requestPayload.reasoning = { effort: process.env.OPENAI_REASONING_EFFORT ?? 'low' };
    }

    const res = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(requestPayload),
      signal: AbortSignal.timeout(110000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const summary =
        res.status === 401 || res.status === 403 ? 'The research provider rejected the API key. Check OPENAI_API_KEY.' :
        res.status === 429 ? 'The research provider is rate-limiting requests. Try again shortly.' :
        'The research provider could not complete the request.';
      log('research_request', { status: 'upstream_error', httpStatus: res.status, branch: body.branch, model, ms: Date.now() - t0 });
      return okResponse({ status: 'upstream_error', httpStatus: res.status, title: 'Research provider error', summary, scorecard: [], sections: [{ heading: 'What happened', body: text.slice(0, 400), flag: 'none' }] });
    }

    apiResponse = await res.json();
    openaiMs = Date.now() - openaiT0;
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.message?.includes('timed out');
    log('research_request', { status: timedOut ? 'timeout' : 'upstream_error', httpStatus: timedOut ? 504 : 502, branch: body.branch, model, ms: Date.now() - t0 });
    return okResponse({
      status: 'upstream_error',
      httpStatus: timedOut ? 504 : 502,
      title: 'Research provider error',
      summary: timedOut ? 'The research provider timed out. Try again.' : 'The research provider could not complete the request.',
      scorecard: [],
      sections: [{ heading: 'What happened', body: err.message ?? 'Unknown error', flag: 'none' }],
    });
  }

  const result = parseOpenAIResponse(apiResponse);

  // Apply deterministic flag overrides — govukFlags are computed from structured
  // data and are more reliable than the model's own judgment for data sections.
  if (result.sections && Object.keys(govukFlags).length) {
    for (const s of result.sections) {
      if (govukFlags[s.heading] !== undefined) s.flag = govukFlags[s.heading];
    }
  }

  // Tag the first section of each part with its part label — the UI renders
  // this as a divider glued directly above the section (no gap between them).
  if (result.sections) {
    const PART_LABELS = {
      'A1.': 'Part A — Official Record',
      'B1.': 'Part B — Independent Research',
      'C1.': 'Part C — Verdict & Synthesis',
    };
    for (const s of result.sections) {
      for (const [prefix, label] of Object.entries(PART_LABELS)) {
        if (s.heading?.startsWith(prefix)) s._partLabel = label;
      }
    }
  }


  const ms = Date.now() - t0;

  // ── Build trace ───────────────────────────────────────────────────────────────
  const webSearches = (apiResponse.output ?? [])
    .filter(item => item.type === 'web_search_call')
    .map(item => item.action?.query ?? null)
    .filter(Boolean);

  const usage = apiResponse.usage ?? {};

  const trace = {
    totalMs: ms,
    govuk: {
      ms:              govukMs,
      injected:        govukBlock.length > 0,
      chars:           govukBlock.length,
      estimatedTokens: Math.ceil(govukBlock.length / 4),
    },
    openai: {
      ms:           openaiMs,
      inputTokens:  usage.input_tokens  ?? null,
      outputTokens: usage.output_tokens ?? null,
      webSearches,
    },
    output: {
      status:   result.status,
      title:    result.title ?? null,
      sections: result.sections?.length ?? 0,
    },
  };

  log('research_request', {
    status:    result.status,
    httpStatus: result.httpStatus ?? 200,
    branch:    body.branch,
    model,
    question:  body.question.slice(0, 200),
    ms,
    govuk:  { ms: trace.govuk.ms, injected: trace.govuk.injected, chars: trace.govuk.chars, estimatedTokens: trace.govuk.estimatedTokens },
    openai: { ms: trace.openai.ms, inputTokens: trace.openai.inputTokens, outputTokens: trace.openai.outputTokens, searches: webSearches.length },
    output: trace.output,
  });

  return okResponse(isAdmin ? { ...result, _trace: trace } : result);
};
