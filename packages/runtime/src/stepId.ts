/**
 * Step-ID derivation. See `docs/architecture.md` §4.
 *
 * A step's identity must be stable across restarts and replays, unique within a
 * run, and collision-free across ReAct loop iterations. We hash the four
 * identifying fields with SHA-256, joined by the ASCII unit separator (0x1f) —
 * a byte that cannot occur in the textual inputs — so concatenation is
 * unambiguous.
 *
 * SHA-256 (not BLAKE3) because it ships in the Node standard library with zero
 * added dependencies. Derivation runs once per step, dwarfed by LLM latency, so
 * hash speed is irrelevant here.
 */
import { createHash } from 'node:crypto';

const UNIT_SEPARATOR = '';

export function deriveStepId(
  workflowId: string,
  parentStepId: string,
  loopIndex: number,
  semanticName: string,
): string {
  const input = [
    workflowId,
    parentStepId,
    String(loopIndex),
    semanticName,
  ].join(UNIT_SEPARATOR);
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
