import * as fs from "node:fs/promises";
import * as path from "node:path";
export type GjcTeamPhase = "starting" | "running" | "complete" | "failed" | "cancelled";
export type GjcTeamTaskStatus = "pending" | "in_progress" | "complete" | "failed" | "blocked";

export interface GjcTeamLeader {
	session_id: string;
	pane_id: string;
	cwd: string;
}

export interface GjcTeamWorker {
	id: string;
	agent_type: string;
	pane_id?: string;
	status: "starting" | "idle" | "busy" | "stopped";
	last_heartbeat: string;
	worktree_repo_root?: string;
	worktree_path?: string;
	worktree_branch?: string | null;
	worktree_detached?: boolean;
	worktree_created?: boolean;
	worktree_base_ref?: string;
}

export interface GjcTeamTask {
	id: string;
	title: string;
	objective: string;
	status: GjcTeamTaskStatus;
	assignee?: string;
	created_at: string;
	updated_at: string;
}

export type GjcTeamWorktreeMode =
	| { enabled: false }
	| { enabled: true; detached: true; name: null }
	| { enabled: true; detached: false; name: string };

export interface GjcTeamConfig {
	team_name: string;
	display_name: string;
	requested_name: string;
	task: string;
	agent_type: string;
	worker_count: number;
	state_root: string;
	worker_command: string;
	tmux_command: string;
	tmux_session: string;
	workspace_mode: "direct" | "worktree";
	leader: GjcTeamLeader;
	workers: GjcTeamWorker[];
	created_at: string;
	updated_at: string;
}

export interface GjcTeamSnapshot {
	team_name: string;
	display_name: string;
	phase: GjcTeamPhase;
	state_dir: string;
	tmux_session: string;
	task_total: number;
	task_counts: Record<GjcTeamTaskStatus, number>;
	workers: GjcTeamWorker[];
	updated_at: string;
}

export interface GjcTeamStartOptions {
	workerCount: number;
	agentType: string;
	task: string;
	teamName?: string;
	worktreeMode?: GjcTeamWorktreeMode;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	dryRun?: boolean;
}

export interface GjcTeamApiClaimResult {
	ok: boolean;
	task?: GjcTeamTask;
	worker_id?: string;
	reason?: string;
}

interface FsError {
	code?: string;
}

function isEnoent(error: unknown): error is FsError {
	return typeof error === "object" && error !== null && "code" in error && (error as FsError).code === "ENOENT";
}

interface GjcTeamEvent {
	ts: string;
	type: string;
	message: string;
	data?: Record<string, unknown>;
}

function now(): string {
	return new Date().toISOString();
}

function sanitizeName(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40)
		.replace(/-$/, "");
	return sanitized || "team";
}

function shortHash(value: string): string {
	return Bun.hash(value).toString(16).slice(0, 8).padStart(8, "0");
}

function makeTeamName(task: string, env: NodeJS.ProcessEnv): string {
	const basis = [task, env.GJC_SESSION_ID, env.CODEX_SESSION_ID, env.TMUX_PANE, env.TMUX, now()]
		.filter(Boolean)
		.join(":");
	const prefix = sanitizeName(task).slice(0, 30).replace(/-$/, "") || "team";
	return `${prefix}-${shortHash(basis)}`;
}

export function resolveGjcTeamStateRoot(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.GJC_TEAM_STATE_ROOT?.trim();
	if (explicit) return path.resolve(cwd, explicit);
	return path.join(cwd, ".gjc", "state", "team");
}

