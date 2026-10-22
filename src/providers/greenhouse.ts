import { formatPay, htmlToText, titleSaysRemote, toIso, truncate, uniq, workplaceFromText } from "../text";
import type { JobDetail, JobSummary, ProviderAdapter, Workplace } from "../types";

const API = "https://boards-api.greenhouse.io/v1/boards";
const careersUrl = (slug: string) => `https://job-boards.greenhouse.io/${encodeURIComponent(slug)}`;

interface GhJob {
	id: number;
	title?: string;
	absolute_url?: string;
	company_name?: string;
	location?: { name?: string | null } | null;
	first_published?: string | null;
	updated_at?: string | null;
	departments?: { name?: string | null }[] | null;
	offices?: { name?: string | null; location?: string | null }[] | null;
	metadata?: { name?: string | null; value?: unknown }[] | null;
	content?: string | null;
	pay_input_ranges?: {
		min_cents?: number | null;
		max_cents?: number | null;
		currency_type?: string | null;
		title?: string | null;
		blurb?: string | null;
	}[];
}

// Custom fields companies use to say where the work happens ("Location Type: On-Site").
const WORKPLACE_FIELD_RE = /location type|workplace|work ?type|work arrangement|work model|work setting|work location|remote|office/i;

function workplace(j: GhJob): Workplace {
	const placeText = [j.location?.name, ...(j.offices ?? []).map((o) => o.name)].join(" | ");
	if (workplaceFromText(placeText) === "remote" || titleSaysRemote(j.title)) return "remote";
	let fromMeta: Workplace | undefined;
	for (const m of j.metadata ?? []) {
		if (!m.name || !WORKPLACE_FIELD_RE.test(m.name) || m.value === null || m.value === undefined) continue;
		const value = Array.isArray(m.value) ? m.value.join(" ") : String(m.value);
		if (/remote/i.test(m.name) && /^(yes|true)$/i.test(value.trim())) return "remote";
		fromMeta ??= workplaceFromText(value);
	}
	if (fromMeta === "remote") return "remote";
	return fromMeta ?? workplaceFromText(placeText) ?? "unknown";
}

function departments(j: GhJob): string | undefined {
	const names = uniq((j.departments ?? []).map((d) => d.name)).filter((n) => !/^no department$/i.test(n));
	return names.length ? names.join(" / ") : undefined;
}

function summarize(j: GhJob): JobSummary {
	return {
		id: String(j.id),
		title: (j.title ?? "").trim(),
		location: j.location?.name?.trim() || undefined,
		places: uniq((j.offices ?? []).flatMap((o) => [o.location, o.name])),
		department: departments(j),
		workplace: workplace(j),
		published: toIso(j.first_published),
		updated: toIso(j.updated_at),
		url: j.absolute_url,
	};
}

export const greenhouse: ProviderAdapter = {
	id: "greenhouse",

	careersUrl,

	async fetchBoard(up, slug) {
		const data = await up.json<{ jobs?: GhJob[] }>(`${API}/${encodeURIComponent(slug)}/jobs?content=true`);
		if (!data) return null;
		const raw = Array.isArray(data.jobs) ? data.jobs : [];
		return {
			board: `greenhouse:${slug}`,
			provider: "greenhouse",
			slug,
			company: raw.find((j) => j.company_name)?.company_name?.trim(),
			url: careersUrl(slug),
			fetchedAt: new Date().toISOString(),
			// Descriptions are dropped here; get_job fetches the single job (with pay ranges).
			jobs: raw.map(summarize),
		};
	},

	async fetchJob(up, slug, jobId): Promise<JobDetail | null> {
		if (!/^\d{1,20}$/.test(jobId)) return null;
		const j = await up.json<GhJob>(`${API}/${encodeURIComponent(slug)}/jobs/${jobId}?pay_transparency=true`);
		if (!j || typeof j.id !== "number") return null;
		const ranges = j.pay_input_ranges ?? [];
		const pay = uniq(
			ranges.map((r) => {
				const range = formatPay(
					typeof r.min_cents === "number" ? r.min_cents / 100 : null,
					typeof r.max_cents === "number" ? r.max_cents / 100 : null,
					r.currency_type,
				);
				const label = r.title?.trim().replace(/:$/, "");
				return range && label ? `${label}: ${range}` : range;
			}),
		);
		const notes = uniq(ranges.map((r) => htmlToText(r.blurb))).join("\n");
		const { places: _places, ...summary } = summarize(j);
		return {
			...summary,
			board: `greenhouse:${slug}`,
			company: j.company_name?.trim() || undefined,
			applyUrl: j.absolute_url,
			pay,
			payNotes: notes ? truncate(notes, 500) : undefined,
			description: htmlToText(j.content),
		};
	},
};
