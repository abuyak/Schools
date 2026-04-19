import { Langfuse } from 'langfuse';

let _lf;

function getLangfuse() {
  if (_lf !== undefined) return _lf;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  if (!secretKey || !publicKey) { _lf = null; return null; }
  _lf = new Langfuse({
    secretKey,
    publicKey,
    baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
    flushAt: 1,
  });
  return _lf;
}

export function startTrace(name, input, metadata) {
  return getLangfuse()?.trace({ name, input, metadata }) ?? null;
}

export async function flushTracing() {
  await getLangfuse()?.flushAsync();
}
