/**
 * Child process for the crash-recovery invariant. Runs
 * `llm_1 -> fake_tool -> llm_2`, counting real executions in files so the test
 * can prove replayed steps are not re-run.
 *
 * Args: dbPath (2), toolCountPath (3), llmCountPath (4).
 * With QUILL_CRASH=1 the process SIGKILLs itself between fake_tool's completion
 * and llm_2.
 */
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '../../src/db.js';
import {
  fakeAnthropic,
  type AnthropicResponse,
  type ToolUseBlock,
} from '../../src/fakeAnthropic.js';
import { runWorkflow, type Workflow } from '../../src/orchestrator.js';
import { defineTool } from '../../src/tools.js';
import { bumpExecCount } from './fileRemote.js';

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  const toolCountPath = process.argv[3];
  const llmCountPath = process.argv[4];
  if (!dbPath || !toolCountPath || !llmCountPath) {
    throw new Error('reactChild: dbPath, toolCountPath, llmCountPath required');
  }

  const conn = openDatabase(dbPath);
  migrate(conn.db, { migrationsFolder: 'drizzle' });

  const fakeTool = defineTool({
    name: 'fake_tool',
    determinism: 'recorded',
    inputHash: (args: { value: number }) => String(args.value),
    execute: (args: { value: number }) => {
      bumpExecCount(toolCountPath);
      return { doubled: args.value * 2 };
    },
  });

  const workflow: Workflow = async (ctx) => {
    const r1 = await ctx.llm('llm_1', {
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'fake_tool' }],
    });
    const toolUse = r1.content.find(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );
    if (!toolUse) throw new Error('expected a tool_use block');

    const toolResult = await ctx.tool(
      'fake_tool',
      fakeTool,
      toolUse.input as { value: number },
    );

    if (process.env.QUILL_CRASH === '1') {
      // Crash between step 2 (tool) and step 3 (llm_2).
      process.kill(process.pid, 'SIGKILL');
    }

    await ctx.llm('llm_2', {
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
  };

  await runWorkflow(conn.db, workflow, {
    runId: 'react_run',
    workflowId: 'wf@1',
    llm: (request): AnthropicResponse => {
      bumpExecCount(llmCountPath);
      return fakeAnthropic(request);
    },
  });
  conn.sqlite.close();
}

void main();
