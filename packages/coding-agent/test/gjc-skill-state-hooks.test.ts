import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	mergeGjcManagedCodexHooksConfig,
	readGjcManagedCodexHooksStatus,
} from "../src/hooks/codex-native-hooks-config";
import { dispatchGjcNativeSkillHook } from "../src/hooks/native-skill-hook";
import { detectSkillKeywords, readVisibleSkillActiveState } from "../src/hooks/skill-state";

describe("GJC native skill-state hooks", () => {
	let tempDir: string | undefined;

	afterEach(async () => {
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	async function cwd(): Promise<string> {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-skill-hooks-"));
		return tempDir;
	}

	it("detects only the public GJC workflow skill surface", () => {
		expect(detectSkillKeywords("$deep-interview then $team").map(match => match.skill)).toEqual([
			"deep-interview",
			"team",
		]);
		expect(detectSkillKeywords("$autopilot deep interview")).toEqual([]);
		expect(detectSkillKeywords("please run a consensus plan")[0]?.skill).toBe("ralplan");
	});

	it("UserPromptSubmit persists session-scoped skill-active and mode state", async () => {
		const root = await cwd();
		const result = await dispatchGjcNativeSkillHook({
			hook_event_name: "UserPromptSubmit",
			prompt: "$deep-interview clarify this feature",
			cwd: root,
			session_id: "session-1",
			thread_id: "thread-1",
			turn_id: "turn-1",
		});

		expect(result.hookEventName).toBe("UserPromptSubmit");
		expect(result.outputJson?.hookSpecificOutput).toMatchObject({ hookEventName: "UserPromptSubmit" });
		const state = await readVisibleSkillActiveState(root, "session-1");
		expect(state).toMatchObject({
			active: true,
			skill: "deep-interview",
			keyword: "$deep-interview",
			session_id: "session-1",
			initialized_mode: "deep-interview",
		});
		expect(state?.initialized_state_path).toBe(
			path.join(root, ".gjc", "state", "sessions", "session-1", "deep-interview-state.json"),
		);
		const modeState = await Bun.file(state?.initialized_state_path ?? "").json();
		expect(modeState).toMatchObject({ active: true, current_phase: "interviewing", session_id: "session-1" });
	});

	it("encodes hook session ids before writing skill and mode state paths", async () => {
		const root = await cwd();
		await dispatchGjcNativeSkillHook({
			hookEventName: "UserPromptSubmit",
			userPrompt: "$team coordinate this",
			cwd: root,
			sessionId: "../../../escape",
			threadId: "thread-safe",
		});

		const encodedSession = "%2E%2E%2F%2E%2E%2F%2E%2E%2Fescape";
		const state = await readVisibleSkillActiveState(root, "../../../escape");
		expect(state?.initialized_state_path).toBe(
			path.join(root, ".gjc", "state", "sessions", encodedSession, "team-state.json"),
		);
		expect(
			await fs.stat(path.join(root, ".gjc", "state", "sessions", encodedSession, "skill-active-state.json")),
		).toBeDefined();
		await expect(fs.stat(path.join(root, ".gjc", "escape"))).rejects.toThrow();
	});

	it("Stop blocks while matching skill state is active and allows terminal mode state", async () => {
		const root = await cwd();
		await dispatchGjcNativeSkillHook({
			hookEventName: "UserPromptSubmit",
			userPrompt: "$ralplan plan this",
			cwd: root,
			sessionId: "session-2",
			threadId: "thread-2",
		});

		const blocked = await dispatchGjcNativeSkillHook({
			hookEventName: "Stop",
			cwd: root,
			sessionId: "session-2",
			threadId: "thread-2",
		});
		expect(blocked.outputJson).toMatchObject({ decision: "block", stopReason: "gjc_skill_ralplan_planning" });

		await Bun.write(
			path.join(root, ".gjc", "state", "sessions", "session-2", "ralplan-state.json"),
			JSON.stringify({ active: false, current_phase: "complete", session_id: "session-2" }),
		);
		const allowed = await dispatchGjcNativeSkillHook({
			hookEventName: "Stop",
			cwd: root,
			sessionId: "session-2",
			threadId: "thread-2",
		});
		expect(allowed.outputJson).toBeNull();
	});

	it("UserPromptSubmit reminds active Ultragoal sessions to use ultragoal steer", async () => {
		const root = await cwd();
		await dispatchGjcNativeSkillHook({
			hookEventName: "UserPromptSubmit",
			userPrompt: "$ultragoal plan this",
			cwd: root,
			sessionId: "session-ultra",
			threadId: "thread-ultra",
		});

		const result = await dispatchGjcNativeSkillHook({
			hookEventName: "UserPromptSubmit",
			userPrompt: "Add a blocker-resolution subgoal based on the failed smoke test",
			cwd: root,
			sessionId: "session-ultra",
			threadId: "thread-ultra",
		});

		expect(result.outputJson?.hookSpecificOutput).toMatchObject({ hookEventName: "UserPromptSubmit" });
		const context = String(
			(result.outputJson?.hookSpecificOutput as { additionalContext?: unknown } | undefined)?.additionalContext ??
				"",
		);
		expect(context).toContain("Ultragoal is active");
		expect(context).toContain("gjc ultragoal steer");
		expect(context).toContain("add or steer subgoals");
	});

	it("UserPromptSubmit includes steer guidance when activating Ultragoal", async () => {
		const root = await cwd();
		const result = await dispatchGjcNativeSkillHook({
			hookEventName: "UserPromptSubmit",
			userPrompt: "$ultragoal plan this",
			cwd: root,
			sessionId: "session-ultra-start",
			threadId: "thread-ultra-start",
		});
		const context = String(
			(result.outputJson?.hookSpecificOutput as { additionalContext?: unknown } | undefined)?.additionalContext ??
				"",
		);
		expect(context).toContain("Ultragoal is active");
		expect(context).toContain("gjc ultragoal steer");
	});

	it("merges managed Codex UserPromptSubmit/Stop hooks without dropping user hooks", () => {
		const existing = JSON.stringify({
			hooks: {
				UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo user-prompt" }] }],
				Stop: [
					{ hooks: [{ type: "command", command: "gjc codex-native-hook" }] },
					{ hooks: [{ type: "command", command: "echo user-stop" }] },
				],
			},
		});

		const merged = mergeGjcManagedCodexHooksConfig(existing);
		const parsed = JSON.parse(merged.content) as {
			hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
		};

		expect(parsed.hooks.UserPromptSubmit?.flatMap(entry => entry.hooks.map(hook => hook.command))).toEqual([
			"gjc codex-native-hook",
			"echo user-prompt",
		]);
		expect(parsed.hooks.Stop?.flatMap(entry => entry.hooks.map(hook => hook.command))).toEqual([
			"gjc codex-native-hook",
			"echo user-stop",
		]);
		expect(readGjcManagedCodexHooksStatus(merged.content, "/tmp/hooks.json")).toMatchObject({
			installed: true,
			missingEvents: [],
			managedHookCount: 2,
		});
	});
});
