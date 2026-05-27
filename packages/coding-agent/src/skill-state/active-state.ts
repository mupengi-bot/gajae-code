import * as fs from "node:fs/promises";
import * as path from "node:path";

export const SKILL_ACTIVE_STATE_FILE = "skill-active-state.json";
export const SKILL_ACTIVE_STALE_MS = 24 * 60 * 60 * 1000;

export const CANONICAL_GJC_WORKFLOW_SKILLS = ["deep-interview", "ralplan", "ultragoal", "team"] as const;

export type CanonicalGjcWorkflowSkill = (typeof CANONICAL_GJC_WORKFLOW_SKILLS)[number];

export interface SkillActiveEntry {
	skill: string;
	phase?: string;
	active?: boolean;
	activated_at?: string;
	updated_at?: string;
	session_id?: string;
	thread_id?: string;
	turn_id?: string;
}

export interface SkillActiveState {
	version?: number;
	active?: boolean;
	skill?: string;
	keyword?: string;
	phase?: string;
	activated_at?: string;
	updated_at?: string;
	source?: string;
	session_id?: string;
	thread_id?: string;
	turn_id?: string;
	active_skills?: SkillActiveEntry[];
	[key: string]: unknown;
}

export interface SkillActiveStatePaths {
	rootPath: string;
	sessionPath?: string;
}

export interface SyncSkillActiveStateOptions {
	cwd: string;
	skill: string;
	active: boolean;
	phase?: string;
	sessionId?: string;
	threadId?: string;
	turnId?: string;
	nowIso?: string;
	source?: string;
}

