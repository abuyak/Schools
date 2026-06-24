import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchGovDataForPrompt, renderPartA, renderPartAComparison, computeFlags, getAreaData, renderPartBArea, fetchSchoolsInArea, renderPartASchools } from './govuk.js';

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
- **CRITICAL — Bullet points for observations:** Every Part A observation section (headings A2–A7 with "Observations" suffix, e.g. "A5. Observations") MUST use bullet-point format. Never write an A-section body as a prose paragraph. Each distinct finding, observation, or data point must be a separate "- " bullet. Group related bullets under bold-only bullet headers ("- **Theme name**"). A single paragraph of prose in an A-section is the most common quality failure.

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

3. **scorecard**: 3–6 key dimensions that have actual data. For each: a short dimension label, a rating (strong / good / mixed / weak / unknown), and a one-sentence note backed by a number from the pre-fetched block.

Rules:
- Use ONLY the pre-fetched block. Do not search the web.
- Use the official school name and local authority exactly as they appear in the pre-fetched block.
- Do not generate any Part A, Part B, or Part C sections.
- Never ask clarifying questions.
- **Never include a dimension where the data is missing, NaN, or "not retrieved."** If Ofsted data exists, include it. If attendance data exists, include it. If financial data shows NaN or —, skip it. Build the scorecard from what's available, not from a fixed template. A scorecard with 3 well-supported dimensions is better than 5 with gaps.
`;

// Call 1 (Quick Take) for Branch 2 comparison — title, summary, scorecard only,
// no web search. Uses condensed comparison data (~500 chars).
const QUICK_TAKE_COMPARISON_INSTRUCTIONS = `You are School Scanner, an AI school advisor.

Pre-fetched government data comparing the schools is appended at the end of this message.

Your task — produce exactly three things:

1. **title**: "[School A] vs [School B]" — use the official names from the pre-fetched data.

2. **summary**: 1–2 sentences. Which school is the stronger choice and why. If the parent described their child, say which school fits that child better. Be direct — no throat-clearing.

3. **scorecard**: 3–6 comparison dimensions backed by actual data. For each: a short dimension label, a rating (strong / good / mixed / weak / unknown), and a one-sentence note with a number from the pre-fetched block.

Rules:
- Use ONLY the pre-fetched comparison data. Do not search the web.
- Use the official school names exactly as they appear in the pre-fetched block.
- Do not generate any sections (no Verdict, no Comparison Table, no What Matters Most).
- Never ask clarifying questions.
- If the parent asked about a specific concern (SEN, sports, arts, faith, etc.), that concern must appear in the scorecard IF data exists.
- **Never include a dimension where data is missing for either school.** If KS2 results aren't in the pre-fetched block, don't create a "Primary outcomes" row. If SEN data is missing, skip it. A scorecard with 3 solid data-backed dimensions is far better than 5 with gaps and question marks. Only rate what you can see.
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

// Strip AI search result markers (turn0search2, turn1view0, etc.) that
// gpt-5.4-mini sometimes leaks into section bodies.
export function cleanBody(text) {
  return (text ?? '').replace(/\.?turn\d+(?:search|view)\d+\.?/gi, '').replace(/\s{2,}/g, ' ').trim();
}

// Strip markdown heading prefixes (##, ###, #, ####) from section headings
// so that "## A2. Observations" becomes "A2. Observations".
export function cleanHeading(h) {
  return (h ?? '').replace(/^#{1,4}\s+/, '').trim();
}

export function parseOpenAIResponse(apiResponse) {
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
  // Heading/body cleanup is now handled by module-level cleanHeading/cleanBody
  const sections = (parsed.sections ?? []).map(s => ({ ...s, heading: cleanHeading(s.heading), body: cleanBody(s.body) }));

  let primarySourcesBody = null;
  for (const s of sections) {
    if (/^sources?$/i.test(s.heading)) {
      s.heading = 'Primary Sources';
      primarySourcesBody = s.body;
      break;
    }
  }

  // Append secondary sources not already cited in any section body
  if (sources.length) {
    const allBodies = sections.map(s => s.body).filter(Boolean).join(' ');
    const secondary = sources
      .filter(s => !allBodies.includes(s.body))
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
    body: JSON.stringify({ ...body, _v: '2026-05-18-p2-v2' }),
  };
}

function okResponse(body) {
  return {
    statusCode: body.httpStatus ?? 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, _v: '2026-05-18-p2-v2' }),
  };
}

function log(event, props = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...props }));
}

