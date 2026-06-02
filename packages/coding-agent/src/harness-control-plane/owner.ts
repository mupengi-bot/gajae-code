/**
 * RuntimeOwner — the detached per-session process that makes live control honest.
 *
 * Responsibilities:
 *  - hold the {@link SessionLease} (single writer),
 *  - own the {@link HarnessRpc} subprocess (injected; real `GajaeCodeRpc` in prod, fake in tests),
 *  - serve owner-routed primitives over the {@link ControlServer} endpoint,
 *  - be the SOLE writer of the severity event stream,
 *  - heartbeat the lease.
 *
 * Stateless `gjc harness` CLI calls reach the owner via {@link resolveOwner} + the endpoint.
 */
import { randomUUID } from "node:crypto";
import { ControlServer, type EndpointRequest } from "./control-endpoint";
import type { HarnessRpc } from "./rpc-adapter";
import { singleFlightAccept } from "./rpc-adapter";
import {
	acquireLease,
	canWriteEvents,
	heartbeat,
	isStale,
	readLease,
	releaseLease,
	type SessionLease,
} from "./session-lease";
import { buildStateView, nextAllowedActions } from "./state-machine";
import { appendEvent, readEvents, readSessionState, sessionPaths, writeSessionState } from "./storage";
import type { EventEnvelope, PrimitiveResponse, SessionState, Severity } from "./types";

export interface OwnerOptions {
	root: string;
	sessionId: string;
	rpc: HarnessRpc;
	ownerId?: string;
	ttlMs?: number;
	heartbeatMs?: number;
	acceptanceTimeoutMs?: number;
	clock?: () => number;
}

export interface OwnerStartInfo {
	ownerId: string;
	socketPath: string;
	leaseEpoch: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_ACCEPT_TIMEOUT_MS = 60_000;

export class RuntimeOwner {
	readonly ownerId: string;
	#opts: Required<Omit<OwnerOptions, "clock">> & { clock?: () => number };
	#server: ControlServer;
	#cursor = 0;
	#leaseEpoch = 0;
	#heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	#socketPath: string;

	constructor(opts: OwnerOptions) {
		this.ownerId = opts.ownerId ?? `owner-${randomUUID()}`;
		this.#socketPath = sessionPaths(opts.root, opts.sessionId).controlSock;
		this.#opts = {
			root: opts.root,
			sessionId: opts.sessionId,
			rpc: opts.rpc,
			ownerId: this.ownerId,
			ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
			heartbeatMs: opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
			acceptanceTimeoutMs: opts.acceptanceTimeoutMs ?? DEFAULT_ACCEPT_TIMEOUT_MS,
			clock: opts.clock,
		};
		this.#server = new ControlServer(this.#socketPath, req => this.#handle(req));
	}

