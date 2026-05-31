import { Command } from "@gajae-code/utils/cli";
import { runBridgedRuntimeEndpoint } from "./gjc-runtime-bridge";

export default class State extends Command {
	static description = "Read or update private GJC workflow state through the bridge (requires GJC_RUNTIME_BINARY)";
	static strict = false;
	static examples = [
		'$ GJC_RUNTIME_BINARY=/path/to/private-runtime gjc state read --input \'{"mode":"team"}\' --json',
	];

	async run(): Promise<void> {
		await runBridgedRuntimeEndpoint("state", this.argv);
	}
}
