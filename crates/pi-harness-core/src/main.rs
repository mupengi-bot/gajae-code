use std::{
	fs,
	path::{Path, PathBuf},
	time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};

#[derive(Parser, Debug)]
#[command(name = "pi-harness-core", about = "GJC run ledger and scoring core")]
struct Cli {
	#[command(subcommand)]
	command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
	InitRun {
		#[arg(long)]
		goal:      String,
		#[arg(long, default_value = ".")]
		workspace: PathBuf,
		#[arg(long)]
		run:       Option<String>,
	},
	AddAttempt {
		#[arg(long)]
		run:       String,
		#[arg(long)]
		label:     String,
		#[arg(long, default_value = ".")]
		workspace: PathBuf,
		#[arg(long)]
		notes:     Option<String>,
		#[arg(long)]
		attempt:   Option<String>,
	},
	ScoreAttempt {
		#[arg(long)]
		run:        String,
		#[arg(long)]
		attempt:    String,
		#[arg(long, default_value = ".")]
		workspace:  PathBuf,
		#[arg(long)]
		build:      f64,
		#[arg(long)]
		tests:      f64,
		#[arg(long)]
		lint:       f64,
		#[arg(long, default_value_t = 0.0)]
		checks:     f64,
		#[arg(long, default_value_t = 0.0)]
		screenshot: f64,
		#[arg(long, default_value_t = 0.0)]
		review:     f64,
		#[arg(long, default_value_t = 0.0)]
		risk:       f64,
		#[arg(long = "diff-size", default_value_t = 0.5)]
		diff_size:  f64,
	},
	Propose {
		#[arg(long)]
		run:       String,
		#[arg(long)]
		title:     String,
		#[arg(long)]
		body:      String,
		#[arg(long, default_value = ".")]
		workspace: PathBuf,
		#[arg(long)]
		proposal:  Option<String>,
	},
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunLedger {
	pub schema_version: u32,
	pub run_id:         String,
	pub goal:           String,
	pub workspace:      String,
	pub created_at:     String,
	pub updated_at:     String,
	pub attempts:       Vec<String>,
	pub proposals:      Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttemptLedger {
	pub attempt_id: String,
	pub run_id:     String,
	pub label:      String,
	pub notes:      Option<String>,
	pub created_at: String,
	pub updated_at: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScoreInput {
	pub build:      f64,
	pub tests:      f64,
	pub lint:       f64,
	pub checks:     f64,
	pub screenshot: f64,
	pub review:     f64,
	pub risk:       f64,
	pub diff_size:  f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttemptScore {
	pub attempt_id:  String,
	pub run_id:      String,
	pub input:       ScoreInput,
	pub final_score: f64,
	pub grade:       String,
	pub created_at:  String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct CommandResponse<T> {
	ok:       bool,
	action:   &'static str,
	run_id:   String,
	path:     String,
	evidence: T,
}

pub fn score_attempt(input: &ScoreInput) -> f64 {
	let build = clamp01(input.build);
	let tests = clamp01(input.tests);
	let lint = clamp01(input.lint);
	let checks = clamp01(input.checks);
	let screenshot = clamp01(input.screenshot);
	let review = clamp01(input.review);
	let risk = clamp01(input.risk);
	let diff_size = clamp01(input.diff_size);
	let diff_penalty = (diff_size - 0.35).max(0.0) * 0.2;
	let raw = tests.mul_add(
		0.22,
		lint.mul_add(
			0.14,
			checks.mul_add(
				0.12,
				screenshot
					.mul_add(0.10, review.mul_add(0.12, (1.0 - risk).mul_add(0.08, build * 0.22))),
			),
		),
	) - diff_penalty;
	round4(clamp01(raw))
}

const fn clamp01(value: f64) -> f64 {
	if value.is_nan() {
		return 0.0;
	}
	value.clamp(0.0, 1.0)
}

fn round4(value: f64) -> f64 {
	(value * 10_000.0).round() / 10_000.0
}

fn grade(score: f64) -> String {
	if score >= 0.9 {
		"excellent".to_string()
	} else if score >= 0.75 {
		"keep".to_string()
	} else if score >= 0.55 {
		"review".to_string()
	} else {
		"discard".to_string()
	}
}

fn now_token() -> String {
	let millis = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis();
	millis.to_string()
}

fn now_isoish() -> String {
	format!("unix-ms:{}", now_token())
}

fn slug(value: &str) -> String {
	let mut out = String::new();
	for ch in value.chars() {
		if ch.is_ascii_alphanumeric() {
			out.push(ch.to_ascii_lowercase());
		} else if (ch.is_whitespace() || ch == '-' || ch == '_') && !out.ends_with('-') {
			out.push('-');
		}
	}
	out.trim_matches('-').chars().take(48).collect::<String>()
}

fn validate_id(value: String, kind: &str) -> Result<String> {
	let trimmed = value.trim();
	if trimmed.is_empty() {
		bail!("invalid_{kind}_id:empty");
	}
	if trimmed == "."
		|| trimmed == ".."
		|| trimmed.contains('/')
		|| trimmed.contains('\\')
		|| trimmed.starts_with('.')
	{
		bail!("invalid_{kind}_id:path-segment");
	}
	if !trimmed
		.chars()
		.all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
	{
		bail!("invalid_{kind}_id:characters");
	}
	Ok(trimmed.to_string())
}

fn optional_id(value: Option<String>, kind: &str) -> Result<Option<String>> {
	value.map(|entry| validate_id(entry, kind)).transpose()
}

fn ledger_root(workspace: &Path) -> PathBuf {
	workspace.join(".gjc").join("runs")
}

fn run_dir(workspace: &Path, run_id: &str) -> PathBuf {
	ledger_root(workspace).join(run_id)
}

fn run_json_path(workspace: &Path, run_id: &str) -> PathBuf {
	run_dir(workspace, run_id).join("run.json")
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
	let text = serde_json::to_string_pretty(value)?;
	fs::write(path, format!("{text}\n")).with_context(|| format!("write {}", path.display()))
}

fn read_run(workspace: &Path, run_id: &str) -> Result<RunLedger> {
	let path = run_json_path(workspace, run_id);
	let text = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
	serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

fn write_run(workspace: &Path, run: &RunLedger) -> Result<()> {
	write_json(&run_json_path(workspace, &run.run_id), run)
}

fn canonical_workspace(workspace: &Path) -> Result<PathBuf> {
	if workspace.exists() {
		workspace
			.canonicalize()
			.with_context(|| format!("canonicalize {}", workspace.display()))
	} else {
		bail!("workspace_not_found:{}", workspace.display())
	}
}

fn init_run(
	goal: String,
	workspace: PathBuf,
	run: Option<String>,
) -> Result<CommandResponse<RunLedger>> {
	let workspace = canonical_workspace(&workspace)?;
	let base = slug(&goal);
	let run_id = optional_id(run, "run")?.unwrap_or_else(|| {
		format!("run-{}-{}", now_token(), if base.is_empty() { "goal" } else { &base })
	});
	let dir = run_dir(&workspace, &run_id);
	fs::create_dir_all(dir.join("attempts"))?;
	fs::create_dir_all(dir.join("proposals"))?;
	fs::write(dir.join("goal.md"), format!("# Goal\n\n{goal}\n"))?;
	let now = now_isoish();
	let ledger = RunLedger {
		schema_version: 1,
		run_id: run_id.clone(),
		goal,
		workspace: workspace.display().to_string(),
		created_at: now.clone(),
		updated_at: now,
		attempts: Vec::new(),
		proposals: Vec::new(),
	};
	write_run(&workspace, &ledger)?;
	Ok(CommandResponse {
		ok: true,
		action: "init-run",
		run_id,
		path: dir.display().to_string(),
		evidence: ledger,
	})
}

fn add_attempt(
	run_id: String,
	label: String,
	workspace: PathBuf,
	notes: Option<String>,
	attempt: Option<String>,
) -> Result<CommandResponse<AttemptLedger>> {
	let workspace = canonical_workspace(&workspace)?;
	let run_id = validate_id(run_id, "run")?;
	let mut run = read_run(&workspace, &run_id)?;
	let attempt_id = optional_id(attempt, "attempt")?
		.unwrap_or_else(|| format!("attempt-{}-{}", now_token(), slug(&label)));
	let dir = run_dir(&workspace, &run_id)
		.join("attempts")
		.join(&attempt_id);
	fs::create_dir_all(&dir)?;
	let now = now_isoish();
	let ledger = AttemptLedger {
		attempt_id: attempt_id.clone(),
		run_id: run_id.clone(),
		label,
		notes,
		created_at: now.clone(),
		updated_at: now,
	};
	write_json(&dir.join("attempt.json"), &ledger)?;
	if !run.attempts.contains(&attempt_id) {
		run.attempts.push(attempt_id);
	}
	run.updated_at = now_isoish();
	write_run(&workspace, &run)?;
	Ok(CommandResponse {
		ok: true,
		action: "add-attempt",
		run_id,
		path: dir.display().to_string(),
		evidence: ledger,
	})
}

fn score_attempt_cmd(
	run_id: String,
	attempt_id: String,
	workspace: PathBuf,
	input: ScoreInput,
) -> Result<CommandResponse<AttemptScore>> {
	let workspace = canonical_workspace(&workspace)?;
	let run_id = validate_id(run_id, "run")?;
	let attempt_id = validate_id(attempt_id, "attempt")?;
	let attempt_dir = run_dir(&workspace, &run_id)
		.join("attempts")
		.join(&attempt_id);
	if !attempt_dir.join("attempt.json").exists() {
		bail!("attempt_not_found:{attempt_id}");
	}
	let final_score = score_attempt(&input);
	let score = AttemptScore {
		attempt_id,
		run_id: run_id.clone(),
		input,
		final_score,
		grade: grade(final_score),
		created_at: now_isoish(),
	};
	let path = attempt_dir.join("score.json");
	write_json(&path, &score)?;
	Ok(CommandResponse {
		ok: true,
		action: "score-attempt",
		run_id,
		path: path.display().to_string(),
		evidence: score,
	})
}

fn propose(
	run_id: String,
	title: String,
	body: String,
	workspace: PathBuf,
	proposal: Option<String>,
) -> Result<CommandResponse<serde_json::Value>> {
	let workspace = canonical_workspace(&workspace)?;
	let run_id = validate_id(run_id, "run")?;
	let mut run = read_run(&workspace, &run_id)?;
	let proposal_id = optional_id(proposal, "proposal")?
		.unwrap_or_else(|| format!("proposal-{}-{}", now_token(), slug(&title)));
	let dir = run_dir(&workspace, &run_id).join("proposals");
	fs::create_dir_all(&dir)?;
	let path = dir.join(format!("{proposal_id}.md"));
	fs::write(&path, format!("# {title}\n\n{body}\n"))?;
	if !run.proposals.contains(&proposal_id) {
		run.proposals.push(proposal_id.clone());
	}
	run.updated_at = now_isoish();
	write_run(&workspace, &run)?;
	let evidence = serde_json::json!({ "proposalId": proposal_id, "title": title });
	Ok(CommandResponse {
		ok: true,
		action: "propose",
		run_id,
		path: path.display().to_string(),
		evidence,
	})
}

fn main() -> Result<()> {
	let cli = Cli::parse();
	let response = match cli.command {
		Commands::InitRun { goal, workspace, run } => {
			serde_json::to_value(init_run(goal, workspace, run)?)?
		},
		Commands::AddAttempt { run, label, workspace, notes, attempt } => {
			serde_json::to_value(add_attempt(run, label, workspace, notes, attempt)?)?
		},
		Commands::ScoreAttempt {
			run,
			attempt,
			workspace,
			build,
			tests,
			lint,
			checks,
			screenshot,
			review,
			risk,
			diff_size,
		} => {
			let input = ScoreInput { build, tests, lint, checks, screenshot, review, risk, diff_size };
			serde_json::to_value(score_attempt_cmd(run, attempt, workspace, input)?)?
		},
		Commands::Propose { run, title, body, workspace, proposal } => {
			serde_json::to_value(propose(run, title, body, workspace, proposal)?)?
		},
	};
	println!("{}", serde_json::to_string_pretty(&response)?);
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn scoring_rewards_verified_low_risk_attempts() {
		let input = ScoreInput {
			build:      1.0,
			tests:      1.0,
			lint:       1.0,
			checks:     1.0,
			screenshot: 1.0,
			review:     1.0,
			risk:       0.0,
			diff_size:  0.2,
		};
		assert_eq!(score_attempt(&input), 1.0);
	}

	#[test]
	fn rejects_path_like_user_supplied_ids() {
		assert!(validate_id("../escape".to_string(), "run").is_err());
		assert!(validate_id("/tmp/escape".to_string(), "attempt").is_err());
		assert!(validate_id("safe-id_1".to_string(), "proposal").is_ok());
	}
}
