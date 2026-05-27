---
name: ultragoal
description: Create and execute durable repo-native multi-goal plans over GJC goal mode artifacts.

source: "forked from upstream ultragoal skill and rebranded for GJC"
---

# Ultragoal Workflow

Use when the user asks for `ultragoal`, `create-goals`, `complete-goals`, durable multi-goal planning, or sequential execution over GJC goal mode.

## Purpose

`ultragoal` turns a brief into repo-native artifacts and then drives a GJC goal safely through the named goal tools: `get_goal`, `create_goal`, and `update_goal`. New plans default to a stable pointer-style aggregate GJC goal for the whole durable plan in `.gjc/ultragoal/goals.json`, including later accepted/appended stories under the original brief constraints, while GJC tracks G001/G002 story progress in the ledger. Ultragoal does not call `/goal clear`; before multiple sequential ultragoal runs in one session/thread, manually run `/goal clear` in the UI so the previous completed aggregate goal does not block or confuse the next `create_goal`.

- `.gjc/ultragoal/brief.md`
- `.gjc/ultragoal/goals.json`
- `.gjc/ultragoal/ledger.jsonl` (checkpoint and structured steering audit events)

Existing aggregate plans with the legacy enumerated objective are migrated to the stable pointer objective on read, persisted to `goals.json`, retained in `gjcObjectiveAliases` for already-active hidden goal reconciliation, and audited with an `aggregate_objective_migrated` ledger entry.

## Always-used command examples

Use these exact `gjc ultragoal` commands before spending tool calls rediscovering syntax:

```sh
gjc ultragoal status
gjc ultragoal status --json
gjc ultragoal create-goals --brief "<brief>"
gjc ultragoal create-goals --brief-file <path>
gjc ultragoal complete-goals
gjc ultragoal complete-goals --retry-failed
gjc ultragoal checkpoint --goal-id <id> --status complete --evidence "<evidence>" --gjc-goal-json <get-goal-json-or-path>
gjc ultragoal checkpoint --goal-id <id> --status failed --evidence "<blocker/evidence>"
gjc ultragoal record-review-blockers --goal-id <id> --title "Resolve final review blockers" --objective "<blocker-resolution objective>" --evidence "<review findings>" --gjc-goal-json <active-get-goal-json-or-path>
```

Use these exact goal-tool calls for the inline goal state:

```json
get_goal({})
create_goal({"objective":"<printed aggregate or per-story objective>"})
update_goal({"status":"complete"})
```

`get_goal`, `create_goal`, and `update_goal` share the same session goal state as `/goal`; prefer these named tools inside Ultragoal because they produce JSON snapshots for ledger reconciliation.


## Create goals

1. Run one of:
   - `gjc ultragoal create-goals --brief "<brief>"`
   - `gjc ultragoal create-goals --brief-file <path>`
   - `cat <brief> | gjc ultragoal create-goals --from-stdin`
   - `gjc ultragoal create-goals --gjc-goal-mode per-story --brief "<brief>"` only when one GJC goal context per story is explicitly preferred
2. Inspect `.gjc/ultragoal/goals.json` and refine if needed.

## Complete goals

Loop until `gjc ultragoal status` reports all goals complete:

1. Run `gjc ultragoal complete-goals`.
2. Read the printed handoff.
3. Call `get_goal({})`.
4. If no active GJC goal exists, call `create_goal({"objective":"<printed payload objective>"})` with the printed payload. In aggregate mode, if the same aggregate objective is already active, continue the current GJC story without creating a new GJC goal.
5. Complete the current GJC story only.
6. Run a completion audit against the story objective and real artifacts/tests.
7. Before any `--status complete` checkpoint, run the mandatory final cleanup/review gate below. In aggregate mode, do **not** call `update_goal` for intermediate stories; checkpoint with a fresh `get_goal({})` snapshot whose aggregate objective is still `active`. On the final story only, call `update_goal({"status":"complete"})` after the gate is clean, then call `get_goal({})` again for a fresh `complete` snapshot.
8. Checkpoint the durable ledger with that snapshot. Complete checkpoints require `--quality-gate-json`; the runtime hook rejects closure without a clean architect review:
   `gjc ultragoal checkpoint --goal-id <id> --status complete --evidence "<evidence>" --gjc-goal-json <get_goal-json-or-path> --quality-gate-json <quality-gate-json-or-path>`
9. If blocked or failed, checkpoint failure:
   `gjc ultragoal checkpoint --goal-id <id> --status failed --evidence "<blocker/evidence>"`
10. For legacy per-story completed-goal blockers, preserve the non-terminal blocker with:
   `gjc ultragoal checkpoint --goal-id <id> --status blocked --evidence "<completed legacy GJC goal blocks create_goal in this thread>" --gjc-goal-json <get_goal-json-or-path>`
11. Resume failed goals with `gjc ultragoal complete-goals --retry-failed`.

## Dynamic steering

Use `gjc ultragoal steer` when real findings or blockers prove the current story decomposition should change while the aggregate objective and constraints stay fixed. Steering is explicit-only and evidence-backed; broad natural-language requests are rejected instead of guessed.

Allowed mutation kinds are:

- `add_subgoal`
- `split_subgoal`
- `reorder_pending`
- `revise_pending_wording`
- `annotate_ledger`
- `mark_blocked_superseded`

Examples:

```sh
gjc ultragoal steer --kind add_subgoal --title "Investigate blocker" --objective "Validate the blocker and report evidence." --evidence "log/test output" --rationale "The blocker changes the safe execution order." --json
gjc ultragoal steer --directive-json ./steering.json --json
```

Steering invariants:

