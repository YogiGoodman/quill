/**
 * The canonical `llm_1 -> fake_tool -> llm_2` workflow, shared by the
 * context-reducer and deterministic-replay tests so they exercise identical
 * steps. Runs in-process against the deterministic fake provider.
 */
import type { ToolUseBlock } from '../../src/fakeAnthropic.js';
import type { Workflow } from '../../src/orchestrator.js';
import { defineTool } from '../../src/tools.js';

export const happyWorkflow: Workflow = async (ctx) => {
  const fakeTool = defineTool({
    name: 'fake_tool',
    determinism: 'recorded',
    inputHash: (args: { value: number }) => String(args.value),
    execute: (args: { value: number }) => ({ doubled: args.value * 2 }),
  });

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
