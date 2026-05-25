/**
 * Invariant 6 — side-effect non-replay (the moat). NON-NEGOTIABLE in Week 1.
 *
 * A `side_effect` charge tool fires against a file-backed remote, then the
 * process is killed after STEP_STARTED but before STEP_COMPLETED. On restart the
 * runtime calls reconcile(), finds the remote record, logs STEP_COMPLETED with
 * the reconciled value, and does NOT re-charge.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type QuillConnection } from '../../src/db.js';
import { deriveStepId } from '../../src/stepId.js';
import { findStarted, findTerminal } from '../../src/walReader.js';
import { execCount, remoteSize } from '../fixtures/fileRemote.js';
import { runChargeWorkflow } from '../crashHarness.js';

describe('invariant 6: side-effect non-replay', () => {
  let dir: string;
  let conn: QuillConnection | null = null;
  const stepId = deriveStepId('wf@1', '', 0, 'charge_step');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quill-moat-'));
  });

  afterEach(() => {
    conn?.sqlite.close();
    conn = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reconciles after a crash without double-firing the charge', () => {
    const dbPath = join(dir, 'quill.db');
    const remotePath = join(dir, 'remote.json');
    const execPath = join(dir, 'exec.count');

    // 1. Run and crash mid-step: the charge fires, then kill -9.
    const crash = runChargeWorkflow(dbPath, remotePath, execPath, {
      QUILL_CRASH: '1',
    });
    expect(crash.signal, crash.stderr).toBe('SIGKILL');
    expect(remoteSize(remotePath)).toBe(1); // charge fired exactly once
    expect(execCount(execPath)).toBe(1);

    // The WAL holds an orphan STEP_STARTED with no terminal.
    conn = openDatabase(dbPath);
    expect(findStarted(conn.db, 'charge_run:root', stepId)).not.toBeNull();
    expect(findTerminal(conn.db, 'charge_run:root', stepId)).toBeNull();
    conn.sqlite.close();
    conn = null;

    // 2. Restart cleanly: the orchestrator reconciles instead of re-charging.
    const resume = runChargeWorkflow(dbPath, remotePath, execPath, {});
    expect(resume.status, resume.stderr).toBe(0);
    expect(execCount(execPath)).toBe(1); // NOT re-executed on restart
    expect(remoteSize(remotePath)).toBe(1); // no double-charge

    conn = openDatabase(dbPath);
    const terminal = findTerminal(conn.db, 'charge_run:root', stepId);
    expect(terminal?.type).toBe('STEP_COMPLETED');
    expect(terminal?.payloadJson).toBe(
      JSON.stringify({ id: 'ch_1', amount: 1000 }),
    );
  });
});
