import { describe, expect, it } from 'vitest';
import { deriveStepId } from '../src/stepId.js';

describe('deriveStepId', () => {
  it('is deterministic and returns a 64-char hex digest', () => {
    const a = deriveStepId('trading_research@1', '', 0, 'react_llm');
    const b = deriveStepId('trading_research@1', '', 0, 'react_llm');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces six distinct ids across a 3-iteration ReAct loop', () => {
    // Architecture §4 worked example: react_llm and react_tool over loops 0..2,
    // all children of the same parent S0, distinguished only by loop_index.
    const wf = 'trading_research@1';
    const parent = 'S0';
    const ids = new Set<string>();
    for (let loopIndex = 0; loopIndex < 3; loopIndex++) {
      ids.add(deriveStepId(wf, parent, loopIndex, 'react_llm'));
      ids.add(deriveStepId(wf, parent, loopIndex, 'react_tool'));
    }
    expect(ids.size).toBe(6);
  });

  it('separates fields unambiguously via the unit separator', () => {
    // Without a separator, ('a','bc') and ('ab','c') would concatenate alike.
    expect(deriveStepId('a', 'bc', 0, 'x')).not.toBe(
      deriveStepId('ab', 'c', 0, 'x'),
    );
  });
});
