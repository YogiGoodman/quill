# Quill — Architecture

Quill is a durable execution runtime for LLM agents. You define a workflow in
ordinary TypeScript; Quill logs every step to a local SQLite write-ahead log
(WAL) **before** executing it, so that a process killed at any point can restart,
skip what already completed, reconcile side effects that may have fired against
remote systems, and continue — without double-charging, double-trading, or
silent state drift.

This document stands alone. It assumes a senior engineer who has not read the
goals document. It does not assume the runtime is built — it describes the design
the implementation must satisfy.

---

## 1. System overview

A workflow is a TypeScript function that receives a context object `ctx`. It
calls `ctx.llm(...)` to talk to Claude and `ctx.tool(...)` to invoke tools. The
**orchestrator** drives the workflow forward in a `while` loop. Before executing
any step it consults the WAL; if the step already completed, it replays the
recorded result instead of executing. Every execution writes an intent record
(`STEP_STARTED`) before acting and a completion record (`STEP_COMPLETED`) after,
both inside `BEGIN IMMEDIATE` transactions. Side-effecting tools carry an
idempotency key and a reconciliation function so the runtime can ask the remote
system "did this already happen?" instead of guessing.

```
  ┌──────────────┐      ┌──────────────────────────────┐     ┌──────────────┐
  │ USER         │      │ ORCHESTRATOR                  │     │ CONTEXT      │
  │ WORKFLOW     │─────▶│ while(not done):              │◀───▶│ REDUCER      │
  │ async (ctx)  │      │  1. compute step_id           │     │ rebuilds     │
  │  ctx.llm()   │      │  2. WAL: already COMPLETED?    │     │ messages[]   │
  │  ctx.tool()  │      │  3. if no → STARTED, run, DONE │     │ from deltas  │
  └──────────────┘      └───────────────┬───────────────┘     └──────────────┘
                                        │ every write
                                        ▼
                  ┌───────────────────────────────────────────┐
                  │ WRITE-AHEAD LOG — SQLite, WAL mode,         │
                  │ BEGIN IMMEDIATE, intent-then-commit         │
                  └───────────────┬─────────────────────────────┘
                                  │ side_effect calls carry idempotency keys
                                  ▼
                  ┌───────────────────────────────────────────┐
                  │ REMOTE SYSTEMS — Stripe, trading API,       │
                  │ email, MCP servers. Reconciled by key,      │
                  │ never blindly re-fired.                     │
                  └─────────────────────────────────────────────┘
```

---

## 2. The WAL schema

Four tables. Shapes shown in Drizzle TypeScript syntax — illustrative, not the
actual source files. The schema lands on day one and evolves only via Drizzle
migrations.

### `runs`

One row per workflow invocation.

```ts
export const runs = sqliteTable('runs', {
  id:          text('id').primaryKey(),            // ULID-shaped run identifier
  workflowId:  text('workflow_id').notNull(),      // logical workflow name/version
  status:      text('status').notNull(),           // 'running' | 'completed' | 'failed' | 'indeterminate'
  inputJson:   text('input_json').notNull(),       // serialised workflow input
  createdAt:   integer('created_at').notNull(),     // epoch ms, from ctx.now() at start
  updatedAt:   integer('updated_at').notNull(),
});
```

### `branches`

A run has at least one branch (the root). Forks create child branches.
Copy-on-write: a branch records its parent and the step it diverged from.

```ts
export const branches = sqliteTable('branches', {
  id:             text('id').primaryKey(),
  runId:          text('run_id').notNull().references(() => runs.id),
  parentBranchId: text('parent_branch_id').references(() => branches.id), // null = root
  forkedFromStep: text('forked_from_step'),         // step_id of the divergence point, null on root
  createdAt:      integer('created_at').notNull(),
});
```

### `events`

The WAL proper. Append-only. Every step produces a `STEP_STARTED` then exactly
one terminal event (`STEP_COMPLETED` or `STEP_FAILED`). `INTERVENTION` and
`INVALIDATED_BY_FORK` are written by fork/intervene operations.

