import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type BoardMatch, type Resolution, detectBoards, getJob, notFoundMessage, resolveBoard } from "./boards";
import { type JobFilters, departmentCounts, filterJobs, sortNewestFirst } from "./filters";
import { normalizeJobId, parseBoardId, parseBoardUrl } from "./providers";
import { day, parseSince, payMentions, timeOf, truncate } from "./text";
import type { JobSummary, Provider } from "./types";
import { BudgetExceededError, Upstream, UpstreamError, errorMessage, mapLimit } from "./upstream";

const MAX_COMPANIES = 10;
const COMPANY_CONCURRENCY = 3;
const MAX_DESCRIPTION_CHARS = 15_000;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

// ---------------------------------------------------------------------------
// Shared schema pieces
// ---------------------------------------------------------------------------

const boardParam = z
	.string()
	.trim()
	.min(1)
	.max(300)
	.describe(
		'Board id from find_job_board, e.g. "greenhouse:anthropic", "ashby:openai", "lever:palantir", "workable:huggingface". ' +
			"A careers-page URL, company name or domain also works (auto-detected).",
	);
const keywordParam = z
	.string()
	.trim()
	.max(200)
	.describe(
		'Matches words in the job title, case-insensitively. Every word must match the start of a title word ("engineer" matches "Engineering"); ' +
			'use "|" for alternatives, e.g. "frontend | front-end". Use department to filter by team.',
	);
const locationParam = z
	.string()
	.trim()
	.max(200)
	.describe('Matches posted locations, e.g. "London", "Austin, TX", "US", "UK", "Europe", "Bay Area", "remote". Use "|" for alternatives.');
const remoteParam = z
	.boolean()
	.describe("true: only roles marked remote / remote-friendly. false: exclude those. Hybrid roles count as not remote.");
const companiesParam = z
	.array(z.string().trim().min(1).max(300))
	.min(1)
	.max(25)
	.describe(`Company names, domains, careers-page URLs or board ids. Up to ${MAX_COMPANIES} are processed per call.`);

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function ok(data: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): CallToolResult {
	return { isError: true, content: [{ type: "text", text: message }] };
}

async function run(env: Env, handler: (up: Upstream) => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await handler(new Upstream(env));
	} catch (err) {
		if (err instanceof BudgetExceededError) {
			return fail('This request needed more job-board calls than one tool call allows. Try fewer companies, or pass board ids ("provider:slug").');
		}
		if (err instanceof UpstreamError) return fail(`Job board request failed: ${err.message}. Try again shortly.`);
		return fail(`Unexpected error: ${errorMessage(err)}`);
	}
}

const nonEmpty = <T>(items: T[]): T[] | undefined => (items.length ? items : undefined);

function jobItem(j: JobSummary) {
	return {
		id: j.id,
		title: j.title,
		location: j.location,
		department: j.department,
		team: j.team && j.team !== j.department ? j.team : undefined,
		workplace: j.workplace === "unknown" ? undefined : j.workplace,
		type: j.employmentType,
		posted: day(j.published),
		pay: j.pay,
		url: j.url,
	};
}

function matchItem(m: BoardMatch) {
	return {
		board: m.board,
		provider: m.provider,
		slug: m.slug,
		company: m.company,
		open_jobs: m.openJobs,
		careers_url: m.careersUrl,
		confidence: m.confidence,
	};
}

function boardHeader(r: Extract<Resolution, { ok: true }>) {
	const { board } = r;
	return {
		board: board.board,
		company: board.company,
		careers_url: board.url,
		// Only shown for auto-detected boards; see find_job_board for what the levels mean.
		match_confidence: r.confidence === "exact" ? undefined : r.confidence,
		data_fetched_at: board.fetchedAt,
	};
}

interface Change {
	j: JobSummary;
	change: "new" | "updated";
	at: number;
}

const TIMESTAMP_NOTES: Partial<Record<Provider, string>> = {
	lever: "Lever only reports when a posting was created; edits to older postings are not visible.",
	ashby: "Ashby only reports when a posting was published; edits to older postings are not visible.",
	workable: "Workable only reports the publish date (no time) and no update dates.",
};

