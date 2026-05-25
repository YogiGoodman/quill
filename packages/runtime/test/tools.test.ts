import { describe, expect, it } from 'vitest';
import { defineTool, type ToolDefinition } from '../src/tools.js';

describe('defineTool', () => {
  it('accepts a well-formed side_effect tool', () => {
    const tool = defineTool({
      name: 'charge_card',
      determinism: 'side_effect',
      execute: (args: { amountCents: number }) => ({ charged: args.amountCents }),
      idempotencyKey: (stepId, args) => `${stepId}:${args.amountCents}`,
      reconcile: () => null,
    });
    expect(tool.determinism).toBe('side_effect');
  });

  it('rejects a side_effect tool missing reconcile at runtime', () => {
    // Cast through a partial shape to simulate a non-TypeScript / dynamic caller.
    const bad = {
      name: 'charge_card',
      determinism: 'side_effect',
      execute: () => null,
      idempotencyKey: () => 'k',
    } as unknown as ToolDefinition;
    expect(() => defineTool(bad)).toThrow(/requires reconcile/);
  });

  it('rejects a side_effect tool missing idempotencyKey at runtime', () => {
    const bad = {
      name: 'charge_card',
      determinism: 'side_effect',
      execute: () => null,
      reconcile: () => null,
    } as unknown as ToolDefinition;
    expect(() => defineTool(bad)).toThrow(/requires idempotencyKey/);
  });

  it('rejects a recorded tool missing inputHash', () => {
    const bad = {
      name: 'fetch_price',
      determinism: 'recorded',
      execute: () => 1,
    } as unknown as ToolDefinition;
    expect(() => defineTool(bad)).toThrow(/requires inputHash/);
  });
});
