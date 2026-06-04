#!/usr/bin/env bun
import { $ } from "bun";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");

const relevantPathPrefixes = [
	"packages/coding-agent/",
	".github/workflows/dev-ci.yml",
	".github/workflows/ci.yml",
	"scripts/ci-gjc-state-gates.ts",
	"scripts/verify-gjc-state-writers.ts",
	"scripts/generate-gjc-workflow-manifest.ts",
	"scripts/verify-gjc-skill-docs.ts",
	"scripts/verify-g002-gates.ts",
	"package.json",
	"bun.lock",
	"tsconfig.json",
	"tsconfig.base.json",
	"tsconfig.tools.json",
];

const boundedGateCommands = [
	["bun", "scripts/verify-gjc-state-writers.ts", "--fail"],
	["bun", "scripts/generate-gjc-workflow-manifest.ts", "--check"],
	["bun", "scripts/verify-gjc-skill-docs.ts", "--fail"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-runtime.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-handoff.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-receipts.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-integrity.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-write-hardening.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-graph.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-read-markdown.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-runtime/state-token-thrift.test.ts"],
	["bun", "test", "packages/coding-agent/test/deep-interview-mutation-guard.test.ts"],
	["bun", "test", "packages/coding-agent/test/gjc-skill-state-hooks.test.ts"],
	["bun", "test", "packages/coding-agent/test/skill-active-state.test.ts"],
];

async function changedFiles(): Promise<string[]> {
	if (process.env.GITHUB_EVENT_NAME === "pull_request" && process.env.GITHUB_BASE_SHA) {
		await $`git fetch --no-tags --depth=1 origin ${process.env.GITHUB_BASE_SHA}`.cwd(repoRoot).nothrow();
		const result = await $`git diff --name-only ${process.env.GITHUB_BASE_SHA} HEAD`.cwd(repoRoot).quiet();
		return result.stdout.toString().split("\n").filter(Boolean);
	}

	if (process.env.GITHUB_EVENT_BEFORE && !/^0+$/.test(process.env.GITHUB_EVENT_BEFORE)) {
		await $`git fetch --no-tags --depth=1 origin ${process.env.GITHUB_EVENT_BEFORE}`.cwd(repoRoot).nothrow();
		const result = await $`git diff --name-only ${process.env.GITHUB_EVENT_BEFORE} HEAD`.cwd(repoRoot).quiet();
		return result.stdout.toString().split("\n").filter(Boolean);
	}

	console.log("gjc-state-gates: no comparable base SHA found; running bounded gates.");
	return ["packages/coding-agent/"];
}

function isRelevant(file: string): boolean {
	return relevantPathPrefixes.some(prefix => file === prefix || file.startsWith(prefix));
}

const files = await changedFiles();
const relevantFiles = files.filter(isRelevant);

if (relevantFiles.length === 0) {
	console.log("gjc-state-gates: no relevant paths changed; gate commands skipped.");
	console.log(`gjc-state-gates: inspected ${files.length} changed path(s).`);
	process.exit(0);
}

console.log("gjc-state-gates: relevant paths changed; running bounded gates.");
for (const file of relevantFiles) {
	console.log(`gjc-state-gates: relevant ${file}`);
}

for (const command of boundedGateCommands) {
	console.log(`gjc-state-gates: running ${command.join(" ")}`);
	await $`${command}`.cwd(repoRoot);
}

console.log("gjc-state-gates: bounded gates passed.");
