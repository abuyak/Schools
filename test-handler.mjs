/**
 * test-handler.mjs
 *
 * End-to-end test for the research handler — calls the full pipeline:
 *   gov.uk pre-fetch → prompt injection → OpenAI Responses API → structured JSON
 *
 * Uses env.json (same config as SAM local / deployed Lambda) — no extra setup needed.
 *
 * Usage:
 *   node test-handler.mjs "Tell me about Redriff Primary School"
 *   node test-handler.mjs --branch 2 "Reigate School vs Reigate Grammar School"
 *   node test-handler.mjs --branch 1 --model gpt-4o "Tell me about Fortismere School"
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { handler } from './functions/research/index.js';

// ── Load env.json from project root ───────────────────────────────────────────
// env.json is gitignored so it only exists in the real root, not in worktrees.
// Walk up until we find it.
const __dir = dirname(fileURLToPath(import.meta.url));
let envJsonPath = null;
let searchDir = __dir;
for (let i = 0; i < 8; i++) {
  const candidate = join(searchDir, 'env.json');
  if (existsSync(candidate)) { envJsonPath = candidate; break; }
  const parent = dirname(searchDir);
  if (parent === searchDir) break;
  searchDir = parent;
}
if (envJsonPath) {
  const vars = JSON.parse(readFileSync(envJsonPath, 'utf8'));
  const block = vars.ResearchFunction ?? Object.values(vars)[0] ?? {};
  for (const [k, v] of Object.entries(block)) {
    if (!process.env[k]) process.env[k] = String(v);
  }
} else {
  console.warn('⚠  No env.json found.\n');
}

// ── Parse args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let branch = 'prompt_branch_1';
let modelOverride = null;

let promptFile = null;

const filtered = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--branch' && args[i + 1]) {
    branch = `prompt_branch_${args[++i]}`;
  } else if (args[i] === '--model' && args[i + 1]) {
    modelOverride = args[++i];
  } else if (args[i] === '--file' && args[i + 1]) {
    promptFile = args[++i];   // e.g. prompt_branch_1_specific_school_v2.md
  } else {
    filtered.push(args[i]);
  }
}

const question = filtered.join(' ') || 'Tell me about Redriff Primary School';
const adminKey = process.env.ADMIN_KEY;

const DIVIDER = '─'.repeat(70);

console.log(DIVIDER);
console.log(`Branch:   ${branch}`);
console.log(`Question: ${question}`);
if (promptFile)    console.log(`Prompt:   ${promptFile}`);
if (modelOverride) console.log(`Model:    ${modelOverride} (override)`);
console.log(DIVIDER + '\n');

// ── Build request body ─────────────────────────────────────────────────────────
const body = { branch, question };
if (adminKey) body._adminKey = adminKey;                        // always send key — unlocks _trace + admin overrides
if (adminKey && modelOverride) body._model    = modelOverride;
if (adminKey && promptFile)    body._promptFile = promptFile;   // load alternate prompt file

// ── Call handler ───────────────────────────────────────────────────────────────
const t0 = Date.now();
const response = await handler({ body: JSON.stringify(body) });
const ms = Date.now() - t0;

const result = JSON.parse(response.body);

// ── Print result ───────────────────────────────────────────────────────────────
console.log(`HTTP ${response.statusCode}  •  ${ms}ms\n`);

if (result.status !== 'completed') {
  console.log('⚠  Status:', result.status);
  console.log('Title:  ', result.title);
  console.log('Summary:', result.summary);
  if (result.sections?.length) {
    for (const s of result.sections) console.log(`\n[${s.heading}]\n${s.body}`);
  }
  process.exit(1);
}

console.log(`TITLE:   ${result.title}\n`);
console.log(`SUMMARY: ${result.summary}\n`);

if (result.scorecard?.length) {
  console.log('SCORECARD:');
  for (const s of result.scorecard) {
    const bar = { strong: '●●●●●', good: '●●●●○', mixed: '●●●○○', weak: '●●○○○', unknown: '○○○○○' }[s.rating] ?? '?????';
    console.log(`  ${bar}  ${s.dimension.padEnd(28)} ${s.note}`);
  }
  console.log();
}

console.log('SECTIONS:');
for (const s of result.sections ?? []) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`## ${s.heading}`);
  console.log(s.body);
}

// ── Token consumption ──────────────────────────────────────────────────────────
if (result._trace) {
  const t = result._trace;
  console.log(`\n${DIVIDER}`);
  console.log('TOKEN CONSUMPTION');
  console.log(DIVIDER);
  console.log(`  Gov.uk data injected : ${t.govuk?.injected ? 'yes' : 'no'}  (${t.govuk?.chars ?? '?'} chars · ~${t.govuk?.estimatedTokens ?? '?'} tokens)`);
  console.log(`  Input tokens         : ${t.openai?.inputTokens ?? '?'}`);
  console.log(`  Output tokens        : ${t.openai?.outputTokens ?? '?'}`);
  console.log(`  Total tokens         : ${(t.openai?.inputTokens ?? 0) + (t.openai?.outputTokens ?? 0)}`);
  console.log(`  Web searches         : ${t.openai?.webSearches?.length ?? 0}${t.openai?.webSearches?.length ? ' — ' + t.openai.webSearches.join(', ') : ''}`);
  console.log(`  OpenAI latency       : ${t.openai?.ms ?? '?'}ms`);
  console.log(`  Gov.uk latency       : ${t.govuk?.ms ?? '?'}ms`);
}

console.log(`\n${DIVIDER}`);
console.log(`Done in ${ms}ms`);
