# opencode-goal

An agent that says "done" is not done until a verifier agrees. Native OpenCode V2 rewrite of
[`pi-goal`](https://github.com/hakergeniusz/pi-goal) (v0.2).

Arm a goal with `/goal <text>`. Arming starts a turn immediately with the condition as the directive.
After every finished turn, a verifier model receives the goal plus a bounded transcript digest and
rules on the evidence:

- **DONE** — records an achieved message and clears the goal.
- **NOT_DONE** — queues the verifier's reason as guidance and starts the next turn.
- **UNREACHABLE** — records a failed message and clears the goal.

## Guards

- **Stall detector**: no tool use for `stallTurns` (default 3) consecutive evaluated turns pauses
  the loop but KEEPS the goal; the next prompt resumes evaluation. Chatting is not progress.
- **Check ceiling**: after `maxChecks` (default 12) evaluations the goal is cleared and reported.
  `/goal <text>` re-arms.
- **Fail-open**: if the verifier call fails, the turn settles normally and the goal stays armed;
  three consecutive failures pause the goal. A broken verifier must never trap a finished run.
- **Turn outcomes**: only successful turns are audited. A failed turn keeps the goal armed and asks
  for another message; an interrupted turn is skipped silently.
- **Per-session persistence**: armed goals are stored with `ctx.storage` under `goal:<sessionID>`
  and restored on plugin load / first use, with fresh counters. Cleared and achieved goals stay
  cleared.

Every verdict and status notice lands in the transcript as a visible `[opencode-goal]` message, so
you always see *why* the agent kept going. The verifier is a stateless
`ctx.experimental.generate.text` call with no tools and no session side effects — deliberately
cheap, since it runs after every turn while a goal is armed.

## Load

This is an OpenCode V2 server plugin. Add it to `opencode.json(c)` (or drop the directory in
`.opencode/plugins/`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "opencode-goal", "options": {} }
  ]
}
```

A local checkout can be loaded the same way, e.g. `{ "package": "/home/hakergeniusz/Projects/opencode-goal", "options": {} }`.

## Commands

```
/goal <text>   arm a goal (replaces any active goal, starts a turn)
/goal          show condition, elapsed, turns, checks, last reason
/goal clear    dismiss the goal (aliases: stop off reset none cancel)
```

Conditions are capped at 4000 chars; include a turn/time clause to bound the run.

## Configuration

Plugin options (object form above) take precedence; environment variables are the fallback.

| Option       | Env var                     | Default        | Meaning                                        |
| ------------ | --------------------------- | -------------- | ---------------------------------------------- |
| `maxChecks`  | `OPENCODE_GOAL_MAX_CHECKS`  | `12`           | Evaluations per goal before giving up          |
| `stallTurns` | `OPENCODE_GOAL_STALL_TURNS` | `3`            | Idle turns before pausing (goal kept)          |
| `checkModel` | `OPENCODE_GOAL_CHECK_MODEL` | session model  | `provider:id` or bare id for a cheaper verifier |
| `off`        | `OPENCODE_GOAL_OFF=1`       | *(off)*        | `true`/`1` disables all checking               |

When `checkModel` is unset, the verifier uses the session's active model; if that cannot be read,
OpenCode's configured default model is used.

## Mapping from the pi original

| pi concept | OpenCode V2 equivalent used here |
| --- | --- |
| `pi.registerCommand("goal", …)` | `ctx.command.transform` → `editor.add({ name: "goal", execute })` |
| `pi.on("turn_end")` | `ctx.event.subscribe({ types: ["session.idle"] })` + `ctx.session.get(...).outcome` |
| `pi.on("turn_start")` / `agent_before_settle` backstop | Not needed: `session.idle` is a single reliable turn boundary; a per-session `busy` guard prevents double evaluation |
| `ctx.ui.notify` / `setStatus` | `ctx.session.synthetic({ ..., resume: false })` — display-only transcript messages |
| `event.continue = true` + injected custom entry | `ctx.session.prompt({ ..., delivery: "queue" })` with the guidance text (shows in transcript and starts the next turn) |
| `pi.appendEntry` / session branch restore | `ctx.storage.set/get/remove/scan` keyed by `goal:<sessionID>` |
| `ctx.modelRegistry.streamSimple` | `ctx.experimental.generate.text` (stateless, no tools, no session history) |
| env config | `ctx.options` (plugin object form) with `OPENCODE_GOAL_*` env fallback |

## Known gaps

- **No TUI status widget.** The pi `setStatus` indicator is replaced by `[opencode-goal]` messages
  in the transcript; a TUI part was not added.
- **No verifier token accounting.** `ctx.experimental.generate.text` returns only text, so
  `spentTokens` stays 0 and the status line omits the token figure.
- **Continuation is a new turn, not a same-loop step.** pi's `event.continue = true` resumed the
  same agent loop; OpenCode has no equivalent flag on `session.idle`, so guidance is queued as a
  new prompt. Behavior is equivalent (the model receives the guidance and keeps working).
- **Background-work deferral not mapped.** pi's `pendingMessages` check has no OpenCode equivalent;
  a turn is judged only at `session.idle`, which by definition has no in-flight generation.
- **Abort detection is best-effort.** Failed and interrupted outcomes are read from `Session.Info`;
  exact abort semantics differ from pi's `outcome: "aborted"`.
- **Per-session, per-plugin state.** Storage is plugin-scoped in OpenCode (not in the session
  branch as with pi), so state is keyed explicitly by session ID.

## Tests

The original pi test suite used a fake `ExtensionAPI` and canned `streamSimple` chunks; those
depend on pi runtime types and cannot be ported without adding pi dependencies. No tests are
included here. The plugin was typechecked against `@opencode/plugin` v2.

MIT licensed.
