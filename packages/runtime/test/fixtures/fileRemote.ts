/**
 * A file-backed stand-in for a remote system, used by the moat invariant test.
 * Unlike the in-memory `MockRemote`, this persists to disk so it survives the
 * child process being `kill -9`'d — the restart can then reconcile against it.
 *
 * `applyRemote` is idempotent (first write per key wins). A separate exec-count
 * file records how many times the tool's `execute` actually ran, so the test
 * can prove the step was reconciled, not re-executed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function readStore(path: string): Record<string, unknown> {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : {};
}

export function applyRemote(path: string, key: string, payload: unknown): void {
  const store = readStore(path);
  if (!(key in store)) {
    store[key] = payload;
    writeFileSync(path, JSON.stringify(store));
  }
}

export function lookupRemote(path: string, key: string): unknown {
  const store = readStore(path);
  return key in store ? store[key] : null;
}

export function remoteSize(path: string): number {
  return Object.keys(readStore(path)).length;
}

export function bumpExecCount(path: string): void {
  const current = existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
  writeFileSync(path, String(current + 1));
}

export function execCount(path: string): number {
  return existsSync(path) ? Number(readFileSync(path, 'utf8')) : 0;
}
