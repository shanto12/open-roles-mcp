import { ADAPTERS, looksLikeBoardId, parseBoardId, parseBoardUrl } from "./providers";
import { fold } from "./text";
import { type Board, type JobDetail, PROVIDERS, type Provider } from "./types";
import { BudgetExceededError, type Upstream, cacheGet, cachePut, cacheTtl, errorMessage } from "./upstream";

// Company -> board mappings change rarely, so they outlive the job-data cache.
const DETECT_TTL_FOUND = 6 * 3600;
const DETECT_TTL_MISSING = 3600;

const boardKey = (provider: Provider, slug: string) => `board:v1:${provider}:${slug}`;

/** A board's jobs (summaries), from KV when fresh, otherwise from the provider. Null if it doesn't exist. */
export function getBoard(up: Upstream, provider: Provider, slug: string): Promise<Board | null> {
	const key = boardKey(provider, slug);
	return up.once(key, async () => {
		const hit = await cacheGet<Board>(up.env, key);
		if (hit) return hit;
		const board = await ADAPTERS[provider].fetchBoard(up, slug);
		if (board) await cachePut(up.env, key, board, cacheTtl(up.env));
		return board;
	});
}

export async function getJob(up: Upstream, provider: Provider, slug: string, jobId: string): Promise<JobDetail | null> {
	const key = `job:v1:${provider}:${slug}:${jobId}`;
	const hit = await cacheGet<JobDetail>(up.env, key);
	if (hit) return hit;
	const job = await ADAPTERS[provider].fetchJob(up, slug, jobId);
	if (!job) return null;
	if (!job.company) job.company = (await cacheGet<Board>(up.env, boardKey(provider, slug)))?.company;
	await cachePut(up.env, key, job, cacheTtl(up.env));
	return job;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * How sure we are that a detected board belongs to the queried company.
 * exact: the caller named the board. high: the provider reports the same company name and the board has
 * openings. medium: openings, name unknown (Lever and Ashby don't expose one). low: no openings or another name.
 */
export type Confidence = "exact" | "high" | "medium" | "low";

export interface BoardMatch {
	board: string;
	provider: Provider;
	slug: string;
	company?: string;
	openJobs: number;
	careersUrl: string;
	confidence: Confidence;
}

export interface Detection {
	/** Ranked best first. */
	matches: BoardMatch[];
	/** Slugs (or board ids) that were probed. */
	tried: string[];
	/** False when probing was cut short by provider errors or the request budget. */
	complete: boolean;
	notes: string[];
	fromCache?: boolean;
}

const CORPORATE_SUFFIXES = new Set([
	"inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "gmbh", "ag", "sa", "sas",
	"sarl", "plc", "bv", "nv", "oy", "oyj", "ab", "as", "asa", "aps", "pty", "pte", "srl", "spa", "kk", "lp", "llp",
]);
// Often dropped from board slugs: "Scale AI" may be "scale", "Notion Labs" is "notion".
const SOFT_SUFFIXES = new Set(["ai", "labs", "lab", "hq", "technologies", "technology", "tech", "software", "systems", "group", "app", "io"]);
const SUBDOMAINS = new Set(["www", "www2", "careers", "career", "jobs", "job", "join", "apply", "work", "about", "team", "hiring", "m"]);
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);
// Companies on these TLDs often keep the TLD in their slug ("x.ai" -> "xai").
const SLUGGY_TLDS = new Set(["ai", "io", "app", "so", "dev", "co", "xyz", "tech", "hq", "inc"]);

function hostOf(input: string): string | undefined {
	const s = input.trim();
	if (/\s/.test(s)) return undefined;
	if (!/^https?:\/\//i.test(s) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i.test(s)) return undefined;
	try {
		return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

/** Board-slug guesses for a company name or domain, most likely first. */
export function slugCandidates(input: string): string[] {
	const out: string[] = [];
	const add = (s: string) => {
		const c = s.replace(/^-+|-+$/g, "");
		if (c.length >= 2 && c.length <= 60 && /^[a-z0-9-]+$/.test(c) && !out.includes(c)) out.push(c);
	};
	const host = hostOf(input);
	if (host) {
		const labels = host.split(".").filter(Boolean);
		while (labels.length > 2 && SUBDOMAINS.has(labels[0])) labels.shift();
		if (labels.length < 2) return [];
		let i = labels.length - 2;
		if (labels.length > 2 && labels[labels.length - 1].length === 2 && SECOND_LEVEL.has(labels[i])) i--;
		const name = labels[i];
		const tld = labels.slice(i + 1).join("");
		if (name.length <= 2) add(name + tld);
		add(name);
		if (SLUGGY_TLDS.has(tld)) add(name + tld);
		add(name.replace(/-/g, ""));
		return out.slice(0, 3);
	}
	const words = fold(input.replace(/&/g, " ")).split(" ").filter(Boolean);
	while (words.length > 1 && CORPORATE_SUFFIXES.has(words[words.length - 1])) words.pop();
	const article = words.length > 1 && words[0] === "the" ? words.shift() : undefined;
	if (!words.length) return [];
	const core = [...words];
	while (core.length > 1 && SOFT_SUFFIXES.has(core[core.length - 1])) core.pop();
	add(words.join(""));
	add(core.join(""));
	add(words.join("-"));
	if (article) add(`${article}${words.join("")}`);
	add(core.join("-"));
	return out.slice(0, 4);
}

/** 2: same name, 1: one name extends the other, 0: unknown, -1: different company. */
function nameScore(company: string | undefined, query: string): number {
	if (!company) return 0;
	const compact = (s: string) => {
		const words = fold(s).split(" ").filter(Boolean);
		while (words.length > 1 && CORPORATE_SUFFIXES.has(words[words.length - 1])) words.pop();
		return words.join("");
	};
	const host = hostOf(query);
	const a = compact(company);
	const b = host ? (slugCandidates(query)[0] ?? "") : compact(query);
	if (!a || !b) return 0;
	if (a === b) return 2;
	return a.startsWith(b) || b.startsWith(a) ? 1 : -1;
}

function toMatch(b: Board, query?: string): BoardMatch {
	const score = query === undefined ? 0 : nameScore(b.company, query);
	const confidence: Confidence =
		query === undefined ? "exact" : b.jobs.length === 0 || score < 0 ? "low" : score === 2 ? "high" : "medium";
	return { board: b.board, provider: b.provider, slug: b.slug, company: b.company, openJobs: b.jobs.length, careersUrl: b.url, confidence };
}

/**
 * Best first: has openings, then name not contradicted, then most openings. A matching name only breaks
 * ties: anyone can register a board under a famous name (empty look-alike Workable accounts are common).
 */
function rank(matches: (BoardMatch & { order: number })[], query: string): BoardMatch[] {
	const key = (m: BoardMatch & { order: number }) => {
		const score = nameScore(m.company, query);
		return [m.openJobs > 0 ? 1 : 0, score >= 0 ? 1 : 0, m.openJobs, score, -m.order];
	};
	return [...matches]
		.sort((x, y) => {
			const a = key(x);
			const b = key(y);
			for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
			return 0;
		})
		.map(({ order: _order, ...m }) => m);
}

/**
 * Finds the boards a company uses. Accepts a board id, a careers/API URL, a domain or a name.
 * Name/domain lookups probe every provider for each slug candidate, stopping at a good match.
 */
export async function detectBoards(up: Upstream, query: string, opts: { fresh?: boolean } = {}): Promise<Detection> {
	const q = query.trim();
	const direct = parseBoardId(q) ?? parseBoardUrl(q);
	if (direct) {
		const board = await getBoard(up, direct.provider, direct.slug);
		return { matches: board ? [toMatch(board)] : [], tried: [`${direct.provider}:${direct.slug}`], complete: true, notes: [] };
	}
	if (looksLikeBoardId(q)) {
		return { matches: [], tried: [], complete: true, notes: [`Unknown provider in "${q}". Supported: ${PROVIDERS.join(", ")}.`] };
	}

	const candidates = slugCandidates(q);
	if (!candidates.length) {
		const note = `Could not derive a board name from "${q}". Pass a company name, domain, careers-page URL or "provider:slug".`;
		return { matches: [], tried: [], complete: true, notes: [note] };
	}

	const cacheKey = `detect:v2:${candidates.join(",")}`;
	if (!opts.fresh) {
		const cached = await cacheGet<Detection>(up.env, cacheKey);
		if (cached) return { ...cached, fromCache: true };
	}

	const found: (BoardMatch & { order: number })[] = [];
	const notes = new Set<string>();
	const tried: string[] = [];
	let complete = true;
	for (const [order, slug] of candidates.entries()) {
		if (up.budgetLeft < PROVIDERS.length) {
			complete = false;
			notes.add("Stopped early: upstream request budget for this call is used up.");
			break;
		}
		tried.push(slug);
		const results = await Promise.allSettled(PROVIDERS.map((p) => getBoard(up, p, slug)));
		results.forEach((r, i) => {
			if (r.status === "fulfilled") {
				if (r.value) found.push({ ...toMatch(r.value, q), order });
			} else {
				complete = false;
				notes.add(
					r.reason instanceof BudgetExceededError
						? "Stopped early: upstream request budget for this call is used up."
						: `${PROVIDERS[i]}:${slug} could not be checked (${errorMessage(r.reason)}).`,
				);
			}
		});
		// A board with openings that doesn't belong to a differently named company: good enough.
		if (found.some((m) => m.openJobs > 0 && nameScore(m.company, q) >= 0)) break;
	}

	const detection: Detection = { matches: rank(found, q), tried, complete, notes: [...notes] };
	if (complete) await cachePut(up.env, cacheKey, detection, detection.matches.length ? DETECT_TTL_FOUND : DETECT_TTL_MISSING);
	return detection;
}

export function notFoundMessage(query: string, d: Detection): string {
	// Nothing was probed (unsupported provider, unusable input): the note says why.
	if (!d.tried.length && d.notes.length) return d.notes.join(" ");
	const tried = d.tried.length ? ` (tried: ${d.tried.join(", ")})` : "";
	const notes = d.notes.length ? ` ${d.notes.join(" ")}` : "";
	const head = d.complete
		? `No public Greenhouse, Lever, Ashby or Workable board found for "${query}"${tried}.`
		: `Could not finish looking up "${query}"${tried}.`;
	return `${head}${notes} If you know the board, pass it as "provider:slug" (e.g. "greenhouse:acme") or a careers-page URL.`;
}

export type Resolution =
	| { ok: true; board: Board; confidence: Confidence; resolvedFrom?: string; alternatives: string[] }
	| { ok: false; error: string };

/** Turns a board id, careers URL, domain or company name into a loaded board. */
export async function resolveBoard(up: Upstream, input: string): Promise<Resolution> {
	const direct = parseBoardId(input) ?? parseBoardUrl(input);
	if (direct) {
		const board = await getBoard(up, direct.provider, direct.slug);
		return board
			? { ok: true, board, confidence: "exact", alternatives: [] }
			: { ok: false, error: `No ${direct.provider} board named "${direct.slug}" exists. Use find_job_board to look up the right board.` };
	}
	let detection = await detectBoards(up, input);
	for (let attempt = 0; attempt < 2; attempt++) {
		const best = detection.matches[0];
		if (!best) return { ok: false, error: notFoundMessage(input.trim(), detection) };
		const board = await getBoard(up, best.provider, best.slug);
		if (board) {
			return {
				ok: true,
				board,
				confidence: best.confidence,
				resolvedFrom: input.trim(),
				alternatives: detection.matches.slice(1).filter((m) => m.openJobs > 0).map((m) => m.board),
			};
		}
		// A cached detection pointed at a board that has since disappeared: detect again.
		if (!detection.fromCache) break;
		detection = await detectBoards(up, input, { fresh: true });
	}
	return { ok: false, error: notFoundMessage(input.trim(), detection) };
}
