/**
 * Nondeterminism detection. See `docs/architecture.md` §7 (the `recorded`
 * validator).
 *
 * When a step first executes, the orchestrator records a fingerprint of its
 * inputs in `STEP_STARTED`. On replay it recomputes the fingerprint from the
 * current inputs and compares: a mismatch means the workflow's inputs changed
 * between record and replay (e.g. a mutated system prompt), which would make the
 * cached result a lie. The runtime throws rather than return stale output.
 *
 * The fingerprint is a SHA-256 hash, not the raw input — storing full inputs
 * (which include the growing messages array) would reintroduce the N² storage
 * the WAL deliberately avoids.
 */
import { createHash } from 'node:crypto';
import type { WalEvent } from './walSchema.js';

export function fingerprint(canonicalInput: string): string {
  return createHash('sha256').update(canonicalInput, 'utf8').digest('hex');
}

export class NondeterminismError extends Error {
  readonly stepId: string;
  readonly expected: string;
  readonly actual: string;

  constructor(
    semanticName: string,
    stepId: string,
    expected: string,
    actual: string,
  ) {
    super(
      `nondeterministic input for step "${semanticName}" (${stepId}): ` +
        `recorded fingerprint ${expected}, replay produced ${actual}`,
    );
    this.name = 'NondeterminismError';
    this.stepId = stepId;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Throw if the current input fingerprint differs from the one recorded in the
 * step's `STEP_STARTED` event. No-op when there is nothing recorded to compare.
 */
export function assertDeterministicInput(
  semanticName: string,
  stepId: string,
  started: WalEvent | null,
  currentFingerprint: string,
): void {
  if (!started || started.payloadJson === null) {
    return;
  }
  const recorded = (
    JSON.parse(started.payloadJson) as { inputFingerprint?: string }
  ).inputFingerprint;
  if (recorded !== undefined && recorded !== currentFingerprint) {
    throw new NondeterminismError(semanticName, stepId, recorded, currentFingerprint);
  }
}
