/**
 * RLM (research) mode entry point.
 *
 * Composes an interactive research session over the existing agent/session loop
 * (python kernel + read + web_search + read-only bash), optional DATA.md
 * context, a live notebook.ipynb, and a synthesized report.md on session exit.
 */
import { getProjectDir } from "@gajae-code/utils";
import { parseArgs } from "../cli/args";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { type RlmPreset, runRootCommand } from "../main";
import type { CreateAgentSessionOptions } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { ensureRlmSessionDir, generateRlmSessionId, resolveRlmArtifactPaths } from "./artifacts";
import { loadRlmDataContext, type RlmDataContext } from "./data-context";
import { RlmNotebookWriter } from "./notebook";
import { assertRlmToolAllowlist, buildRlmSystemPrompt, isRlmToolAllowed, RLM_READ_ONLY_BASH_PREFIXES } from "./preset";
import { createRlmPythonTool } from "./python-tool";
import { synthesizeRlmReport } from "./report";
import type { RlmSessionMetadata } from "./types";

interface ExtractedDataFlag {
	dataPath: string | undefined;
	rest: string[];
}

/** Pull `--data <path>` / `--data=<path>` out of argv; the remainder is forwarded to the root command. */
export function extractDataFlag(argv: string[]): ExtractedDataFlag {
	const rest: string[] = [];
	let dataPath: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--data") {
			dataPath = argv[i + 1];
			i += 1;
		} else if (arg.startsWith("--data=")) {
			dataPath = arg.slice("--data=".length);
		} else {
			rest.push(arg);
		}
	}
	return { dataPath, rest };
}

export interface RlmPresetOptions {
	dataContext: RlmDataContext | null;
	pythonTool: CustomTool;
	objective?: string;
}

export function createRlmPreset({ dataContext, pythonTool, objective }: RlmPresetOptions): RlmPreset {
	const resolvedObjective = objective ?? buildRlmGoalObjective({ messages: [], dataContext });
	return {
		applyOptions: (options: CreateAgentSessionOptions, settings) => {
			options.systemPrompt = buildRlmSystemPrompt(dataContext);
			options.customTools = [pythonTool];
			options.toolNames = ["read", "web_search", "search_tool_bm25", "bash", "goal"];
			options.requireYieldTool = false;
			options.skills = [];
			options.rules = [];
			options.disableExtensionDiscovery = true;
			options.extensions = [];
			options.additionalExtensionPaths = [];
			options.preloadedExtensions = undefined;
			options.bashAllowedPrefixes = [...RLM_READ_ONLY_BASH_PREFIXES];
			options.bashRestrictionProfile = "read-only";
			options.goalToolAllowedOps = ["get", "complete"];
			options.discoverableToolAllowedNames = [];
			// RLM always runs in goal mode; recipe injection stays outside the research surface.
			settings.override("goal.enabled", true);
			settings.override("tools.discoveryMode", "all");
			settings.override("recipe.enabled", false);
		},
		onSessionCreated: async (session: AgentSession) => {
			await ensureRlmGoalMode(session, resolvedObjective);
			// Hard boundary: fail launch if any non-allowlisted tool slipped into the active set.
			assertRlmToolAllowlist(session.getActiveToolNames());
		},
	};
}

async function ensureRlmGoalMode(session: AgentSession, objective: string): Promise<void> {
	const current = session.getGoalModeState();
	if (current?.goal && current.goal.status !== "complete" && current.goal.status !== "dropped") {
		if (!current.enabled || current.goal.status === "paused") {
			await session.goalRuntime.resumeGoal();
		}
	} else {
		await session.goalRuntime.createGoal({ objective });
	}
	await session.setActiveToolsByName([...new Set([...session.getActiveToolNames().filter(isRlmToolAllowed), "goal"])]);
}

export function buildRlmGoalObjective(input: {
	messages: readonly string[];
	dataContext: RlmDataContext | null;
}): string {
	const prompt = input.messages
		.map(message => message.trim())
		.filter(Boolean)
		.join("\n\n");
	if (prompt.length > 0) return prompt;
	if (input.dataContext) {
		return `Complete an RLM research session using data context ${input.dataContext.path}, grounding conclusions in notebook outputs and finishing with a report.`;
	}
	return "Complete this RLM research session, grounding conclusions in notebook outputs and finishing with a report.";
}

export async function runRlmCommand(argv: string[]): Promise<void> {
	const cwd = getProjectDir();
	const { dataPath, rest } = extractDataFlag(argv);
	const dataContext = await loadRlmDataContext(cwd, dataPath);

	const sessionId = generateRlmSessionId();
	const paths = resolveRlmArtifactPaths(cwd, sessionId);
	await ensureRlmSessionDir(paths);

	const notebook = new RlmNotebookWriter(paths.notebookPath);
	const pythonTool = createRlmPythonTool({ cwd, sessionId, artifactsDir: paths.dir, notebook });

	const parsed = parseArgs(rest);
	const preset = createRlmPreset({
		dataContext,
		pythonTool,
		objective: buildRlmGoalObjective({ messages: parsed.messages, dataContext }),
	});
	try {
		await runRootCommand(parsed, rest, { rlmPreset: preset });
	} finally {
		await notebook.flush();
		const report = synthesizeRlmReport({
			title: `RLM research session ${sessionId}`,
			notebook: notebook.document,
			dataPath: dataContext?.path ?? null,
		});
		await Bun.write(paths.reportPath, report);
		const metadata: RlmSessionMetadata = {
			sessionId,
			createdAt: new Date().toISOString(),
			cwd,
			dataPath: dataContext?.path ?? null,
			cellCount: notebook.cellCount,
		};
		await Bun.write(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
	}
}
