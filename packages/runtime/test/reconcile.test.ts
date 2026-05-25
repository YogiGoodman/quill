import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QuillConnection } from '../src/db.js';
import { MockRemote } from '../src/mockRemote.js';
import {
  IndeterminateError,
  reconcileIndeterminateStep,
} from '../src/reconcile.js';
import { deriveStepId } from '../src/stepId.js';
import { defineTool } from '../src/tools.js';
import { findRun, findTerminal } from '../src/walReader.js';
import { createBranch, createRun, writeStepStarted } from '../src/walWriter.js';
import { freshTestDb } from './testDb.js';

describe('reconcileIndeterminateStep', () => {
  let conn: QuillConnection;
  let clock = 1_700_000_000_000;
  const nextNow = (): number => clock++;
  const stepId = deriveStepId('wf@1', '', 0, 'charge_step');

  beforeEach(() => {
    conn = freshTestDb();
    clock = 1_700_000_000_000;
    createRun(conn.db, {
      id: 'run_1',
      workflowId: 'wf@1',
      inputJson: '{}',
      now: nextNow(),
    });
    createBranch(conn.db, { id: 'run_1:root', runId: 'run_1', now: nextNow() });
  });

  afterEach(() => {
    conn.sqlite.close();
  });

  it('re-executes a recorded step and records completion', async () => {
    let executed = 0;
    const fetchPrice = defineTool({
      name: 'fetch_price',
      determinism: 'recorded',
      inputHash: () => 'h',
      execute: () => {
        executed += 1;
        return { price: 42 };
      },
    });
    const started = writeStepStarted(conn.db, {
      branchId: 'run_1:root',
      stepId: deriveStepId('wf@1', '', 0, 'price_step'),
      semanticName: 'price_step',
      determinism: 'recorded',
      now: nextNow(),
    });

    const result = await reconcileIndeterminateStep({
      db: conn.db,
      runId: 'run_1',
      branchId: 'run_1:root',
      started,
      tool: fetchPrice,
      args: {},
      now: nextNow,
    });

    expect(result).toEqual({ price: 42 });
    expect(executed).toBe(1);
    expect(findTerminal(conn.db, 'run_1:root', started.stepId)?.type).toBe(
      'STEP_COMPLETED',
    );
  });

  it('reconciles a side_effect step from the remote without re-executing', async () => {
    const remote = new MockRemote<{ id: string }>();
    const key = `quill:${stepId}:1000`;
    remote.apply(key, { id: 'ch_1' }); // the charge fired before the crash

    let executed = 0;
    const charge = defineTool({
      name: 'charge_card',
      determinism: 'side_effect',
      execute: () => {
        executed += 1;
        return { id: 'ch_NEW' };
      },
      idempotencyKey: () => key,
      reconcile: (k) => remote.lookupByKey(k),
    });

    const started = writeStepStarted(conn.db, {
      branchId: 'run_1:root',
      stepId,
      semanticName: 'charge_step',
      determinism: 'side_effect',
      idempotencyKey: key,
      now: nextNow(),
    });

    const result = await reconcileIndeterminateStep({
      db: conn.db,
      runId: 'run_1',
      branchId: 'run_1:root',
      started,
      tool: charge,
      args: { amountCents: 1000 },
      now: nextNow,
    });

    expect(result).toEqual({ id: 'ch_1' }); // reconciled value, not ch_NEW
    expect(executed).toBe(0); // never re-executed
    expect(remote.size).toBe(1); // no double-charge
    expect(findTerminal(conn.db, 'run_1:root', stepId)?.type).toBe(
      'STEP_COMPLETED',
    );
  });

  it('hard-halts when a side_effect step cannot be reconciled', async () => {
    const remote = new MockRemote<{ id: string }>(); // empty — key not found
    const key = `quill:${stepId}:1000`;
    const charge = defineTool({
      name: 'charge_card',
      determinism: 'side_effect',
      execute: () => ({ id: 'ch_NEW' }),
      idempotencyKey: () => key,
      reconcile: (k) => remote.lookupByKey(k),
    });
    const started = writeStepStarted(conn.db, {
      branchId: 'run_1:root',
      stepId,
      semanticName: 'charge_step',
      determinism: 'side_effect',
      idempotencyKey: key,
      now: nextNow(),
    });

    await expect(
      reconcileIndeterminateStep({
        db: conn.db,
        runId: 'run_1',
        branchId: 'run_1:root',
        started,
        tool: charge,
        args: { amountCents: 1000 },
        now: nextNow,
      }),
    ).rejects.toBeInstanceOf(IndeterminateError);

    expect(findTerminal(conn.db, 'run_1:root', stepId)?.type).toBe('STEP_FAILED');
    expect(findRun(conn.db, 'run_1')?.status).toBe('indeterminate');
  });
});
