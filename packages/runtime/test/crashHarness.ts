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

export interface CrashOutcome {
  /** Non-null when the process was terminated by a signal, e.g. 'SIGKILL'. */
  signal: NodeJS.Signals | null;
  /** Exit code when the process exited normally. */
  status: number | null;
  stderr: string;
}

/**
 * Spawn a fixture child in-process via `node --import tsx` (no tsx CLI fork),
 * so a self-SIGKILL propagates to the process spawnSync tracks.
 */
function spawnFixture(
  fixture: string,
  args: string[],
  env: Record<string, string>,
): CrashOutcome {
  const script = join(here, 'fixtures', fixture);
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', script, ...args],
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

export function runChildWorkflow(
  dbPath: string,
  env: Record<string, string> = {},
): CrashOutcome {
  return spawnFixture('crashChild.ts', [dbPath], env);
}

export function runChargeWorkflow(
  dbPath: string,
  remotePath: string,
  execCountPath: string,
  env: Record<string, string> = {},
): CrashOutcome {
  return spawnFixture('chargeChild.ts', [dbPath, remotePath, execCountPath], env);
}

export function runReactWorkflow(
  dbPath: string,
  toolCountPath: string,
  llmCountPath: string,
  env: Record<string, string> = {},
): CrashOutcome {
  return spawnFixture('reactChild.ts', [dbPath, toolCountPath, llmCountPath], env);
}