function teamDir(stateRoot: string, teamName: string): string {
	return path.join(stateRoot, teamName);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
	try {
		return (await Bun.file(filePath).json()) as T;
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

async function appendEvent(dir: string, event: Omit<GjcTeamEvent, "ts">): Promise<void> {
	await appendJsonl(path.join(dir, "events.jsonl"), { ts: now(), ...event });
}

async function appendTelemetry(dir: string, event: Omit<GjcTeamEvent, "ts">): Promise<void> {
	await appendJsonl(path.join(dir, "telemetry.jsonl"), { ts: now(), ...event });
}

async function readConfig(dir: string): Promise<GjcTeamConfig> {
	const config = await readJsonFile<GjcTeamConfig>(path.join(dir, "config.json"));
	if (!config) throw new Error(`team_config_not_found:${dir}`);
	return { ...config, tmux_command: config.tmux_command ?? resolveGjcTmuxCommand() };
}

async function readPhase(dir: string): Promise<GjcTeamPhase> {
	const phase = await readJsonFile<{ current_phase?: GjcTeamPhase }>(path.join(dir, "phase.json"));
	return phase?.current_phase ?? "running";
}

async function writePhase(dir: string, phase: GjcTeamPhase): Promise<void> {
	await writeJsonFile(path.join(dir, "phase.json"), { current_phase: phase, updated_at: now() });
}

async function readTasks(dir: string): Promise<GjcTeamTask[]> {
	const tasksDir = path.join(dir, "tasks");
	try {
		const entries = await fs.readdir(tasksDir, { withFileTypes: true });
		const tasks = await Promise.all(
			entries
				.filter(entry => entry.isFile() && entry.name.endsWith(".json"))
				.map(entry => readJsonFile<GjcTeamTask>(path.join(tasksDir, entry.name))),
		);
		return tasks.filter((task): task is GjcTeamTask => task != null).sort((a, b) => a.id.localeCompare(b.id));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

async function writeTask(dir: string, task: GjcTeamTask): Promise<void> {
	await writeJsonFile(path.join(dir, "tasks", `${task.id}.json`), task);
}

async function findTeamDir(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const root = resolveGjcTeamStateRoot(cwd, env);
	const exact = teamDir(root, sanitizeName(teamName));
	const exactConfig = await readJsonFile<GjcTeamConfig>(path.join(exact, "config.json"));
	if (exactConfig) return exact;

	const candidates = await listGjcTeams(cwd, env);
	const matches = candidates.filter(candidate => {
		const input = sanitizeName(teamName);
		return candidate.team_name === input || sanitizeName(candidate.display_name) === input;
	});
	if (matches.length === 1) return matches[0].state_dir;
	if (matches.length > 1)
		throw new Error(`ambiguous_team_name:${teamName}:${matches.map(match => match.team_name).join(",")}`);
	throw new Error(`team_not_found:${teamName}`);
}

function buildWorkers(count: number, agentType: string): GjcTeamWorker[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `worker-${String(index + 1).padStart(2, "0")}`,
		agent_type: agentType,
		status: "starting",
		last_heartbeat: now(),
	}));
}

function sanitizePathToken(value: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return sanitized || "default";
}

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode === 0) return result.stdout.toString().trim();
	const stderr = result.stderr.toString().trim();
	throw new Error(stderr || `git ${args.join(" ")} failed`);
}

function tryRunGit(cwd: string, args: string[]): string | null {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function isGitRepository(cwd: string): boolean {
	return tryRunGit(cwd, ["rev-parse", "--show-toplevel"]) != null;
}

function parseWorktreeMode(args: string[]): { mode: GjcTeamWorktreeMode; remainingArgs: string[] } {
	let mode: GjcTeamWorktreeMode = { enabled: false };
	const remainingArgs: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--worktree" || arg === "-w") {
			const next = args[index + 1];
			if (typeof next === "string" && next.length > 0 && !next.startsWith("-") && !next.includes(":")) {
				mode = { enabled: true, detached: false, name: next };
				index += 1;
			} else {
				mode = { enabled: true, detached: true, name: null };
			}
			continue;
		}
		if (arg.startsWith("--worktree=")) {
			const name = arg.slice("--worktree=".length).trim();
			mode = name ? { enabled: true, detached: false, name } : { enabled: true, detached: true, name: null };
			continue;
		}
		if (arg.startsWith("-w=") || (arg.startsWith("-w") && arg.length > 2)) {
			const name = arg.startsWith("-w=") ? arg.slice("-w=".length).trim() : arg.slice(2).trim();
			mode = name ? { enabled: true, detached: false, name } : { enabled: true, detached: true, name: null };
			continue;
		}
		remainingArgs.push(arg);
	}

	return { mode, remainingArgs };
}

function resolveDefaultWorktreeMode(mode?: GjcTeamWorktreeMode): GjcTeamWorktreeMode {
	if (mode?.enabled) return mode;
	return { enabled: true, detached: true, name: null };
}

