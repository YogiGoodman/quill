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
import { reduceMessages } from './contextReducer.js';
import type { QuillDatabase } from './db.js';
import {
  fakeAnthropic,
  type AnthropicRequest,
  type AnthropicResponse,
  type Message,
} from './fakeAnthropic.js';
import { reconcileIndeterminateStep } from './reconcile.js';
import { deriveStepId } from './stepId.js';
import type { ToolDefinition } from './tools.js';
import {
  findRun,
  findStarted,
  findTerminal,
  readBranchEvents,
} from './walReader.js';
import {
  createBranch,
  createRun,
  writeStepCompleted,
  writeStepStarted,
} from './walWriter.js';

/** The LLM call function. Defaults to the deterministic fake provider. */
export type LlmFn = (
  request: AnthropicRequest,
) => Promise<AnthropicResponse> | AnthropicResponse;

export interface WorkflowContext {
  /** Invoke a tool as a durable step. Replays from the WAL if already done. */
  tool<TArgs, TResult>(
    semanticName: string,
    tool: ToolDefinition<TArgs, TResult>,
    args: TArgs,
  ): Promise<TResult>;

  /**
   * Make an LLM call as a durable, recorded step. The response is cached to the
   * WAL and replayed on resume; the call is not repeated. ReAct loops are
   * flattened by issuing each `ctx.llm` / `ctx.tool` as its own step.
   */
  llm(
    semanticName: string,
    request: AnthropicRequest,
  ): Promise<AnthropicResponse>;
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
  /** LLM call function. Defaults to the deterministic fake provider. */
  llm?: LlmFn;
}

export async function runWorkflow(
  db: QuillDatabase,
  workflow: Workflow,
  options: RunWorkflowOptions,
): Promise<void> {
  const clock = options.clock ?? ((): number => Date.now());
  const llmFn = options.llm ?? fakeAnthropic;
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

      // An orphaned STEP_STARTED means the process crashed mid-step last time:
      // the step is INDETERMINATE. Recover via reconcile rather than blindly
      // re-running (which could double-fire a side effect).
      const orphan = findStarted(db, branchId, stepId);
      if (orphan) {
        return reconcileIndeterminateStep({
          db,
          runId: options.runId,
          branchId,
          started: orphan,
          tool,
          args,
          now: clock,
        });
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

      // side_effect tools receive the persisted idempotency key so their
      // outbound call and a later reconcile() agree on it.
      const result =
        tool.determinism === 'side_effect'
          ? await tool.execute(args, tool.idempotencyKey(stepId, args))
          : await tool.execute(args);

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

    async llm(semanticName, request) {
      const stepId = deriveStepId(options.workflowId, '', 0, semanticName);

      const terminal = findTerminal(db, branchId, stepId);
      if (terminal) {
        if (terminal.type === 'STEP_FAILED') {
          throw new Error(`llm step "${semanticName}" previously failed`);
        }
        return JSON.parse(terminal.payloadJson ?? 'null');
      }

      // LLM steps are recorded (deterministic). A new step writes STEP_STARTED;
      // an orphan from a crash skips the (unique) STARTED write and simply
      // re-executes — safe because the call is deterministic.
      if (!findStarted(db, branchId, stepId)) {
        writeStepStarted(db, {
          branchId,
          stepId,
          semanticName,
          determinism: 'recorded',
          now: clock(),
        });
      }

      const response = await llmFn(request);

      writeStepCompleted(db, {
        branchId,
        stepId,
        semanticName,
        determinism: 'recorded',
        payloadJson: JSON.stringify(response),
        costJson: JSON.stringify(response.usage),
        now: clock(),
      });

      return response;
    },
  };

  await workflow(ctx);
}

/**
 * Replay a completed run. Re-runs the workflow against the existing WAL — every
 * step is already `STEP_COMPLETED`, so nothing executes — and returns the
 * conversation reconstructed by the context reducer. Deterministic: identical
 * bytes to the original run.
 */
export async function replayRun(
  db: QuillDatabase,
  workflow: Workflow,
  options: RunWorkflowOptions,
): Promise<Message[]> {
  await runWorkflow(db, workflow, options);
  const branchId = options.branchId ?? `${options.runId}:root`;
  return reduceMessages(readBranchEvents(db, branchId));
}
