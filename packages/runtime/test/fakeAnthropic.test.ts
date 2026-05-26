import { describe, expect, it } from 'vitest';
import { fakeAnthropic, type AnthropicRequest } from '../src/fakeAnthropic.js';

describe('fakeAnthropic', () => {
  const initial: AnthropicRequest = {
    messages: [{ role: 'user', content: 'go' }],
    tools: [{ name: 'fake_tool' }],
  };

  it('returns a tool_use turn when no tool_result is present', () => {
    const res = fakeAnthropic(initial);
    expect(res.stop_reason).toBe('tool_use');
    expect(res.content[0]?.type).toBe('tool_use');
  });

  it('returns an end_turn text turn once a tool_result is present', () => {
    const res = fakeAnthropic({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_fake_1', content: '{}' },
          ],
        },
      ],
    });
    expect(res.stop_reason).toBe('end_turn');
    expect(res.content[0]?.type).toBe('text');
  });

  it('is byte-stable across calls', () => {
    expect(JSON.stringify(fakeAnthropic(initial))).toBe(
      JSON.stringify(fakeAnthropic(initial)),
    );
  });
});
