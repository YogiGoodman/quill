/**
 * The Quill write-ahead log schema.
 *
 * Four tables — `runs`, `branches`, `events`, `interventions` — defined per
 * `docs/architecture.md` §2. This file defines the schema and nothing else; the
 * writer lives in `walWriter.ts` and the reader in `walReader.ts`.
 *
 * The schema lands once and evolves only via Drizzle migrations.
 */
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';

/** Lifecycle of a run. `indeterminate` is a hard halt awaiting an operator. */
export const RUN_STATUSES = [
  'running',
  'completed',
  'failed',
  'indeterminate',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * The exhaustive WAL event types. `INDETERMINATE` is intentionally absent: it is
 * a derived condition (a `STEP_STARTED` with no terminal event), not a stored
 * row. See `docs/architecture.md` §3.
 */
export const EVENT_TYPES = [
  'STEP_STARTED',
  'STEP_COMPLETED',
  'STEP_FAILED',
  'INTERVENTION',
  'INVALIDATED_BY_FORK',
] as const;

/** The tool determinism contract. See `docs/architecture.md` §7. */
export const DETERMINISM_MODES = ['recorded', 'side_effect', 'interactive'] as const;

/** Operator override kinds applied on fork. See `docs/architecture.md` §9. */
export const INTERVENTION_KINDS = [
  'override_prompt',
  'override_response',
  'skip',
] as const;

/** One row per workflow invocation. */
export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull(),
  status: text('status', { enum: RUN_STATUSES }).notNull(),
  inputJson: text('input_json').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * A run has at least one branch (the root). Forks create child branches.
 * Copy-on-write: a branch records its parent and the step it diverged from.
 */
export const branches = sqliteTable('branches', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id),
  // Self-reference; null on the root branch. The explicit return type breaks the
  // circular inference Drizzle would otherwise reject.
  parentBranchId: text('parent_branch_id').references(
    (): AnySQLiteColumn => branches.id,
  ),
  forkedFromStep: text('forked_from_step'),
  createdAt: integer('created_at').notNull(),
});

/**
 * The WAL proper. Append-only. Every step produces a `STEP_STARTED` then exactly
 * one terminal event (`STEP_COMPLETED` or `STEP_FAILED`).
 */
export const events = sqliteTable(
  'events',
  {
    // Monotonic WAL sequence — the autoincrement rowid doubles as ordering.
    id: integer('id').primaryKey({ autoIncrement: true }),
    branchId: text('branch_id')
      .notNull()
      .references(() => branches.id),
    stepId: text('step_id').notNull(),
    type: text('type', { enum: EVENT_TYPES }).notNull(),
    determinism: text('determinism', { enum: DETERMINISM_MODES }),
    semanticName: text('semantic_name').notNull(),
    loopIndex: integer('loop_index').notNull().default(0),
    payloadJson: text('payload_json'),
    idempotencyKey: text('idempotency_key'),
    costJson: text('cost_json'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    // The duplicate-write guard: a step is started once and completed once per
    // branch. A second terminal write for the same (branch, step, type) throws.
    uniqueIndex('uniq_step_terminal').on(t.branchId, t.stepId, t.type),
    // Replay reads a branch's events in WAL order.
    index('by_branch_seq').on(t.branchId, t.id),
    // Reconciliation looks up orphaned side effects by idempotency key.
    index('by_idem_key').on(t.idempotencyKey),
  ],
);

/**
 * Operator overrides applied on fork. The orchestrator consults these before
 * executing the affected step.
 */
export const interventions = sqliteTable('interventions', {
  id: text('id').primaryKey(),
  branchId: text('branch_id')
    .notNull()
    .references(() => branches.id),
  stepId: text('step_id').notNull(),
  kind: text('kind', { enum: INTERVENTION_KINDS }).notNull(),
  payloadJson: text('payload_json'),
  createdAt: integer('created_at').notNull(),
});

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
export type Branch = typeof branches.$inferSelect;
export type NewBranch = typeof branches.$inferInsert;
export type WalEvent = typeof events.$inferSelect;
export type NewWalEvent = typeof events.$inferInsert;
export type Intervention = typeof interventions.$inferSelect;
export type NewIntervention = typeof interventions.$inferInsert;
