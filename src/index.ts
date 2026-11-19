/**
 * opencode-goal — Claude Code /goal behavior for OpenCode V2.
 *
 * `/goal <condition>` arms a session goal and immediately starts a turn with
 * the condition as the directive. After every finished turn a cheap verifier
 * model judges the condition against a bounded transcript digest:
 *
 *   NOT_DONE    -> continue with the reason as guidance for the next turn
 *   DONE        -> record an achieved message, clear the goal
 *   UNREACHABLE -> record a failed message, clear the goal
 *
 * No tool use for several turns pauses the loop but KEEPS the goal; the next
 * prompt resumes evaluation. A failed turn keeps the goal armed; an interrupted
 * turn is skipped silently. State is persisted with ctx.storage and restored
 * on plugin load / first use per session.
 *
 * Config: plugin options (object form in opencode.jsonc) with env fallback:
 *   maxChecks  / OPENCODE_GOAL_MAX_CHECKS  (default 12)
 *   stallTurns / OPENCODE_GOAL_STALL_TURNS (default 3)
 *   checkModel / OPENCODE_GOAL_CHECK_MODEL (default: session's active model)
 *   off        / OPENCODE_GOAL_OFF=1       (disable all checking)
 */
import { Plugin } from "@opencode/plugin"

const DIGEST_MSG_CHARS = 400
const DIGEST_MAX_CHARS = 10_000
const DIGEST_LAST_MESSAGES = 40
const STORAGE_PREFIX = "goal:"

const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"])

type Verdict = "DONE" | "NOT_DONE" | "UNREACHABLE"

interface GoalState {
  goal: string | null
  checks: number
  turns: number
  startedAt: number
  spentTokens: number
  lastReason: string | null
  achieved: string | null
  idleTurns: number
  failures: number
  evalPending: boolean
  deferredNotice: boolean
}

interface PluginOptions {
  maxChecks?: unknown
  stallTurns?: unknown
  checkModel?: unknown
  off?: unknown
}

interface ModelRef {
  providerID: string
  id: string
}

