/**
 * WAL writes. Every write runs in a `BEGIN IMMEDIATE` transaction via
 * `immediateTransaction`. SQLite errors — including the duplicate-write guard
 * (`uniq_step_terminal`) — propagate; nothing is swallowed.
 *
 * Callers pass `now` (from `ctx.now()`); this module never reads the wall clock.
 */
import { eq } from 'drizzle-orm';
import { immediateTransaction, type QuillDatabase } from './db.js';
import {
  branches,
  events,
  runs,
  type Branch,
  type Run,
  type RunStatus,
  type WalEvent,
} from './walSchema.js';
import type { DeterminismMode } from './tools.js';

export interface CreateRunInput {
  id: string;
  workflowId: string;
  inputJson: string;
  now: number;
}

export function createRun(db: QuillDatabase, input: CreateRunInput): Run {
  return immediateTransaction(db, (tx) => {
    const [row] = tx
      .insert(runs)
      .values({
        id: input.id,
        workflowId: input.workflowId,
        status: 'running',
        inputJson: input.inputJson,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning()
      .all();
    if (!row) {
      throw new Error('createRun: insert returned no row');
    }
    return row;
  });
}

export interface CreateBranchInput {
  id: string;
  runId: string;
  parentBranchId?: string;
  forkedFromStep?: string;
  now: number;
}

export function createBranch(
  db: QuillDatabase,
  input: CreateBranchInput,
): Branch {
  return immediateTransaction(db, (tx) => {
    const [row] = tx
      .insert(branches)
      .values({
        id: input.id,
        runId: input.runId,
        parentBranchId: input.parentBranchId ?? null,
        forkedFromStep: input.forkedFromStep ?? null,
        createdAt: input.now,
      })
      .returning()
      .all();
    if (!row) {
      throw new Error('createBranch: insert returned no row');
    }
    return row;
  });
}

export interface StepStartedInput {
  branchId: string;
  stepId: string;
  semanticName: string;
  determinism?: DeterminismMode;
  loopIndex?: number;
  payloadJson?: string;
  idempotencyKey?: string;
  now: number;
}

/** Write the intent record. Committed (and fsync'd) before the step executes. */
export function writeStepStarted(
  db: QuillDatabase,
  input: StepStartedInput,
): WalEvent {
  return immediateTransaction(db, (tx) => {
    const [row] = tx
      .insert(events)
      .values({
        branchId: input.branchId,
        stepId: input.stepId,
        type: 'STEP_STARTED',
        determinism: input.determinism ?? null,
        semanticName: input.semanticName,
        loopIndex: input.loopIndex ?? 0,
        payloadJson: input.payloadJson ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        costJson: null,
        createdAt: input.now,
      })
      .returning()
      .all();
    if (!row) {
      throw new Error('writeStepStarted: insert returned no row');
    }
    return row;
  });
}

export interface StepFailedInput {
  branchId: string;
  stepId: string;
  semanticName: string;
  determinism?: DeterminismMode;
  loopIndex?: number;
  /** Serialised error/diagnostic payload, stored in `payloadJson`. */
  errorJson?: string;
  now: number;
}

/** Write the terminal failure record. Subject to the same duplicate guard. */
export function writeStepFailed(
  db: QuillDatabase,
  input: StepFailedInput,
): WalEvent {
  return immediateTransaction(db, (tx) => {
    const [row] = tx
      .insert(events)
      .values({
        branchId: input.branchId,
        stepId: input.stepId,
        type: 'STEP_FAILED',
        determinism: input.determinism ?? null,
        semanticName: input.semanticName,
        loopIndex: input.loopIndex ?? 0,
        payloadJson: input.errorJson ?? null,
        idempotencyKey: null,
        costJson: null,
        createdAt: input.now,
      })
      .returning()
      .all();
    if (!row) {
      throw new Error('writeStepFailed: insert returned no row');
    }
    return row;
  });
}

/** Update a run's lifecycle status. */
export function setRunStatus(
  db: QuillDatabase,
  runId: string,
  status: RunStatus,
  now: number,
): void {
  immediateTransaction(db, (tx) => {
    tx.update(runs)
      .set({ status, updatedAt: now })
      .where(eq(runs.id, runId))
      .run();
  });
}

export interface StepCompletedInput {
  branchId: string;
  stepId: string;
  semanticName: string;
  determinism?: DeterminismMode;
  loopIndex?: number;
  payloadJson?: string;
  costJson?: string;
  now: number;
}

/**
 * Write the terminal success record. The `uniq_step_terminal` index makes a
 * second completion for the same step on the same branch throw — the
 * duplicate-write guard that keeps replay safe.
 */
export function writeStepCompleted(
  db: QuillDatabase,
  input: StepCompletedInput,
): WalEvent {
  return immediateTransaction(db, (tx) => {
    const [row] = tx
      .insert(events)
      .values({
        branchId: input.branchId,
        stepId: input.stepId,
        type: 'STEP_COMPLETED',
        determinism: input.determinism ?? null,
        semanticName: input.semanticName,
        loopIndex: input.loopIndex ?? 0,
        payloadJson: input.payloadJson ?? null,
        idempotencyKey: null,
        costJson: input.costJson ?? null,
        createdAt: input.now,
      })
      .returning()
      .all();
    if (!row) {
      throw new Error('writeStepCompleted: insert returned no row');
    }
    return row;
  });
}