// Normalises the C1 table when the AI outputs it without markdown pipes.
// The AI often strips pipes and appends the summary paragraph to the last
// table row, creating a phantom 4th column. This rewrites the body into
// proper pipe-delimited markdown with the summary separated.
// Normalises Branch 2 comparison tables when the AI outputs them without pipes.
// Handles all Part A/A1-A7 and C1 sections. Strips "Assumption:" preambles,
// converts whitespace-separated rows to proper |...|...|...| markdown, and
// splits off analysis paragraphs that were appended to the last table row.
export function normaliseComparisonTable(sections, schoolNames) {
  if (!schoolNames || schoolNames.length < 2) return sections;

  const shortNames = schoolNames.map(n => {
    const parts = n.split(/\s+/);
    return parts.slice(0, Math.min(3, parts.length)).join(' ');
  });

  for (const s of sections) {
    const body = s.body || '';
    const lines = body.split('\n');
    const hasPipes = lines.some(l => l.trim().startsWith('|'));

    // If already pipe-delimited, just strip any preamble and fix column overflow
    if (hasPipes) {
      const out = [];
      let started = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { if (started) out.push(''); continue; }
        if (!started && !trimmed.startsWith('|')) {
          // Preamble before the table — skip
          if (/^(Assumption|Note|Based on|Given|You asked|The parent|This comparison|We are comparing)/i.test(trimmed)) continue;
          out.push(trimmed);
          continue;
        }
        if (trimmed.startsWith('|')) {
          started = true;
          const cells = trimmed.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
          // Determine expected columns from first data row after header/separator
          const isSeparator = /^[-:| ]+$/.test(cells.join(''));
          if (!isSeparator && cells.length > 2 && cells[cells.length - 1] && cells[cells.length - 1].length > 80) {
            // Last cell is very long — likely a verdict paragraph appended to the table
            const keep = cells.slice(0, cells.length - 1);
            const overflow = cells[cells.length - 1];
            out.push('| ' + keep.join(' | ') + ' |');
            out.push('');
            out.push(overflow);
            started = false;
          } else {
            out.push(trimmed);
          }
        } else if (started) {
          // Non-pipe line inside a table — end the table and push as separate paragraph
          out.push('');
          out.push(trimmed);
          started = false;
        } else {
          out.push(trimmed);
        }
      }
      s.body = out.join('\n');
      continue;
    }

    // No pipes — try whitespace-to-pipe conversion
    // Detect comparison tables (Dimension + school names) or C1 verdict tables (Dimension + Winner)
    const hasTableHeader = lines.some(l => {
      const t = l.trim();
      return (/\bDimension\b/i.test(t) && /\bWinner\b/i.test(t)) ||  // C1 verdict table
             (/\bDimension\b/i.test(t) && shortNames.some(n => t.includes(n)));  // comparison table
    });
    if (!hasTableHeader) continue;

    const out = [];
    let inTable = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { if (inTable) out.push(''); continue; }

      if (/\bDimension\b/i.test(trimmed) && shortNames.some(n => trimmed.includes(n))) {
        inTable = true;
        const cols = splitColumns(trimmed, 3);
        out.push('| ' + cols.join(' | ') + ' |');
        out.push('|---:|---:|---:|');
        continue;
      }
      if (/^\|?\s*[-:| ]+\s*\|?$/.test(trimmed)) continue;
      if (!inTable) {
        if (/^(Assumption|Note|Based on|Given)/i.test(trimmed)) continue;
        out.push(trimmed);
        continue;
      }
      const cols = splitColumns(trimmed, 2);
      if (cols.length >= 2) {
        out.push('| ' + cols.slice(0, 3).join(' | ') + ' |');
        if (cols.length > 3) {
          const overflow = cols.slice(3).join(' ').trim();
          if (overflow.length > 40) { out.push(''); out.push(overflow); inTable = false; }
        }
      } else {
        out.push(''); out.push(trimmed); inTable = false;
      }
    }
    s.body = out.join('\n');
  }
  return sections;
}

// Splits a whitespace-separated line into columns by looking for gaps of 2+ spaces.
// Preserves content with single spaces within a cell.
// Skips leading whitespace (no empty first column) and trailing whitespace.
function splitColumns(line, minCols) {
  const trimmed = line.trim();
  // Find split positions within the trimmed line: sequences of 2+ spaces
  const splits = [];
  const re = /\s{2,}/g;
  let m;
  while ((m = re.exec(trimmed)) !== null) {
    splits.push({ start: m.index, end: m.index + m[0].length });
  }

  if (splits.length < 1) return [trimmed];

  const cols = [];
  let pos = 0;
  for (const s of splits) {
    cols.push(trimmed.slice(pos, s.start).trim());
    pos = s.end;
  }
  // Last column: everything after the final split
  if (pos < trimmed.length) {
    cols.push(trimmed.slice(pos).trim());
  }

  return cols.length >= 2 ? cols : [trimmed];
}

export function normaliseC1Table(sections) {
  for (const s of sections) {
    if (!s.heading?.startsWith('C1.')) continue;
    const body = s.body || '';
    const lines = body.split('\n');

    // Detect: header row contains "Dimension" and "Evidence level"
    const hasC1Header = lines.some(l => /\bDimension\b/i.test(l) && /\bEvidence\s*level\b/i.test(l));
    if (!hasC1Header) continue;

    const out = [];
    let summaryPara = null;
    let inTable = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { out.push(''); continue; }

      // Detect the C1 table header row
      if (/\bDimension\b/i.test(trimmed) && /\bEvidence\s*level\b/i.test(trimmed)) {
        // Use the fixed line for the table, but keep original trimmed for header detection
        inTable = true;
        out.push('| Dimension | Evidence level | Notes |');
        out.push('|---|---|---|');
        continue;
      }

      // Separator row — skip (we add our own)
      if (/^\|?\s*[-:| ]+\s*\|?$/.test(trimmed)) continue;

      if (inTable) {
        // Accept optional **bold** around the evidence keyword.
        // Require the keyword to be flanked by 2+ spaces or a pipe — columnar layout,
        // not prose like "academically strong".
        const evidenceMatch = trimmed.match(
          /(?:^|\s{2,}|\|\s*)(?:\*\*)?(Strong|Present|Not\s*evident|Mixed|Weak)(?:\*\*)?(?=\s{2,}|\s*\|)/i
        );
        if (evidenceMatch) {
          const evidenceLevel = evidenceMatch[1];
          // Position the keyword within trimmed. Use the full match boundaries so
          // that ** markers around the keyword are consumed and don't leak into notes.
          const kwOffsetInMatch = evidenceMatch[0].indexOf(evidenceLevel);
          const kwStart = evidenceMatch.index + kwOffsetInMatch;
          const matchEnd = evidenceMatch.index + evidenceMatch[0].length;  // past closing **

          // Everything before the evidence level = dimension name
          let dimension = trimmed.slice(0, kwStart).trim();
          dimension = dimension.replace(/^[\s|]+/, '').replace(/[\s|]+$/, '');

          // Everything after the full match (after any closing **) = notes
          let notes = trimmed.slice(matchEnd).trim();
          notes = notes.replace(/^[\s|]+/, '').replace(/[\s|]+$/, '');

          // If notes is too long (>200 chars) or contains sentence-like text
          // that looks like a summary paragraph, split it off
          const sentences = notes.match(/[^.!?]+[.!?]+/g) || [];
          if (sentences.length >= 2) {
            const firstSentence = sentences[0] || '';
            const rest = sentences.slice(1).join(' ').trim();
            if (rest.length > 100 && /\b(child|pupil|student|family|parent|school|thrive|struggle|fit|suits)\b/i.test(rest)) {
              notes = firstSentence.trim();
              summaryPara = rest;
            }
          }

          // Also detect when notes clearly runs into a summary (no sentence boundary)
          if (!summaryPara && notes.length > 250) {
            const summaryMatch = notes.match(/\b(A child|This school suits|Pupils who|Children who|Overall,|In summary,)/i);
            if (summaryMatch) {
              summaryPara = notes.slice(summaryMatch.index).trim();
              notes = notes.slice(0, summaryMatch.index).trim();
            }
          }

          out.push(`| ${dimension} | ${evidenceLevel} | ${notes} |`);
        } else if (summaryPara) {
          // Non-table line after table — treat as summary continuation
          summaryPara = summaryPara + ' ' + trimmed.replace(/^[\s|]+/, '');
        } else if (/\b(child|pupil|student|family|parent|thrive|struggle|fit|suits|school)\b/i.test(trimmed) && trimmed.length > 80) {
          // Long prose line — likely the summary paragraph
          // Strip leading pipe/whitespace, then strip any citation prefix like "[Source](url) | "
          summaryPara = trimmed.replace(/^[\s|]+/, '').replace(/^\[[^\]]+\]\([^)]+\)\s*\|\s*/, '');
        } else {
          // Short line that didn't match evidence: keep it as-is rather than dropping
          out.push(trimmed);
        }
      } else {
        out.push(trimmed);
      }
    }

    // End the table
    out.push('');

    // Append the summary paragraph if extracted
    if (summaryPara) {
      out.push(summaryPara.trim());
    } else {
      // Fallback: if no summary was extracted, add a placeholder note
      out.push('_Summary not extracted — see Pros and Cons below._');
    }

    s.body = out.join('\n');
  }
  return sections;
}

