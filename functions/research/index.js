import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchGovDataForPrompt, renderPartA, computeFlags } from './govuk.js';

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
  prompt_branch_2: 'prompt_branch_2_compare_schools_v2.md',
  prompt_branch_3: 'prompt_branch_3_postcode_or_area.md',
  prompt_branch_4: 'prompt_branch_4_admissions_strategy.md',
};

// Branch 1 uses a two-call architecture:
//   Call 1 — Quick Take + scorecard (cheap, no web search)
//   Server  — Part A rendered deterministically from structured data
//   Call 2  — Part B + Part C (full model, web search)
// This file drives Call 2 for branch 1.
const BRANCH_1_BC_FILE = 'prompt_branch_1_bc_v1.md';

const OUTPUT_CONSTRAINTS = `
---
## Output Constraints (do not override)
- Never ask the user clarifying questions. The user has paid for this query. Instead, make the most reasonable assumptions given the question, state them briefly at the start of the first section, and produce a complete answer based on those assumptions. If the question is genuinely unanswerable (e.g. no matching schools exist), say so clearly and redirect to the closest useful answer.
- Return valid JSON only. No markdown fences, no prose outside the JSON object.
- Populate the scorecard array with 4-6 key dimensions. Each item: dimension (label), rating (strong|good|mixed|weak|unknown), note (one short sentence). Do not repeat scorecard content verbatim in the sections.
- Cite each fact inline using markdown link format: [source name](url).
- For fee-paying schools always search for current fees. If not found on first search, try "[school name] fees" as a dedicated search.
- Within each section body, use \\n to separate paragraphs. Use \\n- item for bullet points and \\n1. item for numbered lists. Never write a section body as one long unbroken paragraph.
- Use the exact section heading text from the prompt (the text after ### in the prompt) as the heading field value. Do NOT create separate section objects for structural part headers like "Part A — Official Record" or "Part B — Independent Research" — these are layout labels in the prompt only, not output sections. Do NOT add or remove numeric prefixes from headings unless the prompt already includes them.
- CRITICAL: Never repeat the section heading text inside the body field. The heading is rendered separately by the UI. The body must begin with content, never with the heading repeated.
- Numbered lists (1. 2. 3.) must only be used when ORDER genuinely matters, e.g. step-by-step instructions or a ranked priority list. Use bullets (-) for options, alternatives, and unordered items. Never number sub-points under a numbered item; use indented bullets instead.
- For sections that list options (e.g. "Main Routes Or Fallback Options"): use a bold-only bullet (- **Option name**) for each option header; follow it with regular bullets for the sub-points (Why realistic / Upside / Downside). Do NOT create a numbered list for options.
- When a topic has a colon label (e.g. "11+ mechanics:", "Timing:", "Upside:"), write the label as a plain text line (no leading -) and put the details as bullet sub-points on the following lines. Never merge a label and its content into a single bullet.
- For any comparison table section, write the body as a markdown table using | col | col | syntax with a separator row of |---|---|.
- Every section object MUST include a "flag" field set to exactly one of: "red", "green", or "none". Apply the traffic-light rules below. When in doubt, use "none".
- **CRITICAL — Bullet points for observations:** Every section under Part B (headings starting B1–B9) and Part C MUST use bullet-point format. Never write a B/C section body as a prose paragraph. Each distinct finding, observation, or data point must be a separate "- " bullet. Group related bullets under bold-only bullet headers ("- **Theme name**"). This applies especially to: Community Verdict, Fit Verdict, Value Verdict, Character and Reputation, and all Observations sections. A single paragraph of prose in a B/C section is the most common quality failure.

## Traffic Light Rules

Apply these rules based on section content. Only inspection/performance/census/absence/finance/parentview sections receive red or green flags. Summary/verdict/sources/character/pros-cons/next-steps sections must always be "none".

**"red"** — set when the section contains a genuine concern:
- Ofsted grades section: overall grade Requires Improvement or Inadequate; any sub-grade Inadequate; safeguarding not met
- Improvement requirements section: any requirements are present (content = red by definition)
- Pupil census section: EHC plan % above 6%; FSM above 35% (primary) or 30% (secondary) without strong support evidence
- Academic performance section: any progress score descriptor "below" or "well below" national; attainment more than 10pp below national average
- Absence section: overall absence above 8.6%; persistent absence above 23.3%
- Financial/staffing section: negative in-year balance; revenue reserves below one month's spend; QTS% below comparator average
- Area profile section: IMD decile 1–3; mean household income below £35,000
- Parent View section: any metric flagged ⚠️ in the pre-fetched table
- Community/leadership section: safeguarding concerns; sudden leadership changes; supply teacher reliance

**"green"** — set when the section contains a standout positive:
- Ofsted grades section: overall grade Outstanding or Exceptional; clean sweep of top sub-grades
- Improvement requirements section: section is empty — school received Outstanding with no improvement requirements
- Academic performance section: progress score "well above" national; attainment more than 10pp above national average across core subjects
- Absence section: overall absence below 5%; persistent absence below 15%
- Financial/staffing section: healthy reserves (more than 3 months spend); QTS% above comparator average
- Parent View section: all metrics above thresholds; more than 100 responses
- Extracurricular section: exceptionally broad programme

**"none"** — everything else, including summary/verdict/character/sources sections.
`;


