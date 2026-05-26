import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reduceMessages } from '../src/contextReducer.js';
import type { QuillConnection } from '../src/db.js';
import { runWorkflow } from '../src/orchestrator.js';
import { readBranchEvents } from '../src/walReader.js';
import { happyWorkflow } from './fixtures/happyWorkflow.js';
import { freshTestDb } from './testDb.js';

describe('reduceMessages', () => {
  let conn: QuillConnection;
  let clock = 1_700_000_000_000;
  const nextNow = (): number => clock++;

  beforeEach(async () => {
    conn = freshTestDb();
    clock = 1_700_000_000_000;
    await runWorkflow(conn.db, happyWorkflow, {
      runId: 'r',
      workflowId: 'wf@1',
      clock: nextNow,
    });
  });

  afterEach(() => {
    conn.sqlite.close();
  });

  it('rebuilds the conversation from WAL deltas', () => {
    const messages = reduceMessages(readBranchEvents(conn.db, 'r:root'));
    expect(messages).toHaveLength(3);

    expect(messages[0]?.role).toBe('assistant');
    expect(Array.isArray(messages[0]?.content)).toBe(true);

    expect(messages[1]?.role).toBe('user');
    const toolResult = (messages[1]?.content as { type: string; tool_use_id: string }[])[0];
    expect(toolResult?.type).toBe('tool_result');
    expect(toolResult?.tool_use_id).toBe('toolu_fake_1');

    expect(messages[2]?.role).toBe('assistant');
  });

  it('is byte-stable across repeated calls', () => {
    const events = readBranchEvents(conn.db, 'r:root');
    expect(JSON.stringify(reduceMessages(events))).toBe(
      JSON.stringify(reduceMessages(events)),
    );
  });
});