// Adds _partLabel to the first section of each part (A1, B1, C1).
// The UI uses this to render a divider row directly above the section.
export function tagPartLabels(sections) {
  const PART_LABELS = {
    'A1.': 'Part A — Official Record',
    'B1.': 'Part B — Independent Research',
    'C1.': 'Part C — Verdict & Synthesis',
  };
  for (const s of sections) {
    if (s._partLabel) continue; // already labelled (e.g. by server-rendered Part B)
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
export function interleaveVerdicts(partASections, call2Sections) {
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

/**
 * Strip orphan observation sections (e.g. "A8. Observations" when only A1–A7
 * data sections exist) and ensure every data section A2–A7 has a matching
 * observation slot, inserting an empty placeholder if the AI omitted one.
 */
export function enforceObservations(sections, partADataSections) {
  const dataPrefixes = new Set(
    partADataSections
      .map(s => s.heading?.match(/^(A\d+)\./)?.[1])
      .filter(Boolean)
  );

  // Work on a copy; preserve original order of ALL sections.
  const result = [...sections];

  // 1. Strip orphan observations (A-prefix observations with no matching data section)
  for (let i = result.length - 1; i >= 0; i--) {
    const h = result[i].heading ?? '';
    const isObs = /^A\d+\./i.test(h) && /\bObservations?\b/i.test(h);
    if (!isObs) continue;
    const prefix = h.match(/^(A\d+)/)?.[1];
    if (!prefix || !dataPrefixes.has(prefix)) {
      result.splice(i, 1);
    }
  }

  // 2. Insert placeholders for data sections A2–A7 that lack an observation
  for (const prefix of [...dataPrefixes].sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)))) {
    if (prefix === 'A1') continue;
    const hasObs = result.some(s =>
      /^A\d+\./i.test(s.heading ?? '') &&
      /\bObservations?\b/i.test(s.heading ?? '') &&
      s.heading?.startsWith(prefix + '.')
    );
    if (hasObs) continue;

    // Find the last section with this prefix (should be the data section) and insert after it
    let insertIdx = -1;
    for (let i = 0; i < result.length; i++) {
      if ((result[i].heading ?? '').startsWith(prefix + '.')) insertIdx = i + 1;
    }
    if (insertIdx < 0) insertIdx = result.length;
    result.splice(insertIdx, 0, {
      heading: `${prefix}. Observations`,
      body: '_Analysis not available for this section._',
      flag: 'none',
    });
  }

  return result;
}

// ── In-memory job store for async Call 2 ────────────────────────────────────

const ASYNC_TTL_MS = 120_000;  // drop jobs older than 2 minutes
const call2Jobs = new Map();

// Periodic cleanup of stale jobs (every 60s)
setInterval(() => {
  const cutoff = Date.now() - ASYNC_TTL_MS;
  for (const [id, job] of call2Jobs) {
    if (job.created < cutoff) call2Jobs.delete(id);
  }
}, 60_000).unref();

// ── Retry helper (exponential backoff with jitter) ──────────────────────────