```ts
export const events = sqliteTable('events', {
  id:         integer('id').primaryKey({ autoIncrement: true }), // monotonic WAL sequence
  branchId:   text('branch_id').notNull().references(() => branches.id),
  stepId:     text('step_id').notNull(),            // SHA-256 derivation, see §4
  type:       text('type').notNull(),               // event type enum, see §3
  determinism:text('determinism'),                  // 'recorded' | 'side_effect' | 'interactive' | null
  semanticName:text('semantic_name').notNull(),     // human label, e.g. 'charge_card'
  loopIndex:  integer('loop_index').notNull().default(0), // ReAct iteration index
  payloadJson:text('payload_json'),                 // inputs (STARTED) / outputs (COMPLETED) / error (FAILED)
  idempotencyKey: text('idempotency_key'),          // side_effect only
  costJson:   text('cost_json'),                    // tokens, dollars, TTFT, duration (COMPLETED)
  createdAt:  integer('created_at').notNull(),
}, (t) => ({
  // Prevents two terminal writes for the same step on the same branch — the
  // core duplicate-write guard. A step is started once and completed once.
  uniqStepTerminal: uniqueIndex('uniq_step_terminal')
    .on(t.branchId, t.stepId, t.type),
  // Replay reads events for a branch in WAL order.
  byBranchSeq: index('by_branch_seq').on(t.branchId, t.id),
  // Reconciliation looks up orphaned side effects by key.
  byIdemKey: index('by_idem_key').on(t.idempotencyKey),
}));
```

**The duplicate-write guard.** `uniq_step_terminal` on `(branch_id, step_id,
type)` is the constraint that makes replay safe. A second attempt to write
`STEP_COMPLETED` for an already-completed step throws a uniqueness violation,
surfacing the bug instead of silently double-logging.

### `interventions`

Operator overrides applied on fork — override a prompt, override a response, or
skip a step. Consulted by the orchestrator before executing the affected step.

```ts
export const interventions = sqliteTable('interventions', {
  id:        text('id').primaryKey(),
  branchId:  text('branch_id').notNull().references(() => branches.id),
  stepId:    text('step_id').notNull(),
  kind:      text('kind').notNull(),                // 'override_prompt' | 'override_response' | 'skip'
  payloadJson: text('payload_json'),                // the override content
  createdAt: integer('created_at').notNull(),
});
```

---

## 3. Event types

Exhaustive enum, modelled as a discriminated union on `type`:

| Type                  | Meaning |
|-----------------------|---------|
| `STEP_STARTED`        | Intent record. Written and committed **before** the step executes. |
| `STEP_COMPLETED`      | Terminal success. Carries outputs and cost metadata. |
| `STEP_FAILED`         | Terminal failure. Carries the error. The workflow halts or the step retries per policy. |
| `INTERVENTION`        | An operator override exists for this step; replay must consult it. |
| `INVALIDATED_BY_FORK` | Tombstone. An `interactive` result past a fork point is invalidated and must be re-prompted on the new branch. |

### Valid transitions

```
                ┌──────────────────────────────────────────────┐
                │                                                │
   (no event) ──▶ STEP_STARTED ──▶ STEP_COMPLETED  (terminal, success)
                      │
                      ├──────────▶ STEP_FAILED      (terminal, failure)
                      │
                      └──▶ [process dies before terminal write]
                                     │
                                     ▼
                            INDETERMINATE  (derived state, not a stored row —
                                     │      a STARTED with no terminal event)
                                     ▼
                            reconcile() ──▶ STEP_COMPLETED  (recovered)
                                     │
                                     └────▶ hard halt (reconcile returned null)

   On fork:  interactive STEP_COMPLETED past the fork point ──▶ INVALIDATED_BY_FORK
```

`INDETERMINATE` is **not** a stored event type. It is the runtime's name for the
condition "a `STEP_STARTED` exists with no matching terminal event" — discovered
on restart. See §6.

---

## 4. Step ID derivation

A step's identity must be stable across restarts and replays, unique within a
run, and collision-free across ReAct loop iterations.

```
step_id = sha256_hex( workflow_id ‖ "\x1f" ‖
                      parent_step_id ‖ "\x1f" ‖
                      loop_index ‖ "\x1f" ‖
                      semantic_name )
```

