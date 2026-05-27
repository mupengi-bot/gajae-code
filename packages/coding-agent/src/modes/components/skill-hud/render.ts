import type { SkillActiveEntry } from "../../../skill-state/active-state";

const ANSI_RESET_FG = "\x1b[39m";
const ANSI_RESET_BOLD = "\x1b[22m";
const ANSI_BORDER = "\x1b[90m";
const ANSI_ACCENT = "\x1b[36m";
const ANSI_DIM = "\x1b[2m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function visibleWidth(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}

function truncateToWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(text) <= maxWidth) return text;
	const plain = text.replace(ANSI_PATTERN, "");
	if (maxWidth === 1) return "…";
	return `${plain.slice(0, maxWidth - 1)}…`;
}

function sanitizeHudPart(value: string | undefined): string {
	return (value ?? "")
		.replace(ANSI_PATTERN, "")
		.replace(/[\r\n\t]+/g, " ")
		.trim();
}

function compareEntries(a: SkillActiveEntry, b: SkillActiveEntry): number {
	return a.skill.localeCompare(b.skill) || (a.phase ?? "").localeCompare(b.phase ?? "");
}

export function renderSkillHudBar(entries: readonly SkillActiveEntry[], width: number): string | null {
	const active = entries.filter(entry => entry.active !== false && sanitizeHudPart(entry.skill)).sort(compareEntries);
	if (active.length === 0 || width <= 0) return null;
	const body = active
		.map(entry => {
			const skill = sanitizeHudPart(entry.skill);
			const phase = sanitizeHudPart(entry.phase);
			return phase ? `${skill}:${phase}` : skill;
		})
		.join(" + ");
	const prefix = `${ANSI_BORDER}◆${ANSI_RESET_FG} ${ANSI_BOLD}${ANSI_ACCENT}hud${ANSI_RESET_FG}${ANSI_RESET_BOLD} `;
	const budget = Math.max(1, width - visibleWidth(prefix));
	return truncateToWidth(`${prefix}${ANSI_DIM}${truncateToWidth(body, budget)}${ANSI_RESET_BOLD}`, width);
}
