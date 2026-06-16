# @gajae-code/telegram-remote

A tiny, safe **Telegram operator remote** for Gajae-Code (`gjc`) sessions — v0 of
[issue #681](https://github.com/Yeachan-Heo/gajae-code/issues/681), implementing the
contract fixed in [`docs/telegram-remote.md`](../../docs/telegram-remote.md).

This is a **command + bounded-read** gateway over the **Coordinator MCP**, for session
**lifecycle and observation** from a phone. It is deliberately **not** a remote RPC
cockpit, a remote shell, a config editor, or a transcript viewer. The real session owner
stays GJC/tmux/harness-side; Telegram is only the control button.

## What it does

Five commands, mapped onto Coordinator MCP tool calls:

| Command | Intent | Mutation |
| --- | --- | --- |
| `/sessions` | List live/recent sessions with concise bounded status | none (read) |
| `/observe <sessionId>` | One session's bounded public-safe status slice | none (read) |
| `/start-session <presetId> [task]` | Start a session from an **approved preset** | `sessions` |
| `/stop <sessionId>` | Request a graceful stop (confirmation required) | `reports` |
| `/help` | Show the command set | none |

Everything outside this vocabulary is rejected as unknown.

## Safety properties

- **Default deny.** Only an explicit allowlist of Telegram user/chat ids may issue any
  command. Unlisted senders get an identical, boring refusal — no hints, no enumeration.
- **Preset-only creation.** A preset binds a fixed workdir + fixed session command +
  optional fixed task template with a single length-capped, control-char-stripped
  `{{task}}` slot. No workdir/command/branch/repo/shell/raw-RPC ever comes from chat.
- **Fail-closed mutations.** The coordinator runs with the smallest mutation set
  (`sessions`, plus `reports` only when `/stop` is enabled). `questions` is never enabled.
- **Redaction by construction.** Only a typed projection (session id, derived name,
  bounded status enum, branch, timestamps, bounded turn/lifecycle enum, short sanitized
  blocker) leaves the PC. Raw tmux tail, transcripts, tool IO, diffs, file contents, env,
  system prompt, tokens/secrets, and absolute paths are never transmitted.
- **Confirmation for `/stop`.** A `/stop <id>` arms; a second `/stop <id> confirm` (or the
  inline **Confirm stop** button) records the coordinator terminal `cancelled` status. `/stop`
  does **not** kill a tmux process.

## Rich messaging (optional)

When `GJC_TELEGRAM_REMOTE_ENABLE_RICH` is on (default), replies use HTML formatting and inline
keyboards as a **presentation + alternate-entry layer** — never a new action surface:

- `/sessions` and `/observe` render with bold labels and `<code>` ids and carry **Observe** /
  **Stop** / **Refresh** buttons; `/stop` and the Stop button offer **Confirm stop** / **Cancel**.
- `/start` is friendly onboarding; the Bot command menu (`setMyCommands`) registers
  `sessions`, `observe`, `stop`, `help`, `start` — it cannot register hyphenated `/start-session`,
  which `/help` documents.
- **Callbacks reuse the same surface.** Button presses re-enter the same gateway handlers and the
  same `CoordinatorClient` → Coordinator MCP calls as text commands. No second control protocol.
- **Callback security.** Callback queries pass the same default-deny allowlist. `callback_data` is
  only an opaque `gtr:v1:<token>` (≤64 bytes, never the session id); the exact raw session id lives
  in TTL-bound, chat/user-bound, single-use server-side token metadata. Unauthorized, expired,
  malformed, missing-chat, replayed, and cancel callbacks are **answer-only** (a toast, no chat
  message, no backend call). Every callback is answered (`answerCallbackQuery`).
- **No push notifications.** Rich UI does **not** proactively notify; check with `/sessions` or the
  Refresh button. Push is deferred until a `gjc_coordinator_watch_events`-based design lands — it
  must reuse that existing event surface, not a Telegram-side poller.

Set `GJC_TELEGRAM_REMOTE_ENABLE_RICH=false` to fall back to plain text.

## RPC mode (single persistent session)

Set `GJC_TELEGRAM_REMOTE_BACKEND=rpc` to make the gateway dial one existing
owner-only UNIX socket exposed by `gjc launch --output rpc`. The gateway never
spawns, kills, or tears down that session; it is only a Telegram attach/detach
remote keyboard for the already-running RPC-mode session.

RPC mode exposes only `/attach`, `/detach`, `/status`, `/abort`, `/help`, and
`/start`. Coordinator browsing and lifecycle commands are not available:
`/sessions`, `/observe`, `/presets`, `/start-session`, and `/stop` are rejected
as unknown in RPC mode. When Bot command registration is enabled, the menu
advertises only the RPC command set.

The RPC surface is event-driven: agent questions and gates render as inline
buttons; turn-complete delivery sends only the final assistant text, HTML-escaped
and chunked to Telegram's 4096-byte message limit; session exit or liveness
timeout sends exactly one stale-attachment alert.

The socket OS-ownership boundary is the real security boundary. Same-UID clients
are fully trusted in v1; protection is for different-UID users and unsafe
filesystem placement. Controller ownership is last-connected-wins: a later UDS
client becomes current, old-socket writes are ignored or time out, and the
gateway alerts once, reconnects, and resyncs.

RPC knobs: `GJC_TELEGRAM_REMOTE_BACKEND=rpc`,
`GJC_TELEGRAM_REMOTE_RPC_SOCKET=/path/to/gjc-rpc.sock`,
`GJC_TELEGRAM_REMOTE_STATE_DIR=/path/to/state` (required in RPC mode for
reconnect/resync), `GJC_TELEGRAM_REMOTE_LIVENESS_MS=60000`, and
`GJC_TELEGRAM_REMOTE_ALLOW_ATTACH_SOCKET_ARG=false`. See `.env.example`.

## Run it

```sh
export GJC_TELEGRAM_REMOTE_BOT_TOKEN="123456:telegram-bot-token"
export GJC_TELEGRAM_REMOTE_ALLOWED_USER_IDS="11111111"   # comma-separated
export GJC_TELEGRAM_REMOTE_PRESETS='[
  {"id":"proj","workdir":"/home/bot/src/project","sessionCommand":"gjc --worktree",
   "taskTemplate":"Use /skill:ralplan to plan: {{task}}","taskMaxLen":2000}
]'
export GJC_TELEGRAM_REMOTE_ENABLE_STOP="true"            # optional; enables /stop

bun run start
```

The service spawns `gjc mcp-serve coordinator` with a forced, smallest mutation set and
long-polls the Telegram Bot API. See `.env.example` for every variable.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GJC_TELEGRAM_REMOTE_BOT_TOKEN` | **Required.** Telegram bot token. |
| `GJC_TELEGRAM_REMOTE_ALLOWED_USER_IDS` | Comma-separated allowlist of Telegram user ids. |
| `GJC_TELEGRAM_REMOTE_ALLOWED_CHAT_IDS` | Comma-separated allowlist of chat ids. At least one allowlist is required. |
| `GJC_TELEGRAM_REMOTE_PRESETS` | JSON array of presets (`id`, `workdir`, `sessionCommand`, `taskTemplate?`, `taskMaxLen?`). |
| `GJC_TELEGRAM_REMOTE_ENABLE_STOP` | `true`/`1`/`yes` to enable `/stop` (adds the `reports` mutation class). |
| `GJC_TELEGRAM_REMOTE_ENABLE_RICH` | Enable HTML + inline keyboards (default `true`; `false` for plain text). |
| `GJC_TELEGRAM_REMOTE_RICH_CALLBACK_TTL_MS` | TTL for observe/refresh/arm callback tokens (default `600000`). |
| `GJC_TELEGRAM_REMOTE_RICH_CALLBACK_MAX_TOKENS` | Max in-memory callback tokens (default `500`). |
| `GJC_TELEGRAM_REMOTE_ENABLE_EDIT_MESSAGE_TEXT` | Refresh `/observe` in place via `editMessageText` (default `false`; falls back to a new message). |
| `GJC_TELEGRAM_REMOTE_REGISTER_COMMANDS` | Register the Bot command menu at startup (default `true`). |
| `GJC_TELEGRAM_REMOTE_DEFAULT_TASK_MAX_LEN` | Default per-preset task cap (default `2000`). |
| `GJC_TELEGRAM_REMOTE_POLL_TIMEOUT_SEC` | Bot API long-poll timeout (default `30`). |
| `GJC_TELEGRAM_REMOTE_API_BASE` | Override the Telegram API base URL. |
| `GJC_TELEGRAM_REMOTE_COORDINATOR_COMMAND` | Coordinator command (default `gjc`). |
| `GJC_TELEGRAM_REMOTE_COORDINATOR_ARGS` | Coordinator args (default `mcp-serve,coordinator`). |
| `GJC_COORDINATOR_MCP_WORKDIR_ROOTS` | Optional explicit workdir allowlist; derived from presets otherwise. |
| `GJC_COORDINATOR_MCP_SESSION_COMMAND` | Optional explicit session command; derived from presets otherwise. |
| `GJC_COORDINATOR_MCP_PROFILE` / `_REPO` / `_STATE_ROOT` / `_ARTIFACT_BYTE_CAP` | Passed through to the coordinator namespace/state config. |

`GJC_COORDINATOR_MCP_MUTATIONS` is **forced** by the gateway and cannot be widened from the
environment: `sessions` (read + start) or `sessions,reports` (with `/stop`). `questions` is
never enabled.

## Status

v0, roadmap scope. Lifecycle + observation only; no submit surface and no remote teardown. Optional
rich messaging (inline keyboards, HTML, callback queries) is a presentation + alternate-entry layer
over the same Coordinator MCP surface; push notifications are deferred until a
`gjc_coordinator_watch_events`-based design lands. See [`docs/telegram-remote.md`](../../docs/telegram-remote.md)
for the full contract, deferred decisions, and non-goals.
