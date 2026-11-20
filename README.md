# opencode-goal

An OpenCode goal-verifier plugin: an agent that says "done" is not done until a verifier agrees.

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
  three consecutive failures pause the goal. A broken verifier must never create an infinite loop.

## Usage

```
/goal "fix the bug; all tests pass and git is clean"
/goal                          # show current goal and counters
/goal clear                    # stop and clear the goal
```

Aliases for clear: `stop`, `off`, `reset`, `none`, `cancel`.

## Configuration

Plugin options (object form in `opencode.jsonc`) override environment variables:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-goal",
      "options": {
        "maxChecks": 12,
        "stallTurns": 3,
        "checkModel": "opencode/glm-5.1-nano"
      }
    }
  ]
}
```

| Option       | Env fallback              | Default                 |
|--------------|---------------------------|-------------------------|
| `maxChecks`  | `OPENCODE_GOAL_MAX_CHECKS`| `12`                    |
| `stallTurns` | `OPENCODE_GOAL_STALL_TURNS`| `3`                    |
| `checkModel` | `OPENCODE_GOAL_CHECK_MODEL`| session's active model  |
| `off`        | `OPENCODE_GOAL_OFF=1`     | `false`                 |

## Behavior notes

- State is persisted via plugin storage keyed by session ID and restored on load.
- Evaluation runs at turn completion (`session.idle`); continuation is scheduled as a new queued turn.
- Status is communicated through `[opencode-goal]` session messages.
- `/goal clear` / `reset` / `off` stops and clears the goal.

MIT — see [LICENSE](LICENSE).
