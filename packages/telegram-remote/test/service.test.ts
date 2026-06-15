import { describe, expect, test } from "bun:test";
import type { ServiceConfig } from "../src/config";
import { MESSAGES, UNAUTHORIZED_REFUSAL } from "../src/messages";
import { runService } from "../src/service";
import type { CoordinationStatus, IncomingUpdate } from "../src/types";
import { FakeCoordinatorClient, FakeTransport, preset, presetMap } from "./helpers";

function serviceConfig(overrides: Partial<ServiceConfig["policy"]> = {}): ServiceConfig {
	return {
		botToken: "x",
		pollTimeoutSec: 1,
		enableEditMessageText: false,
		registerBotCommands: false,
		policy: {
			allowedUserIds: new Set(["100"]),
			allowedChatIds: new Set(),
			presets: presetMap(preset()),
			enableStop: true,
			...overrides,
		},
		coordinator: { command: "gjc", args: ["mcp-serve", "coordinator"], env: {} },
	};
}

function liveStatus(): CoordinationStatus {
	return {
		ok: true,
		sessions: [{ session_id: "sess-1", branch: "main" }],
		sessionStates: [{ session_id: "sess-1", state: "running", live: true }],
		turns: [{ session_id: "sess-1", status: "active", turn_id: "turn-1" }],
	};
}

describe("runService end-to-end (fake transport + fake coordinator)", () => {
	test("plain mode drives the command loop and replies per the contract", async () => {
		const coordinator = new FakeCoordinatorClient();
		coordinator.status = liveStatus();

		const inbox: IncomingUpdate[] = [
			{ kind: "message", userId: "100", chatId: "100", text: "/help" },
			{ kind: "message", userId: "100", chatId: "100", text: "/sessions" },
			{ kind: "message", userId: "100", chatId: "100", text: "/start-session demo build it" },
			{ kind: "message", userId: "666", chatId: "666", text: "/sessions" },
		];
		const transport = new FakeTransport(inbox);

		await runService(serviceConfig({ enableRichMessages: false }), { coordinator, transport });

		expect(transport.sent[0]?.text).toBe(MESSAGES.help);
		expect(transport.sent[1]?.text).toContain("sess-1");
		expect(transport.sent[2]?.text).toContain("sess-1");
		expect(transport.sent[3]?.text).toBe(UNAUTHORIZED_REFUSAL);
		// Plain mode: no parse mode or inline keyboard.
		const sessionsReply = transport.sent[1]?.reply;
		expect(typeof sessionsReply === "object" && sessionsReply.kind === "chat" && sessionsReply.parseMode).toBeFalsy();
		expect(coordinator.countOf("startSession")).toBe(1);
	});

	test("rich mode returns an HTML reply with an inline keyboard for /sessions", async () => {
		const coordinator = new FakeCoordinatorClient();
		coordinator.status = liveStatus();
		const transport = new FakeTransport([{ kind: "message", userId: "100", chatId: "100", text: "/sessions" }]);

		await runService(serviceConfig({ enableRichMessages: true }), { coordinator, transport });

		const reply = transport.sent[0]?.reply;
		expect(typeof reply === "object" && reply.kind === "chat").toBe(true);
		if (typeof reply === "object" && reply.kind === "chat") {
			expect(reply.parseMode).toBe("HTML");
			expect(reply.replyMarkup?.inline_keyboard.length).toBe(1);
			expect(reply.text).toContain("<code>");
		}
	});
});
