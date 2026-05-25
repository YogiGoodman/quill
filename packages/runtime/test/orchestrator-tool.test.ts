import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QuillConnection } from '../src/db.js';
import { defineTool } from '../src/tools.js';
import { runWorkflow, type Workflow } from '../src/orchestrator.js';
import { readBranchEvents } from '../src/walReader.js';
import { freshTestDb } from './testDb.js';

describe('orchestrator — tool steps', () => {
  let conn: QuillConnection;
  let clock = 1_700_000_000_000;
  const nextNow = (): number => clock++;

  beforeEach(() => {
    conn = freshTestDb();
    clock = 1_700_000_000_000;
  });

  afterEach(() => {
    conn.sqlite.close();
  });

  it('runs a one-tool workflow to completion and logs a STARTED/COMPLETED pair', async () => {
    let executed = 0;
    const echo = defineTool({
      name: 'echo',
      determinism: 'recorded',
      inputHash: (args: { v: number }) => String(args.v),
      execute: (args: { v: number }) => {
        executed += 1;
        return { doubled: args.v * 2 };
      },
    });

    const workflow: Workflow = async (ctx) => {
      const result = await ctx.tool('echo_step', echo, { v: 21 });
      expect(result).toEqual({ doubled: 42 });
    };

    await runWorkflow(conn.db, workflow, {
      runId: 'run_1',
      workflowId: 'wf@1',
      clock: nextNow,
    });

    expect(executed).toBe(1);
    const events = readBranchEvents(conn.db, 'run_1:root');
    expect(events.map((e) => e.type)).toEqual([
      'STEP_STARTED',
      'STEP_COMPLETED',
    ]);
    expect(events[1]?.payloadJson).toBe('{"doubled":42}');
  });

  it('skips execution on re-run, replaying the recorded result', async () => {
    let executed = 0;
    const echo = defineTool({
      name: 'echo',
      determinism: 'recorded',
      inputHash: (args: { v: number }) => String(args.v),
      execute: (args: { v: number }) => {
        executed += 1;
        return { doubled: args.v * 2 };
      },
    });

    const workflow: Workflow = async (ctx) => {
      const result = await ctx.tool('echo_step', echo, { v: 21 });
      expect(result).toEqual({ doubled: 42 });
    };

    const opts = { runId: 'run_1', workflowId: 'wf@1', clock: nextNow };
    await runWorkflow(conn.db, workflow, opts);
    await runWorkflow(conn.db, workflow, opts); // resume

    expect(executed).toBe(1); // not re-executed
    const events = readBranchEvents(conn.db, 'run_1:root');
    expect(events).toHaveLength(2); // still one pair, no duplicates
  });

  it('records the idempotency key for a side_effect tool in STEP_STARTED', async () => {
    const charge = defineTool({
      name: 'charge_card',
      determinism: 'side_effect',
      execute: (args: { amountCents: number }) => ({ id: 'ch_1', amount: args.amountCents }),
      idempotencyKey: (stepId, args: { amountCents: number }) =>
        `quill:${stepId}:${args.amountCents}`,
      reconcile: () => null,
    });

    const workflow: Workflow = async (ctx) => {
      await ctx.tool('charge_step', charge, { amountCents: 1000 });
    };

    await runWorkflow(conn.db, workflow, {
      runId: 'run_2',
      workflowId: 'wf@1',
      clock: nextNow,
    });

    const events = readBranchEvents(conn.db, 'run_2:root');
    const started = events.find((e) => e.type === 'STEP_STARTED');
    expect(started?.determinism).toBe('side_effect');
    expect(started?.idempotencyKey).toMatch(/^quill:[0-9a-f]{64}:1000$/);
  });
});
