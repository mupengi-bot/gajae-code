import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	checkpointUltragoalGoal,
	createUltragoalPlan,
	getUltragoalStatus,
	runNativeUltragoalCommand,
	startNextUltragoalGoal,
} from "@gajae-code/coding-agent/gjc-runtime/ultragoal-runtime";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-ultragoal-runtime-"));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("native GJC ultragoal runtime", () => {
	it("reports missing status without requiring a private runtime binary", async () => {
		const root = await tempDir();

		const result = await runNativeUltragoalCommand(["status"], root);
		const status = await getUltragoalStatus(root);

		expect(result.status).toBe(0);
		expect(result.stderr).toBeUndefined();
		expect(result.stdout).toContain("No ultragoal plan found");
		expect(status.exists).toBe(false);
		expect(status.status).toBe("missing");
	});

	it("creates a durable aggregate plan and ledger", async () => {
		const root = await tempDir();

		const plan = await createUltragoalPlan({ cwd: root, brief: "Fix native ultragoal status" });
		const goalsRaw = await Bun.file(path.join(root, ".gjc", "ultragoal", "goals.json")).text();
		const ledgerRaw = await Bun.file(path.join(root, ".gjc", "ultragoal", "ledger.jsonl")).text();

		expect(plan.gjcGoalMode).toBe("aggregate");
		expect(plan.gjcObjective).toContain(".gjc/ultragoal/goals.json");
		expect(plan.goals).toHaveLength(1);
		expect(plan.goals[0]).toMatchObject({ id: "G001", status: "pending" });
		expect(goalsRaw).toContain("Fix native ultragoal status");
		expect(ledgerRaw).toContain("plan_created");
	});

	it("starts and checkpoints the current goal", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });

		const started = await startNextUltragoalGoal({ cwd: root });
		expect(started.goal?.status).toBe("active");
		const plan = await checkpointUltragoalGoal({
			cwd: root,
			goalId: "G001",
			status: "complete",
			evidence: "tests passed",
			gjcGoalJson: JSON.stringify({ goal: { status: "complete" } }),
			qualityGateJson: JSON.stringify({
				verification: { status: "passed" },
				codeReview: { recommendation: "APPROVE", architectStatus: "CLEAR" },
			}),
		});
		const status = await getUltragoalStatus(root);

		expect(plan.goals[0]?.status).toBe("complete");
		expect(status.status).toBe("complete");
		expect(status.counts.complete).toBe(1);
	});
	it("blocks complete checkpoints without a clean architect review gate", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "tests passed",
				gjcGoalJson: JSON.stringify({ goal: { status: "complete" } }),
			}),
		).rejects.toThrow("requires --quality-gate-json");

		await expect(
			checkpointUltragoalGoal({
				cwd: root,
				goalId: "G001",
				status: "complete",
				evidence: "tests passed",
				gjcGoalJson: JSON.stringify({ goal: { status: "complete" } }),
				qualityGateJson: JSON.stringify({
					verification: { status: "passed" },
					codeReview: { recommendation: "APPROVE", architectStatus: "WATCH" },
				}),
			}),
		).rejects.toThrow("requires architect review approval");

		const status = await getUltragoalStatus(root);
		expect(status.goals[0]?.status).toBe("active");
	});

	it("blocks complete checkpoint commands without a clean architect review gate", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });
		await startNextUltragoalGoal({ cwd: root });

		const result = await runNativeUltragoalCommand(
			[
				"checkpoint",
				"--goal-id",
				"G001",
				"--status",
				"complete",
				"--evidence",
				"tests passed",
				"--gjc-goal-json",
				JSON.stringify({ goal: { status: "complete" } }),
			],
			root,
		);
		const status = await getUltragoalStatus(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("requires --quality-gate-json");
		expect(status.goals[0]?.status).toBe("active");
	});

	it("rejects mistyped checkpoint statuses instead of silently changing state", async () => {
		const root = await tempDir();
		await createUltragoalPlan({ cwd: root, brief: "Ship the fix" });

		const result = await runNativeUltragoalCommand(
			["checkpoint", "--goal-id", "G001", "--status", "complet", "--evidence", "typo"],
			root,
		);
		const status = await getUltragoalStatus(root);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("checkpoint --status must be");
		expect(status.goals[0]?.status).toBe("pending");
	});
});