function branchExists(repoRoot: string, branchName: string): boolean {
	const result = Bun.spawnSync(["git", "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
		cwd: repoRoot,
		stdout: "ignore",
		stderr: "ignore",
	});
	return result.exitCode === 0;
}

function worktreeIsDirty(worktreePath: string): boolean {
	return runGit(worktreePath, ["status", "--porcelain"]).trim().length > 0;
}

function worktreeHead(worktreePath: string): string {
	return runGit(worktreePath, ["rev-parse", "HEAD"]);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

function findWorktreePath(repoRoot: string, worktreePath: string): string | null {
	const raw = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
	const resolved = path.resolve(worktreePath);
	for (const line of raw.split(/\r?\n/)) {
		if (!line.startsWith("worktree ")) continue;
		const candidate = path.resolve(line.slice("worktree ".length));
		if (candidate === resolved) return candidate;
	}
	return null;
}

async function ensureWorkerWorktree(
	cwd: string,
	dir: string,
	teamName: string,
	worker: GjcTeamWorker,
	mode: GjcTeamWorktreeMode,
): Promise<GjcTeamWorker> {
	if (!mode.enabled) return worker;
	if (!isGitRepository(cwd)) throw new Error(`team_worktree_requires_git_repo:${cwd}`);

	const repoRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	const baseRef = runGit(repoRoot, ["rev-parse", "HEAD"]);
	const worktreePath = path.join(dir, "worktrees", worker.id);
	const existing = findWorktreePath(repoRoot, worktreePath);
	let created = false;
	let branchName: string | null = null;

	if (!mode.detached) {
		branchName = `${mode.name}/${sanitizePathToken(teamName)}/${sanitizePathToken(worker.id)}`;
	}

	if (existing) {
		if (worktreeIsDirty(worktreePath)) throw new Error(`worktree_dirty:${worktreePath}`);
		if (mode.detached && worktreeHead(worktreePath) !== baseRef) throw new Error(`worktree_stale:${worktreePath}`);
	} else {
		if (await pathExists(worktreePath)) throw new Error(`worktree_path_conflict:${worktreePath}`);
		await fs.mkdir(path.dirname(worktreePath), { recursive: true });
		const branchAlreadyExists = branchName ? branchExists(repoRoot, branchName) : false;
		const args = mode.detached
			? ["worktree", "add", "--detach", worktreePath, baseRef]
			: branchAlreadyExists
				? ["worktree", "add", worktreePath, branchName ?? ""]
				: ["worktree", "add", "-b", branchName ?? "", worktreePath, baseRef];
		runGit(repoRoot, args);
		created = true;
	}

	return {
		...worker,
		worktree_repo_root: repoRoot,
		worktree_path: path.resolve(worktreePath),
		worktree_branch: branchName,
		worktree_detached: mode.detached,
		worktree_created: created,
		worktree_base_ref: baseRef,
	};
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

export function resolveGjcTmuxCommand(env: NodeJS.ProcessEnv = process.env): string {
	return env.GJC_TEAM_TMUX_COMMAND?.trim() || "tmux";
}

export function resolveGjcWorkerCommand(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.GJC_TEAM_WORKER_COMMAND?.trim();
	if (explicit) return explicit;

	const entrypoint = process.argv[1];
	if (entrypoint?.endsWith(".ts"))
		return `${shellQuote(process.execPath)} ${shellQuote(path.resolve(cwd, entrypoint))}`;
	if (entrypoint && path.basename(entrypoint).startsWith("gjc")) return shellQuote(path.resolve(cwd, entrypoint));
	return "gjc";
}

function buildWorkerCommand(config: GjcTeamConfig, worker: GjcTeamWorker): string {
	const workspace = worker.worktree_path
		? `Worker worktree: ${worker.worktree_path}.`
		: `Worker cwd: ${config.leader.cwd}.`;
	const prompt = [
		`You are ${worker.id} in gjc team ${config.team_name}.`,
		`Team state root: ${config.state_root}.`,
		`Team command: ${config.worker_command}.`,
		workspace,
		`Task: ${config.task}`,
		`Use ${config.worker_command} team api claim-task/transition-task with this worker id, record evidence, and do not expose private support workflows as public definitions.`,
	].join("\n");
	const env = [
		`GJC_TEAM_NAME=${shellQuote(config.team_name)}`,
		`GJC_TEAM_WORKER_ID=${shellQuote(worker.id)}`,
		`GJC_TEAM_STATE_ROOT=${shellQuote(config.state_root)}`,
		...(worker.worktree_path ? [`GJC_TEAM_WORKTREE_PATH=${shellQuote(worker.worktree_path)}`] : []),
	];
	return `${env.join(" ")} ${config.worker_command} ${shellQuote(prompt)}`;
}

function buildInitialTasks(task: string): GjcTeamTask[] {
	return [
		{
			id: "task-001",
			title: "Execute team brief",
			objective: task,
			status: "pending",
			created_at: now(),
			updated_at: now(),
		},
	];
}

async function startTmuxSession(config: GjcTeamConfig, dir: string, dryRun: boolean): Promise<GjcTeamWorker[]> {
	if (dryRun) return config.workers;
	const [leaderWorker, ...otherWorkers] = config.workers;
	if (!leaderWorker) return config.workers;
	try {
		const create = Bun.spawnSync(
			[
				config.tmux_command,
				"new-session",
				"-d",
				"-s",
				config.tmux_session,
				"-c",
				leaderWorker.worktree_path ?? config.leader.cwd,
				buildWorkerCommand(config, leaderWorker),
			],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (create.exitCode !== 0) {
			const stderr = create.stderr.toString().trim();
			throw new Error(stderr || `tmux_start_failed:${config.tmux_session}`);
		}
	} catch (error) {
		if (error instanceof Error) throw error;
		throw new Error(`tmux_start_failed:${config.tmux_session}`);
	}

	const workers: GjcTeamWorker[] = [];
	const leaderPane = Bun.spawnSync(
		[config.tmux_command, "display-message", "-p", "-t", config.tmux_session, "#{pane_id}"],
		{
			stdout: "pipe",
			stderr: "ignore",
		},
	);
	const leaderPaneId = leaderPane.stdout.toString().trim();
	if (!leaderPaneId) throw new Error(`tmux_leader_pane_missing:${config.tmux_session}`);
	workers.push({
		...leaderWorker,
		pane_id: leaderPaneId,
	});
	for (const worker of otherWorkers) {
		const split = Bun.spawnSync(
			[
				config.tmux_command,
				"split-window",
				"-P",
				"-F",
				"#{pane_id}",
				"-t",
				config.tmux_session,
				"-c",
				worker.worktree_path ?? config.leader.cwd,
				buildWorkerCommand(config, worker),
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (split.exitCode !== 0) {
			const stderr = split.stderr.toString().trim();
			throw new Error(stderr || `tmux_split_failed:${config.tmux_session}:${worker.id}`);
		}
		const paneId = split.stdout.toString().trim();
		if (!paneId) throw new Error(`tmux_split_missing_pane:${config.tmux_session}:${worker.id}`);
		workers.push({ ...worker, pane_id: paneId });
	}
	Bun.spawnSync([config.tmux_command, "select-layout", "-t", config.tmux_session, "tiled"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	await appendTelemetry(dir, {
		type: "tmux_started",
		message: "Started gjc team tmux session",
		data: { tmux_session: config.tmux_session, panes: workers.map(worker => worker.pane_id).filter(Boolean) },
	});
	return workers;
}

function killTmuxSession(config: GjcTeamConfig): void {
	Bun.spawnSync([config.tmux_command, "kill-session", "-t", config.tmux_session], {
		stdout: "ignore",
		stderr: "ignore",
	});
}

async function rollbackCreatedWorktrees(workers: GjcTeamWorker[]): Promise<void> {
	for (const worker of workers.filter(worker => worker.worktree_created).reverse()) {
		if (!worker.worktree_repo_root || !worker.worktree_path) continue;
		Bun.spawnSync(["git", "worktree", "remove", "--force", worker.worktree_path], {
			cwd: worker.worktree_repo_root,
			stdout: "ignore",
			stderr: "ignore",
		});
	}
}

async function removeCleanCreatedWorktrees(workers: GjcTeamWorker[]): Promise<void> {
	for (const worker of workers.filter(worker => worker.worktree_created).reverse()) {
		if (!worker.worktree_repo_root || !worker.worktree_path) continue;
		if (worktreeIsDirty(worker.worktree_path)) continue;
		Bun.spawnSync(["git", "worktree", "remove", worker.worktree_path], {
			cwd: worker.worktree_repo_root,
			stdout: "ignore",
			stderr: "ignore",
		});
	}
}

export async function startGjcTeam(options: GjcTeamStartOptions): Promise<GjcTeamSnapshot> {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const stateRoot = resolveGjcTeamStateRoot(cwd, env);
	const teamName = sanitizeName(options.teamName ?? makeTeamName(options.task, env));
	const displayName = sanitizeName(options.teamName ?? options.task).slice(0, 30) || teamName;
	const dir = teamDir(stateRoot, teamName);
	const createdAt = now();
	const worktreeMode = resolveDefaultWorktreeMode(options.worktreeMode);
	const initialWorkers = buildWorkers(options.workerCount, options.agentType);
	const workers: GjcTeamWorker[] = [];
	try {
		for (const worker of initialWorkers) {
			workers.push(options.dryRun ? worker : await ensureWorkerWorktree(cwd, dir, teamName, worker, worktreeMode));
		}
	} catch (error) {
		await rollbackCreatedWorktrees(workers);
		throw error;
	}
	const config: GjcTeamConfig = {
		team_name: teamName,
		display_name: displayName,
		requested_name: options.teamName ?? displayName,
		task: options.task,
		agent_type: options.agentType,
		worker_count: options.workerCount,
		state_root: stateRoot,
		worker_command: resolveGjcWorkerCommand(cwd, env),
		tmux_command: resolveGjcTmuxCommand(env),
		tmux_session: `gjc-${teamName}`,
		workspace_mode: worktreeMode.enabled ? "worktree" : "direct",
		leader: {
			session_id: env.GJC_SESSION_ID ?? env.CODEX_SESSION_ID ?? "",
			pane_id: env.TMUX_PANE ?? "",
			cwd,
		},
		workers,
		created_at: createdAt,
		updated_at: createdAt,
	};

	await fs.mkdir(path.join(dir, "tasks"), { recursive: true });
	await fs.mkdir(path.join(dir, "mailboxes"), { recursive: true });
	await writeJsonFile(path.join(dir, "config.json"), config);
	await writeJsonFile(path.join(dir, "manifest.v2.json"), {
		version: 2,
		team_name: config.team_name,
		display_name: config.display_name,
		requested_name: config.requested_name,
		tmux_session: config.tmux_session,
		worker_command: config.worker_command,
		tmux_command: config.tmux_command,
		leader: config.leader,
		workers: config.workers,
		workspace_mode: config.workspace_mode,
		created_at: createdAt,
		updated_at: createdAt,
	});
	await writePhase(dir, "starting");
	for (const task of buildInitialTasks(options.task)) await writeTask(dir, task);
	for (const worker of config.workers) {
		await writeJsonFile(path.join(dir, "mailboxes", `${worker.id}.json`), { messages: [] });
	}
	await appendEvent(dir, {
		type: "team_started",
		message: "Started native gjc team runtime",
		data: { worker_count: options.workerCount, agent_type: options.agentType, workspace_mode: config.workspace_mode },
	});
	await appendTelemetry(dir, {
		type: "team_runtime",
		message: "Native gjc team runtime initialized",
		data: { state_root: stateRoot, worker_command: config.worker_command, workspace_mode: config.workspace_mode },
	});
	let tmuxWorkers: GjcTeamWorker[];
	try {
		tmuxWorkers = await startTmuxSession(config, dir, options.dryRun ?? false);
	} catch (error) {
		await writePhase(dir, "failed");
		await appendEvent(dir, {
			type: "team_start_failed",
			message: error instanceof Error ? error.message : String(error),
		});
		killTmuxSession(config);
		await rollbackCreatedWorktrees(config.workers);
		throw error;
	}
	const runningConfig = {
		...config,
		workers: tmuxWorkers.map(worker => ({ ...worker, status: "idle" as const, last_heartbeat: now() })),
		updated_at: now(),
	};
	await writeJsonFile(path.join(dir, "config.json"), runningConfig);
	await writePhase(dir, "running");
	return readGjcTeamSnapshot(teamName, cwd, env);
}

export async function readGjcTeamSnapshot(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamSnapshot> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	const phase = await readPhase(dir);
	const tasks = await readTasks(dir);
	const taskCounts: Record<GjcTeamTaskStatus, number> = {
		pending: 0,
		in_progress: 0,
		complete: 0,
		failed: 0,
		blocked: 0,
	};
	for (const task of tasks) taskCounts[task.status] += 1;
	return {
		team_name: config.team_name,
		display_name: config.display_name,
		phase,
		state_dir: dir,
		tmux_session: config.tmux_session,
		task_total: tasks.length,
		task_counts: taskCounts,
		workers: config.workers,
		updated_at: config.updated_at,
	};
}

export async function listGjcTeams(
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamSnapshot[]> {
	const root = resolveGjcTeamStateRoot(cwd, env);
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		const snapshots = await Promise.all(
			entries
				.filter(entry => entry.isDirectory())
				.map(entry => readGjcTeamSnapshot(entry.name, cwd, env).catch(() => null)),
		);
		return snapshots.filter((snapshot): snapshot is GjcTeamSnapshot => snapshot != null);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

export async function shutdownGjcTeam(
	teamName: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamSnapshot> {
	const dir = await findTeamDir(teamName, cwd, env);
	const config = await readConfig(dir);
	killTmuxSession(config);
	await removeCleanCreatedWorktrees(config.workers);
	const stopped = {
		...config,
		workers: config.workers.map(worker => ({ ...worker, status: "stopped" as const, last_heartbeat: now() })),
		updated_at: now(),
	};
	await writeJsonFile(path.join(dir, "config.json"), stopped);
	await writePhase(dir, "complete");
	await appendEvent(dir, { type: "team_shutdown", message: "Shut down native gjc team runtime" });
	await appendTelemetry(dir, { type: "team_shutdown", message: "Native gjc team runtime stopped" });
	return readGjcTeamSnapshot(config.team_name, cwd, env);
}

export async function claimGjcTeamTask(
	teamName: string,
	workerId: string,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamApiClaimResult> {
	const dir = await findTeamDir(teamName, cwd, env);
	const tasks = await readTasks(dir);
	const task = tasks.find(candidate => candidate.status === "pending");
	if (!task) return { ok: false, reason: "no_pending_task" };
	const updated: GjcTeamTask = { ...task, status: "in_progress", assignee: workerId, updated_at: now() };
	await writeTask(dir, updated);
	await appendEvent(dir, {
		type: "task_claimed",
		message: "Worker claimed task",
		data: { task_id: updated.id, worker_id: workerId },
	});
	return { ok: true, task: updated, worker_id: workerId };
}

export async function transitionGjcTeamTask(
	teamName: string,
	taskId: string,
	status: GjcTeamTaskStatus,
	cwd = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<GjcTeamTask> {
	const dir = await findTeamDir(teamName, cwd, env);
	const tasks = await readTasks(dir);
	const task = tasks.find(candidate => candidate.id === taskId);
	if (!task) throw new Error(`task_not_found:${taskId}`);
	const updated: GjcTeamTask = { ...task, status, updated_at: now() };
	await writeTask(dir, updated);
	await appendEvent(dir, {
		type: "task_transitioned",
		message: "Task status changed",
		data: { task_id: taskId, status },
	});
	return updated;
}

export function parseTeamLaunchArgs(argv: string[]): GjcTeamStartOptions {
	const parsedWorktree = parseWorktreeMode(argv);
	const positionals = parsedWorktree.remainingArgs.filter(arg => !arg.startsWith("--"));
	const dryRun = argv.includes("--dry-run");
	const spec = positionals[0] ?? "3:executor";
	const specMatch = spec.match(/^(?:(\d+):)?([a-zA-Z][a-zA-Z0-9_-]*)$/);
	const workerCount = specMatch?.[1] ? Number.parseInt(specMatch[1], 10) : 3;
	const agentType = specMatch?.[2] ?? "executor";
	const task = positionals
		.slice(specMatch ? 1 : 0)
		.join(" ")
		.trim();
	if (!task) throw new Error("missing_team_task");
	if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 12)
		throw new Error(`invalid_worker_count:${workerCount}`);
	return { workerCount, agentType, task, dryRun, worktreeMode: resolveDefaultWorktreeMode(parsedWorktree.mode) };
}
