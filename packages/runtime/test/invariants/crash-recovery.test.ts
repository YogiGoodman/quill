/**
 * Invariant 2 — crash recovery between steps. The process is killed between the
 * tool execution and the second LLM call. On restart, steps 1 and 2 are
 * replayed from the WAL (not re-executed) and step 3 runs against the
 * reconstructed state.
 *
 * Proof of non-re-execution: per-step exec counters in files. After the crash
 * and restart, the tool counter stays 1 and the llm counter reaches 2 (llm_1
 * once, llm_2 once) — never 3, which would mean llm_1 re-ran.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type QuillConnection } from '../../src/db.js';
import { deriveStepId } from '../../src/stepId.js';
import { findTerminal, readBranchEvents } from '../../src/walReader.js';
import { execCount } from '../fixtures/fileRemote.js';
import { runReactWorkflow } from '../crashHarness.js';

describe('invariant 2: crash recovery between steps', () => {
  let dir: string;
  let conn: QuillConnection | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quill-recover-'));
  });

  afterEach(() => {
    conn?.sqlite.close();
    conn = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it('resumes at step 3 without re-running steps 1 and 2', () => {
    const dbPath = join(dir, 'quill.db');
    const toolCount = join(dir, 'tool.count');
    const llmCount = join(dir, 'llm.count');

    // 1. Crash between the tool and llm_2.
    const crash = runReactWorkflow(dbPath, toolCount, llmCount, {
      QUILL_CRASH: '1',
    });
    expect(crash.signal, crash.stderr).toBe('SIGKILL');
    expect(execCount(toolCount)).toBe(1); // tool ran once
    expect(execCount(llmCount)).toBe(1); // only llm_1 ran

    conn = openDatabase(dbPath);
    const llm2StepId = deriveStepId('wf@1', '', 0, 'llm_2');
    expect(findTerminal(conn.db, 'react_run:root', llm2StepId)).toBeNull();
    conn.sqlite.close();
    conn = null;

    // 2. Restart: replay steps 1 and 2, execute step 3.
    const resume = runReactWorkflow(dbPath, toolCount, llmCount, {});
    expect(resume.status, resume.stderr).toBe(0);
    expect(execCount(toolCount)).toBe(1); // step 2 NOT re-executed
    expect(execCount(llmCount)).toBe(2); // llm_1 replayed, only llm_2 ran

    conn = openDatabase(dbPath);
    const events = readBranchEvents(conn.db, 'react_run:root');
    expect(events.map((e) => `${e.semanticName}:${e.type}`)).toEqual([
      'llm_1:STEP_STARTED',
      'llm_1:STEP_COMPLETED',
      'fake_tool:STEP_STARTED',
      'fake_tool:STEP_COMPLETED',
      'llm_2:STEP_STARTED',
      'llm_2:STEP_COMPLETED',
    ]);
  });
});
