/**
 * Invariant 4 — NondeterminismError on a mutated prompt. The first run records
 * an input fingerprint for step 1. A replay with the system prompt changed in
 * code produces a different fingerprint, so the runtime throws instead of
 * returning the stale cached response.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QuillConnection } from '../../src/db.js';
import { NondeterminismError } from '../../src/nondeterminism.js';
import { runWorkflow, type Workflow } from '../../src/orchestrator.js';
import { freshTestDb } from '../testDb.js';

describe('invariant 4: nondeterminism detection', () => {
  let conn: QuillConnection;
  let clock = 1_700_000_000_000;
  const nextNow = (): number => clock++;

  const workflowWithPrompt =
    (system: string): Workflow =>
    async (ctx) => {
      await ctx.llm('llm_1', {
        system,
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'fake_tool' }],
      });
    };

  beforeEach(() => {
    conn = freshTestDb();
    clock = 1_700_000_000_000;
  });

  afterEach(() => {
    conn.sqlite.close();
  });

  it('throws NondeterminismError when the system prompt changes on replay', async () => {
    const opts = { runId: 'r', workflowId: 'wf@1', clock: nextNow };

    await runWorkflow(conn.db, workflowWithPrompt('system prompt A'), opts);

    await expect(
      runWorkflow(conn.db, workflowWithPrompt('system prompt B'), opts),
    ).rejects.toBeInstanceOf(NondeterminismError);
  });

  it('replays cleanly when the prompt is unchanged', async () => {
    const opts = { runId: 'r', workflowId: 'wf@1', clock: nextNow };
    await runWorkflow(conn.db, workflowWithPrompt('system prompt A'), opts);
    await expect(
      runWorkflow(conn.db, workflowWithPrompt('system prompt A'), opts),
    ).resolves.toBeUndefined();
  });

  it('includes both fingerprints in the error message', async () => {
    const opts = { runId: 'r', workflowId: 'wf@1', clock: nextNow };
    await runWorkflow(conn.db, workflowWithPrompt('system prompt A'), opts);
    try {
      await runWorkflow(conn.db, workflowWithPrompt('system prompt B'), opts);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NondeterminismError);
      const e = err as NondeterminismError;
      expect(e.message).toContain(e.expected);
      expect(e.message).toContain(e.actual);
      expect(e.expected).not.toBe(e.actual);
    }
  });
});