async function fetchWithRetry(url, options, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        if (attempt < maxRetries) {
          const delay = Math.floor(Math.pow(2, attempt) * 1000 + Math.random() * 500);
          log('retry_backoff', { attempt: attempt + 1, status: res.status, delayMs: delay });
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && (err.name === 'TimeoutError' || err.message?.includes('timed out') || err.message?.includes('fetch failed'))) {
        const delay = Math.floor(Math.pow(2, attempt) * 1000 + Math.random() * 500);
        log('retry_backoff', { attempt: attempt + 1, error: err.message, delayMs: delay });
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// Partially applied — returns { res, ms } or throws { httpError }
async function callOpenAI(url, payload, timeoutMs) {
  const t0 = Date.now();
  const auth = payload._auth;
  delete payload._auth;  // OpenAI rejects unknown parameters
  try {
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': auth },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { res, ms: Date.now() - t0 };
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.message?.includes('timed out');
    throw {
      httpError: {
        status: timedOut ? 504 : 502,
        summary: timedOut ? 'The research provider timed out.' : 'The research provider could not complete the request.',
      },
      ms: Date.now() - t0,
    };
  }
}

// Resumes a stored Call 2 job — runs the heavy (web search) call for either branch.
async function processCall2(job, event, body, t0) {
  const { call2Data, apiConfig } = job;
  const { govukBlock, question } = call2Data;
  const { model, baseUrl, apiKey, promptFile, isAdmin } = apiConfig;

  if (call2Data.branch === 'prompt_branch_1') {
    // ── Branch 1: Call 2 (Part B + Part C) ────────────────────────────────
    const { govukSchool, partAFlags, partASections, qt1Title, qt1Summary, qt1Scorecard } = call2Data;

    const call2Instructions = getBCInstructions(promptFile) + (govukBlock ? `\n\n${govukBlock}` : '');
    const call2IsReasoning = /^o\d/i.test(model);
    const call2Payload = {
      _auth:  `Bearer ${apiKey}`,
      model,
      tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'GB', city: 'London', region: 'London', timezone: 'Europe/London' }, external_web_access: true }],
      tool_choice: 'auto',
      include: ['web_search_call.action.sources'],
      instructions: call2Instructions,
      input: question,
      max_output_tokens: parseInt(process.env.OPENAI_MAX_TOKENS ?? '8000', 10),
      text: { format: SCHEMA_BC },
    };
    if (call2IsReasoning) call2Payload.reasoning = { effort: process.env.OPENAI_REASONING_EFFORT ?? 'low' };

    let call2Response, call2Ms;
    try {
      const { res, ms } = await callOpenAI(`${baseUrl}/responses`, call2Payload, 120000);
      call2Ms = ms;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log('call2_error', { branch: 'prompt_branch_1', status: res.status, body: body.slice(0, 500) });
        throw { httpError: { status: res.status, summary: 'Call 2 failed: HTTP ' + res.status + ' — ' + body.slice(0, 200) } };
      }
      call2Response = await res.json();
    } catch (err) {
      const httpErr = err.httpError;
      if (httpErr) {
        job.status = 'error';
        job.error = httpErr.summary;
        log('research_request', { status: httpErr.status === 504 ? 'timeout' : 'upstream_error', httpStatus: httpErr.status, branch: 'prompt_branch_1', model, question: question.slice(0, 200), ms: Date.now() - t0 });
        return errorResponse(httpErr.status, { error: httpErr.summary });
      }
      throw err;
    }

    const call2Parsed = parseOpenAIResponse(call2Response);
    const bcSections = call2Parsed.sections ?? [];
    const call2Searches = (call2Response.output ?? []).filter(i => i.type === 'web_search_call').map(i => i.action?.query ?? null).filter(Boolean);
    const deferredPartA = partASections.filter(s => s._deferred);
    const visiblePartA = partASections.filter(s => !s._deferred);
    let finalSections = normaliseC1Table(tagPartLabels(
      enforceObservations(
        interleaveVerdicts([...visiblePartA, ...deferredPartA], bcSections),
        partASections
      )
    ));

    if (Object.keys(partAFlags).length) {
      for (const s of finalSections) {
        const prefix = s.heading?.match(/^(A\d+)\./)?.[1];
        if (!prefix) continue;
        for (const [flagKey, flagVal] of Object.entries(partAFlags)) {
          if (flagKey.startsWith(prefix + '.') && flagVal !== undefined) { s.flag = flagVal; break; }
        }
      }
    }

    const ms = Date.now() - t0;
    const usage = call2Response?.usage ?? {};
    log('research_request', { status: 'completed', httpStatus: 200, branch: 'prompt_branch_1', model, question: question.slice(0, 200), ms, govuk: { ms: 0, injected: true, chars: govukBlock.length }, call2: { ms: call2Ms, outputTokens: usage.output_tokens ?? null, searches: call2Searches.length }, output: { title: qt1Title, partASections: partASections.length, bcSections: finalSections.length } });

    const result = { status: 'completed', httpStatus: 200, title: qt1Title, summary: qt1Summary, scorecard: qt1Scorecard, sections: finalSections };
    job.status = 'completed';
    job.result = result;
    return okResponse(isAdmin ? { ...result, _trace: { totalMs: ms, call2: { ms: call2Ms, model, inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, webSearches: call2Searches.length }, output: { title: qt1Title, sections: finalSections.length } } } : result);
  }

  // ── Branch 2: Call 2 (Full Comparison) ──────────────────────────────────
  const { qt2Title, qt2Summary, qt2Scorecard } = call2Data;

  const call2Instructions = getBranchInstructions('prompt_branch_2', promptFile) + (govukBlock ? `\n\n${govukBlock}` : '');
  const call2IsReasoning = /^o\d/i.test(model);
  const call2Payload = {
    _auth: `Bearer ${apiKey}`,
    model,
    tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'GB', city: 'London', region: 'London', timezone: 'Europe/London' }, external_web_access: true }],
    tool_choice: 'auto',
    include: ['web_search_call.action.sources'],
    instructions: call2Instructions,
    input: question,
    max_output_tokens: parseInt(process.env.OPENAI_MAX_TOKENS ?? '8000', 10),
    text: { format: SCHEMA_BC },
  };
  if (call2IsReasoning) call2Payload.reasoning = { effort: process.env.OPENAI_REASONING_EFFORT ?? 'low' };

  let call2Response, call2Ms;
  try {
    const { res, ms } = await callOpenAI(`${baseUrl}/responses`, call2Payload, 120000);
    call2Ms = ms;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log('call2_error', { branch: 'prompt_branch_2', status: res.status, body: body.slice(0, 500) });
      throw { httpError: { status: res.status, summary: 'Call 2 failed: HTTP ' + res.status + ' — ' + body.slice(0, 200) } };
    }
    call2Response = await res.json();
  } catch (err) {
    const httpErr = err.httpError;
    if (httpErr) {
      job.status = 'error';
      job.error = httpErr.summary;
      log('research_request', { status: httpErr.status === 504 ? 'timeout' : 'upstream_error', httpStatus: httpErr.status, branch: 'prompt_branch_2', model, question: question.slice(0, 200), ms: Date.now() - t0 });
      return errorResponse(httpErr.status, { error: httpErr.summary });
    }
    throw err;
  }

  const call2Parsed = parseOpenAIResponse(call2Response);
  const schools = call2Data.schools ?? [];
  let aiSections = call2Parsed.sections ?? [];

  // Strip any AI-generated Part A sections that aren't Observations.
  // Server-rendered tables provide the data — the AI must not output
  // duplicate A1/A2/etc sections with empty tables.
  aiSections = aiSections.filter(s => {
    if (/^A\d+\./i.test(s.heading ?? '')) {
      // Keep only Observation sections, strip any tables from them
      if (!/\bObservations?\b/i.test(s.heading ?? '')) return false;
      s.body = (s.body || '').split('\n').filter(l => !l.trim().startsWith('|') && !/^\|?\s*[-:| ]+\s*\|?$/.test(l.trim())).join('\n').trim();
    }
    return true;
  });

  // Server-render Part A tables and interleave with AI observations
  const partATables = schools.length >= 1 ? renderPartAComparison(schools) : [];
  const interleaved = interleaveVerdicts(partATables, aiSections);
  const finalSections = tagPartLabels(normaliseComparisonTable(interleaved, schoolNames.length >= 2 ? schoolNames : qt2Title.split(/\s+vs\.?\s+/i)));

  const call2Searches = (call2Response.output ?? []).filter(i => i.type === 'web_search_call').map(i => i.action?.query ?? null).filter(Boolean);
  const ms = Date.now() - t0;
  const usage = call2Response?.usage ?? {};

  log('research_request', { status: 'completed', httpStatus: 200, branch: 'prompt_branch_2', model, question: question.slice(0, 200), ms, govuk: { ms: 0, injected: true, chars: govukBlock.length }, call2: { ms: call2Ms, outputTokens: usage.output_tokens ?? null, searches: call2Searches.length }, output: { title: qt2Title, sections: finalSections.length } });

  const result = { status: 'completed', httpStatus: 200, title: qt2Title, summary: qt2Summary, scorecard: qt2Scorecard, sections: finalSections };
  job.status = 'completed';
  job.result = result;
  return okResponse(isAdmin ? { ...result, _trace: { totalMs: ms, call2: { ms: call2Ms, model, inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, webSearches: call2Searches.length }, output: { title: qt2Title, sections: finalSections.length } } } : result);
}

