<p align="center"><img src="https://open-roles-mcp.shantomathew.workers.dev/logo.png" alt="Open Roles" width="128" height="128"></p>

# Open Roles

A free, remote [MCP](https://modelcontextprotocol.io) server for **live job postings**. It reads the public
job-board APIs of **Greenhouse, Lever, Ashby and Workable**, the applicant-tracking systems behind thousands
of company careers pages, so an AI assistant can find a company's board, browse and filter its openings, and
read full job descriptions with pay ranges and apply links.

- No accounts, no API keys, no auth.
- Read-only. Every tool is annotated `readOnlyHint`.
- No personal data collected or logged (see [Privacy](#privacy)).
- Runs on Cloudflare Workers: TypeScript, Cloudflare's [`agents`](https://www.npmjs.com/package/agents) `McpAgent`
  and [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk), streamable HTTP at `/mcp`.

## Connect

Server URL (replace `<subdomain>` with your workers.dev subdomain once deployed):

```
https://open-roles-mcp.<subdomain>.workers.dev/mcp
```

- **Claude (web / desktop):** Settings → Connectors → *Add custom connector* → paste the URL.
- **Claude Code:** `claude mcp add --transport http open-roles https://open-roles-mcp.<subdomain>.workers.dev/mcp`
- **Other clients** that support remote MCP servers over streamable HTTP:
  `{ "mcpServers": { "open-roles": { "url": "https://open-roles-mcp.<subdomain>.workers.dev/mcp" } } }`.
  Clients that only speak stdio can use a bridge such as `npx mcp-remote <url>`.
- **MCP Inspector:** `npx @modelcontextprotocol/inspector`, transport *Streamable HTTP*, URL as above.

Try asking: *"What remote engineering roles is Anthropic hiring for?"*, *"Compare open ML roles at OpenAI,
Anthropic and Hugging Face in Europe"*, *"What did Stripe and Linear post this week?"*

## Tools

Boards are identified as **`provider:slug`**, e.g. `greenhouse:anthropic`, `ashby:openai`, `lever:palantir`,
`workable:huggingface`. Anywhere a board is expected you can also pass a careers-page URL
(`https://jobs.ashbyhq.com/openai`), a domain or a company name. It is then auto-detected.

| Tool | Parameters | What it does |
| --- | --- | --- |
| `find_job_board` | `company_or_domain` | Probes all four providers with slug candidates derived from the name or domain (`"Scale AI"` → `scaleai`, `scale`, `scale-ai`; `x.ai` → `xai`). Returns the best board (provider, slug, company name where the provider exposes one, open-job count, careers URL, `confidence`) plus other boards found. |
| `list_jobs` | `board`, `keyword?`, `location?`, `remote?`, `department?`, `limit?` (30, max 200), `offset?` | Open jobs, newest first, with a per-department count of the matches. |
| `get_job` | `board`, `job_id` | Full description as plain text (HTML stripped), pay where posted, location, workplace type, employment type, apply URL. `job_id` may also be a job URL. |
| `search_jobs` | `companies[]`, `keyword`, `location?`, `remote?`, `limit_per_company?` (10) | The same search across up to 10 companies (auto-detected), grouped by company. |
| `whats_new` | `companies[]`, `since`, `keyword?`, `limit_per_company?` (20) | Jobs published (or, on Greenhouse, updated) since an ISO date or date-time (`"2026-10-01"`, `"2026-10-01T09:00:00Z"`; `"7d"` / `"48h"` also work). New postings first. |

**Filter semantics** (all case-insensitive and accent-insensitive):

- `keyword` matches the **job title**. Every word must match the start of a title word (`engineer` matches
  "Engineering", while `ai` does not match "Air"). Use `|` or ` OR ` for alternatives: `frontend | front-end`.
- `department` matches department or team names (`engineering` → "AI Research & Engineering").
- `location` matches posted locations, offices and countries. It understands common aliases: `US`/`USA`,
  `UK`, `NYC`, `SF`/`Bay Area`, `LA`, `DC`, `Europe`/`EMEA`, `APAC`, `LATAM`, US state codes (`Austin, TX`
  also matches "Austin, Texas") and `remote`.
- `remote: true` keeps roles marked remote or remote-friendly. `remote: false` excludes them. Hybrid counts as
  not remote. The provider's workplace field wins when it exists (Lever, Ashby, Workable). Otherwise location
  text ("Remote-Friendly, United States") and Greenhouse custom fields ("Location Type: Remote") are used.

Results are compact JSON with stable `id`s to pass to `get_job`.

### Pay data

| Provider | Source |
| --- | --- |
| Greenhouse | `pay_input_ranges` from the single-job endpoint (`?pay_transparency=true`), only when the company enables pay transparency. |
| Lever | `salaryRange` (min/max/currency/interval) and `salaryDescription`. |
| Ashby | `compensation` tiers (`includeCompensation=true`), e.g. "$257K – $335K • Offers Equity". |
| Workable | `salary_from` / `salary_to` / currency / frequency on the job endpoint. |

If there are no structured pay fields, `get_job` returns `pay_mentions`: lines from the description that state
an amount. These are heuristic, so treat them as hints.

## How it works

| Provider | List | Single job |
| --- | --- | --- |
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{b}/jobs?content=true` | `…/jobs/{id}?pay_transparency=true` |
| Lever | `api.lever.co/v0/postings/{b}?mode=json` | `…/postings/{b}/{id}?mode=json` |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{b}?includeCompensation=true` | picked from the list (no single-job endpoint) |
| Workable | `apply.workable.com/api/v1/widget/accounts/{b}` | `apply.workable.com/api/v2/accounts/{b}/jobs/{shortcode}` |

- **Cache:** upstream responses are normalised to compact job summaries (descriptions dropped) and cached in
  Workers KV (binding `CACHE`) for `CACHE_TTL_SECONDS` (default 600 s). Job details are cached the same way.
  Company → board detections are cached for 6 h (1 h when nothing was found). Caching is best-effort: KV
  errors or quota limits never fail a tool call.
- **Request budget:** each tool call makes at most `MAX_UPSTREAM_REQUESTS` (default 40) upstream requests,
  below the Workers Free limit of 50 subrequests per invocation. Probes for one slug run in parallel,
  identical requests within a call are shared, and detection stops at the first good match. If the budget runs
  out, the affected companies are reported as not finished rather than not found. Each upstream request
  times out after 25 s, and a whole tool call stops starting new requests after 45 s, so multi-company
  searches stay within typical client timeouts.
- **Sessions:** `McpAgent` keeps one Durable Object per MCP session. The tools themselves are stateless.

## Run locally

```sh
npm install
npm run dev            # wrangler dev on http://localhost:8787 (local KV and Durable Objects, no login needed)
npm run test:e2e       # in another terminal: end-to-end test, writes test/e2e-output.txt
npm run typecheck
```

`test/e2e.mjs` uses the MCP SDK `Client` with `StreamableHTTPClientTransport`. It lists the tools, runs
`find_job_board("Anthropic")`, runs `list_jobs` (keyword "engineer", department "engineering", remote), and
calls `get_job` on the first result. It then runs `search_jobs`, `whats_new` and the error paths, and does a
smoke test of Lever, Ashby and Workable boards. Pass another URL as the first argument to test a deployment.

## Deploy

```sh
npx wrangler login
npx wrangler kv namespace create CACHE   # copy the returned id ...
# ... into wrangler.jsonc → kv_namespaces[0].id (replacing REPLACE_WITH_KV_NAMESPACE_ID)
npm run deploy                            # → https://open-roles-mcp.<subdomain>.workers.dev
```

The Workers Free plan is enough. Optional settings live in `wrangler.jsonc` → `vars`: `CACHE_TTL_SECONDS` and
`MAX_UPSTREAM_REQUESTS` (raise it on a paid plan, where the subrequest limit is much higher). After changing
bindings or vars, run `npm run cf-typegen`.

## Privacy

- No authentication, accounts or cookies. The server never asks who you are.
- No request logging: Workers observability is disabled in `wrangler.jsonc`, and the code logs nothing.
- KV holds only public job-board data and company-name → board lookups, all with short expirations.
- The per-session Durable Object holds MCP protocol state (e.g. the client's name/version from `initialize`)
  for the session's lifetime. It holds no user data.
- Upstream requests go to the four job-board APIs with a generic `User-Agent`. Nothing from the client is
  forwarded apart from the company or board being looked up.

## Caveats

- **Board detection is a heuristic.** Boards are found by guessing slugs, so expect misses and the
  occasional wrong match. Check `confidence` and `careers_url`.
  - **Greenhouse:** the most reliable. The API returns the company name, which is checked against your query,
    and slugs usually match the brand. Some companies use a different token (e.g. `scaleai`).
  - **Ashby** and **Lever:** the APIs expose no company name, so a match is only "medium" confidence and slug
    collisions can't be detected. Stale empty boards are common after a company switches ATS (e.g.
    `lever:mistral` has 0 jobs).
  - **Workable:** the least reliable. Many famous names (`openai`, `stripe`, `figma`, `linear`, …) are
    registered by unrelated or squatting accounts, mostly with no jobs, and the account name is whatever the
    owner typed. Empty boards are ranked last and hidden when a better board exists. If a company isn't on
    any of the four systems, though, a look-alike Workable board with postings could be returned.
  - Companies on other ATSs (Workday, SmartRecruiters, iCIMS, Personio, in-house, …) aren't covered. Neither
    are EU-hosted Lever (`jobs.eu.lever.co`) or Greenhouse EU boards.
- **Timestamps differ by provider.** Greenhouse has first-published and updated times. Lever has only creation
  time. Ashby has only publish time. Workable has only a publish date. `whats_new` can therefore report
  "updated" jobs only for Greenhouse, and reposted jobs may appear new.
- **Remote/hybrid labels are inferred.** Classification depends on what each company fills in. The Workable
  list endpoint only says remote or not; `get_job` shows hybrid/on-site.
- **Payloads can be large.** Big boards return several MB because list endpoints include descriptions (OpenAI
  on Ashby is ~14 MB, Anthropic on Greenhouse ~10 MB). The first request for such a board takes a second or
  two and uses noticeable memory and CPU; later requests hit the cache. On the Free plan, KV allows 1,000
  writes per day. Beyond that, results are simply not cached.
- **Live data:** postings change constantly and may close between `list_jobs` and applying. Always apply via
  the official `apply_url`. This project is not affiliated with Greenhouse, Lever, Ashby or Workable.
  Respect their terms and rate limits.
- `McpAgent` is marked deprecated (feature-frozen) in `agents` 0.30 in favour of `createMcpHandler`. It still
  works and is used here as specified, but a future major version may require migrating.

## License

[MIT](LICENSE) © 2026 Shanto Mathew
