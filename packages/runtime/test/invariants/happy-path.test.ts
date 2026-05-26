/**
 * Invariant 1 — happy path. The workflow `fake_llm -> fake_tool -> fake_llm`
 * runs to completion and the WAL holds all three STEP_STARTED/STEP_COMPLETED
 * pairs in order.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QuillConnection } from '../../src/db.js';
import type { ToolUseBlock } from '../../src/fakeAnthropic.js';
import { runWorkflow, type Workflow } from '../../src/orchestrator.js';
import { defineTool } from '../../src/tools.js';
import { readBranchEvents } from '../../src/walReader.js';
import { freshTestDb } from '../testDb.js';

describe('invariant 1: happy path', () => {
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

  it('runs a 3-step workflow to completion and logs every pair', async () => {
    const fakeTool = defineTool({
      name: 'fake_tool',
      determinism: 'recorded',
      inputHash: (args: { value: number }) => String(args.value),
      execute: (args: { value: number }) => ({ doubled: args.value * 2 }),
    });

    const workflow: Workflow = async (ctx) => {
      const r1 = await ctx.llm('llm_1', {
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'fake_tool' }],
      });
      expect(r1.stop_reason).toBe('tool_use');
      const toolUse = r1.content.find(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      );
      if (!toolUse) throw new Error('expected a tool_use block');

      const toolResult = await ctx.tool(
        'fake_tool',
        fakeTool,
        toolUse.input as { value: number },
      );
      expect(toolResult).toEqual({ doubled: 42 });

      const r2 = await ctx.llm('llm_2', {
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: r1.content },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify(toolResult),
              },
            ],
          },
        ],
      });
      expect(r2.stop_reason).toBe('end_turn');
    };

    await runWorkflow(conn.db, workflow, {
      runId: 'happy_run',
      workflowId: 'wf@1',
      clock: nextNow,
    });

    const events = readBranchEvents(conn.db, 'happy_run:root');
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
