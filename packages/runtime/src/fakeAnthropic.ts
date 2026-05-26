/**
 * A shape-correct, deterministic stand-in for the Anthropic Messages API. Not
 * intelligent — a fixed state machine so tests run offline and replay produces
 * identical bytes. The real `@anthropic-ai/sdk`, env-gated, arrives in Week 2.
 *
 * State machine: if the conversation contains no `tool_result` yet, return a
 * `tool_use` turn (ask to call `fake_tool`); once a `tool_result` is present,
 * return a final `end_turn` text turn.
 */

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface AnthropicRequest {
  system?: string;
  messages: Message[];
  tools?: { name: string }[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export type StopReason = 'end_turn' | 'tool_use';

export interface AnthropicResponse {
  id: string;
  role: 'assistant';
  content: ContentBlock[];
  stop_reason: StopReason;
  usage: Usage;
}

function hasToolResult(messages: Message[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((b) => b.type === 'tool_result'),
  );
}

export function fakeAnthropic(request: AnthropicRequest): AnthropicResponse {
  if (!hasToolResult(request.messages)) {
    return {
      id: 'msg_fake_tooluse',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_fake_1',
          name: 'fake_tool',
          input: { value: 21 },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }
  return {
    id: 'msg_fake_text',
    role: 'assistant',
    content: [{ type: 'text', text: 'done: 42' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 20, output_tokens: 8 },
  };
}
