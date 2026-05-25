import { describe, expect, it } from 'vitest';
import { MockRemote } from '../src/mockRemote.js';

describe('MockRemote', () => {
  it('stores one record per key and is idempotent on re-apply', () => {
    const remote = new MockRemote<{ id: string }>();
    const first = remote.apply('quill:charge:cus_42:1000', { id: 'ch_1' });
    const second = remote.apply('quill:charge:cus_42:1000', { id: 'ch_2' });
    expect(first).toEqual({ id: 'ch_1' });
    expect(second).toEqual({ id: 'ch_1' }); // first write wins
    expect(remote.size).toBe(1);
  });

  it('returns null for an unknown key', () => {
    const remote = new MockRemote();
    expect(remote.lookupByKey('nope')).toBeNull();
  });

  it('looks up an applied record by key', () => {
    const remote = new MockRemote<number>();
    remote.apply('k', 7);
    expect(remote.lookupByKey('k')).toBe(7);
  });
});
