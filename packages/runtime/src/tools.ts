/**
 * The tool determinism contract. See `docs/architecture.md` §7.
 *
 * A tool declares exactly one of three modes via a discriminated union on
 * `determinism`. The union forces the compiler to require the right fields per
 * mode — a `side_effect` tool that omits `idempotencyKey` or `reconcile` does
 * not type-check. `defineTool` re-checks at runtime so non-TypeScript callers
 * and dynamic construction fail loudly too.
 */
import type { DETERMINISM_MODES } from './walSchema.js';

export type DeterminismMode = (typeof DETERMINISM_MODES)[number];

interface BaseTool<TArgs, TResult> {
  /** Stable, human-readable tool name, e.g. `charge_card`. */
  name: string;
  execute(args: TArgs): Promise<TResult> | TResult;
}

/** Pure / read-only. Cached and replayed from the WAL. */
export interface RecordedTool<TArgs, TResult> extends BaseTool<TArgs, TResult> {
  determinism: 'recorded';
  /** Hash of the inputs; compared on replay to detect non-determinism. */
  inputHash(args: TArgs): string;
}

/** Mutates the world. Never re-executed; reconciled by idempotency key. */
export interface SideEffectTool<TArgs, TResult>
  extends BaseTool<TArgs, TResult> {
  determinism: 'side_effect';
  idempotencyKey(stepId: string, args: TArgs): string;
  reconcile(key: string): Promise<TResult | null> | TResult | null;
}

/** Human-in-the-loop. Pauses replay; tombstoned past a fork point. */
export interface InteractiveTool<TArgs, TResult>
  extends BaseTool<TArgs, TResult> {
  determinism: 'interactive';
  /** Describes the consent being requested from the operator. */
  prompt(args: TArgs): string;
}

export type ToolDefinition<TArgs = unknown, TResult = unknown> =
  | RecordedTool<TArgs, TResult>
  | SideEffectTool<TArgs, TResult>
  | InteractiveTool<TArgs, TResult>;

/**
 * Validate and return a tool definition. Throws if a mode's required fields are
 * missing — the runtime enforcement point named in architecture §7.
 */
export function defineTool<TArgs, TResult>(
  tool: ToolDefinition<TArgs, TResult>,
): ToolDefinition<TArgs, TResult> {
  if (!tool.name) {
    throw new Error('tool requires a non-empty name');
  }
  switch (tool.determinism) {
    case 'recorded':
      if (typeof tool.inputHash !== 'function') {
        throw new Error(`recorded tool "${tool.name}" requires inputHash`);
      }
      break;
    case 'side_effect':
      if (typeof tool.idempotencyKey !== 'function') {
        throw new Error(
          `side_effect tool "${tool.name}" requires idempotencyKey`,
        );
      }
      if (typeof tool.reconcile !== 'function') {
        throw new Error(`side_effect tool "${tool.name}" requires reconcile`);
      }
      break;
    case 'interactive':
      if (typeof tool.prompt !== 'function') {
        throw new Error(`interactive tool "${tool.name}" requires prompt`);
      }
      break;
    default: {
      // Exhaustiveness: a new mode must be handled above.
      const exhaustive: never = tool;
      throw new Error(
        `unknown determinism mode: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
  return tool;
}
