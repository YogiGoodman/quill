import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QuillConnection } from '../src/db.js';
import {
  createBranch,
  createRun,
  writeStepCompleted,
  writeStepStarted,
} from '../src/walWriter.js';
import {
  findStarted,
  findTerminal,
  readBranchEvents,
} from '../src/walReader.js';
import { freshTestDb } from './testDb.js';

describe('WAL writer and reader', () => {
  let conn: QuillConnection;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    conn = freshTestDb();
    createRun(conn.db, {
      id: 'run_1',
      workflowId: 'wf@1',
      inputJson: '{}',
      now: NOW,
    });
    createBranch(conn.db, { id: 'branch_1', runId: 'run_1', now: NOW });
  });

  afterEach(() => {
    conn.sqlite.close();
  });

  it('writes and reads a STARTED/COMPLETED pair', () => {
    writeStepStarted(conn.db, {
      branchId: 'branch_1',
      stepId: 'step_a',
      semanticName: 'fake_tool',
      now: NOW,
    });
    writeStepCompleted(conn.db, {
      branchId: 'branch_1',
      stepId: 'step_a',
      semanticName: 'fake_tool',
      payloadJson: '{"ok":true}',
      now: NOW + 1,
    });

    const started = findStarted(conn.db, 'branch_1', 'step_a');
    const terminal = findTerminal(conn.db, 'branch_1', 'step_a');
    expect(started?.type).toBe('STEP_STARTED');
    expect(terminal?.type).toBe('STEP_COMPLETED');
    expect(terminal?.payloadJson).toBe('{"ok":true}');

    const all = readBranchEvents(conn.db, 'branch_1');
    expect(all.map((e) => e.type)).toEqual(['STEP_STARTED', 'STEP_COMPLETED']);
  });

  it('throws on a duplicate terminal write (uniq_step_terminal guard)', () => {
    writeStepStarted(conn.db, {
      branchId: 'branch_1',
      stepId: 'step_a',
      semanticName: 'fake_tool',
      now: NOW,
    });
    writeStepCompleted(conn.db, {
      branchId: 'branch_1',
      stepId: 'step_a',
      semanticName: 'fake_tool',
      now: NOW + 1,
    });
    expect(() =>
      writeStepCompleted(conn.db, {
        branchId: 'branch_1',
        stepId: 'step_a',
        semanticName: 'fake_tool',
        now: NOW + 2,
      }),
    ).toThrow(/UNIQUE|constraint/i);
  });

  it('returns null when a step has no started or terminal record', () => {
    expect(findStarted(conn.db, 'branch_1', 'missing')).toBeNull();
    expect(findTerminal(conn.db, 'branch_1', 'missing')).toBeNull();
  });
});
