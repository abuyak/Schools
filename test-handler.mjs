/**
 * test-handler.mjs
 *
 * End-to-end test for the research handler — calls the full pipeline:
 *   gov.uk pre-fetch → prompt injection → OpenAI Responses API → structured JSON
 *
 * Setup (one time):
 *   Create a file called .env.local in this directory with:
 *     OPENAI_API_KEY=sk-...
 *     OPENAI_MODEL=o4-mini          # optional, default: o4-mini
 *     ADMIN_KEY=any-secret-string   # optional, enables _model override in requests
 *
 * Usage:
 *   node test-handler.mjs "Tell me about Redriff Primary School"
 *   node test-handler.mjs --branch 2 "Reigate School vs Reigate Grammar School"
 *   node test-handler.mjs --branch 1 --model gpt-4o "Tell me about Fortismere School"
 */

import { readFileSync, existsSync } from 'fs';
import { handler } from './functions/research/index.js';

// ── Load .env.local ────────────────────────────────────────────────────────────
const envFile = new URL('.env.local', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
} else {
  console.warn('⚠  No .env.local found. Set OPENAI_API_KEY in the environment or create .env.local\n');
}

// ── Parse args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let branch = 'prompt_branch_1';
let modelOverride = null;

const filtered = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--branch' && args[i + 1]) {
    branch = `prompt_branch_${args[++i]}`;
  } else if (args[i] === '--model' && args[i + 1]) {
    modelOverride = args[++i];
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
if (modelOverride) console.log(`Model:    ${modelOverride} (override)`);
console.log(DIVIDER + '\n');

// ── Build request body ─────────────────────────────────────────────────────────
const body = { branch, question };
if (adminKey && modelOverride) {
  body._adminKey = adminKey;
  body._model    = modelOverride;
}

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

console.log(`\n${DIVIDER}`);
console.log(`Done in ${ms}ms`);
