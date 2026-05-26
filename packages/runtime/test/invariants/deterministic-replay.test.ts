/**
 * Invariant 3 — deterministic replay. Replaying a completed run produces output
 * bytes identical to the original, and executes nothing (no new WAL events).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QuillConnection } from '../../src/db.js';
import { reduceMessages } from '../../src/contextReducer.js';
import { replayRun, runWorkflow } from '../../src/orchestrator.js';
import { readBranchEvents } from '../../src/walReader.js';
import { happyWorkflow } from '../fixtures/happyWorkflow.js';
import { freshTestDb } from '../testDb.js';

describe('invariant 3: deterministic replay', () => {
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

  it('replays to identical bytes and writes no new events', async () => {
    const opts = { runId: 'r', workflowId: 'wf@1', clock: nextNow };

    await runWorkflow(conn.db, happyWorkflow, opts);
    const originalEvents = readBranchEvents(conn.db, 'r:root');
    const originalBytes = JSON.stringify(reduceMessages(originalEvents));

    const replayed = await replayRun(conn.db, happyWorkflow, opts);
    const afterEvents = readBranchEvents(conn.db, 'r:root');

    expect(afterEvents).toHaveLength(originalEvents.length); // nothing executed
    expect(JSON.stringify(replayed)).toBe(originalBytes); // identical bytes
  });
});
