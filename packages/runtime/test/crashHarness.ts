/**
 * Crash harness. Spawns the child workflow as a separate process so it can be
 * `kill -9`'d at a controlled point, then exposes the outcome for assertions
 * against the surviving WAL file.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // packages/runtime/test
const runtimeRoot = dirname(here); // packages/runtime
const childScript = join(here, 'fixtures', 'crashChild.ts');

export interface CrashOutcome {
  /** Non-null when the process was terminated by a signal, e.g. 'SIGKILL'. */
  signal: NodeJS.Signals | null;
  /** Exit code when the process exited normally. */
  status: number | null;
  stderr: string;
}

export function runChildWorkflow(
  dbPath: string,
  env: Record<string, string> = {},
): CrashOutcome {
  // `--import tsx` runs the TypeScript child in-process (no tsx CLI fork), so a
  // self-SIGKILL propagates to the process spawnSync tracks.
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', childScript, dbPath],
    {
      cwd: runtimeRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    },
  );
  return {
    signal: result.signal,
    status: result.status,
    stderr: result.stderr ?? '',
  };
}
