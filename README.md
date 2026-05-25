# Quill

> Durable execution runtime for LLM agents. Workflows survive crashes, side effects don't double-fire, and every run is replayable, forkable, and inspectable from a local time-travel debugger.

![Status](https://img.shields.io/badge/status-Week_1_of_10_%E2%80%94_not_production_ready-orange)

LLM agents in production charge credit cards, place trades, send emails, and
mutate databases — then the process running them dies. An OOM kill, a deploy, a
network blip: the host goes down mid-workflow and the system is left in an
undefined state. Did the LLM call complete? Did the tool execute? Did the charge
actually fire on the remote system? If you restart and replay, will you
double-charge? Existing tools paper over this — checkpointing without remote
reconciliation, tracing without execution, orchestration without a first-class
notion of LLM calls. Quill closes that gap.

> **The headline guarantee.** `kill -9` the Node process at any point during a
> multi-step agentic workflow. On restart, Quill resumes — without re-executing
> completed steps, without double-firing side effects, and without silent state
> drift.

## The crash, reconciled

```
  run ──▶ STEP_STARTED (charge_card, idem-key) ──▶ [ kill -9 ]
                                                        │
                          remote may or may not have charged — local cannot know
                                                        │
  restart ──▶ orphan STARTED found ──▶ reconcile(key) ──▶ remote: CHARGED
                                                        │
                          STEP_COMPLETED logged with reconciled value
                                                        │
                          continue — card charged exactly once
```

## Quickstart

```bash
pnpm install
pnpm --filter examples run trading-research
```

Expected: the workflow runs a few LLM and tool steps to completion and prints a
final result, with each step's status logged to the local SQLite WAL. Kill the
process mid-run (`Ctrl-C` or `kill -9`) and re-run the same command — Quill
resumes from the WAL instead of starting over, and any side-effecting step is
reconciled rather than re-executed.

## Scripts

| Script | What it does |
|--------|--------------|
| `dev` | Run the runtime in watch mode for local development |
| `build` | Compile all workspace packages to JavaScript |
| `test` | Run the full unit and integration test suite |
| `test:invariants` | Run the six Week-1 invariant tests (the contract) |
| `db:migrate` | Apply Drizzle migrations, creating the WAL database |
| `lint` | Run ESLint across the monorepo |
| `typecheck` | Type-check all packages with no emit |

## How it works

A workflow is an ordinary TypeScript function that receives a `ctx` object. It
calls `ctx.llm(...)` to talk to Claude and `ctx.tool(...)` to invoke tools. An
**orchestrator** drives the workflow forward in a `while` loop, and before
executing any step it consults a local SQLite **write-ahead log** (WAL). If the
step already completed, the orchestrator replays the recorded result instead of
running it again.

Every step writes an intent record (`STEP_STARTED`) before acting and a
completion record (`STEP_COMPLETED`) after, both inside `BEGIN IMMEDIATE`
transactions. A process that dies between the two leaves an orphan `STEP_STARTED`
— the signal, on restart, that a step was in flight when the lights went out.

For read-only tools that orphan is harmless: re-run them, they are pure. For
side-effecting tools — a charge, a trade, an email — re-running is the disaster
Quill exists to prevent. Those tools declare an **idempotency key** and a
**reconcile** function. On recovery, the runtime calls `reconcile` to ask the
remote system "did this already happen?" and records the answer, rather than
guessing. The Two Generals problem cannot be solved locally; the contract pushes
resolution to the system that actually knows.

ReAct loops are flattened: each LLM call and each tool call is an independent WAL
step, so a crash at any iteration is recoverable. The conversation context is not
stored whole — the WAL holds deltas, and a deterministic reducer rebuilds the
`messages[]` array on every turn. Runs are forkable: a recursive CTE traverses
branched event logs copy-on-write, and interactive results past a fork point are
tombstoned so consent is asked afresh on the new branch.

The full design — schema, event state machine, step-ID derivation, the
reconciliation flow — is in [docs/architecture.md](docs/architecture.md).

## Roadmap

The 10-week plan. Current week in **bold**.

- [ ] **Week 1 — The vertical slice & the moat: `kill -9` survives, side effects don't double-fire**
- [ ] Week 2 — The ReAct loop & real Anthropic
- [ ] Week 3 — MCP tools & fork semantics
- [ ] Week 4 — The CLI
- [ ] Week 5 — The runtime HTTP layer & SSE stream
- [ ] Week 6 — The debugger UI: trace tree
- [ ] Week 7 — The debugger UI: fork, diff, intervene
- [ ] Week 8 — Hardening & real demo workflow
- [ ] Week 9 — Documentation & launch post
- [ ] Week 10 — Polish, publish, ship

## Licence

ISC.

## Contributing

Issues are welcome — bug reports, design questions, and edge cases on the
determinism model especially. Pull requests are deferred until v0.2; the
architecture is still settling and the schema is deliberately frozen for Week 1.

For the project's goals and rationale, see
[the problem-and-goals document](.cursor/docs/01-problem-and-goals.md).
