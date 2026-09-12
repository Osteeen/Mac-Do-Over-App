import { execFile } from 'node:child_process';
import os from 'node:os';
import { LIMITS, type FindResult, type StripSnapshot } from '../../shared/types.js';
import { buildPayload, DEFAULT_MODEL } from './payload.js';
import { SCHEMA, SYSTEM } from './prompt.js';
import { validateAnswer } from './validate.js';

const ENDPOINT = 'https://api.openai.com/v1/responses';
/** Same Keychain service scripts/set-api-key.sh writes. */
export const KEYCHAIN_SERVICE = 'agent-starter-openai';

/** OPENAI_API_KEY if set, otherwise the macOS Keychain. The key is never logged and never leaves main except to OpenAI. */
export function readApiKey(): Promise<string | null> {
  const env = process.env.OPENAI_API_KEY?.trim();
  if (env) return Promise.resolve(env);
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-a', os.userInfo().username, '-s', KEYCHAIN_SERVICE, '-w'], { timeout: 5_000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
}

export interface FindOptions {
  /** Injected in tests. `null` means no key is configured. */
  apiKey?: string | null;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Optional, previewed, and never needed to put a file back. Sends the same payload the preview showed.
 * Every failure is a result the screen can show next to the list, never an exception.
 */
export async function runFind(snap: StripSnapshot, reference: unknown, opts: FindOptions = {}): Promise<FindResult> {
  const payload = buildPayload(snap, reference);
  if (!payload.reference) return { status: 'error', reason: 'Type a few words about the file you mean, then press Find.' };
  if (payload.candidates.length === 0) return { status: 'no_match', caveats: ['Nothing that can be put back was recorded in the last ten minutes.'] };

  const apiKey = opts.apiKey !== undefined ? opts.apiKey : await readApiKey();
  if (!apiKey) return { status: 'error', reason: 'No OpenAI key is set up on this Mac. You can still pick from the list.' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? LIMITS.findTimeoutMs);
  let text: string | undefined;
  try {
    const res = await (opts.fetchImpl ?? fetch)(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: opts.model ?? DEFAULT_MODEL,
        input: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(payload) }],
        text: { format: { type: 'json_schema', name: 'incident_selection', strict: true, schema: SCHEMA } },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn('[find] OpenAI answered with status', res.status);
      return { status: 'error', reason: `OpenAI answered with an error (${res.status}). You can still pick from the list.` };
    }
    const data = (await res.json()) as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
    text = data.output_text ?? data.output?.flatMap((o) => o.content ?? []).find((c) => c.type === 'output_text')?.text;
  } catch (err) {
    // Why it failed, for the Terminal log only: an error code or message, never the key or the payload.
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } } | undefined;
    console.warn('[find] request failed:', ctrl.signal.aborted ? 'no answer within the time limit'
      : String(e?.cause?.code ?? e?.code ?? e?.cause?.message ?? e?.message ?? err).slice(0, 160));
    return ctrl.signal.aborted
      ? { status: 'timeout', reason: 'Find took too long. You can still pick from the list.' }
      : { status: 'offline', reason: 'No connection. You can still pick from the list.' };
  } finally {
    clearTimeout(timer);
  }

  if (typeof text !== 'string') return { status: 'invalid', reason: 'The answer was not in the expected format.' };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { status: 'invalid', reason: 'The answer was not in the expected format.' }; }
  return validateAnswer(parsed, snap);
}