// ── JSON schemas ──────────────────────────────────────────────────────────────

const SCORECARD_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    rating:    { type: 'string', enum: ['strong', 'good', 'mixed', 'weak', 'unknown'] },
    note:      { type: 'string' },
  },
  required: ['dimension', 'rating', 'note'],
};

const SECTION_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    heading: { type: 'string' },
    body:    { type: 'string' },
    flag:    { type: 'string', enum: ['red', 'green', 'none'] },
  },
  required: ['heading', 'body', 'flag'],
};

// Call 1 (Quick Take): title + summary + scorecard — no sections
const SCHEMA_QUICK_TAKE = {
  type: 'json_schema',
  name: 'school_scanner_quick_take',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title:     { type: 'string' },
      summary:   { type: 'string' },
      scorecard: { type: 'array', items: SCORECARD_ITEM },
    },
    required: ['title', 'summary', 'scorecard'],
  },
};

// Call 2 (B+C): sections only — Part A is rendered server-side
const SCHEMA_BC = {
  type: 'json_schema',
  name: 'school_scanner_bc',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sections: { type: 'array', items: SECTION_ITEM },
    },
    required: ['sections'],
  },
};

// Kept for non-branch-1 paths (branches 2, 3, 4) that still use the single-call flow
const RESPONSE_SCHEMA = {
  type: 'json_schema',
  name: 'school_scanner_answer',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title:     { type: 'string' },
      summary:   { type: 'string' },
      scorecard: { type: 'array', items: SCORECARD_ITEM },
      sections:  { type: 'array', items: SECTION_ITEM },
    },
    required: ['title', 'summary', 'scorecard', 'sections'],
  },
};

// ── Quick Take prompt (Call 1) ─────────────────────────────────────────────────
const QUICK_TAKE_INSTRUCTIONS = `You are School Scanner, an AI school advisor.

Pre-fetched government data for the school is appended at the end of this message.

Your task — produce exactly three things:

1. **title**: The school's official name and local authority in parentheses, e.g. "Riverside Primary School (Southwark)". Copy the name and LA verbatim from the pre-fetched block — never from the parent's question.

2. **summary**: One paragraph — what this school looks like overall, who it suits best, and the single most important watchout. If the parent described their child, add a one-line fit verdict at the end.

3. **scorecard**: 4–6 key dimensions. For each: a short dimension label, a rating (strong / good / mixed / weak / unknown), and a one-sentence note.

Rules:
- Use ONLY the pre-fetched block. Do not search the web.
- Use the official school name and local authority exactly as they appear in the pre-fetched block.
- Do not generate any Part A, Part B, or Part C sections.
- Never ask clarifying questions.
`;


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

