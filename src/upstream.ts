const USER_AGENT = "open-roles-mcp/0.1 (read-only client for public job-board APIs)";
// Big boards can take several seconds (Lever: 10 s+ at busy times). Waiting costs no CPU, but the
// whole tool call must finish well inside typical client timeouts (60 s in the MCP SDK).
const REQUEST_TIMEOUT_MS = 25_000;
const CALL_DEADLINE_MS = 45_000;
/** Workers Free allows 50 outbound subrequests per invocation; leave headroom. */
const DEFAULT_REQUEST_BUDGET = 40;

export class UpstreamError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "UpstreamError";
	}
}

export class BudgetExceededError extends Error {
	constructor() {
		super("upstream request budget for this call is used up");
		this.name = "BudgetExceededError";
	}
}

/**
 * Upstream access for a single tool call: enforces a request budget, applies timeouts,
 * maps 404/410 to `null`, and de-duplicates identical work within the call.
 */
export class Upstream {
	private remaining: number;
	private readonly deadline = Date.now() + CALL_DEADLINE_MS;
	private readonly memo = new Map<string, Promise<unknown>>();

	constructor(readonly env: Env) {
		const configured = Number.parseInt(env.MAX_UPSTREAM_REQUESTS ?? "", 10);
		this.remaining = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REQUEST_BUDGET;
	}

	get budgetLeft(): number {
		return this.remaining;
	}

	async json<T>(url: string, init: RequestInit = {}): Promise<T | null> {
		if (this.remaining <= 0) throw new BudgetExceededError();
		const host = new URL(url).hostname;
		const timeLeft = this.deadline - Date.now();
		if (timeLeft < 1_000) throw new UpstreamError(`no time left in this call to query ${host}`);
		this.remaining--;
		let res: Response;
		try {
			res = await fetch(url, {
				...init,
				headers: { accept: "application/json", "user-agent": USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
				signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, timeLeft)),
			});
		} catch (err) {
			const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "failed";
			throw new UpstreamError(`request to ${host} ${reason}`);
		}
		if (res.status === 404 || res.status === 410) {
			await res.body?.cancel();
			return null;
		}
		if (!res.ok) {
			await res.body?.cancel();
			throw new UpstreamError(
				res.status === 429 ? `${host} is rate limiting requests; try again shortly` : `${host} responded with HTTP ${res.status}`,
				res.status,
			);
		}
		try {
			return (await res.json()) as T;
		} catch (err) {
			// The timeout signal also covers reading the body.
			if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
				throw new UpstreamError(`request to ${host} timed out`);
			}
			throw new UpstreamError(`${host} returned a response that is not JSON`);
		}
	}

	/** Runs `load` at most once per key during this call. */
	once<T>(key: string, load: () => Promise<T>): Promise<T> {
		let p = this.memo.get(key) as Promise<T> | undefined;
		if (!p) {
			p = load();
			this.memo.set(key, p);
		}
		return p;
	}
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// KV cache. Best effort: quota errors (Free: 1,000 writes/day), the 1 write/sec/key
// limit, or outages never fail a tool call; we simply fetch upstream again.
// ---------------------------------------------------------------------------

export function cacheTtl(env: Env): number {
	const n = Number.parseInt(env.CACHE_TTL_SECONDS ?? "", 10);
	return Number.isFinite(n) ? Math.min(Math.max(n, 60), 86_400) : 600;
}

export async function cacheGet<T>(env: Env, key: string): Promise<T | null> {
	try {
		return await env.CACHE.get<T>(key, "json");
	} catch {
		return null;
	}
}

export async function cachePut(env: Env, key: string, value: unknown, ttlSeconds: number): Promise<void> {
	try {
		await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, Math.round(ttlSeconds)) });
	} catch {
		// Not cached this time.
	}
}

/** Maps with bounded concurrency; `fn` should not throw. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
