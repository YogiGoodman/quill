/**
 * Child process for the crash harness. Runs a one-tool workflow against a
 * file-backed database whose path is argv[2]. When QUILL_CRASH=1, the tool
 * SIGKILLs its own process mid-execute — after the orchestrator has committed
 * STEP_STARTED but before STEP_COMPLETED — simulating `kill -9`.
 */
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '../../src/db.js';
import { defineTool } from '../../src/tools.js';
import { runWorkflow, type Workflow } from '../../src/orchestrator.js';

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  if (!dbPath) {
    throw new Error('crashChild: database path argument required');
  }

  const conn = openDatabase(dbPath);
  migrate(conn.db, { migrationsFolder: 'drizzle' });

  const crashy = defineTool({
    name: 'crashy',
    determinism: 'recorded',
    inputHash: () => 'h',
    execute: () => {
      if (process.env.QUILL_CRASH === '1') {
        // Uncatchable, no cleanup — STEP_STARTED is already committed, but
        // STEP_COMPLETED will never be written.
        process.kill(process.pid, 'SIGKILL');
      }
      return { ok: true };
    },
  });

  const workflow: Workflow = async (ctx) => {
    await ctx.tool('crash_step', crashy, {});
  };

  await runWorkflow(conn.db, workflow, {
    runId: 'crash_run',
    workflowId: 'wf@1',
  });
  conn.sqlite.close();
}

void main();