// Returns the Call 2 (B+C) instructions for branch 1.
// Admin can override with a custom file via _promptFile.
function getBCInstructions(promptFile) {
  let file;
  if (promptFile) {
    if (!/^[\w\s()-]+\.md$/.test(promptFile)) throw new Error('Invalid prompt file name.');
    file = promptFile;
  } else {
    file = BRANCH_1_BC_FILE;
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

  // Collect web search sources — check multiple possible response formats
  const sources = [];
  for (const item of (apiResponse.output ?? [])) {
    const srcs = item.action?.sources ?? item.sources ?? item.output_sources
      ?? item.action?.web_search?.sources ?? null;
    if (srcs && Array.isArray(srcs)) {
      for (const s of srcs) {
        if (s.url && !sources.some(e => e.body === s.url)) {
          sources.push({ heading: s.title || s.url, body: s.url });
        }
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

// Adds _partLabel to the first section of each part (A1, B1, C1).
// The UI uses this to render a divider row directly above the section.
function tagPartLabels(sections) {
  const PART_LABELS = {
    'A1.': 'Part A — Official Record',
    'B1.': 'Part B — Independent Research',
    'C1.': 'Part C — Verdict & Synthesis',
  };
  for (const s of sections) {
    for (const [prefix, label] of Object.entries(PART_LABELS)) {
      if (s.heading?.startsWith(prefix)) { s._partLabel = label; break; }
    }
  }
  return sections;
}

// Merges Call 2 output with server-rendered Part A sections.
//
// Sections whose headings match /^A\d+\. / (e.g. "A6. Verdict", "A5. Observations")
// are spliced in immediately after their corresponding data section (e.g. "A6. Academic
// Performance"). Everything else (B and C sections) is appended at the end.
//
// The match is on the numeric prefix only — "A6." matches "A6. Academic Performance"
// regardless of the rest of the heading.
function interleaveVerdicts(partASections, call2Sections) {
  // Partition call2 sections into Part-A verdicts vs B/C sections
  const aVerdicts = [];
  const bcSections = [];
  for (const s of call2Sections) {
    if (/^A\d+\./i.test(s.heading ?? '')) {
      aVerdicts.push(s);
    } else {
      bcSections.push(s);
    }
  }

  if (!aVerdicts.length) return [...partASections, ...bcSections];

  // Sort verdicts by section number so insertion order is predictable
  aVerdicts.sort((a, b) => {
    const na = parseInt(a.heading.match(/^A(\d+)/i)?.[1] ?? '0', 10);
    const nb = parseInt(b.heading.match(/^A(\d+)/i)?.[1] ?? '0', 10);
    return na - nb;
  });

  // Build result by inserting each verdict after its matching data section
  const result = [...partASections];
  let offset = 0; // tracks insertions so indices stay valid

  for (const verdict of aVerdicts) {
    const prefix = verdict.heading.match(/^A\d+/i)?.[0]; // e.g. "A6"
    if (!prefix) { result.push(verdict); offset++; continue; }

    // Find the last data section whose heading starts with this prefix
    let insertAfterIdx = -1;
    for (let i = 0; i < result.length; i++) {
      if (result[i].heading?.startsWith(prefix + '.')) insertAfterIdx = i;
    }

    if (insertAfterIdx >= 0) {
      result.splice(insertAfterIdx + 1, 0, verdict);
      offset++;
    } else {
      // No matching data section found — append before B sections
      result.push(verdict);
    }
  }

  return [...result, ...bcSections];
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
  const model     = (isAdmin && body._model)      ? body._model      : (process.env.OPENAI_MODEL ?? 'gpt-5.4-mini');
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
      const block  = govukResult?.block  ?? '';
      const flags  = govukResult?.flags  ?? {};
      const school = govukResult?.schools?.[0] ?? null;
      const partA  = school ? renderPartA(school, computeFlags(school)) : [];
      return okResponse({ status: 'debug_govuk', block, flags, partASectionCount: partA.length });
    } catch (err) {
      return okResponse({ status: 'debug_govuk_error', error: err.message });
    }
  }

  // ── Branch 1: two-call architecture ─────────────────────────────────────────
  //   Step 1 — Fetch gov.uk data (always)
  //   Step 2 — Call 1: Quick Take + scorecard (cheap, no web search)
  //   Step 3 — Server-render Part A (deterministic)
  //   Step 4 — Call 2: Part B + Part C (full model, web search)
  //   Step 5 — Assemble and return
  //
  // Branches 2, 3, 4 continue to use the original single-call flow below.

  if (body.branch === 'prompt_branch_1') {
    // ── Step 1: Fetch gov.uk data ─────────────────────────────────────────────
    let govukBlock = '';
    let govukFlags = {};
    let govukSchool = null;
    let govukMs = 0;
    try {
      const govukT0 = Date.now();
      const govukResult = await fetchGovDataForPrompt(body.question, 'prompt_branch_1', apiKey, baseUrl, model);
      govukBlock  = govukResult?.block  ?? '';
      govukFlags  = govukResult?.flags  ?? {};
      govukSchool = govukResult?.schools?.[0] ?? null;
      govukMs = Date.now() - govukT0;
    } catch (err) {
      log('govuk_inject_error', { branch: 'prompt_branch_1', error: err.message });
      // Non-fatal — continue with empty data; server-rendered Part A will show "not retrieved"
    }

    // ── Step 2: Call 1 — Quick Take + scorecard ───────────────────────────────
    const qt1Instructions = QUICK_TAKE_INSTRUCTIONS + (govukBlock ? `\n\n${govukBlock}` : '');
    const qt1Model  = process.env.OPENAI_QUICK_TAKE_MODEL ?? model;
    const qt1IsReasoning = /^o\d/i.test(qt1Model);

    let qt1Response = null;
    let qt1Ms = 0;
    let qt1HttpError = null; // { status, summary } — set on non-2xx or network/timeout

    const qt1T0 = Date.now();
    try {
      const qt1Payload = {
        model:             qt1Model,
        tool_choice:       'none',   // no web search for Quick Take
        instructions:      qt1Instructions,
        input:             body.question,
        max_output_tokens: 2000,
        text:              { format: SCHEMA_QUICK_TAKE },
      };
      if (qt1IsReasoning) qt1Payload.reasoning = { effort: 'low' };

      const qt1Res = await fetch(`${baseUrl}/responses`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body:    JSON.stringify(qt1Payload),
        signal:  AbortSignal.timeout(40000),
      });
      qt1Ms = Date.now() - qt1T0;
      if (qt1Res.ok) {
        qt1Response = await qt1Res.json();
      } else {
        const txt = await qt1Res.text().catch(() => '');
        const summary =
          qt1Res.status === 401 || qt1Res.status === 403 ? 'The research provider rejected the API key. Check OPENAI_API_KEY.' :
          qt1Res.status === 429 ? 'The research provider is rate-limiting requests. Try again shortly.' :
          'The research provider could not complete the request.';
        qt1HttpError = { status: qt1Res.status, summary };
        log('qt1_error', { status: qt1Res.status, body: txt.slice(0, 200) });
      }
    } catch (err) {
      qt1Ms = Date.now() - qt1T0;
      const timedOut = err.name === 'TimeoutError' || err.message?.includes('timed out');
      qt1HttpError = {
        status:  timedOut ? 504 : 502,
        summary: timedOut ? 'The research provider timed out. Try again.' : 'The research provider could not complete the request.',
      };
      log('qt1_error', { error: err.message });
    }

    // Propagate Call 1 fatal errors immediately — same contract as the single-call path
    if (qt1HttpError) {
      log('research_request', { status: 'upstream_error', httpStatus: qt1HttpError.status, branch: body.branch, model, question: body.question.slice(0, 200), ms: Date.now() - t0 });
      return okResponse({ status: 'upstream_error', httpStatus: qt1HttpError.status, title: 'Research provider error', summary: qt1HttpError.summary, scorecard: [], sections: [{ heading: 'What happened', body: qt1HttpError.summary, flag: 'none' }] });
    }

    // Parse Call 1 — extract title, summary, scorecard; propagate format errors immediately
    const qt1Parsed = parseOpenAIResponse(qt1Response ?? {});
    if (qt1Parsed.status === 'upstream_invalid_format') {
      log('research_request', { status: 'upstream_invalid_format', httpStatus: qt1Parsed.httpStatus ?? 502, branch: body.branch, model, question: body.question.slice(0, 200), ms: Date.now() - t0 });
      return okResponse(qt1Parsed);
    }
    const qt1Title    = qt1Parsed.title    || '';
    const qt1Summary  = qt1Parsed.summary  || '';
    const qt1Scorecard = qt1Parsed.scorecard || [];

    // ── Step 3: Server-render Part A ──────────────────────────────────────────
    // Flags come from structured data — fully deterministic, no AI needed.
    const partAFlags = govukSchool ? computeFlags(govukSchool) : govukFlags;
    const partASections = govukSchool
      ? renderPartA(govukSchool, partAFlags)
      : [];  // No school data — Part A will be empty; Call 2 can note this

    // Deferred sections (e.g. A9 Pupil Experience) are held back from partial
    // responses and only included in the full response when Call 2 succeeds.
    const deferredPartA = partASections.filter(s => s._deferred);
    const visiblePartA  = partASections.filter(s => !s._deferred);

    // ── Step 4: Call 2 — Part B + Part C ─────────────────────────────────────
    const call2Instructions = getBCInstructions(promptFile) + (govukBlock ? `\n\n${govukBlock}` : '');
    const call2IsReasoning  = /^o\d/i.test(model);

    let call2Response = null;
    let call2Ms = 0;
    let call2Err = null;
    try {
      const call2T0 = Date.now();
      const call2Payload = {
        model,
        tools: [{
          type: 'web_search',
          user_location: { type: 'approximate', country: 'GB', city: 'London', region: 'London', timezone: 'Europe/London' },
          external_web_access: true,
        }],
        tool_choice: 'auto',
        include:     ['web_search_call.action.sources'],
        instructions: call2Instructions,
        input:        body.question,
        max_output_tokens: parseInt(process.env.OPENAI_MAX_TOKENS ?? '8000', 10),
        text: { format: SCHEMA_BC },
      };
      if (call2IsReasoning) call2Payload.reasoning = { effort: process.env.OPENAI_REASONING_EFFORT ?? 'low' };

      const call2Res = await fetch(`${baseUrl}/responses`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body:    JSON.stringify(call2Payload),
        signal:  AbortSignal.timeout(110000),
      });

      if (!call2Res.ok) {
        const txt = await call2Res.text().catch(() => '');
        call2Err = { status: call2Res.status, body: txt.slice(0, 400) };
        const errSummary =
          call2Res.status === 401 || call2Res.status === 403 ? 'The research provider rejected the API key.' :
          call2Res.status === 429 ? 'Rate limit reached — try again shortly.' :
          'The research provider could not complete the request.';
        log('research_request', { status: 'upstream_error', httpStatus: call2Res.status, branch: body.branch, model, ms: Date.now() - t0 });
        // Return partial result: Quick Take + visible Part A only (no deferred sections)
        const partialSections = tagPartLabels(visiblePartA);
        return okResponse({
          status: 'partial',
          httpStatus: 200,
          title:    qt1Title,
          summary:  qt1Summary,
          scorecard: qt1Scorecard,
          sections: partialSections,
          _warning: `Part B and Part C could not be generated: ${errSummary}`,
        });
      }

      call2Response = await call2Res.json();
      call2Ms = Date.now() - call2T0;
    } catch (err) {
      const timedOut = err.name === 'TimeoutError' || err.message?.includes('timed out');
      log('research_request', { status: timedOut ? 'timeout' : 'upstream_error', branch: body.branch, model, ms: Date.now() - t0 });
      const partialSections = tagPartLabels(visiblePartA);
      return okResponse({
        status: 'partial',
        httpStatus: 200,
        title:    qt1Title,
        summary:  qt1Summary,
        scorecard: qt1Scorecard,
        sections: partialSections,
        _warning: timedOut ? 'Part B and Part C timed out.' : 'Part B and Part C could not be generated.',
      });
    }

    // Parse Call 2 — sections only
    const call2Parsed = parseOpenAIResponse(call2Response);
    const bcSections  = call2Parsed.sections ?? [];

    // Collect web search sources from Call 2.
    const call2Searches = [];
    const call2Sources = [];
    for (const item of (call2Response?.output ?? [])) {
      // Track search queries for trace logging
      if (item.type === 'web_search_call' && item.action?.query) {
        call2Searches.push(item.action.query);
      }
      // Extract source URLs — the OpenAI API nests these in action.sources
      // on web_search_call items
      const sources = item.action?.sources ?? item.sources ?? item.output_sources
        ?? item.action?.web_search?.sources ?? null;
      if (sources && Array.isArray(sources)) {
        for (const s of sources) {
          if (s.url && !call2Sources.some(e => e.body === s.url)) {
            call2Sources.push({ heading: s.title || s.url, body: s.url });
          }
        }
      }
    }

    // Debug: log the output item types and whether we found sources
    const outputItemTypes = (call2Response?.output ?? []).map(item => ({
      type: item.type,
      hasActionSources: !!item.action?.sources,
      hasSources: !!item.sources,
      sourceCount: (item.action?.sources ?? item.sources ?? []).length,
    }));
    log('research_debug_sources', {
      outputItemTypes,
      call2SourcesFound: call2Sources.length,
      call2SearchesFound: call2Searches.length,
    });

    // Rename model's "Sources" section → "Primary Sources", append Secondary Sources
    let primarySourcesBody = null;
    for (const s of bcSections) {
      if (/^sources?$/i.test(s.heading)) {
        s.heading = 'Primary Sources';
        primarySourcesBody = s.body;
        break;
      }
    }
    // Always append Secondary Sources if we have web search URLs, even if the
    // model didn't produce a Primary Sources section.
    const secondaryUrls = primarySourcesBody
      ? call2Sources.filter(s => !primarySourcesBody.includes(s.body))
      : call2Sources;
    if (secondaryUrls.length) {
      const body = secondaryUrls
        .map(s => `[${s.heading}](${s.body})`)
        .join('\n');
      bcSections.push({ heading: 'Secondary Sources', body, flag: 'none' });
    }

    // ── Step 5: Assemble and return ───────────────────────────────────────────
    // Part A sections already have _partLabel on A1; tag B1 and C1 from Call 2.
    const finalSections = tagPartLabels(interleaveVerdicts(partASections, bcSections));

    const ms = Date.now() - t0;
    const call2Usage = call2Response?.usage ?? {};

    const trace = {
      totalMs: ms,
      govuk: {
        ms:              govukMs,
        injected:        govukBlock.length > 0,
        chars:           govukBlock.length,
        estimatedTokens: Math.ceil(govukBlock.length / 4),
      },
      call1: { ms: qt1Ms, model: qt1Model, inputTokens: qt1Response?.usage?.input_tokens ?? null, outputTokens: qt1Response?.usage?.output_tokens ?? null },
      call2: { ms: call2Ms, model, inputTokens: call2Usage.input_tokens ?? null, outputTokens: call2Usage.output_tokens ?? null, webSearches: call2Searches },
      output: { title: qt1Title, partASections: partASections.length, bcSections: bcSections.length },
    };

    log('research_request', {
      status: 'completed',
      httpStatus: 200,
      branch: body.branch,
      model,
      question: body.question.slice(0, 200),
      ms,
      govuk:  { ms: govukMs, injected: govukBlock.length > 0, chars: govukBlock.length },
      call1:  { ms: qt1Ms, outputTokens: trace.call1.outputTokens },
      call2:  { ms: call2Ms, outputTokens: trace.call2.outputTokens, searches: call2Searches.length },
      output: trace.output,
    });

    const result1 = {
      status:    'completed',
      httpStatus: 200,
      title:     qt1Title,
      summary:   qt1Summary,
      scorecard: qt1Scorecard,
      sections:  finalSections,
    };

    return okResponse(isAdmin ? { ...result1, _trace: trace } : result1);
  }

  // ── Branches 2, 3, 4: original single-call flow ───────────────────────────

  let instructions = getBranchInstructions(body.branch, promptFile);

  // Pre-fetch gov.uk data for branch 2 (comparison summary)
  let govukBlock = '';
  let govukFlags = {};
  let govukMs    = 0;
  if (body.branch === 'prompt_branch_2') {
    try {
      const govukT0 = Date.now();
      const govukResult = await fetchGovDataForPrompt(body.question, body.branch, apiKey, baseUrl, model);
      govukBlock = govukResult?.block  ?? '';
      govukFlags = govukResult?.flags  ?? {};
      govukMs = Date.now() - govukT0;
      if (govukBlock) instructions += govukBlock;
    } catch (err) {
      log('govuk_inject_error', { branch: body.branch, error: err.message });
    }
  }

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

  // Apply deterministic flag overrides from structured data
  if (result.sections && Object.keys(govukFlags).length) {
    for (const s of result.sections) {
      if (govukFlags[s.heading] !== undefined) s.flag = govukFlags[s.heading];
    }
  }

  // Tag part labels
  result.sections = tagPartLabels(result.sections ?? []);

  const ms = Date.now() - t0;
  const webSearches = (apiResponse.output ?? []).filter(i => i.type === 'web_search_call').map(i => i.action?.query ?? null).filter(Boolean);
  const usage = apiResponse.usage ?? {};

  const trace = {
    totalMs: ms,
    govuk:  { ms: govukMs, injected: govukBlock.length > 0, chars: govukBlock.length, estimatedTokens: Math.ceil(govukBlock.length / 4) },
    openai: { ms: openaiMs, inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, webSearches },
    output: { status: result.status, title: result.title ?? null, sections: result.sections?.length ?? 0 },
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