- Do not edit the aggregate goal objective, original brief constraints, quality gates, or completion status. The aggregate objective is a stable pointer to `.gjc/ultragoal/goals.json` and `.gjc/ultragoal/ledger.jsonl`, not an enumeration of initial goal ids.
- Do not hard-delete goals, auto-complete work, weaken verification, or silently mutate `.gjc/ultragoal`.
- Accepted and rejected attempts append structured audit entries to `.gjc/ultragoal/ledger.jsonl`.
- Superseded goals remain in `goals.json` with steering metadata and are skipped for scheduling.
- Blocked goals without replacements are skipped for scheduling but still block final completion until later explicit steering replaces or supersedes them.

UserPromptSubmit uses the same steering API only for structured directives such as `GJC_ULTRAGOAL_STEER: { ... }`, `gjc.ultragoal.steer: { ... }`, or `gjc ultragoal steer: { ... }`. Normal prose does not mutate state, and repeated prompt-submit directives dedupe by prompt signature or idempotency key.


## Role-agent delegation guidance

Ultragoal execution should use GJC's bundled role-agent roster when a durable story is large enough to benefit from delegation:

- Use `executor` for bounded implementation, refactoring, and fix slices.
- Use `planner` for story sequencing or handoff refinement when execution uncovers a missing plan branch.
- Use `architect` for read-only architecture and code-review lanes, including `CLEAR` / `WATCH` / `BLOCK` status.
- Use `critic` for read-only plan or handoff critique before execution proceeds.

If an Ultragoal request has no approved plan or consensus artifact, run `ralplan` first and preserve its PRD, test spec, role roster, and verification guidance in the Ultragoal ledger. Do not silently substitute ad-hoc execution for missing planning.

The Ultragoal leader owns `.gjc/ultragoal/goals.json` and `.gjc/ultragoal/ledger.jsonl`. Role agents return implementation/review evidence; they do not checkpoint Ultragoal or mutate goal state.

## Use Ultragoal and Team together

Use ultragoal and team together for a durable Ultragoal story that benefits from one visible tmux worker session. Ultragoal remains leader-owned: `.gjc/ultragoal/goals.json` stores the story plan and `.gjc/ultragoal/ledger.jsonl` stores checkpoints. Team is the single-worker tmux execution engine and returns task/evidence status to the leader.

The leader checkpoints Ultragoal from Team evidence with a fresh `get_goal` snapshot:

```sh
gjc ultragoal checkpoint --goal-id <id> --status complete --evidence "<team evidence mentioning .gjc/ultragoal and <id>>" --gjc-goal-json <fresh-get_goal-json-or-path>
```

Workers do not own ultragoal goal state, do not create worker ultragoal ledgers, and do not checkpoint Ultragoal. Team launch remains explicit; Ultragoal does not auto-launch Team and performs no hidden goal mutation.

## Mandatory completion cleanup and review gate

An ultragoal story cannot be checkpointed `complete` until the active agent has run the quality gate:

1. Run targeted verification for the story.
2. Run a cleanup/refactor review pass on changed files only; if there are no relevant edits, the cleaner still runs and records a passed/no-op report.
3. Rerun verification after the cleaner pass.
4. Run a final code review pass. Clean means `codeReview.recommendation: "APPROVE"` and `codeReview.architectStatus: "CLEAR"`; `COMMENT`, `WATCH`, `REQUEST CHANGES`, and `BLOCK` are non-clean.
5. If review is non-clean, do **not** call `update_goal`. Record durable blocker work instead:

   ```sh
   gjc ultragoal record-review-blockers --goal-id <id> --title "Resolve final review blockers" --objective "<blocker-resolution objective>" --evidence "<review findings>" --gjc-goal-json <active-get-goal-json-or-path>
   ```

   This marks the current story `review_blocked`, appends a pending blocker-resolution story, keeps the GJC goal active, and lets `gjc ultragoal complete-goals` start the blocker next. In legacy per-story mode, the blocker may need an available GJC goal context because the old per-story GJC goal remains active/incomplete.

6. If review is clean, call `update_goal({"status":"complete"})`, call `get_goal({})`, and checkpoint with a structured final gate:

   ```sh
   gjc ultragoal checkpoint --goal-id <id> --status complete --evidence "<tests/files/review evidence>" --gjc-goal-json <fresh-complete-get-goal-json-or-path> --quality-gate-json <quality-gate-json-or-path>
   ```

`--quality-gate-json` must include:

```json
{
  "aiSlopCleaner": { "status": "passed", "evidence": "cleaner report" },
  "verification": { "status": "passed", "commands": ["npm test"], "evidence": "post-cleaner verification" },
  "codeReview": { "recommendation": "APPROVE", "architectStatus": "CLEAR", "evidence": "final review synthesis" }
}
```

## Constraints

- The shell command cannot directly invoke interactive `/goal`; it emits a model-facing handoff for the active GJC agent.
- Ultragoal intentionally does not invoke `/goal clear` or hidden `thread/goal/clear`; use only the named goal-tool surface: `get_goal`, `create_goal`, and `update_goal`.
- After a completed aggregate ultragoal run, clear the goal manually with `/goal clear` before starting another ultragoal run in the same session/thread.
- Never call `create_goal` when `get_goal` reports a different active goal.
- Never call `update_goal` unless the aggregate run or legacy per-story goal is actually complete.
- In aggregate mode, intermediate story checkpoints require a matching `active` GJC goal snapshot; final story completion requires a matching `complete` snapshot after `update_goal`.
- Completion checkpoints require read-only goal snapshot reconciliation: pass fresh `get_goal` JSON/path with `--gjc-goal-json`; shell commands and hooks must not mutate goal state.
- Treat `ledger.jsonl` as the durable audit trail; checkpoint after every success or failure.