Fields are joined with the ASCII unit separator `0x1f` (a byte that cannot occur
in the textual inputs) to prevent ambiguous concatenation. `parent_step_id` is
the empty string at the top level. `loop_index` is the ReAct iteration counter,
zero-based.

**Hash choice: SHA-256.** Chosen over BLAKE3 because it ships in the Node
standard library (`crypto.createHash('sha256')`) with zero added dependencies,
which honours the "no premature dependencies" guardrail. Step-ID derivation is
not in any hot path — it runs once per step, dwarfed by LLM latency — so BLAKE3's
speed advantage is irrelevant here. We need a stable, collision-resistant,
deterministic digest; SHA-256 is exactly that.

### Worked example — a 3-iteration ReAct loop

`workflow_id = "trading_research@1"`. Top-level LLM step has `parent_step_id =
""`. Suppose its id (loop_index 0, name `react_root`) is `S0`. Each iteration
issues an LLM call and a tool call, both children of `S0`, distinguished by
`loop_index`:

| Iteration | semantic_name | loop_index | parent | distinct? |
|-----------|---------------|------------|--------|-----------|
| 0 | `react_llm`  | 0 | `S0` | id_A |
| 0 | `react_tool` | 0 | `S0` | id_B |
| 1 | `react_llm`  | 1 | `S0` | id_C |
| 1 | `react_tool` | 1 | `S0` | id_D |
| 2 | `react_llm`  | 2 | `S0` | id_E |
| 2 | `react_tool` | 2 | `S0` | id_F |

`react_llm` at iteration 0 vs iteration 1 differ only in `loop_index` — different
input bytes, different SHA-256, no collision. Because the derivation is pure, a
replay recomputes the identical ids and matches them against the WAL.

---

## 5. The orchestrator loop

Pseudocode. The invariant: **never execute a step whose `STEP_COMPLETED` is
already in the WAL.**

```
function runWorkflow(run, branch):
    while not done:
        step = nextStepFromWorkflow(ctx)        # workflow code yields the next intent
        stepId = deriveStepId(run.workflowId, step.parentId, step.loopIndex, step.name)

        completed = wal.findTerminal(branch.id, stepId)   # COMPLETED or FAILED?
        if completed is STEP_COMPLETED:
            ctx.feed(completed.payload)          # replay recorded result, do not execute
            continue
        if completed is STEP_FAILED:
            halt(completed.error)

        started = wal.findStarted(branch.id, stepId)
        if started exists and no terminal:       # crash happened mid-step
            result = reconcileIndeterminateStep(step, started)   # §6
        else:
            intervention = wal.findIntervention(branch.id, stepId)  # §9
            tx.immediate:
                wal.write(STEP_STARTED, stepId, inputs)   # intent, fsync'd before acting
            result = execute(step, intervention)          # the LLM call or tool call
            tx.immediate:
                wal.write(STEP_COMPLETED, stepId, result, cost)

        # tool_use yield-and-flatten: if an LLM step returned tool_use blocks,
        # the orchestrator does not recurse. It enqueues each tool call as an
        # independent step (with the current loop_index), and the next while
        # iteration drives them. Each tool_result feeds back into the reducer.
        if result.stopReason == 'tool_use':
            enqueueToolSteps(result.toolUses, loopIndex)

        # context reduction runs here, on every turn: the Context Reducer
        # rebuilds the Anthropic messages[] array deterministically from the
        # branch's WAL deltas before the next ctx.llm() call.
        ctx.messages = contextReducer.rebuild(branch.id)
```

`ctx.llm` returns when Claude stops — either with text (`stop_reason: end_turn`)
or with `tool_use`. ReAct loops are not in-memory recursion; they are flattened
into independent WAL steps so a crash at any iteration is recoverable.

---

## 6. The INDETERMINATE recovery state

**What it means.** On restart, the orchestrator scans the branch and finds a
`STEP_STARTED` with no matching terminal event. The process died after declaring
intent but before recording the outcome. For a `recorded` tool this is harmless
(re-execute — it is pure). For a `side_effect` tool it is the dangerous case: the
remote system **may or may not** have applied the effect. Local code cannot know
(the Two Generals problem).