/** De-duplicates company inputs (case-insensitively) and applies the per-call cap. */
function takeCompanies(companies: string[]): { list: string[]; notes: string[] } {
	const seen = new Set<string>();
	const unique = companies.filter((c) => {
		const k = c.toLowerCase();
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	const notes =
		unique.length > MAX_COMPANIES
			? [`Only the first ${MAX_COMPANIES} companies were processed; call again for: ${unique.slice(MAX_COMPANIES).join(", ")}.`]
			: [];
	return { list: unique.slice(0, MAX_COMPANIES), notes };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, env: Env): void {
	server.registerTool(
		"find_job_board",
		{
			title: "Find a company's job board",
			description:
				"Find which public job board a company uses: Greenhouse, Lever, Ashby or Workable. Probes likely board names derived from the " +
				'company name or domain and returns a board id such as "greenhouse:anthropic" for list_jobs / get_job, plus any other boards found. ' +
				"Also accepts a careers-page URL (e.g. https://jobs.ashbyhq.com/openai). confidence is high when the provider reports the same " +
				"company name, medium when it reports none (Lever, Ashby), low for empty or differently named boards; anyone can register a " +
				"board name, so check careers_url for medium/low matches. Companies using other applicant-tracking systems, or whose board " +
				"name differs from their brand, may not be found.",
			inputSchema: {
				company_or_domain: z
					.string()
					.trim()
					.min(1)
					.max(300)
					.describe('Company name ("Anthropic"), domain ("anthropic.com"), careers-page URL or board id.'),
			},
			annotations: { title: "Find job board", ...READ_ONLY },
		},
		async ({ company_or_domain }) =>
			run(env, async (up) => {
				const d = await detectBoards(up, company_or_domain);
				const [best, ...others] = d.matches;
				if (!best) return fail(notFoundMessage(company_or_domain, d));
				const notes = [...d.notes];
				if (best.openJobs === 0) {
					notes.push("This board exists but lists no open jobs; the company may have moved to another job board.");
				}
				if (best.confidence === "low" || best.confidence === "medium") {
					notes.push("Boards are matched by name, and anyone can register one: check careers_url belongs to the company.");
				}
				// Empty look-alike boards are noise once a board with openings is found.
				const alternatives = others.filter((m) => m.openJobs > 0 || best.openJobs === 0);
				return ok({
					query: company_or_domain,
					...matchItem(best),
					other_matches: nonEmpty(alternatives.map(matchItem)),
					tried: d.tried,
					notes: nonEmpty(notes),
				});
			}),
	);

	server.registerTool(
		"list_jobs",
		{
			title: "List jobs on a board",
			description:
				"List open jobs on one company's job board, newest first, with optional filters. Returns ids for get_job, " +
				"plus a count of matching jobs per department to help narrow the search.",
			inputSchema: {
				board: boardParam,
				keyword: keywordParam.optional(),
				location: locationParam.optional(),
				remote: remoteParam.optional(),
				department: z.string().trim().max(200).optional().describe('Matches department or team names, e.g. "engineering".'),
				limit: z.number().int().min(1).max(200).optional().describe("Maximum jobs to return (default 30)."),
				offset: z.number().int().min(0).optional().describe("Number of matching jobs to skip, for paging (default 0)."),
			},
			annotations: { title: "List jobs", ...READ_ONLY },
		},
		async ({ board, keyword, location, remote, department, limit = 30, offset = 0 }) =>
			run(env, async (up) => {
				const r = await resolveBoard(up, board);
				if (!r.ok) return fail(r.error);
				const filters: JobFilters = { keyword, location, remote, department };
				const matched = sortNewestFirst(filterJobs(r.board.jobs, filters));
				const page = matched.slice(offset, offset + limit);
				const filtered = Object.values(filters).some((v) => v !== undefined && v !== "");
				return ok({
					...boardHeader(r),
					resolved_from: r.resolvedFrom,
					other_boards: nonEmpty(r.alternatives),
					total_jobs: r.board.jobs.length,
					matched: matched.length,
					returned: page.length,
					offset: offset || undefined,
					next_offset: offset + page.length < matched.length ? offset + page.length : undefined,
					filters: filtered ? filters : undefined,
					departments: departmentCounts(matched.length ? matched : r.board.jobs),
					hint:
						matched.length === 0 && r.board.jobs.length > 0
							? "No jobs matched. Loosen the filters; 'departments' lists all departments on this board."
							: undefined,
					jobs: page.map(jobItem),
				});
			}),
	);

	server.registerTool(
		"get_job",
		{
			title: "Get job details",
			description:
				"Get one job's full details: the description as plain text, pay range where the company posts it, location, " +
				"workplace type and the apply URL.",
			inputSchema: {
				board: boardParam,
				job_id: z.string().trim().min(1).max(500).describe('The job "id" from list_jobs, search_jobs or whats_new (a job URL also works).'),
			},
			annotations: { title: "Get job", ...READ_ONLY },
		},
		async ({ board, job_id }) =>
			run(env, async (up) => {
				let ref = parseBoardId(board) ?? parseBoardUrl(board);
				if (!ref) {
					const d = await detectBoards(up, board);
					if (!d.matches[0]) return fail(notFoundMessage(board, d));
					ref = { provider: d.matches[0].provider, slug: d.matches[0].slug };
				}
				const jobId = normalizeJobId(ref.provider, job_id);
				const job = await getJob(up, ref.provider, ref.slug, jobId);
				if (!job) {
					return fail(
						`Job "${jobId}" was not found on ${ref.provider}:${ref.slug}. It may have closed, or the id belongs to another board; ` +
							"use list_jobs to see current openings.",
					);
				}
				const description = truncate(job.description, MAX_DESCRIPTION_CHARS, "\n\n[… description truncated; see url for the full posting]");
				return ok({
					board: job.board,
					id: job.id,
					title: job.title,
					company: job.company,
					location: job.location,
					department: job.department,
					team: job.team && job.team !== job.department ? job.team : undefined,
					employment_type: job.employmentType,
					workplace: job.workplace,
					posted: day(job.published),
					updated: day(job.updated),
					pay: nonEmpty(job.pay),
					pay_notes: job.payNotes,
					pay_mentions: job.pay.length ? undefined : nonEmpty(payMentions(job.description)),
					url: job.url,
					apply_url: job.applyUrl,
					description,
				});
			}),
	);

	server.registerTool(
		"search_jobs",
		{
			title: "Search jobs across companies",
			description:
				`Search open jobs at several companies at once (up to ${MAX_COMPANIES} per call). Each company's board is auto-detected ` +
				"from its name or domain (or pass board ids / careers URLs). Returns matches grouped by company, newest first.",
			inputSchema: {
				companies: companiesParam,
				keyword: keywordParam.min(1),
				location: locationParam.optional(),
				remote: remoteParam.optional(),
				limit_per_company: z.number().int().min(1).max(50).optional().describe("Maximum jobs returned per company (default 10)."),
			},
			annotations: { title: "Search jobs", ...READ_ONLY },
		},
		async ({ companies, keyword, location, remote, limit_per_company = 10 }) =>
			run(env, async (up) => {
				const { list, notes } = takeCompanies(companies);
				const filters: JobFilters = { keyword, location, remote };
				const results = await mapLimit(list, COMPANY_CONCURRENCY, async (company) => {
					try {
						const r = await resolveBoard(up, company);
						if (!r.ok) return { query: company, error: r.error };
						const matched = sortNewestFirst(filterJobs(r.board.jobs, filters));
						return {
							query: company,
							...boardHeader(r),
							total_jobs: r.board.jobs.length,
							matched: matched.length,
							jobs: matched.slice(0, limit_per_company).map(jobItem),
							more: matched.length > limit_per_company ? matched.length - limit_per_company : undefined,
						};
					} catch (err) {
						return { query: company, error: errorMessage(err) };
					}
				});
				return ok({
					filters,
					companies_searched: list.length,
					total_matched: results.reduce((n, r) => n + ("matched" in r ? r.matched : 0), 0),
					results,
					notes: nonEmpty(notes),
				});
			}),
	);

	server.registerTool(
		"whats_new",
		{
			title: "What's new since a date",
			description:
				`List jobs posted (or, where the provider reports it, updated) since a date, for up to ${MAX_COMPANIES} companies. ` +
				"Uses each provider's published / updated timestamps; newly posted jobs come first.",
			inputSchema: {
				companies: companiesParam,
				since: z
					.string()
					.trim()
					.min(1)
					.max(40)
					.describe('ISO 8601 date or date-time, e.g. "2026-10-01" or "2026-10-01T09:00:00Z" (UTC if no offset). "7d" or "48h" also work.'),
				keyword: keywordParam.optional(),
				limit_per_company: z.number().int().min(1).max(100).optional().describe("Maximum jobs returned per company (default 20)."),
			},
			annotations: { title: "What's new", ...READ_ONLY },
		},
		async ({ companies, since, keyword, limit_per_company = 20 }) =>
			run(env, async (up) => {
				const sinceMs = parseSince(since);
				if (sinceMs === undefined) return fail(`Could not parse since="${since}". Use an ISO date like "2026-10-01", or "7d".`);
				const { list, notes } = takeCompanies(companies);
				const results = await mapLimit(list, COMPANY_CONCURRENCY, async (company) => {
					try {
						const r = await resolveBoard(up, company);
						if (!r.ok) return { query: company, error: r.error };
						const changed = filterJobs(r.board.jobs, { keyword }).flatMap((j): Change[] => {
							const published = timeOf(j.published);
							const updated = timeOf(j.updated);
							if (published !== undefined && published >= sinceMs) return [{ j, change: "new", at: published }];
							if (updated !== undefined && updated >= sinceMs) return [{ j, change: "updated", at: updated }];
							return [];
						});
						changed.sort((a, b) => (a.change === b.change ? b.at - a.at : a.change === "new" ? -1 : 1));
						const fresh = changed.filter((c) => c.change === "new").length;
						return {
							query: company,
							...boardHeader(r),
							new: fresh,
							updated: changed.length - fresh,
							jobs: changed.slice(0, limit_per_company).map(({ j, change }) => ({
								change,
								...jobItem(j),
								updated: change === "updated" ? day(j.updated) : undefined,
							})),
							more: changed.length > limit_per_company ? changed.length - limit_per_company : undefined,
							note: TIMESTAMP_NOTES[r.board.provider],
						};
					} catch (err) {
						return { query: company, error: errorMessage(err) };
					}
				});
				return ok({ since: new Date(sinceMs).toISOString(), keyword, results, notes: nonEmpty(notes) });
			}),
	);
}
