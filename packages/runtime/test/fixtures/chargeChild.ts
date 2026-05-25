/**
 * Child process for the moat invariant. Runs a one-step `side_effect` charge
 * workflow against a file db (argv[2]), a file-backed remote (argv[3]), and an
 * exec-count file (argv[4]).
 *
 * With QUILL_CRASH=1 the tool charges the remote then SIGKILLs itself — after
 * STEP_STARTED is committed and the remote has fired, but before STEP_COMPLETED.
 * On a clean restart the orchestrator finds the orphan and reconciles instead of
 * re-charging.
 */
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { openDatabase } from '../../src/db.js';
import { defineTool } from '../../src/tools.js';
import { runWorkflow, type Workflow } from '../../src/orchestrator.js';
import { applyRemote, bumpExecCount, lookupRemote } from './fileRemote.js';

interface Charge {
  id: string;
  amount: number;
}

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  const remotePath = process.argv[3];
  const execCountPath = process.argv[4];
  if (!dbPath || !remotePath || !execCountPath) {
    throw new Error('chargeChild: dbPath, remotePath, execCountPath required');
  }

  const conn = openDatabase(dbPath);
  migrate(conn.db, { migrationsFolder: 'drizzle' });

  const charge = defineTool({
    name: 'charge_card',
    determinism: 'side_effect',
    execute: (args: { amountCents: number }, idempotencyKey: string): Charge => {
      bumpExecCount(execCountPath);
      const result: Charge = { id: 'ch_1', amount: args.amountCents };
      applyRemote(remotePath, idempotencyKey, result);
      if (process.env.QUILL_CRASH === '1') {
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    },
    idempotencyKey: (stepId, args: { amountCents: number }): string =>
      `quill:${stepId}:${args.amountCents}`,
    reconcile: (key): Charge | null => lookupRemote(remotePath, key) as Charge | null,
  });

  const workflow: Workflow = async (ctx) => {
    await ctx.tool('charge_step', charge, { amountCents: 1000 });
  };

  await runWorkflow(conn.db, workflow, {
    runId: 'charge_run',
    workflowId: 'wf@1',
  });
  conn.sqlite.close();
}

void main();
