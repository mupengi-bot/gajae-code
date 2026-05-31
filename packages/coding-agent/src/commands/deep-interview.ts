import { Command } from "@gajae-code/utils/cli";
import { syncSkillActiveState } from "../skill-state/active-state";
import { runGjcRuntimeBridgeWithHudSidecar } from "./gjc-runtime-bridge";

export default class DeepInterview extends Command {
	static description = "Run private GJC deep-interview bridge commands (requires GJC_RUNTIME_BINARY)";
	static strict = false;
	static examples = ["$ GJC_RUNTIME_BINARY=/path/to/private-runtime gjc deep-interview --help"];

	async run(): Promise<void> {
		const cwd = process.cwd();
		const result = await runGjcRuntimeBridgeWithHudSidecar("deep-interview", this.argv, {
			cwd,
			sidecarSkill: "deep-interview",
			onHudPayload: payload =>
				syncSkillActiveState({
					cwd,
					skill: "deep-interview",
					active: payload.active ?? true,
					phase: payload.phase,
					sessionId: payload.session_id,
					threadId: payload.thread_id,
					turnId: payload.turn_id,
					hud: payload.hud,
					source: "gjc-runtime-bridge",
				}),
		});
		if (result.error) process.stderr.write(`${result.error}\n`);
		process.exitCode = result.status;
	}
}