function safeString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function encodePathSegment(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

function entryKey(entry: Pick<SkillActiveEntry, "skill" | "session_id">): string {
	return `${entry.skill}::${safeString(entry.session_id).trim()}`;
}

function timestampMs(value: string | undefined): number | null {
	if (!value) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

function isFreshEntry(entry: SkillActiveEntry, nowMs = Date.now()): boolean {
	const ms = timestampMs(entry.updated_at) ?? timestampMs(entry.activated_at);
	return ms === null || nowMs - ms <= SKILL_ACTIVE_STALE_MS;
}

function normalizeEntry(raw: unknown): SkillActiveEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const record = raw as Record<string, unknown>;
	const skill = safeString(record.skill).trim();
	if (!skill) return null;
	return {
		...record,
		skill,
		phase: safeString(record.phase).trim() || undefined,
		active: record.active !== false,
		activated_at: safeString(record.activated_at).trim() || undefined,
		updated_at: safeString(record.updated_at).trim() || undefined,
		session_id: safeString(record.session_id).trim() || undefined,
		thread_id: safeString(record.thread_id).trim() || undefined,
		turn_id: safeString(record.turn_id).trim() || undefined,
	};
}

export function isCanonicalGjcWorkflowSkill(skill: string): skill is CanonicalGjcWorkflowSkill {
	return (CANONICAL_GJC_WORKFLOW_SKILLS as readonly string[]).includes(skill);
}

export function listActiveSkills(raw: unknown): SkillActiveEntry[] {
	if (!raw || typeof raw !== "object") return [];
	const state = raw as SkillActiveState;
	const deduped = new Map<string, SkillActiveEntry>();

	if (Array.isArray(state.active_skills)) {
		for (const candidate of state.active_skills) {
			const normalized = normalizeEntry(candidate);
			if (!normalized || normalized.active === false) continue;
			deduped.set(entryKey(normalized), normalized);
		}
	}

	const topLevelSkill = safeString(state.skill).trim();
	if (deduped.size === 0 && state.active === true && topLevelSkill) {
		const entry: SkillActiveEntry = {
			skill: topLevelSkill,
			phase: safeString(state.phase).trim() || undefined,
			active: true,
			activated_at: safeString(state.activated_at).trim() || undefined,
			updated_at: safeString(state.updated_at).trim() || undefined,
			session_id: safeString(state.session_id).trim() || undefined,
			thread_id: safeString(state.thread_id).trim() || undefined,
			turn_id: safeString(state.turn_id).trim() || undefined,
		};
		deduped.set(entryKey(entry), entry);
	}

	return [...deduped.values()];
}

export function normalizeSkillActiveState(raw: unknown): SkillActiveState | null {
	if (!raw || typeof raw !== "object") return null;
	const state = raw as SkillActiveState;
	const activeSkills = listActiveSkills(state);
	const primary = activeSkills.find(entry => entry.skill === safeString(state.skill).trim()) ?? activeSkills[0];
	const skill = safeString(state.skill).trim() || primary?.skill || "";
	if (!skill && activeSkills.length === 0) return null;
	return {
		...state,
		version: typeof state.version === "number" ? state.version : 1,
		active: typeof state.active === "boolean" ? state.active : activeSkills.length > 0,
		skill,
		keyword: safeString(state.keyword).trim(),
		phase: safeString(state.phase).trim() || primary?.phase || "",
		activated_at: safeString(state.activated_at).trim() || primary?.activated_at || "",
		updated_at: safeString(state.updated_at).trim() || primary?.updated_at || "",
		source: safeString(state.source).trim() || undefined,
		session_id: safeString(state.session_id).trim() || primary?.session_id || undefined,
		thread_id: safeString(state.thread_id).trim() || primary?.thread_id || undefined,
		turn_id: safeString(state.turn_id).trim() || primary?.turn_id || undefined,
		active_skills: activeSkills.length > 0 ? activeSkills : [],
	};
}

export function getSkillActiveStatePaths(cwd: string, sessionId?: string): SkillActiveStatePaths {
	const stateDir = path.join(cwd, ".gjc", "state");
	const rootPath = path.join(stateDir, SKILL_ACTIVE_STATE_FILE);
	const normalizedSessionId = safeString(sessionId).trim();
	if (!normalizedSessionId) return { rootPath };
	return {
		rootPath,
		sessionPath: path.join(stateDir, "sessions", encodePathSegment(normalizedSessionId), SKILL_ACTIVE_STATE_FILE),
	};
}

async function readStateFile(filePath: string): Promise<SkillActiveState | null> {
	try {
		return normalizeSkillActiveState(JSON.parse(await Bun.file(filePath).text()));
	} catch {
		return null;
	}
}

function filterRootEntriesForSession(entries: SkillActiveEntry[], sessionId?: string): SkillActiveEntry[] {
	const normalizedSessionId = safeString(sessionId).trim();
	if (!normalizedSessionId) return entries;
	return entries.filter(entry => {
		const entrySessionId = safeString(entry.session_id).trim();
		return entrySessionId.length === 0 || entrySessionId === normalizedSessionId;
	});
}

function mergeVisibleEntries(
	sessionState: SkillActiveState | null,
	rootState: SkillActiveState | null,
	sessionId?: string,
): SkillActiveEntry[] {
	const rootEntries = filterRootEntriesForSession(listActiveSkills(rootState), sessionId).filter(entry =>
		isFreshEntry(entry),
	);
	const merged = new Map(rootEntries.map(entry => [entryKey(entry), entry]));
	for (const entry of listActiveSkills(sessionState).filter(entry => isFreshEntry(entry))) {
		merged.set(entryKey(entry), entry);
	}
	return [...merged.values()];
}

export async function readVisibleSkillActiveState(cwd: string, sessionId?: string): Promise<SkillActiveState | null> {
	const { rootPath, sessionPath } = getSkillActiveStatePaths(cwd, sessionId);
	const [rootState, sessionState] = await Promise.all([
		readStateFile(rootPath),
		sessionPath ? readStateFile(sessionPath) : Promise.resolve(null),
	]);
	const activeSkills = mergeVisibleEntries(sessionState, rootState, sessionId);
	if (activeSkills.length === 0) return null;
	const primary = activeSkills[0];
	return {
		...(rootState ?? {}),
		...(sessionState ?? {}),
		version: 1,
		active: true,
		skill: primary?.skill ?? "",
		phase: primary?.phase ?? "",
		session_id: safeString(sessionId).trim() || primary?.session_id,
		active_skills: activeSkills,
	};
}

async function writeStateFile(filePath: string, state: SkillActiveState): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function upsertEntry(entries: SkillActiveEntry[], entry: SkillActiveEntry, active: boolean): SkillActiveEntry[] {
	const key = entryKey(entry);
	const retained = entries.filter(candidate => entryKey(candidate) !== key);
	return active ? [...retained, entry] : retained;
}

export async function syncSkillActiveState(options: SyncSkillActiveStateOptions): Promise<void> {
	const nowIso = options.nowIso ?? new Date().toISOString();
	const entry: SkillActiveEntry = {
		skill: options.skill,
		phase: options.phase,
		active: options.active,
		activated_at: nowIso,
		updated_at: nowIso,
		session_id: options.sessionId,
		thread_id: options.threadId,
		turn_id: options.turnId,
	};
	const { rootPath, sessionPath } = getSkillActiveStatePaths(options.cwd, options.sessionId);
	const rootState = (await readStateFile(rootPath)) ?? { version: 1, active_skills: [] };
	const rootEntries = upsertEntry(listActiveSkills(rootState), entry, options.active);
	const nextRoot: SkillActiveState = {
		...rootState,
		version: 1,
		active: rootEntries.length > 0,
		skill: rootEntries[0]?.skill ?? "",
		phase: rootEntries[0]?.phase ?? "",
		updated_at: nowIso,
		source: options.source,
		active_skills: rootEntries,
	};
	await writeStateFile(rootPath, nextRoot);

	if (!sessionPath) return;
	const sessionState = (await readStateFile(sessionPath)) ?? { version: 1, active_skills: [] };
	const sessionEntries = upsertEntry(listActiveSkills(sessionState), entry, options.active);
	const nextSession: SkillActiveState = {
		...sessionState,
		version: 1,
		active: sessionEntries.length > 0,
		skill: sessionEntries[0]?.skill ?? "",
		phase: sessionEntries[0]?.phase ?? "",
		session_id: options.sessionId,
		updated_at: nowIso,
		source: options.source,
		active_skills: sessionEntries,
	};
	await writeStateFile(sessionPath, nextSession);
}