**When entered.** Exactly when `findStarted` returns a row and `findTerminal`
returns nothing for the same `(branch_id, step_id)`.

**How `reconcile()` is invoked.**

```
function reconcileIndeterminateStep(step, started):
    if step.determinism == 'recorded':
        return execute(step)                 # pure, safe to re-run; then write COMPLETED

    if step.determinism == 'side_effect':
        key = started.idempotencyKey
        remoteState = step.reconcile(key)    # query the remote system by key
        if remoteState is not null:
            tx.immediate:
                wal.write(STEP_COMPLETED, step.id, remoteState, cost=reconciled)
            return remoteState               # recovered, NOT re-executed
        else:
            run.status = 'indeterminate'
            tx.immediate: wal.write(STEP_FAILED, step.id, error='UNRECONCILED')
            haltForOperator()                # hard stop — human intervention required

    if step.determinism == 'interactive':
        return reprompt(step)                # consent cannot be assumed; ask again
```

**If `reconcile()` returns null.** The remote system reports no record for the
key. The runtime cannot prove the effect did not fire (it might have fired and
the remote's record is eventually-consistent, or it genuinely never happened).
This is a **hard halt**: the run is marked `indeterminate` and an operator must
decide. Quill never resolves an unreconcilable side effect automatically — doing
so would risk the exact double-execution the runtime exists to prevent.

---

## 7. The tool determinism contract

Every tool declares one of three modes. The mode is a discriminated union; the
runtime enforces the required fields at registration and the behaviour at
execution.

| Mode          | Semantics | Required fields | Runtime enforcement |
|---------------|-----------|-----------------|---------------------|
| `recorded`    | Pure / read-only. Cache the response, replay from the WAL. | `execute(args)`; a validator `hash(args)` to detect input drift. | On replay, returns the cached payload. On input-hash mismatch, throws `NondeterminismError` with a diff. |
| `side_effect` | Mutates the world. Never re-executed. | `idempotencyKey(stepId, args)`; `reconcile(key)`. | On `INDETERMINATE`, calls `reconcile` rather than `execute`. Registration without both functions is rejected. |
| `interactive` | Human-in-the-loop. | `prompt(args)` describing what consent is needed. | Pauses replay and re-prompts. Tombstoned (`INVALIDATED_BY_FORK`) past a fork point. |

Enforcement points: **registration** (required fields present, else throw) and
**execution/replay** (mode dictates execute-vs-replay-vs-reconcile-vs-reprompt).

---

## 8. Idempotency contract

A `side_effect` tool must supply two pure functions:

```ts
idempotencyKey(stepId: string, args: TArgs): string
reconcile(key: string): Promise<RemoteState | null>
```

- `idempotencyKey` derives a stable key from the step identity and the call
  arguments. It must be deterministic: the same step and args always yield the
  same key, across restarts. The runtime embeds this key in the outbound call
  (e.g. as Stripe's `Idempotency-Key` header) so the remote system itself
  deduplicates.
- `reconcile` queries the remote system for the outcome associated with `key`.
  It returns the `RemoteState` if the effect was applied, or `null` if no record
  exists. `null` triggers the hard halt of §6.

### Worked example — a mock Stripe-shaped charge

```ts
// determinism: 'side_effect'
idempotencyKey(stepId, args) {
  // stable across restarts: same step + same amount + same customer ⇒ same key
  return `quill:${stepId}:charge:${args.customerId}:${args.amountCents}`;
}

async reconcile(key) {
  // ask the (mock) Stripe: is there a charge recorded under this key?
  const charge = await stripe.charges.lookupByIdempotencyKey(key);
  return charge ? { id: charge.id, status: charge.status } : null;
}
```

Crash sequence: orchestrator writes `STEP_STARTED` with `idempotency_key =
quill:S_charge:charge:cus_42:1000`, sends the charge, then `kill -9` before
`STEP_COMPLETED`. On restart, the step is INDETERMINATE. `reconcile(key)` asks
the remote; the remote found the key (the charge did apply) and returns
`{ id: 'ch_1', status: 'succeeded' }`. The runtime writes `STEP_COMPLETED` with
that reconciled value — the card is **not** charged twice. Had the charge never
reached the remote, `reconcile` returns `null` and the run halts for an operator.

---

## 9. Forking and branching

A fork creates a child branch that diverges at a chosen step. History up to the
fork point is shared (copy-on-write — the child does not duplicate parent rows);
events after the fork point are written under the new `branch_id`.

**Recursive CTE to traverse the branch ancestry.** To read a child branch's full
event history, walk from the branch up through its parents, taking each parent's
events only up to the step it was forked from:

```sql
WITH RECURSIVE ancestry(branch_id, parent_branch_id, forked_from_step, depth) AS (
  SELECT id, parent_branch_id, forked_from_step, 0
    FROM branches WHERE id = :targetBranch
  UNION ALL
  SELECT b.id, b.parent_branch_id, b.forked_from_step, a.depth + 1
    FROM branches b
    JOIN ancestry a ON b.id = a.parent_branch_id
)
SELECT e.*
  FROM events e
  JOIN ancestry a ON e.branch_id = a.branch_id
 ORDER BY a.depth DESC, e.id ASC;   -- oldest ancestor first, WAL order within
```

(The fork-point cutoff per ancestor is applied as an additional predicate on
`e.step_id` against the child's `forked_from_step`; shown trimmed here for
clarity.) This recursive CTE is exactly the kind of query that uses Drizzle's raw
`sql` template tag rather than the typed query builder.

**Tombstoning interactive results.** Consent given on the parent branch does not
carry to a forked reality. Any `interactive` `STEP_COMPLETED` after the fork
point is written as `INVALIDATED_BY_FORK` on the child branch, forcing a fresh
re-prompt when replay reaches it. Branched reality requires branched consent.

---

## 10. Folder structure

```
quill/
├── AGENTS.md                  # binding rules for AI edits (and .cursorrules symlink)
├── README.md                  # public-facing pitch and quickstart
├── package.json               # workspace root, shared scripts
├── pnpm-workspace.yaml        # declares packages/* and examples/*
├── tsconfig.json              # strict, noUncheckedIndexedAccess, noImplicitOverride
├── docs/
│   ├── architecture.md        # this document
│   └── implementation-plan.md # granular Week 1 checklist
├── packages/
│   ├── runtime/               # the durable execution engine
│   │   └── src/
│   │       ├── walSchema.ts       # Drizzle schema: runs, branches, events, interventions
│   │       ├── walWriter.ts       # writes STEP_STARTED / STEP_COMPLETED in BEGIN IMMEDIATE
│   │       ├── walReader.ts       # reads events; recursive-CTE branch traversal
│   │       ├── stepId.ts          # SHA-256 step-id derivation (§4)
│   │       ├── orchestrator.ts    # the while loop (§5)
│   │       ├── contextReducer.ts  # rebuilds messages[] from WAL deltas
│   │       ├── reconcile.ts       # INDETERMINATE recovery (§6)
│   │       ├── tools.ts           # determinism contract: recorded/side_effect/interactive
│   │       └── fakeAnthropic.ts   # shape-correct fake provider for offline tests
│   ├── cli/                   # the `quill` command-line interface
│   │   └── src/
│   └── ui/                    # React + Vite time-travel debugger (Week 6+)
│       └── src/
├── examples/                  # runnable demo workflows (e.g. trading-research)
└── test/                      # invariant tests + crash harness
```

One concept per file: `walSchema.ts` defines, `walWriter.ts` writes,
`walReader.ts` reads.

---

## 11. Out of scope

Lifted from the goals document. These are **not** being built:

- Multi-machine / distributed execution. Single-process proves the model.
- Multi-tenancy.
- Authentication. The runtime and UI are localhost-only and documented as such.
- A hosted SaaS dashboard.
- Billing or any pricing model.
- A plugin system or extension ecosystem.
- Production-grade horizontal scaling.
- Pixel-perfect UI. The debugger must be clear and functional, not a portfolio
  piece.

Quill is a hiring-signal artifact and a technically defensible runtime — not a
product.
