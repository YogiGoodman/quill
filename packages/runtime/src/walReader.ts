/**
 * WAL reads. Single-statement selects — no transaction needed. The orchestrator
 * consults these before executing a step (architecture §5).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { QuillDatabase } from './db.js';
import {
  events,
  interventions,
  runs,
  type Intervention,
  type Run,
  type WalEvent,
} from './walSchema.js';

/** The run row, or `null` if it does not exist yet. */
export function findRun(db: QuillDatabase, runId: string): Run | null {
  const row = db.select().from(runs).where(eq(runs.id, runId)).get();
  return row ?? null;
}

/** The `STEP_STARTED` intent record for a step, or `null` if none. */
export function findStarted(
  db: QuillDatabase,
  branchId: string,
  stepId: string,
): WalEvent | null {
  const row = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.branchId, branchId),
        eq(events.stepId, stepId),
        eq(events.type, 'STEP_STARTED'),
      ),
    )
    .get();
  return row ?? null;
}

/** The terminal record (`STEP_COMPLETED` or `STEP_FAILED`), or `null`. */
export function findTerminal(
  db: QuillDatabase,
  branchId: string,
  stepId: string,
): WalEvent | null {
  const row = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.branchId, branchId),
        eq(events.stepId, stepId),
        inArray(events.type, ['STEP_COMPLETED', 'STEP_FAILED']),
      ),
    )
    .get();
  return row ?? null;
}

/** An operator override for a step on a branch, or `null`. */
export function findIntervention(
  db: QuillDatabase,
  branchId: string,
  stepId: string,
): Intervention | null {
  const row = db
    .select()
    .from(interventions)
    .where(
      and(
        eq(interventions.branchId, branchId),
        eq(interventions.stepId, stepId),
      ),
    )
    .get();
  return row ?? null;
}

/** All events for a branch in WAL order (ascending sequence id). */
export function readBranchEvents(
  db: QuillDatabase,
  branchId: string,
): WalEvent[] {
  return db
    .select()
    .from(events)
    .where(eq(events.branchId, branchId))
    .orderBy(asc(events.id))
    .all();
}
