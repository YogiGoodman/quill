/**
 * The orchestrator. For Week 1 step 5.2 this drives **tool steps only**; LLM
 * dispatch and ReAct flattening arrive in step 7. See `docs/architecture.md` §5.
 *
 * The core invariant: never execute a step whose `STEP_COMPLETED` is already in
 * the WAL. Before each tool call the orchestrator computes the step id, consults
 * the WAL, and either replays the recorded result or writes `STEP_STARTED`,
 * executes, and writes `STEP_COMPLETED`.
 *
 * `clock` is injected so steps never read the wall clock directly; tests pass a
 * deterministic clock, production passes `Date.now`.
 */
import type { QuillDatabase } from './db.js';
import { deriveStepId } from './stepId.js';
import type { ToolDefinition } from './tools.js';
import { findRun, findTerminal } from './walReader.js';
import {
  createBranch,
  createRun,
  writeStepCompleted,
  writeStepStarted,
} from './walWriter.js';

export interface WorkflowContext {
  /** Invoke a tool as a durable step. Replays from the WAL if already done. */
  tool<TArgs, TResult>(
    semanticName: string,
    tool: ToolDefinition<TArgs, TResult>,
    args: TArgs,
  ): Promise<TResult>;
}

export type Workflow = (ctx: WorkflowContext) => Promise<void>;

export interface RunWorkflowOptions {
  runId: string;
  workflowId: string;
  /** Defaults to `${runId}:root`. */
  branchId?: string;
  input?: unknown;
  /** Monotonic millisecond clock. Defaults to `Date.now`. */
  clock?: () => number;
}

export async function runWorkflow(
  db: QuillDatabase,
  workflow: Workflow,
  options: RunWorkflowOptions,
): Promise<void> {
  const clock = options.clock ?? ((): number => Date.now());
  const branchId = options.branchId ?? `${options.runId}:root`;

  if (!findRun(db, options.runId)) {
    createRun(db, {
      id: options.runId,
      workflowId: options.workflowId,
      inputJson: JSON.stringify(options.input ?? null),
      now: clock(),
    });
    createBranch(db, { id: branchId, runId: options.runId, now: clock() });
  }

  const ctx: WorkflowContext = {
    async tool(semanticName, tool, args) {
      // Flat sequential model for 5.2: no parent step, single loop index.
      // Loop indexing for ReAct lands in step 10.
      const stepId = deriveStepId(options.workflowId, '', 0, semanticName);

      const terminal = findTerminal(db, branchId, stepId);
      if (terminal) {
        if (terminal.type === 'STEP_FAILED') {
          throw new Error(`step "${semanticName}" previously failed`);
        }
        // Replay the recorded result without executing.
        return JSON.parse(terminal.payloadJson ?? 'null');
      }

      const idempotencyKey =
        tool.determinism === 'side_effect'
          ? tool.idempotencyKey(stepId, args)
          : undefined;

      writeStepStarted(db, {
        branchId,
        stepId,
        semanticName,
        determinism: tool.determinism,
        idempotencyKey,
        now: clock(),
      });

      const result = await tool.execute(args);

      writeStepCompleted(db, {
        branchId,
        stepId,
        semanticName,
        determinism: tool.determinism,
        payloadJson: JSON.stringify(result ?? null),
        now: clock(),
      });

      return result;
    },
  };

  await workflow(ctx);
}
