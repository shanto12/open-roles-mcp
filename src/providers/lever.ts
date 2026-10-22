import { countryName, formatPay, htmlToText, titleSaysRemote, toIso, truncate, uniq, workplaceFromText } from "../text";
import type { JobDetail, JobSummary, ProviderAdapter, Workplace } from "../types";
import { UpstreamError } from "../upstream";

// Global instance only; EU-hosted accounts (api.eu.lever.co) are not covered.
const API = "https://api.lever.co/v0/postings";
const careersUrl = (slug: string) => `https://jobs.lever.co/${encodeURIComponent(slug)}`;

interface LeverPosting {
	id: string;
	text?: string;
	categories?: {
		commitment?: string | null;
		department?: string | null;
		location?: string | null;
		team?: string | null;
		allLocations?: (string | null)[] | null;
	} | null;
	country?: string | null;
	workplaceType?: string | null;
	createdAt?: number | null;
	hostedUrl?: string;
	applyUrl?: string;
	description?: string | null;
	lists?: { text?: string | null; content?: string | null }[] | null;
	additional?: string | null;
	salaryRange?: { min?: number | null; max?: number | null; currency?: string | null; interval?: string | null } | null;
	salaryDescriptionPlain?: string | null;
}

function workplace(p: LeverPosting, locations: string[]): Workplace {
	switch (p.workplaceType?.toLowerCase()) {
		case "remote":
			return "remote";
		case "hybrid":
			return "hybrid";
		case "onsite":
		case "on-site":
			return "onsite";
	}
	return workplaceFromText(...locations) ?? (titleSaysRemote(p.text) ? "remote" : "unknown");
}

/** "per-year-salary" -> "per year", "per-hour-wage" -> "per hour". */
function interval(raw: string | null | undefined): string | undefined {
	if (!raw) return undefined;
	return raw.replace(/-(salary|wage)$/i, "").replace(/-/g, " ").toLowerCase();
}

function pay(p: LeverPosting): string | undefined {
	const r = p.salaryRange;
	return r ? formatPay(r.min, r.max, r.currency, interval(r.interval)) : undefined;
}

function summarize(p: LeverPosting): JobSummary {
	const c = p.categories ?? {};
	const locations = uniq([...(c.allLocations ?? []), c.location]);
	return {
		id: p.id,
		title: (p.text ?? "").trim(),
		location: locations.join("; ") || undefined,
		places: uniq([p.country, countryName(p.country)]),
		department: c.department?.trim() || undefined,
		team: c.team?.trim() || undefined,
		employmentType: c.commitment?.trim() || undefined,
		workplace: workplace(p, locations),
		published: toIso(p.createdAt),
		url: p.hostedUrl,
		pay: pay(p),
	};
}

export const lever: ProviderAdapter = {
	id: "lever",
	careersUrl,

	async fetchBoard(up, slug) {
		const data = await up.json<LeverPosting[]>(`${API}/${encodeURIComponent(slug)}?mode=json`);
		if (!data) return null;
		if (!Array.isArray(data)) throw new UpstreamError("api.lever.co returned an unexpected response");
		return {
			board: `lever:${slug}`,
			provider: "lever",
			slug,
			url: careersUrl(slug),
			fetchedAt: new Date().toISOString(),
			jobs: data.filter((p) => p?.id).map(summarize),
		};
	},

	async fetchJob(up, slug, jobId): Promise<JobDetail | null> {
		if (!/^[0-9a-f-]{8,64}$/i.test(jobId)) return null;
		const p = await up.json<LeverPosting>(`${API}/${encodeURIComponent(slug)}/${jobId}?mode=json`);
		if (!p?.id) return null;
		const sections = [
			htmlToText(p.description),
			...(p.lists ?? []).map((l) => [l.text?.trim(), htmlToText(l.content)].filter(Boolean).join("\n")),
			htmlToText(p.additional),
		];
		const { places: _places, pay: payRange, ...summary } = summarize(p);
		const notes = p.salaryDescriptionPlain?.trim();
		return {
			...summary,
			board: `lever:${slug}`,
			applyUrl: p.applyUrl ?? (p.hostedUrl ? `${p.hostedUrl}/apply` : undefined),
			pay: payRange ? [payRange] : [],
			payNotes: notes ? truncate(notes, 500) : undefined,
			description: sections.filter(Boolean).join("\n\n"),
		};
	},
};