const freshState = (): GoalState => ({
  goal: null,
  checks: 0,
  turns: 0,
  startedAt: 0,
  spentTokens: 0,
  lastReason: null,
  achieved: null,
  idleTurns: 0,
  failures: 0,
  evalPending: false,
  deferredNotice: false,
})

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`
}

/** Compact a stored message for the digest; tool calls keep name + short args. */
function compactMessage(m: unknown): string {
  if (typeof m === "string") return m.slice(0, DIGEST_MSG_CHARS)
  if (m === null || typeof m !== "object") return String(m).slice(0, DIGEST_MSG_CHARS)
  const msg = m as Record<string, unknown>
  const type = typeof msg.type === "string" ? msg.type : ""
  const role = typeof msg.role === "string" ? msg.role : type || "message"
  const raw = msg.content ?? msg.parts
  if (typeof raw === "string") return `${role}: ${raw.slice(0, DIGEST_MSG_CHARS)}`
  if (typeof msg.text === "string" && !Array.isArray(raw))
    return `${role}: ${msg.text.slice(0, DIGEST_MSG_CHARS)}`
  if (!Array.isArray(raw)) return `${role}: ${JSON.stringify(raw ?? msg).slice(0, DIGEST_MSG_CHARS)}`

  const parts: string[] = []
  for (const b of raw) {
    if (typeof b === "string") {
      parts.push(b.slice(0, DIGEST_MSG_CHARS))
      continue
    }
    if (b === null || typeof b !== "object") continue
    const block = b as Record<string, unknown>
    const bt = typeof block.type === "string" ? block.type : ""
    if (bt === "text" && typeof block.text === "string")
      parts.push(block.text.slice(0, DIGEST_MSG_CHARS))
    else if (bt === "tool" || bt === "toolCall" || bt === "tool-call") {
      const detail = block.state ?? block.input ?? block.arguments ?? {}
      parts.push(`[tool ${String(block.name ?? "?")}: ${JSON.stringify(detail).slice(0, 160)}]`)
    } else if (bt === "reasoning") {
      // Keep the verifier cheap: reasoning traces are not evidence.
    } else if (typeof block.text === "string") {
      parts.push(block.text.slice(0, DIGEST_MSG_CHARS))
    }
  }
  return `${role}: ${parts.join(" | ").slice(0, DIGEST_MSG_CHARS * 2)}`
}

/** Last N messages, newest last, hard-capped so the check stays cheap. */
function buildDigest(messages: readonly unknown[]): string {
  const lines = messages.slice(-DIGEST_LAST_MESSAGES).map(compactMessage)
  let digest = lines.join("\n")
  if (digest.length > DIGEST_MAX_CHARS) digest = `…(truncated)…\n${digest.slice(-DIGEST_MAX_CHARS)}`
  return digest
}

function parseVerdict(text: string): { verdict: Verdict; reason: string } | null {
  const m = text.match(/VERDICT\s*:\s*(DONE|NOT_DONE|UNREACHABLE)/i)
  if (!m) return null
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ")
  return { verdict: m[1].toUpperCase() as Verdict, reason: firstLine.slice(0, 300) }
}

function hasToolUse(messages: readonly unknown[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || typeof m !== "object") continue
    const msg = m as Record<string, unknown>
    if (msg.type !== "assistant" && msg.role !== "assistant") continue
    const raw = msg.content ?? msg.parts
    if (!Array.isArray(raw)) continue
    return raw.some((b) => {
      if (!b || typeof b !== "object") return false
      const bt = (b as Record<string, unknown>).type
      return bt === "tool" || bt === "toolCall" || bt === "tool-call"
    })
  }
  return false
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function sessionIDOf(event: unknown): string | undefined {
  const e = event as {
    sessionID?: string
    data?: { sessionID?: string }
    properties?: { sessionID?: string }
  }
  return e.sessionID ?? e.data?.sessionID ?? e.properties?.sessionID
}

export default Plugin.define({
  id: "opencode-goal",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as unknown as PluginOptions
    const env = process.env
    const MAX_CHECKS = asNumber(options.maxChecks ?? env.OPENCODE_GOAL_MAX_CHECKS, 12)
    const STALL_TURNS = asNumber(options.stallTurns ?? env.OPENCODE_GOAL_STALL_TURNS, 3)
    const CHECK_MODEL =
      (typeof options.checkModel === "string" && options.checkModel.trim()) ||
      env.OPENCODE_GOAL_CHECK_MODEL?.trim() ||
      undefined
    const OFF = options.off === true || env.OPENCODE_GOAL_OFF === "1"
    if (OFF) return

    const states = new Map<string, GoalState>()
    const busy = new Set<string>()
    const key = (sessionID: string) => `${STORAGE_PREFIX}${sessionID}`

    // Restore armed goals. Like the pi original, counters restart fresh.
    try {
      const page = await ctx.storage.scan({ prefix: STORAGE_PREFIX })
      for (const entry of page.entries) {
        const saved = entry.value as unknown as { goal?: unknown } | undefined
        if (!saved || typeof saved.goal !== "string" || saved.goal.length === 0) continue
        const state = freshState()
        state.goal = saved.goal
        state.startedAt = Date.now()
        states.set(entry.key.slice(STORAGE_PREFIX.length), state)
      }
    } catch {
      /* restore is best effort */
    }

    const ensure = async (sessionID: string): Promise<GoalState> => {
      const existing = states.get(sessionID)
      if (existing) return existing
      const state = freshState()
      try {
        const saved = (await ctx.storage.get(key(sessionID))) as unknown as
          | { goal?: unknown }
          | undefined
        if (saved && typeof saved.goal === "string" && saved.goal.length > 0) {
          state.goal = saved.goal
          state.startedAt = Date.now()
        }
      } catch {
        /* restore is best effort */
      }
      states.set(sessionID, state)
      return state
    }

    const persist = async (sessionID: string, state: GoalState) => {
      try {
        if (state.goal) {
          await ctx.storage.set(key(sessionID), {
            v: 1,
            goal: state.goal,
            checks: state.checks,
            turns: state.turns,
            startedAt: state.startedAt,
            spentTokens: state.spentTokens,
            lastReason: state.lastReason,
            achieved: state.achieved,
          })
        } else {
          await ctx.storage.remove(key(sessionID))
        }
      } catch {
        /* persistence is best effort */
      }
    }

    /** Visible user-facing message (the server part has no toast/status API). */
    const notify = async (sessionID: string, text: string) => {
      try {
        await ctx.session.synthetic({
          sessionID,
          text: `[opencode-goal] ${text}`,
          resume: false, // display only — do not schedule another turn
        })
      } catch {
        /* notifications are best effort */
      }
    }

    const statusLine = (state: GoalState): string => {
      if (!state.goal)
        return state.achieved ? `goal: none (last achieved: ${state.achieved})` : "goal: none"
      const elapsed = fmtElapsed(Date.now() - state.startedAt)
      const last = state.lastReason ? `\nlast: ${state.lastReason}` : ""
      return (
        `goal: ${state.goal}\n` +
        `elapsed ${elapsed}, turns ${state.turns}, checks ${state.checks}/${MAX_CHECKS}${last}`
      )
    }

    const clearGoal = async (sessionID: string, state: GoalState) => {
      state.goal = null
      state.checks = 0
      state.turns = 0
      state.lastReason = null
      state.idleTurns = 0
      state.failures = 0
      state.evalPending = false
      state.deferredNotice = false
      await persist(sessionID, state)
    }

    /** Verifier model: explicit checkModel, else the session's active model. */
    const resolveCheckModel = async (sessionID: string): Promise<ModelRef | undefined> => {
      if (CHECK_MODEL) {
        const sep = CHECK_MODEL.indexOf(":")
        if (sep > 0) return { providerID: CHECK_MODEL.slice(0, sep), id: CHECK_MODEL.slice(sep + 1) }
        try {
          const models = await ctx.model.list()
          const match = models.find((m) => m.id === CHECK_MODEL)
          if (match) return { providerID: match.providerID, id: match.id }
        } catch {
          /* fall through */
        }
      }
      try {
        const session = await ctx.session.get({ sessionID })
        const model = session?.model as { providerID?: string; id?: string } | undefined
        if (model?.providerID && model.id) return { providerID: model.providerID, id: model.id }
      } catch {
        /* fall through */
      }
      // Omitting `model` lets OpenCode use the configured default model.
      return undefined
    }

    /** One stateless verifier call. Throws on failure so the caller fails open. */
    const verify = async (sessionID: string, state: GoalState, messages: readonly unknown[]) => {
      const digest = buildDigest(messages)
      const elapsed = fmtElapsed(Date.now() - state.startedAt)
      const prompt =
        `You are a goal evaluator. Judge ONLY what the transcript below demonstrates — do not assume unseen work.\n` +
        `GOAL: ${state.goal}\n` +
        `PROGRESS: turn ${state.turns + 1} of evaluation, ${state.checks} checks used of ${MAX_CHECKS} max, elapsed ${elapsed}.\n` +
        `Reply with exactly one line "VERDICT: DONE" (transcript proves the goal), ` +
        `"VERDICT: NOT_DONE" (work remains), or "VERDICT: UNREACHABLE" (can never be satisfied), ` +
        `followed by one short sentence of evidence or the next missing piece.\n` +
        `A turn/time clause in the goal ("stop after N turns") counts as a binding bound: judge it from this PROGRESS line.\n` +
        `TRANSCRIPT DIGEST (oldest first):\n${digest}`
      const model = await resolveCheckModel(sessionID)
      const result = model
        ? await ctx.experimental.generate.text({ model, prompt })
        : await ctx.experimental.generate.text({ prompt })
      const text = typeof result?.text === "string" ? result.text : ""
      state.checks++
      return parseVerdict(text)
    }

    const evaluate = async (sessionID: string) => {
      if (busy.has(sessionID)) return
      const state = await ensure(sessionID)
      if (!state.goal) return
      busy.add(sessionID)
      try {
        // Turn-level guards: only a succeeded turn is audited.
        let outcome: string | undefined
        try {
          outcome = (await ctx.session.get({ sessionID }))?.outcome
        } catch {
          /* treat unknown outcome as succeeded */
        }
        if (outcome === "failed") {
          await notify(sessionID, `turn failed — goal kept: ${state.goal}. Send a message to resume.`)
          return
        }
        if (outcome === "interrupted") return

        let messages: readonly unknown[] = []
        try {
          messages = await ctx.session.context({ sessionID })
        } catch {
          /* no transcript: verifier will fail open */
        }

        let parsed: { verdict: Verdict; reason: string } | null = null
        try {
          parsed = await verify(sessionID, state, messages)
        } catch {
          parsed = null
        }
        state.evalPending = false

        if (!parsed) {
          state.failures++
          if (state.failures >= 3) {
            await notify(sessionID, `goal check failed ${state.failures}x — goal paused, re-arm with /goal.`)
            await clearGoal(sessionID, state)
          } else {
            await notify(sessionID, "goal check failed — settling (fail open).")
            await persist(sessionID, state)
          }
          return
        }

        state.failures = 0
        state.turns++
        state.lastReason = parsed.reason

        if (parsed.verdict === "DONE") {
          await notify(
            sessionID,
            `✓ Goal achieved in ${state.turns} turn(s) / ${state.checks} check(s): ${state.goal}\nEvidence: ${parsed.reason}`,
          )
          state.achieved = state.goal
          await clearGoal(sessionID, state)
          return
        }

        if (parsed.verdict === "UNREACHABLE") {
          await notify(sessionID, `✗ Goal failed (unreachable): ${state.goal}\nBlocker: ${parsed.reason}`)
          await clearGoal(sessionID, state)
          return
        }

        // NOT_DONE: stall detection first — no tool use for several turns
        // pauses the loop but KEEPS the goal; the next prompt resumes it.
        state.idleTurns = hasToolUse(messages) ? 0 : state.idleTurns + 1
        if (state.idleTurns >= STALL_TURNS) {
          state.idleTurns = 0
          await notify(
            sessionID,
            `no progress for ${STALL_TURNS} turns (no tool use) — Paused with goal still set: ${state.goal}. Send a message to resume.`,
          )
          await persist(sessionID, state)
          return
        }

        if (state.checks >= MAX_CHECKS) {
          await notify(
            sessionID,
            `gave up after ${MAX_CHECKS} checks — still not done: ${state.goal}. Re-arm with /goal to continue.`,
          )
          await clearGoal(sessionID, state)
          return
        }

        const guidance =
          `[opencode-goal] Goal not yet met (turn ${state.turns}, check ${state.checks}/${MAX_CHECKS}): ${state.goal}\n` +
          `Evaluator: ${parsed.reason}\n` +
          `Keep working toward the goal. State the verifiable outcome (test output, build exit code, file state) in your reply.`
        await persist(sessionID, state)
        // A new prompt is the OpenCode equivalent of pi's event.continue = true:
        // it shows the guidance in the transcript and starts the next turn.
        await ctx.session.prompt({ sessionID, text: guidance, delivery: "queue" })
      } finally {
        busy.delete(sessionID)
      }
    }

    // Register the /goal command.
    await ctx.command.transform((editor) => {
      editor.add({
        name: "goal",
        description:
          "Set a completion condition; OpenCode keeps working across turns until a verifier confirms it",
        execute: async ({ sessionID, prompt, delivery }) => {
          let text = (prompt?.text ?? "").trim()
          if (/^\/goal\b/i.test(text)) text = text.replace(/^\/goal\b/i, "").trim()
          const state = await ensure(sessionID)

          if (!text) {
            await notify(sessionID, statusLine(state))
            return
          }

          const words = text.split(/\s+/)
          if (CLEAR_ALIASES.has(words[0].toLowerCase()) && words.length === 1) {
            if (state.goal) await notify(sessionID, `Goal cleared: ${state.goal}`)
            else await notify(sessionID, "goal: no goal set")
            await clearGoal(sessionID, state)
            return
          }

          if (text.length > 4000) {
            await notify(sessionID, "condition too long (max 4000 chars).")
            return
          }

          if (state.goal) await notify(sessionID, `replacing active goal — ${state.goal}`)
          state.goal = text
          state.checks = 0
          state.turns = 0
          state.startedAt = Date.now()
          state.spentTokens = 0
          state.lastReason = null
          state.idleTurns = 0
          state.failures = 0
          state.evalPending = false
          state.deferredNotice = false
          await persist(sessionID, state)
          await notify(sessionID, `goal set — ${text}`)

          // Arming starts a turn immediately with the condition as directive.
          try {
            await ctx.session.prompt({
              sessionID,
              text:
                `[opencode-goal] Work toward this goal until it is verifiably met. ` +
                `State the verifiable outcome in your replies.\nGoal: ${text}`,
              delivery,
            })
          } catch {
            await notify(sessionID, "could not start the turn — send any message to begin.")
          }
        },
      })
    })

    // Turn boundary: session.idle fires once when the agent loop finishes a
    // turn. (session.status{type:"idle"} fires too, but subscribing to both
    // would double-evaluate; session.idle is the canonical single signal.)
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["session.idle"],
        signal: controller.signal,
      })) {
        const sessionID = sessionIDOf(event)
        if (sessionID) void evaluate(sessionID).catch(() => {})
      }
    })().catch(() => {})

    return () => controller.abort()
  },
})
