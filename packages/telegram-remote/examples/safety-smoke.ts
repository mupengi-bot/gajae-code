/**
 * Runnable safety smoke for the Telegram Remote gateway. Drives adversarial text
 * messages AND inline-keyboard callbacks through the gateway with an in-memory
 * coordinator (no bot token, no network, no real session backend) and asserts the
 * v0 + rich-message safety invariants hold. Prints a single deterministic line on
 * success so it can be replayed as CLI evidence; throws (non-zero exit) on any
 * violation.
 *
 *   bun packages/telegram-remote/examples/safety-smoke.ts
 */
import { TelegramRemoteGateway } from "../src/gateway";
import { UNAUTHORIZED_REFUSAL } from "../src/messages";
import type {
	CoordinationStatus,
	CoordinatorClient,
	IncomingCallbackQuery,
	IncomingMessage,
	OutgoingReply,
	ReportStatusResult,
	StartSessionResult,
	TelegramInlineKeyboardButton,
} from "../src/types";

const HOSTILE_STATUS: CoordinationStatus = {
	ok: true,
	sessions: [
		{
			session_id: "sess-1",
			branch: "feat/x",
			repo: "proj",
			cwd: "/secret/abs/path",
			tail_preview: ["SECRET_TAIL", "export TOKEN=sk-LEAK"],
			final_response: { text: "TRANSCRIPT_LEAK" },
		},
	],
	sessionStates: [{ session_id: "sess-1", state: "running", live: true, reason: "INTERNAL_LEAK" }],
	turns: [{ session_id: "sess-1", status: "active", turn_id: "turn-1", prompt: { text: "PROMPT_LEAK" } }],
};

const FORBIDDEN = ["SECRET_TAIL", "sk-LEAK", "TRANSCRIPT_LEAK", "PROMPT_LEAK", "/secret/abs/path"];

// Long, punctuation-heavy raw coordinator id that must survive unchanged through
// tokens/coordinator calls but never appear in callback_data or chat text.
const LONG_ID = `sess:gjc/feat-x&<unsafe>${"z".repeat(50)}`;

class SmokeCoordinator implements CoordinatorClient {
	startCalls = 0;
	reportCalls = 0;
	lastStartCwd = "";
	lastReportSessionId = "";
	constructor(private readonly status: CoordinationStatus) {}
	async getCoordinationStatus(): Promise<CoordinationStatus> {
		return this.status;
	}
	async startSession(input: { cwd: string; prompt?: string }): Promise<StartSessionResult> {
		this.startCalls++;
		this.lastStartCwd = input.cwd;
		return { ok: true, sessionId: "sess-new" };
	}
	async reportStatus(input: { sessionId: string }): Promise<ReportStatusResult> {
		this.reportCalls++;
		this.lastReportSessionId = input.sessionId;
		return { ok: true };
	}
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(`safety-smoke failed: ${message}`);
}

function asChat(reply: OutgoingReply): Extract<OutgoingReply, { kind: "chat" }> {
	assert(reply.kind === "chat", `expected chat reply, got ${reply.kind}`);
	return reply as Extract<OutgoingReply, { kind: "chat" }>;
}

function buttons(reply: OutgoingReply): TelegramInlineKeyboardButton[] {
	const chat = asChat(reply);
	return (chat.replyMarkup?.inline_keyboard ?? []).flat();
}

const msg = (userId: string, text: string): IncomingMessage => ({ kind: "message", userId, chatId: userId, text });
const cb = (userId: string, chatId: string, data: string): IncomingCallbackQuery => ({
	kind: "callback_query",
	userId,
	chatId,
	messageId: 1,
	callbackQueryId: "cb",
	data,
});

function richGateway(coordinator: CoordinatorClient): TelegramRemoteGateway {
	return new TelegramRemoteGateway(
		{
			allowedUserIds: new Set(["100"]),
			allowedChatIds: new Set(),
			presets: new Map([
				[
					"demo",
					{ id: "demo", workdir: "/home/bot/src/project", sessionCommand: "gjc --worktree", taskMaxLen: 50 },
				],
			]),
			enableStop: true,
			enableRichMessages: true,
		},
		{ coordinator },
	);
}

