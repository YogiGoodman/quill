import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type QuillConnection } from '../src/db.js';
import { deriveStepId } from '../src/stepId.js';
import { findStarted, findTerminal } from '../src/walReader.js';
import { runChildWorkflow } from './crashHarness.js';

describe('crash harness', () => {
  let dir: string;
  let conn: QuillConnection | null = null;
  const stepId = deriveStepId('wf@1', '', 0, 'crash_step');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quill-crash-'));
  });

  afterEach(() => {
    conn?.sqlite.close();
    conn = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('kill -9 mid-step leaves an orphan STEP_STARTED and no terminal', () => {
    const dbPath = join(dir, 'quill.db');
    const outcome = runChildWorkflow(dbPath, { QUILL_CRASH: '1' });
    expect(outcome.signal, outcome.stderr).toBe('SIGKILL');

    conn = openDatabase(dbPath);
    expect(findStarted(conn.db, 'crash_run:root', stepId)).not.toBeNull();
    expect(findTerminal(conn.db, 'crash_run:root', stepId)).toBeNull();
  });

  it('runs to completion when the crash flag is unset', () => {
    const dbPath = join(dir, 'quill.db');
    const outcome = runChildWorkflow(dbPath, {});
    expect(outcome.status, outcome.stderr).toBe(0);
    expect(outcome.signal).toBeNull();

    conn = openDatabase(dbPath);
    expect(findTerminal(conn.db, 'crash_run:root', stepId)?.type).toBe(
      'STEP_COMPLETED',
    );
  });
});
