import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { registerTools } from "./tools";

const VERSION = "0.1.0";

const INSTRUCTIONS = `Open Roles reads live job postings from the public job-board APIs of Greenhouse, Lever, Ashby and Workable.
Typical flow: find_job_board (company name or domain -> board id such as "greenhouse:anthropic"), then list_jobs (filter by keyword, location, remote, department), then get_job (full description, pay where posted, apply URL).
search_jobs and whats_new cover up to 10 companies per call and accept names, domains, careers URLs or board ids.
Data is fetched live and cached for about 10 minutes. Companies using other applicant-tracking systems are not covered.`;

/** One Durable Object per MCP session (streamable HTTP). Tools are stateless and read-only. */
export class OpenRolesMCP extends McpAgent<Env> {
	server = new McpServer({ name: "open-roles", title: "Open Roles", version: VERSION }, { instructions: INSTRUCTIONS });

	async init(): Promise<void> {
		registerTools(this.server, this.env);
	}
}

const mcp = OpenRolesMCP.serve("/mcp");

export default {
	fetch(request, env, ctx) {
		const { pathname } = new URL(request.url);
		if (pathname === "/mcp") return mcp.fetch(request, env, ctx);
		if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
			const info = {
				name: "Open Roles",
				version: VERSION,
				description: "Free remote MCP server for live job postings from public Greenhouse, Lever, Ashby and Workable job boards.",
				mcp_endpoint: new URL("/mcp", request.url).toString(),
				transport: "streamable-http",
				tools: ["find_job_board", "list_jobs", "get_job", "search_jobs", "whats_new"],
				privacy: "No accounts, no auth, no personal data collected or logged.",
			};
			return Response.json(info, { headers: { "cache-control": "public, max-age=3600" } });
		}
		return new Response("Not found. The MCP endpoint is /mcp.\n", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
