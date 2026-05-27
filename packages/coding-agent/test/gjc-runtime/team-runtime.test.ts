import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	claimGjcTeamTask,
	listGjcTeams,
	parseTeamLaunchArgs,
	readGjcTeamSnapshot,
	resolveGjcWorkerCommand,
	shutdownGjcTeam,
	startGjcTeam,
	transitionGjcTeamTask,
} from "../../src/gjc-runtime/team-runtime";

let cleanupRoot: string | undefined;
function runGit(cwd: string, args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `git ${args.join(" ")} failed`);
}

async function createFakeTmuxBin(
	root: string,
	options: { failNewSession?: boolean; failSplit?: boolean } = {},
): Promise<string> {
	const binDir = path.join(root, ".test-bin");
	await fs.mkdir(binDir, { recursive: true });
	const logPath = path.join(root, "tmux.log");
	const script = `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(logPath)}
case "$1" in
  new-session)
    ${options.failNewSession ? "echo tmux failed >&2; exit 1" : "exit 0"}
    ;;
  display-message)
    echo %1
    ;;
  split-window)
    ${options.failSplit ? "echo split failed >&2; exit 1" : ""}
    count_file=${JSON.stringify(path.join(root, "tmux-split-count"))}
    count=0
    if [ -f "$count_file" ]; then count=$(cat "$count_file"); fi
    count=$((count + 1))
    echo "$count" > "$count_file"
    echo "%$((count + 1))"
    ;;
  select-layout|kill-session)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
	await Bun.write(path.join(binDir, "tmux"), script);
	await fs.chmod(path.join(binDir, "tmux"), 0o755);
	return path.join(binDir, "tmux");
}

async function createGitRepo(): Promise<string> {
	const repo = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-git-"));
	runGit(repo, ["init"]);
	runGit(repo, ["config", "user.email", "gjc@example.test"]);
	runGit(repo, ["config", "user.name", "GJC Test"]);
	await Bun.write(path.join(repo, "README.md"), "# test\n");
	runGit(repo, ["add", "README.md"]);
	runGit(repo, ["commit", "-m", "initial"]);
	return repo;
}

afterEach(async () => {
	if (cleanupRoot) {
		for (const session of [
			"gjc-worktree-team",
			"gjc-fail-team",
			"gjc-split-fail-team",
			"gjc-named-team",
			"gjc-cleanup-team",
			"gjc-dirty-cleanup-team",
		]) {
			Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
		}
		await fs.rm(cleanupRoot, { recursive: true, force: true });
		cleanupRoot = undefined;
	}
});

describe("native gjc team runtime", () => {
	it("creates GJC-scoped team state, task mailboxes, and telemetry without delegating to legacy runtimes", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		const snapshot = await startGjcTeam({
			workerCount: 2,
			agentType: "executor",
			task: "Implement the approved plan",
			teamName: "demo-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		expect(snapshot.team_name).toBe("demo-team");
		expect(snapshot.phase).toBe("running");
		expect(snapshot.state_dir).toContain(path.join(".gjc", "state", "team", "demo-team"));
		expect(snapshot.task_counts.pending).toBe(1);
		expect(snapshot.workers).toHaveLength(2);

		const telemetry = await Bun.file(path.join(snapshot.state_dir, "telemetry.jsonl")).text();
		expect(telemetry).toContain("Native gjc team runtime initialized");
	});

	it("persists the active worker command so tmux workers use the same gjc entrypoint", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Use local entrypoint",
			teamName: "entrypoint-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "", GJC_TEAM_WORKER_COMMAND: "bun ./packages/coding-agent/src/cli.ts" },
		});

		const config = await Bun.file(path.join(snapshot.state_dir, "config.json")).json();
		const manifest = await Bun.file(path.join(snapshot.state_dir, "manifest.v2.json")).json();
		const telemetry = await Bun.file(path.join(snapshot.state_dir, "telemetry.jsonl")).text();

		expect(config.worker_command).toBe("bun ./packages/coding-agent/src/cli.ts");
		expect(manifest.worker_command).toBe("bun ./packages/coding-agent/src/cli.ts");
		expect(telemetry).toContain("bun ./packages/coding-agent/src/cli.ts");
		expect(resolveGjcWorkerCommand(cleanupRoot, { GJC_TEAM_WORKER_COMMAND: "gjc-dev" })).toBe("gjc-dev");
	});

	it("parses team starts with automatic detached worktrees and legacy --worktree stripping", () => {
		const defaultStart = parseTeamLaunchArgs(["2:executor", "build", "feature"]);
		expect(defaultStart.worktreeMode).toEqual({ enabled: true, detached: true, name: null });
		expect(defaultStart.workerCount).toBe(2);
		expect(defaultStart.task).toBe("build feature");

		const explicitDetached = parseTeamLaunchArgs(["--worktree", "3:debugger", "fix", "bug"]);
		expect(explicitDetached.worktreeMode).toEqual({ enabled: true, detached: true, name: null });
		expect(explicitDetached.workerCount).toBe(3);
		expect(explicitDetached.agentType).toBe("debugger");
		expect(explicitDetached.task).toBe("fix bug");

		const named = parseTeamLaunchArgs(["--worktree=feature/demo", "1:executor", "ship", "it"]);
		expect(named.worktreeMode).toEqual({ enabled: true, detached: false, name: "feature/demo" });
		expect(named.task).toBe("ship it");

		const separatedLong = parseTeamLaunchArgs(["--worktree", "feature/demo", "1:executor", "ship", "it"]);
		expect(separatedLong.worktreeMode).toEqual({ enabled: true, detached: false, name: "feature/demo" });
		expect(separatedLong.task).toBe("ship it");

		const separatedShort = parseTeamLaunchArgs(["-w", "feature/demo", "1:executor", "ship", "it"]);
		expect(separatedShort.worktreeMode).toEqual({ enabled: true, detached: false, name: "feature/demo" });
		expect(separatedShort.task).toBe("ship it");
	});

	it("creates worker worktrees by default for the tmux launch path", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 2,
			agentType: "executor",
			task: "Use worker worktrees",
			teamName: "worktree-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});

		const config = await Bun.file(path.join(snapshot.state_dir, "config.json")).json();
		const manifest = await Bun.file(path.join(snapshot.state_dir, "manifest.v2.json")).json();

		expect(config.workspace_mode).toBe("worktree");
		expect(manifest.workspace_mode).toBe("worktree");
		expect(snapshot.workers).toHaveLength(2);
		for (const worker of snapshot.workers) {
			expect(worker.pane_id?.startsWith("%")).toBe(true);
			expect(worker.worktree_detached).toBe(true);
			expect(worker.worktree_base_ref).toBeTruthy();
			expect(worker.worktree_path).toContain(path.join(".gjc", "state", "team", "worktree-team", "worktrees"));
			const gitFile = await Bun.file(path.join(worker.worktree_path ?? "", ".git")).text();
			expect(gitFile).toContain("gitdir:");
		}
	});

	it("fails startup instead of reporting running when tmux launch fails", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot, { failNewSession: true });

		await expect(
			startGjcTeam({
				workerCount: 1,
				agentType: "executor",
				task: "Fail loudly",
				teamName: "fail-team",
				cwd: cleanupRoot,
				env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
			}),
		).rejects.toThrow(/tmux failed|tmux_start_failed/);

		const phase = await Bun.file(path.join(cleanupRoot, ".gjc", "state", "team", "fail-team", "phase.json")).json();
		expect(phase.current_phase).toBe("failed");
		await expect(
			Bun.file(
				path.join(cleanupRoot, ".gjc", "state", "team", "fail-team", "worktrees", "worker-01", ".git"),
			).text(),
		).rejects.toThrow();
	});

	it("cleans partial tmux sessions and worktrees when pane startup fails", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot, { failSplit: true });

		await expect(
			startGjcTeam({
				workerCount: 2,
				agentType: "executor",
				task: "Fail split",
				teamName: "split-fail-team",
				cwd: cleanupRoot,
				env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
			}),
		).rejects.toThrow(/split failed|tmux_split_failed/);

		const tmuxLog = await Bun.file(path.join(cleanupRoot, "tmux.log")).text();
		expect(tmuxLog).toContain("new-session");
		expect(tmuxLog).toContain("split-window");
		expect(tmuxLog).toContain("kill-session -t gjc-split-fail-team");
		await expect(
			Bun.file(
				path.join(cleanupRoot, ".gjc", "state", "team", "split-fail-team", "worktrees", "worker-01", ".git"),
			).text(),
		).rejects.toThrow();
	});

	it("creates named worker branches for legacy --worktree=<name> mode", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Named worktree",
			teamName: "named-team",
			worktreeMode: { enabled: true, detached: false, name: "feature/demo" },
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});

		expect(snapshot.workers[0]?.worktree_branch).toBe("feature/demo/named-team/worker-01");
		expect(snapshot.workers[0]?.worktree_detached).toBe(false);
		expect(
			Bun.spawnSync(["git", "branch", "--show-current"], { cwd: snapshot.workers[0]?.worktree_path, stdout: "pipe" })
				.stdout.toString()
				.trim(),
		).toBe("feature/demo/named-team/worker-01");
	});

	it("removes clean created worker worktrees on normal shutdown", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Clean shutdown",
			teamName: "cleanup-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const worktreePath = snapshot.workers[0]?.worktree_path ?? "";
		expect(await Bun.file(path.join(worktreePath, ".git")).exists()).toBe(true);

		const stopped = await shutdownGjcTeam("cleanup-team", cleanupRoot, { PATH: process.env.PATH ?? "" });

		expect(stopped.phase).toBe("complete");
		expect(await Bun.file(path.join(worktreePath, ".git")).exists()).toBe(false);
	});

	it("preserves dirty worker worktrees on normal shutdown", async () => {
		cleanupRoot = await createGitRepo();
		const fakeTmux = await createFakeTmuxBin(cleanupRoot);
		const snapshot = await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Preserve dirty shutdown",
			teamName: "dirty-cleanup-team",
			cwd: cleanupRoot,
			env: { PATH: process.env.PATH ?? "", GJC_TEAM_WORKER_COMMAND: "true", GJC_TEAM_TMUX_COMMAND: fakeTmux },
		});
		const worktreePath = snapshot.workers[0]?.worktree_path ?? "";
		await Bun.write(path.join(worktreePath, "worker-change.txt"), "keep me\n");

		const stopped = await shutdownGjcTeam("dirty-cleanup-team", cleanupRoot, { PATH: process.env.PATH ?? "" });

		expect(stopped.phase).toBe("complete");
		expect(await Bun.file(path.join(worktreePath, "worker-change.txt")).text()).toBe("keep me\n");
	});

	it("supports task claim, transition, list, status, and shutdown lifecycle operations", async () => {
		cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-team-runtime-"));
		await startGjcTeam({
			workerCount: 1,
			agentType: "executor",
			task: "Ship lifecycle",
			teamName: "life-team",
			cwd: cleanupRoot,
			dryRun: true,
			env: { PATH: "" },
		});

		const claim = await claimGjcTeamTask("life-team", "worker-01", cleanupRoot, { PATH: "" });
		expect(claim.ok).toBe(true);
		expect(claim.task?.status).toBe("in_progress");
		const task = await transitionGjcTeamTask("life-team", "task-001", "complete", cleanupRoot, { PATH: "" });
		expect(task.status).toBe("complete");

		const status = await readGjcTeamSnapshot("life-team", cleanupRoot, { PATH: "" });
		expect(status.task_counts.complete).toBe(1);
		expect(await listGjcTeams(cleanupRoot, { PATH: "" })).toHaveLength(1);

		const stopped = await shutdownGjcTeam("life-team", cleanupRoot, { PATH: "" });
		expect(stopped.phase).toBe("complete");
		expect(stopped.workers[0]?.status).toBe("stopped");
	});
});