	async start(): Promise<OwnerStartInfo> {
		const { root, sessionId } = this.#opts;
		const eventsPath = sessionPaths(root, sessionId).events;
		const existing = await readEvents(root, sessionId, 0);
		this.#cursor = existing.reduce((max, e) => Math.max(max, e.cursor), 0);
		const { lease } = await acquireLease(root, sessionId, {
			ownerId: this.ownerId,
			pid: process.pid,
			endpoint: { kind: "unix-socket", path: this.#socketPath },
			eventsPath,
			ttlMs: this.#opts.ttlMs,
			clock: this.#opts.clock,
		});
		this.#leaseEpoch = lease.leaseEpoch;
		await this.#server.listen();
		await this.#emit("info", "owner_started", { ownerId: this.ownerId, leaseEpoch: this.#leaseEpoch });
		this.#heartbeatTimer = setInterval(() => {
			void heartbeat(root, sessionId, this.ownerId, this.#opts.ttlMs, this.#opts.clock).catch(() => {});
		}, this.#opts.heartbeatMs);
		this.#heartbeatTimer.unref?.();
		return { ownerId: this.ownerId, socketPath: this.#socketPath, leaseEpoch: this.#leaseEpoch };
	}

	async #loadState(): Promise<SessionState> {
		const state = await readSessionState(this.#opts.root, this.#opts.sessionId);
		if (!state) throw new Error(`session_not_found:${this.#opts.sessionId}`);
		return state;
	}

	async #emit(severity: Severity, kind: string, evidence: Record<string, unknown>): Promise<void> {
		const lease = await readLease(this.#opts.root, this.#opts.sessionId);
		// Single-writer guard: only emit while we still hold a live lease.
		if (!lease || !canWriteEvents(lease, this.ownerId, this.#opts.clock)) return;
		const state = await readSessionState(this.#opts.root, this.#opts.sessionId);
		const view = state
			? buildStateView(state, true)
			: {
					sessionId: this.#opts.sessionId,
					lifecycle: "started" as const,
					harness: "gajae-code" as const,
					ownerLive: true,
					blockers: [],
				};
		const envelope: EventEnvelope = {
			eventId: randomUUID(),
			cursor: ++this.#cursor,
			createdAt: new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString(),
			severity,
			kind,
			state: view,
			evidence,
			nextAllowedActions: nextAllowedActions(view.lifecycle, true),
			writer: { ownerId: this.ownerId, leaseEpoch: this.#leaseEpoch },
		};
		await appendEvent(this.#opts.root, this.#opts.sessionId, envelope);
	}

	#response(state: SessionState, evidence: Record<string, unknown>, ok = true): PrimitiveResponse {
		return {
			ok,
			state: buildStateView(state, true),
			evidence,
			nextAllowedActions: nextAllowedActions(state.lifecycle, true),
		};
	}

	async #handle(req: EndpointRequest): Promise<unknown> {
		switch (req.verb) {
			case "ping":
				return { ok: true, ownerId: this.ownerId, leaseEpoch: this.#leaseEpoch };
			case "submit":
				return this.#submit(req.input);
			case "observe":
				return this.#observe();
			case "retire":
				return this.#retire();
			default:
				return { ok: false, error: `owner_unsupported_verb:${req.verb}` };
		}
	}

	async #submit(input: Record<string, unknown>): Promise<PrimitiveResponse> {
		const prompt = typeof input.prompt === "string" ? input.prompt : "";
		if (!prompt) {
			const state = await this.#loadState();
			return this.#response(state, { accepted: false, reason: "empty-prompt" }, false);
		}
		const result = await singleFlightAccept(this.#opts.rpc, prompt, this.#opts.acceptanceTimeoutMs);
		const state = await this.#loadState();
		if (result.accepted) {
			state.lifecycle = "observing";
			state.updatedAt = new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString();
			await writeSessionState(this.#opts.root, state);
			await this.#emit("info", "prompt_accepted", {
				reason: result.reason,
				agentStartCursor: result.agentStartCursor,
			});
		} else {
			await this.#emit("warn", "prompt_not_accepted", { reason: result.reason });
		}
		return this.#response(
			state,
			{
				accepted: result.accepted,
				submitted: true,
				reason: result.reason,
				commandId: result.commandId,
				preSubmitCursor: result.preSubmitCursor,
				agentStartCursor: result.agentStartCursor,
				acceptanceEvidence: result.preSubmitState,
			},
			result.accepted,
		);
	}

	async #observe(): Promise<PrimitiveResponse> {
		const state = await this.#loadState();
		const rpcState = await this.#opts.rpc.getState().catch(() => null);
		return this.#response(state, {
			observation: {
				lifecycle: state.lifecycle,
				ownerLive: true,
				cwd: state.handle.workspace,
				branch: state.handle.branch,
				gitDelta: "unknown",
				lastActivityAt: state.updatedAt,
				observedSignals: rpcState?.isStreaming ? ["streaming"] : ["idle"],
				risk: "normal",
			},
			ownerRouted: true,
		});
	}

	async #retire(): Promise<PrimitiveResponse> {
		const state = await this.#loadState();
		state.lifecycle = "retired";
		state.updatedAt = new Date(this.#opts.clock ? this.#opts.clock() : Date.now()).toISOString();
		await writeSessionState(this.#opts.root, state);
		await this.#emit("info", "owner_retired", {});
		queueMicrotask(() => void this.stop());
		return this.#response(state, { retired: true });
	}

	async stop(): Promise<void> {
		if (this.#heartbeatTimer) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = null;
		}
		await this.#server.close().catch(() => {});
		await this.#opts.rpc.close().catch(() => {});
		await releaseLease(this.#opts.root, this.#opts.sessionId, this.ownerId).catch(() => {});
	}
}

export interface ResolvedOwner {
	live: boolean;
	socketPath: string | null;
	lease: SessionLease | null;
}

/** Determine whether a live owner currently holds the session (for CLI routing). */
export async function resolveOwner(root: string, sessionId: string): Promise<ResolvedOwner> {
	const lease = await readLease(root, sessionId);
	if (!lease) return { live: false, socketPath: null, lease: null };
	if (isStale(lease)) return { live: false, socketPath: lease.endpoint?.path ?? null, lease };
	return { live: true, socketPath: lease.endpoint?.path ?? null, lease };
}
