/**
 * Deterministic reconstruction of the Anthropic `messages[]` array from a
 * branch's WAL deltas. See `docs/architecture.md` §5 (context hydration).
 *
 * The WAL stores deltas, not the whole conversation. This reducer replays the
 * `STEP_COMPLETED` events in order to rebuild the conversation: an LLM response
 * becomes an assistant turn; a tool result becomes a user turn carrying a
 * `tool_result` block keyed to the most recent `tool_use`.
 *
 * Pure function of its input — no wall clock, no ambient state — so it produces
 * byte-identical output on every call.
 */
import type {
  AnthropicResponse,
  Message,
  ToolUseBlock,
} from './fakeAnthropic.js';
import type { WalEvent } from './walSchema.js';

function isAnthropicResponse(value: unknown): value is AnthropicResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'stop_reason' in value &&
    'content' in value
  );
}

export function reduceMessages(events: WalEvent[]): Message[] {
  const messages: Message[] = [];
  let lastToolUseId: string | null = null;

  for (const event of events) {
    if (event.type !== 'STEP_COMPLETED' || event.payloadJson === null) {
      continue;
    }
    const payload: unknown = JSON.parse(event.payloadJson);

    if (isAnthropicResponse(payload)) {
      messages.push({ role: 'assistant', content: payload.content });
      const toolUse = payload.content.find(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      );
      lastToolUseId = toolUse ? toolUse.id : lastToolUseId;
      continue;
    }

    // A tool result delta — emit it as a user turn referencing the open tool_use.
    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: lastToolUseId ?? '',
          content: event.payloadJson,
        },
      ],
    });
  }

  return messages;
}