export const handler = async (event) => {
  const t0 = Date.now();

  // ── GET: job status polling ────────────────────────────────────────────────
  const method = event.requestContext?.http?.method ?? 'POST';
  if (method === 'GET') {
    const params = event.queryStringParameters ?? {};
    const jobId = params.jobId;
    if (!jobId) return errorResponse(400, { error: 'Missing jobId query parameter.' });

    const job = call2Jobs.get(jobId);
    if (!job) return errorResponse(404, { error: 'Job not found or expired.' });

    if (job.status === 'completed') {
      call2Jobs.delete(jobId);
      return okResponse(job.result);
    }
    if (job.status === 'error') {
      call2Jobs.delete(jobId);
      return errorResponse(502, { error: job.error || 'Call 2 failed.' });
    }
    return okResponse({ status: 'processing', _jobId: jobId });
  }

  // ── POST: analytics / feedback (fire-and-forget) ──────────────────────────────
  const path = event.requestContext?.http?.path ?? '/';
  if (method === 'POST' && (path === '/api/feedback' || path === '/api/analytics/click')) {
    let fbBody;
    try { fbBody = JSON.parse(event.body ?? '{}'); } catch { fbBody = {}; }
    log('feedback', {
      name: (fbBody.event || 'feedback').slice(0, 64),
      branch: (fbBody.branch || '').slice(0, 32),
      section: (fbBody.section || '').slice(0, 128),
      rating: (fbBody.rating || '').slice(0, 8),
      text: (fbBody.text || '').slice(0, 500),
      email: (fbBody.email || '').slice(0, 120)
    });
    return okResponse({ status: 'logged', httpStatus: 200 });
  }

  // ── POST: research request ──────────────────────────────────────────────────

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    log('research_request', { status: 'invalid_json', httpStatus: 400 });
    return errorResponse(400, { error: 'Invalid JSON payload.' });
  }

  // ── Resume: skip Call 1, run Call 2 directly from stored data ──────────────
  if (body._resume) {
    const job = call2Jobs.get(body._resume);
    if (!job || job.status === 'completed' || job.status === 'error') {
      return errorResponse(404, { error: 'Job not found, already completed, or expired.' });
    }
    return await processCall2(job, event, body, t0);
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
    let qt1Block = '';
    try {
      const govukT0 = Date.now();
      const govukResult = await fetchGovDataForPrompt(body.question, 'prompt_branch_1', apiKey, baseUrl, model);
      govukBlock  = govukResult?.block  ?? '';
      govukFlags  = govukResult?.flags  ?? {};
      govukSchool = govukResult?.schools?.[0] ?? null;
      qt1Block    = govukResult?.quickTakeBlock ?? '';
      govukMs = Date.now() - govukT0;
    } catch (err) {
      log('govuk_inject_error', { branch: 'prompt_branch_1', error: err.message });
      // Non-fatal — continue with empty data; server-rendered Part A will show "not retrieved"
    }

    // ── Step 2: Call 1 — Quick Take + scorecard ───────────────────────────────
    // Use a condensed ~500-token block for Call 1 (headline metrics only).
    // The full slim block goes to Call 2 which needs Ofsted narratives, subject
    // tables, financial detail, and census breakdowns.
    const qt1Instructions = QUICK_TAKE_INSTRUCTIONS + (qt1Block ? `\n\n${qt1Block}` : '');
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

    // ── Async split (opt-in via _async): return Call 1 immediately ──────────
    if (body._async && !body._resume) {
      const jobId = crypto.randomUUID();
      call2Jobs.set(jobId, {
        status: 'processing',
        created: Date.now(),
        call2Data: {
          branch: 'prompt_branch_1',
          govukBlock, govukSchool, partAFlags,
          partASections: partASections.map(s => ({ ...s })),
          qt1Title, qt1Summary, qt1Scorecard,
          question: body.question,
        },
        apiConfig: { model, baseUrl, apiKey, promptFile, isAdmin },
      });
      const partialSections = tagPartLabels(visiblePartA);
      const ms = Date.now() - t0;
      log('research_request', { status: 'partial', httpStatus: 200, branch: 'prompt_branch_1', model, question: body.question.slice(0, 200), ms, govuk: { ms: govukMs, injected: govukBlock.length > 0, chars: govukBlock.length }, call1: { ms: qt1Ms, outputTokens: qt1Response?.usage?.output_tokens ?? null }, output: { title: qt1Title, partASections: visiblePartA.length } });
      return okResponse({ status: 'partial', httpStatus: 200, _jobId: jobId, title: qt1Title, summary: qt1Summary, scorecard: qt1Scorecard, sections: partialSections });
    }

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

    // Collect web search sources from Call 2
    const call2Searches = (call2Response?.output ?? [])
      .filter(item => item.type === 'web_search_call')
      .map(item => item.action?.query ?? null)
      .filter(Boolean);

    const call2Sources = [];
    for (const item of (call2Response?.output ?? [])) {
      if (item.type === 'web_search_call' && item.action?.sources) {
        for (const s of item.action.sources) {
          if (s.url) call2Sources.push({ heading: s.title || s.url, body: s.url });
        }
      }
    }

    // Rename model's "Sources" section → "Primary Sources", append Secondary Sources
    let primarySourcesBody = null;
    for (const s of bcSections) {
      if (/^sources?$/i.test(s.heading)) { s.heading = 'Primary Sources'; primarySourcesBody = s.body; break; }
    }
    if (call2Sources.length) {
      // Dedup: exclude any URL already present in ANY existing section body
      const allBodies = bcSections.map(s => s.body).filter(Boolean).join(' ');
      const secondary = call2Sources
        .filter(s => !allBodies.includes(s.body))
        .map(s => `[${s.heading}](${s.body})`);
      if (secondary.length) bcSections.push({ heading: 'Secondary Sources', body: secondary.join('\n'), flag: 'none' });
    }

    // ── Step 5: Assemble and return ───────────────────────────────────────────
    // Part A sections already have _partLabel on A1; tag B1 and C1 from Call 2.
    let finalSections = normaliseC1Table(tagPartLabels(
      enforceObservations(
        interleaveVerdicts(partASections, bcSections),
        partASections
      )
    ));

    // Apply deterministic flag overrides to AI-generated verdict sections.
    // partAFlags keys are like 'A5. Academic Performance'; verdict headings
    // are like 'A5. Observations'. Match on the numeric prefix.
    if (Object.keys(partAFlags).length) {
      for (const s of finalSections) {
        const prefix = s.heading?.match(/^(A\d+)\./)?.[1];  // e.g. "A5"
        if (!prefix) continue;
        // Find the matching data-section flag key (e.g. "A5. Academic Performance")
        for (const [flagKey, flagVal] of Object.entries(partAFlags)) {
          if (flagKey.startsWith(prefix + '.') && flagVal !== undefined) {
            s.flag = flagVal;
            break;
          }
        }
      }
    }

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

  // ── Branch 2: two-call flow (Quick Take + full comparison) ──────────────────

  if (body.branch === 'prompt_branch_2') {
    // ── Step 1: Fetch gov.uk data for all schools ──────────────────────────
    let govukBlock = '';
    let qt2Block = '';
    let govukMs = 0;
    let govukResult;
    try {
      const govukT0 = Date.now();
      govukResult = await fetchGovDataForPrompt(body.question, 'prompt_branch_2', apiKey, baseUrl, model);
      govukBlock = govukResult?.block ?? '';
      qt2Block   = govukResult?.quickTakeBlock ?? '';
      govukMs = Date.now() - govukT0;
    } catch (err) {
      log('govuk_inject_error', { branch: 'prompt_branch_2', error: err.message });
    }

    // ── Step 2: Call 1 — Quick Take Comparison ─────────────────────────────
    const qt2Instructions = QUICK_TAKE_COMPARISON_INSTRUCTIONS + (qt2Block ? `\n\n${qt2Block}` : '');
    const qt2Model = process.env.OPENAI_QUICK_TAKE_MODEL ?? model;
    const qt2IsReasoning = /^o\d/i.test(qt2Model);

    let qt2Response = null;
    let qt2Ms = 0;
    let qt2HttpError = null;

    const qt2T0 = Date.now();
    try {
      const qt2Payload = {
        model:             qt2Model,
        tool_choice:       'none',
        instructions:      qt2Instructions,
        input:             body.question,
        max_output_tokens: 1200,
        text:              { format: SCHEMA_QUICK_TAKE },
      };
      if (qt2IsReasoning) qt2Payload.reasoning = { effort: 'low' };

      const qt2Res = await fetch(`${baseUrl}/responses`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body:    JSON.stringify(qt2Payload),
        signal:  AbortSignal.timeout(30000),
      });
      qt2Ms = Date.now() - qt2T0;
      if (qt2Res.ok) {
        qt2Response = await qt2Res.json();
      } else {
        const txt = await qt2Res.text().catch(() => '');
        const summary =
          qt2Res.status === 401 || qt2Res.status === 403 ? 'The research provider rejected the API key.' :
          qt2Res.status === 429 ? 'The research provider is rate-limiting requests. Try again shortly.' :
          'The research provider could not complete the request.';
        qt2HttpError = { status: qt2Res.status, summary };
        log('qt2_error', { status: qt2Res.status, body: txt.slice(0, 200) });
      }
    } catch (err) {
      qt2Ms = Date.now() - qt2T0;
      const timedOut = err.name === 'TimeoutError' || err.message?.includes('timed out');
      qt2HttpError = {
        status:  timedOut ? 504 : 502,
        summary: timedOut ? 'The research provider timed out.' : 'The research provider could not complete the request.',
      };
      log('qt2_error', { error: err.message });
    }

    if (qt2HttpError) {
      const qt2Status = qt2HttpError.status === 504 ? 'timeout' : 'upstream_error';
      log('research_request', { status: qt2Status, httpStatus: qt2HttpError.status, branch: 'prompt_branch_2', model, question: body.question.slice(0, 200), ms: Date.now() - t0 });
      return okResponse({ status: qt2Status, httpStatus: qt2HttpError.status, title: 'Research provider error', summary: qt2HttpError.summary, scorecard: [], sections: [{ heading: 'What happened', body: qt2HttpError.summary, flag: 'none' }] });
    }

    const qt2Parsed = parseOpenAIResponse(qt2Response ?? {});
    if (qt2Parsed.status === 'upstream_invalid_format') {
      log('research_request', { status: 'upstream_invalid_format', httpStatus: qt2Parsed.httpStatus ?? 502, branch: 'prompt_branch_2', model, question: body.question.slice(0, 200), ms: Date.now() - t0 });
      return okResponse(qt2Parsed);
    }
    const qt2Title    = qt2Parsed.title    || '';
    const qt2Summary  = qt2Parsed.summary  || '';
    const qt2Scorecard = qt2Parsed.scorecard || [];

    // ── Async split (opt-in via _async): return Call 1 immediately ──────────
    if (body._async && !body._resume) {
      const jobId = crypto.randomUUID();
      call2Jobs.set(jobId, {
        status: 'processing',
        created: Date.now(),
        call2Data: {
          branch: 'prompt_branch_2',
          govukBlock,
          schools: govukResult?.schools ?? [],
          schoolNames: (govukResult?.schools ?? []).map(s => s.identity?.officialName).filter(Boolean),
          qt2Title, qt2Summary, qt2Scorecard,
          question: body.question,
        },
        apiConfig: { model, baseUrl, apiKey, promptFile, isAdmin },
      });
      const ms = Date.now() - t0;
      log('research_request', { status: 'partial', httpStatus: 200, branch: 'prompt_branch_2', model, question: body.question.slice(0, 200), ms, govuk: { ms: govukMs, injected: govukBlock.length > 0, chars: govukBlock.length }, call1: { ms: qt2Ms, outputTokens: qt2Response?.usage?.output_tokens ?? null }, output: { title: qt2Title } });
      return okResponse({ status: 'partial', httpStatus: 200, _jobId: jobId, title: qt2Title, summary: qt2Summary, scorecard: qt2Scorecard, sections: [] });
    }

    // ── Step 3: Call 2 — Full Comparison with web search ──────────────────
    const call2Instructions = getBranchInstructions('prompt_branch_2', promptFile) + (govukBlock ? `\n\n${govukBlock}` : '');
    const call2IsReasoning = /^o\d/i.test(model);

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
        signal:  AbortSignal.timeout(120000),
      });
      call2Ms = Date.now() - call2T0;
      if (call2Res.ok) {
        call2Response = await call2Res.json();
      } else {
        const txt = await call2Res.text().catch(() => '');
        call2Err = {
          status:  call2Res.status,
          summary: call2Res.status === 429 ? 'The research provider is rate-limiting requests.' : 'The research provider could not complete the full comparison.',
        };
        log('call2_error', { branch: 'prompt_branch_2', status: call2Res.status, body: txt.slice(0, 200) });
      }
    } catch (err) {
      call2Ms = Date.now() - (Date.now() - call2Ms);
      call2Err = { status: 502, summary: 'The research provider could not complete the request.' };
      log('call2_error', { branch: 'prompt_branch_2', error: err.message });
    }

    // If Call 2 fails, return a degraded response with Call 1 data only
    if (call2Err || !call2Response) {
      const ms = Date.now() - t0;
      log('research_request', {
        status: 'degraded',
        httpStatus: 200,
        branch: 'prompt_branch_2',
        model,
        question: body.question.slice(0, 200),
        ms,
        govuk:  { ms: govukMs, injected: govukBlock.length > 0, chars: govukBlock.length },
        call1:  { ms: qt2Ms, outputTokens: qt2Response?.usage?.output_tokens ?? null },
        call2:  { ms: call2Ms, error: call2Err?.status },
        output: { title: qt2Title, sections: 0 },
      });
      return okResponse({
        status:    'degraded',
        httpStatus: 200,
        title:     qt2Title,
        summary:   qt2Summary + '\n\n_' + (call2Err?.summary ?? 'Full comparison unavailable.') + '_',
        scorecard: qt2Scorecard,
        sections:  [{ heading: '1. Verdict', body: qt2Summary + '\n\n_' + (call2Err?.summary ?? '') + '_', flag: 'none' }],
      });
    }

    // ── Step 4: Assemble and return ──────────────────────────────────────
    const call2Parsed = parseOpenAIResponse(call2Response);
    let call2Sections = call2Parsed.sections ?? [];
    const call2Searches = (call2Response.output ?? []).filter(i => i.type === 'web_search_call').map(i => i.action?.query ?? null).filter(Boolean);

    // Strip AI-generated non-Observation Part A sections (server tables provide data)
    call2Sections = call2Sections.filter(s => {
      if (/^A\d+\./i.test(s.heading ?? '')) {
        if (!/\bObservations?\b/i.test(s.heading ?? '')) return false;
        s.body = (s.body || '').split('\n').filter(l => !l.trim().startsWith('|') && !/^\|?\s*[-:| ]+\s*\|?$/.test(l.trim())).join('\n').trim();
      }
      return true;
    });

    // Server-render Part A tables and interleave with AI observations
    const br2Schools = govukResult?.schools ?? [];
    const partATables = br2Schools.length >= 1 ? renderPartAComparison(br2Schools) : [];
    const interleavedB2 = interleaveVerdicts(partATables, call2Sections);
    let finalSections = tagPartLabels(normaliseComparisonTable(interleavedB2, br2Schools.length >= 2 ? br2Schools.map(s => s.identity?.officialName).filter(Boolean) : qt2Title.split(/\s+vs\.?\s+/i)));

    const ms = Date.now() - t0;
    const call2Usage = call2Response?.usage ?? {};

    log('research_request', {
      status: 'completed',
      httpStatus: 200,
      branch: 'prompt_branch_2',
      model,
      question: body.question.slice(0, 200),
      ms,
      govuk:  { ms: govukMs, injected: govukBlock.length > 0, chars: govukBlock.length },
      call1:  { ms: qt2Ms, outputTokens: qt2Response?.usage?.output_tokens ?? null },
      call2:  { ms: call2Ms, outputTokens: call2Usage.output_tokens ?? null, searches: call2Searches.length },
      output: { title: qt2Title, sections: finalSections.length },
    });

    const result2 = {
      status:    'completed',
      httpStatus: 200,
      title:     qt2Title,
      summary:   qt2Summary,
      scorecard: qt2Scorecard,
      sections:  finalSections,
    };

    const trace2 = {
      totalMs: ms,
      govuk:  { ms: govukMs, injected: govukBlock.length > 0, chars: govukBlock.length, estimatedTokens: Math.ceil(govukBlock.length / 4) },
      call1:  { ms: qt2Ms, model: qt2Model, inputTokens: qt2Response?.usage?.input_tokens ?? null, outputTokens: qt2Response?.usage?.output_tokens ?? null },
      call2:  { ms: call2Ms, model, inputTokens: call2Usage.input_tokens ?? null, outputTokens: call2Usage.output_tokens ?? null, webSearches: call2Searches.length },
      output: { title: qt2Title, sections: finalSections.length },
    };

    return okResponse(isAdmin ? { ...result2, _trace: trace2 } : result2);
  }

  // ── Branches 3, 4: original single-call flow ───────────────────────────────

  let instructions = getBranchInstructions(body.branch, promptFile);

  // Pre-fetch gov.uk data for branch 2 (comparison summary) and
  // branch 3 (area data for server-rendered Part B).
  let govukBlock = '';
  let govukFlags = {};
  let govukMs    = 0;
  let partBSections = [];   // Branch 3 server-rendered area sections
  let partASections = null;  // Branch 3 server-rendered A2 school list

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

  if (body.branch === 'prompt_branch_3') {
    try {
      const govukT0 = Date.now();
      // Extract a UK postcode from the question.
      let postcode = null;
      const fullPcMatch = body.question?.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})\b/i);
      if (fullPcMatch) {
        postcode = fullPcMatch[1] + ' ' + fullPcMatch[2];
      } else {
        const outMatch = body.question?.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\b/i);
        if (outMatch && /^[A-Z]{1,2}\d/i.test(outMatch[1])) {
          postcode = outMatch[1];
        }
      }
      if (postcode) {
        let area = await getAreaData(postcode);

        // Fallback: outward-only codes (e.g. "SE16") don't resolve via
        // postcodes.io postcode lookup. Try the outward-code endpoint
        // which returns a centroid lat/lon for the postcode area.
        if (!area && /^[A-Z]{1,2}\d{1,2}[A-Z]?$/i.test(postcode)) {
          try {
            const outcodeRes = await fetch(`https://api.postcodes.io/outcodes/${encodeURIComponent(postcode)}`);
            if (outcodeRes.ok) {
              const outcodeJson = await outcodeRes.json();
              const r = outcodeJson?.result;
              if (r) {
                area = {
                  postcode: postcode,
                  district: r.admin_district?.[0] || r.admin_county?.[0] || '',
                  region: r.region || '',
                  lat: r.latitude ?? null,
                  lon: r.longitude ?? null,
                };
              }
            }
          } catch (_) {}
        }

        partBSections = renderPartBArea(area);

        // Find nearby schools using the bundled GIAS index (TD-008)
        const lat = area?.lat, lon = area?.lon;
        if (lat != null && lon != null) {
          const schools = fetchSchoolsInArea(lat, lon, 1.5, 60); // within 1.5 miles
          if (schools.length) {
            // Render A2 server-side — all schools, grouped by phase, no AI curation
            const a2Section = renderPartASchools(schools, postcode);
            if (a2Section) {
              a2Section._partLabel = 'Part A — Official Record';
              // Prepend after the AI response is parsed — see below
              partASections = [a2Section];
            }
          }
        }
        govukMs = Date.now() - govukT0;
      }
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

  // Branch 3: insert server-rendered A2 after AI's A1 (Direct Answer)
  if (partASections && result.sections) {
    const a1Idx = result.sections.findIndex(s => /^A1\./i.test(s.heading ?? ''));
    const insertAt = a1Idx >= 0 ? a1Idx + 1 : 0;
    result.sections = [...result.sections.slice(0, insertAt), ...partASections, ...result.sections.slice(insertAt)];
  }

  // Apply deterministic flag overrides from structured data
  if (result.sections && Object.keys(govukFlags).length) {
    for (const s of result.sections) {
      if (govukFlags[s.heading] !== undefined) s.flag = govukFlags[s.heading];
    }
  }

  // Insert server-rendered Part B sections (Branch 3 area data)
  // between the last A-section and the first C-section.
  if (partBSections.length) {
    partBSections[0]._partLabel = 'Part B — Area Data';
    const sections = result.sections ?? [];
    // Find the boundary: last A-section, first C-section
    let insertIdx = sections.length;
    for (let i = 0; i < sections.length; i++) {
      if (/^C\d+\./i.test(sections[i].heading ?? '')) { insertIdx = i; break; }
    }
    result.sections = [...sections.slice(0, insertIdx), ...partBSections, ...sections.slice(insertIdx)];
  }

  // Tag part labels (Part A and Part C from AI output)
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
