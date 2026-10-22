// End-to-end test against a running server (default: `npx wrangler dev --port 8787`).
// Usage: node test/e2e.mjs [mcp-url]   — writes a transcript to test/e2e-output.txt
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.argv[2] ?? process.env.MCP_URL ?? "http://localhost:8787/mcp";
const OUTPUT = new URL("./e2e-output.txt", import.meta.url);
const EXPECTED_TOOLS = ["find_job_board", "list_jobs", "get_job", "search_jobs", "whats_new"];

const lines = [];
const log = (...parts) => {
	const line = parts.join(" ");
	lines.push(line);
	console.log(line);
};
let failures = 0;
let warnings = 0;
const check = (cond, label) => {
	log(`${cond ? "PASS" : "FAIL"}  ${label}`);
	if (!cond) failures++;
	return cond;
};
const warn = (cond, label) => {
	log(`${cond ? "PASS" : "WARN"}  ${label}`);
	if (!cond) warnings++;
	return cond;
};
const excerpt = (text, max = 1500) => (text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more chars]` : text);

const client = new Client({ name: "open-roles-e2e", version: "0.1.0" });

/** Calls a tool, logs the request/response, and returns { result, data, text, ms }. */
async function call(name, args) {
	log(`\n>>> ${name} ${JSON.stringify(args)}`);
	const started = Date.now();
	const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
	const ms = Date.now() - started;
	const text = result.content?.find((c) => c.type === "text")?.text ?? "";
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = undefined;
	}
	log(`<<< ${result.isError ? "ERROR " : ""}(${ms} ms)\n${excerpt(text)}`);
	return { result, data, text, ms };
}

async function main() {
	log(`Open Roles MCP e2e — ${new Date().toISOString()}`);
	log(`Server: ${MCP_URL}`);
	await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
	const server = client.getServerVersion();
	log(`Connected to ${server?.name} ${server?.version}`);

	// 1. Tools
	const { tools } = await client.listTools();
	log(`\nTools (${tools.length}):`);
	for (const t of tools) {
		const params = Object.entries(t.inputSchema?.properties ?? {}).map(([k]) => (t.inputSchema.required?.includes(k) ? k : `${k}?`));
		log(`  - ${t.name}(${params.join(", ")}) readOnly=${t.annotations?.readOnlyHint === true}`);
	}
	check(EXPECTED_TOOLS.every((n) => tools.some((t) => t.name === n)), `all ${EXPECTED_TOOLS.length} tools are listed`);
	check(tools.every((t) => t.annotations?.readOnlyHint === true), "every tool is annotated read-only");

	// 2. find_job_board("Anthropic")
	const found = await call("find_job_board", { company_or_domain: "Anthropic" });
	check(!found.result.isError && /^(greenhouse|lever|ashby|workable):/.test(found.data?.board ?? ""), `find_job_board returns a board id (${found.data?.board})`);
	check((found.data?.open_jobs ?? 0) > 0, `board has open jobs (${found.data?.open_jobs})`);
	const board = found.data?.board;
	if (!board) throw new Error("cannot continue without a board");

	// 3. list_jobs with keyword/department/remote filters
	const listed = await call("list_jobs", { board, keyword: "engineer", department: "engineering", remote: true });
	const jobs = listed.data?.jobs ?? [];
	check(!listed.result.isError && jobs.length > 0, `list_jobs returns matches (${listed.data?.matched} of ${listed.data?.total_jobs})`);
	check(jobs.every((j) => /engineer/i.test(j.title)), "every title matches keyword 'engineer'");
	check(jobs.every((j) => /engineer/i.test(`${j.department ?? ""} ${j.team ?? ""}`)), "every job is in an engineering department/team");
	check(jobs.every((j) => j.workplace === "remote"), "every job is remote");
	check(jobs.every((j) => j.id && j.url), "every job has an id and url");

	// 4. get_job on the first result
	const first = jobs[0];
	const detail = await call("get_job", { board, job_id: first.id });
	const job = detail.data ?? {};
	check(!detail.result.isError && job.id === first.id && job.title === first.title, `get_job returns the same job (${job.title})`);
	check(typeof job.description === "string" && job.description.length > 200 && !/<\/?[a-z][^>]*>/i.test(job.description), `description is plain text (${job.description?.length ?? 0} chars)`);
	check(/^https?:\/\//.test(job.apply_url ?? ""), `apply_url present (${job.apply_url})`);
	log(`      pay: ${JSON.stringify(job.pay ?? job.pay_mentions ?? "not posted")}`);

	// 5. search_jobs across companies (names and domains, auto-detected)
	const searched = await call("search_jobs", { companies: ["Anthropic", "linear.app"], keyword: "engineer", remote: true, limit_per_company: 3 });
	const results = searched.data?.results ?? [];
	check(!searched.result.isError && results.length === 2, "search_jobs returns one result per company");
	check(results.every((r) => r.board && !r.error), `search_jobs resolved every company (${results.map((r) => r.board ?? r.error).join(", ")})`);
	check((searched.data?.total_matched ?? 0) > 0, `search_jobs found matches (${searched.data?.total_matched})`);

	// 6. whats_new since two weeks ago
	const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
	const fresh = await call("whats_new", { companies: [board], since, limit_per_company: 5 });
	const r0 = fresh.data?.results?.[0];
	check(!fresh.result.isError && r0 && !r0.error && typeof r0.new === "number", `whats_new reports ${r0?.new} new / ${r0?.updated} updated since ${since}`);
	// Dates are shown as posted (in the posting's own UTC offset), so allow one day of slack.
	const sinceLoose = new Date(Date.parse(since) - 86_400_000).toISOString().slice(0, 10);
	check((r0?.jobs ?? []).every((j) => (j.change === "new" ? j.posted >= sinceLoose : (j.updated ?? "") >= sinceLoose)), "whats_new jobs are on/after the date");

	// 7. Error handling
	const missingJob = await call("get_job", { board, job_id: "1" });
	check(missingJob.result.isError === true, "unknown job id -> isError");
	const missingBoard = await call("list_jobs", { board: "greenhouse:zz-no-such-board-zz" });
	check(missingBoard.result.isError === true, "unknown board -> isError");

	// 8. Other providers (live boards change, so these only warn)
	for (const [b, label] of [
		["lever:palantir", "Lever"],
		["ashby:linear", "Ashby"],
		["workable:huggingface", "Workable"],
	]) {
		try {
			const l = await call("list_jobs", { board: b, limit: 2 });
			const id = l.data?.jobs?.[0]?.id;
			if (!warn(!l.result.isError && id, `${label}: list_jobs ${b} (${l.data?.total_jobs ?? 0} jobs)`)) continue;
			const d = await call("get_job", { board: b, job_id: id });
			warn(!d.result.isError && (d.data?.description?.length ?? 0) > 100, `${label}: get_job ${id}`);
		} catch (err) {
			warn(false, `${label}: ${err.message}`);
		}
	}
}

try {
	await main();
} catch (err) {
	failures++;
	log(`FAIL  aborted: ${err?.stack ?? err}`);
} finally {
	await client.close().catch(() => {});
	log(`\nResult: ${failures === 0 ? "PASSED" : `FAILED (${failures} failing checks)`}${warnings ? `, ${warnings} warnings` : ""}`);
	writeFileSync(OUTPUT, `${lines.join("\n")}\n`);
	process.exit(failures === 0 ? 0 : 1);
}
