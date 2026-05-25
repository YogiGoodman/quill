/**
 * INDETERMINATE recovery. See `docs/architecture.md` §6.
 *
 * A step is INDETERMINATE when a `STEP_STARTED` exists with no terminal event —
 * the process died after declaring intent but before recording the outcome.
 * Recovery depends on the tool's determinism mode:
 *
 * - `recorded`   — pure, safe to re-execute; record completion.
 * - `side_effect` — never re-execute. Query the remote by idempotency key via
 *   `reconcile`. If the effect was applied, record the reconciled value. If the
 *   remote shows nothing, hard-halt: the runtime cannot prove the effect did not
 *   fire, so an operator must decide.
 * - `interactive` — consent cannot survive a crash; re-prompt (Week 3). For now
 *   this is a hard halt.
 */
import type { QuillDatabase } from './db.js';
import type { ToolDefinition } from './tools.js';
import type { WalEvent } from './walSchema.js';
import { setRunStatus, writeStepCompleted, writeStepFailed } from './walWriter.js';

/** Thrown on a hard halt; the run is marked `indeterminate` and needs an operator. */
export class IndeterminateError extends Error {
  readonly stepId: string;
  readonly idempotencyKey: string | null;

  constructor(message: string, stepId: string, idempotencyKey: string | null) {
    super(message);
    this.name = 'IndeterminateError';
    this.stepId = stepId;
    this.idempotencyKey = idempotencyKey;
  }
}

export interface ReconcileParams<TArgs, TResult> {
  db: QuillDatabase;
  runId: string;
  branchId: string;
  /** The orphaned `STEP_STARTED` event. */
  started: WalEvent;
  tool: ToolDefinition<TArgs, TResult>;
  args: TArgs;
  /** Millisecond clock; never read the wall clock directly. */
  now: () => number;
}

export async function reconcileIndeterminateStep<TArgs, TResult>(
  params: ReconcileParams<TArgs, TResult>,
): Promise<TResult> {
  const { db, runId, branchId, started, tool, args, now } = params;
  const { stepId, semanticName } = started;

  switch (tool.determinism) {
    case 'recorded': {
      const result = await tool.execute(args);
      writeStepCompleted(db, {
        branchId,
        stepId,
        semanticName,
        determinism: 'recorded',
        payloadJson: JSON.stringify(result ?? null),
        now: now(),
      });
      return result;
    }

    case 'side_effect': {
      const key = started.idempotencyKey;
      if (!key) {
        throw new IndeterminateError(
          `side_effect step "${semanticName}" has no idempotency key to reconcile`,
          stepId,
          null,
        );
      }
      const remoteState = await tool.reconcile(key);
      if (remoteState !== null) {
        writeStepCompleted(db, {
          branchId,
          stepId,
          semanticName,
          determinism: 'side_effect',
          payloadJson: JSON.stringify(remoteState),
          now: now(),
        });
        return remoteState;
      }
      // Hard halt: the remote shows no record and we cannot prove the effect
      // did not fire. Record the failure and stop for an operator.
      writeStepFailed(db, {
        branchId,
        stepId,
        semanticName,
        determinism: 'side_effect',
        errorJson: JSON.stringify({ reason: 'UNRECONCILED', key }),
        now: now(),
      });
      setRunStatus(db, runId, 'indeterminate', now());
      throw new IndeterminateError(
        `side_effect step "${semanticName}" could not be reconciled; operator intervention required`,
        stepId,
        key,
      );
    }

    case 'interactive': {
      throw new IndeterminateError(
        `interactive step "${semanticName}" needs re-prompt after crash`,
        stepId,
        started.idempotencyKey,
      );
    }

    default: {
      const exhaustive: never = tool;
      throw new Error(`unknown determinism mode: ${JSON.stringify(exhaustive)}`);
    }
  }
}
