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

// ── Find project root (walk up to locate template.yaml and env.json) ──────────
const __dir = dirname(fileURLToPath(import.meta.url));
let projectRoot = null;
let searchDir = __dir;
for (let i = 0; i < 6; i++) {
  if (existsSync(join(searchDir, 'template.yaml'))) { projectRoot = searchDir; break; }
  const parent = dirname(searchDir);
  if (parent === searchDir) break;
  searchDir = parent;
}
if (!projectRoot) console.warn('⚠  Could not find project root (template.yaml).\n');

// ── Load static env vars from template.yaml (single source of truth) ──────────
// Reads non-!Ref values from the global Environment.Variables block.
if (projectRoot) {
  const yaml = readFileSync(join(projectRoot, 'template.yaml'), 'utf8');
  const inVars = /^\s{4}Variables:\s*$/m;
  const varBlock = yaml.slice(yaml.search(inVars));
  for (const m of varBlock.matchAll(/^\s{6}(\w+):\s*'?([^'\n!][^'\n]*?)'?\s*$/gm)) {
    if (!process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

// ── Load secrets from env.json (API key, model, admin key) ────────────────────
const envJsonPath = projectRoot ? join(projectRoot, 'env.json') : null;
if (envJsonPath && existsSync(envJsonPath)) {
  const envJson = JSON.parse(readFileSync(envJsonPath, 'utf8'));
  const vars = envJson.ResearchFunction ?? Object.values(envJson)[0] ?? {};
  for (const [k, v] of Object.entries(vars)) {
    if (!process.env[k]) process.env[k] = String(v);
  }
} else {
  console.warn('⚠  No env.json found — OPENAI_API_KEY must be set in the environment.\n');
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
