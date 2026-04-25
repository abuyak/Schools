import { handler } from '../functions/research/index.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function applySettings(settings) {
  if (!settings) return;
  if (settings.apiKey) process.env.OPENAI_API_KEY = settings.apiKey;
  if (settings.model) process.env.OPENAI_MODEL = settings.model;
  if (settings.baseUrl) process.env.OPENAI_BASE_URL = settings.baseUrl;
  if (settings.reasoningEffort) process.env.OPENAI_REASONING_EFFORT = settings.reasoningEffort;
  if (settings.maxOutputTokens != null) process.env.OPENAI_MAX_TOKENS = String(settings.maxOutputTokens);
}

try {
  const raw = await readStdin();
  const input = raw ? JSON.parse(raw) : {};
  applySettings(input.settings);

  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};

  const response = await handler({
    body: JSON.stringify(input.payload ?? {}),
  });

  console.log = originalLog;
  console.error = originalError;

  const body = typeof response?.body === 'string' ? response.body : JSON.stringify(response ?? {});
  process.stdout.write(body);
} catch (err) {
  process.stderr.write(err?.stack || String(err));
  process.exitCode = 1;
}