async function plainInvariants(): Promise<void> {
	const coordinator = new SmokeCoordinator(HOSTILE_STATUS);
	const gateway = richGateway(coordinator);

	// 1. Default deny: an intruder gets the identical boring refusal and no backend call.
	for (const text of ["/sessions", "/start-session demo x", "/stop sess-1 confirm"]) {
		assert((await gateway.handleMessage(msg("999", text))) === UNAUTHORIZED_REFUSAL, `intruder refused: ${text}`);
	}
	assert(coordinator.startCalls === 0 && coordinator.reportCalls === 0, "intruder triggered no mutation");

	// 2. Redaction: hostile coordinator fields never reach chat (plain or HTML).
	const listed = await gateway.handleMessage(msg("100", "/sessions"));
	const observed = await gateway.handleMessage(msg("100", "/observe sess-1"));
	for (const secret of FORBIDDEN) {
		assert(!listed.includes(secret), `list leaked ${secret}`);
		assert(!observed.includes(secret), `observe leaked ${secret}`);
	}

	// 3. Workdir injection: chat-supplied path never becomes the cwd.
	await gateway.handleMessage(msg("100", "/start-session demo /etc/shadow"));
	assert(coordinator.lastStartCwd === "/home/bot/src/project", "workdir bound to preset, not chat");

	// 4. Text /stop confirmation gating: arm does not mutate; only confirm does.
	await gateway.handleMessage(msg("100", "/stop sess-1"));
	assert(coordinator.reportCalls === 0, "arm did not mutate");
	await gateway.handleMessage(msg("100", "/stop sess-1 confirm"));
	assert(coordinator.reportCalls === 1, "confirm recorded exactly one cancel");
}

async function richCallbackInvariants(): Promise<void> {
	const status: CoordinationStatus = {
		ok: true,
		sessions: [{ session_id: LONG_ID, branch: "main", cwd: "/secret/abs/path" }],
		sessionStates: [{ session_id: LONG_ID, state: "running", live: true }],
		turns: [{ session_id: LONG_ID, status: "active", turn_id: "turn-x" }],
	};
	const coordinator = new SmokeCoordinator(status);
	const gateway = richGateway(coordinator);

	// 5. Rich /sessions: HTML + inline keyboard; callback_data is opaque and bounded.
	const sessions = asChat(await gateway.handleUpdate(msg("100", "/sessions")));
	assert(sessions.parseMode === "HTML", "rich /sessions is HTML");
	assert(!sessions.text.includes(LONG_ID), "raw id not in rendered text");
	const observeBtn = buttons(sessions).find(b => b.text.startsWith("Observe"));
	const stopBtn = buttons(sessions).find(b => b.text.startsWith("Stop"));
	assert(!!observeBtn && !!stopBtn, "observe + stop buttons present");
	for (const b of buttons(sessions)) {
		assert(Buffer.byteLength(b.callbackData, "utf8") <= 64, "callback_data <=64 bytes");
		assert(!b.callbackData.includes(LONG_ID), "callback_data never contains the raw id");
	}

	// 6. Observe callback: reuses read path, renders the exact-raw-id view, leaks nothing.
	const observed = asChat(
		await gateway.handleUpdate(cb("100", "100", (observeBtn as TelegramInlineKeyboardButton).callbackData)),
	);
	assert(observed.text.includes("status:"), "observe callback renders the view");
	for (const secret of FORBIDDEN) assert(!observed.text.includes(secret), `observe callback leaked ${secret}`);

	// 7. Stop arm -> confirm: exact raw id reaches the coordinator unchanged.
	const arm = asChat(
		await gateway.handleUpdate(cb("100", "100", (stopBtn as TelegramInlineKeyboardButton).callbackData)),
	);
	assert(coordinator.reportCalls === 0, "stop arm did not mutate");
	const confirmBtn = buttons(arm).find(b => b.text === "Confirm stop");
	assert(!!confirmBtn, "confirm button present");
	await gateway.handleUpdate(cb("100", "100", (confirmBtn as TelegramInlineKeyboardButton).callbackData));
	assert(coordinator.reportCalls === 1, "confirm recorded exactly one cancel");
	assert(coordinator.lastReportSessionId === LONG_ID, "coordinator received the EXACT raw id");

	// 8. Replay: a second confirm press is single-use and does not double-mutate.
	const replay = await gateway.handleUpdate(
		cb("100", "100", (confirmBtn as TelegramInlineKeyboardButton).callbackData),
	);
	assert(replay.kind === "callback_answer", "replayed confirm is answer-only");
	assert(coordinator.reportCalls === 1, "replay did not double-mutate");

	// 9. Unauthorized / forwarded callback: answer-only refusal, no backend call.
	const fresh = asChat(await gateway.handleUpdate(msg("100", "/sessions")));
	const freshObserve = buttons(fresh).find(b => b.text.startsWith("Observe")) as TelegramInlineKeyboardButton;
	const before = coordinator.reportCalls;
	const intruder = await gateway.handleUpdate(cb("999", "999", freshObserve.callbackData));
	assert(intruder.kind === "callback_answer", "unauthorized callback is answer-only");
	assert(
		intruder.kind === "callback_answer" && intruder.callbackAnswer.text === UNAUTHORIZED_REFUSAL,
		"boring refusal",
	);
	assert(coordinator.reportCalls === before, "unauthorized callback triggered no mutation");
}

async function main(): Promise<void> {
	await plainInvariants();
	await richCallbackInvariants();
	process.stdout.write("telegram-remote-safety-ok\n");
}

await main();
