import type { FindMatch, FindResult, StripSnapshot } from '../../shared/types.js';

const MAX_TEXT = 300;
const MAX_CAVEATS = 5;
const clip = (s: string) => s.slice(0, MAX_TEXT);

interface RawMatch { action_id: string; why: string; evidence_event_ids: string[] }

function isRawMatch(m: unknown): m is RawMatch {
  if (!m || typeof m !== 'object') return false;
  const r = m as Record<string, unknown>;
  return typeof r.action_id === 'string' && typeof r.why === 'string'
    && Array.isArray(r.evidence_event_ids) && r.evidence_event_ids.every((x) => typeof x === 'string');
}

/**
 * Turn the model's answer into a FindResult. Nothing is filtered into shape: an answer that cites a
 * candidate or an event that is not in this snapshot, or claims a match with no evidence, is
 * `invalid` as a whole and is never shown as a match.
 */
export function validateAnswer(answer: unknown, snap: StripSnapshot): FindResult {
  if (!answer || typeof answer !== 'object') return { status: 'invalid', reason: 'The answer was not in the expected format.' };
  const a = answer as Record<string, unknown>;
  if (!Array.isArray(a.matches) || !a.matches.every(isRawMatch) || !Array.isArray(a.caveats) || !a.caveats.every((c) => typeof c === 'string')) {
    return { status: 'invalid', reason: 'The answer was not in the expected format.' };
  }
  const candidates = new Set(snap.candidates.map((c) => c.id));
  const events = new Set(snap.events.map((e) => e.id));
  const caveats = (a.caveats as string[]).slice(0, MAX_CAVEATS).map(clip);

  const seen = new Set<string>();
  const matches: FindMatch[] = [];
  for (const m of a.matches as RawMatch[]) {
    if (!candidates.has(m.action_id)) return { status: 'invalid', reason: `The answer named a file that is not in this list (${clip(m.action_id)}).` };
    const bad = m.evidence_event_ids.find((e) => !events.has(e));
    if (bad !== undefined) return { status: 'invalid', reason: `The answer cited an event that was never recorded (${clip(bad)}).` };
    if (m.evidence_event_ids.length === 0) return { status: 'invalid', reason: 'The answer picked a file without citing any recorded event.' };
    if (seen.has(m.action_id)) continue;
    seen.add(m.action_id);
    matches.push({ candidateId: m.action_id, why: clip(m.why), evidenceEventIds: [...new Set(m.evidence_event_ids)] });
  }
  return matches.length ? { status: 'matched', matches, caveats } : { status: 'no_match', caveats };
}
