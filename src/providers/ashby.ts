import { formatPay, htmlToText, titleSaysRemote, toIso, uniq, workplaceFromText } from "../text";
import type { JobDetail, JobSummary, ProviderAdapter, Workplace } from "../types";
import type { Upstream } from "../upstream";

const API = "https://api.ashbyhq.com/posting-api/job-board";
const careersUrl = (slug: string) => `https://jobs.ashbyhq.com/${encodeURIComponent(slug)}`;

interface PostalAddress {
	addressLocality?: string | null;
	addressRegion?: string | null;
	addressCountry?: string | null;
}

interface CompComponent {
	compensationType?: string | null;
	interval?: string | null;
	currencyCode?: string | null;
	minValue?: number | null;
	maxValue?: number | null;
}

interface AshbyJob {
	id: string;
	title?: string;
	department?: string | null;
	team?: string | null;
	employmentType?: string | null;
	location?: string | null;
	secondaryLocations?: { location?: string | null; address?: { postalAddress?: PostalAddress | null } | null }[] | null;
	address?: { postalAddress?: PostalAddress | null } | null;
	publishedAt?: string | null;
	isListed?: boolean | null;
	isRemote?: boolean | null;
	workplaceType?: string | null;
	jobUrl?: string;
	applyUrl?: string;
	descriptionHtml?: string | null;
	descriptionPlain?: string | null;
	compensation?: {
		compensationTierSummary?: string | null;
		scrapeableCompensationSalarySummary?: string | null;
		compensationTiers?: { title?: string | null; tierSummary?: string | null; additionalInformation?: string | null; components?: CompComponent[] | null }[] | null;
		summaryComponents?: CompComponent[] | null;
	} | null;
}

const EMPLOYMENT: Record<string, string> = {
	FullTime: "Full-time",
	PartTime: "Part-time",
	Intern: "Intern",
	Contract: "Contract",
	Temporary: "Temporary",
};

function workplace(j: AshbyJob, locations: string[]): Workplace {
	switch (j.workplaceType?.toLowerCase()) {
		case "remote":
			return "remote";
		case "hybrid":
			return "hybrid";
		case "onsite":
		case "on-site":
			return "onsite";
	}
	// Older postings only carry isRemote (newer ones set it for hybrid roles too, hence second).
	if (j.isRemote === true) return "remote";
	return workplaceFromText(...locations) ?? (titleSaysRemote(j.title) ? "remote" : "unknown");
}

function addressParts(a: PostalAddress | null | undefined): (string | null | undefined)[] {
	return a ? [a.addressLocality, a.addressRegion, a.addressCountry] : [];
}

/** "1 YEAR" -> "per year". */
function interval(raw: string | null | undefined): string | undefined {
	const m = raw ? /^1\s+([a-z]+)$/i.exec(raw.trim()) : null;
	return m ? `per ${m[1].toLowerCase()}` : undefined;
}

function payLines(j: AshbyJob): string[] {
	const c = j.compensation;
	if (!c) return [];
	const tiers = (c.compensationTiers ?? []).map((t) => {
		const summary = t.tierSummary?.trim();
		return summary && t.title?.trim() ? `${t.title.trim()}: ${summary}` : summary;
	});
	const lines = uniq(tiers);
	if (lines.length) return lines;
	if (c.compensationTierSummary) return [c.compensationTierSummary];
	const salary = (c.summaryComponents ?? []).find((s) => s.compensationType === "Salary");
	const formatted = salary && formatPay(salary.minValue, salary.maxValue, salary.currencyCode, interval(salary.interval));
	if (formatted) return [formatted];
	return c.scrapeableCompensationSalarySummary ? [c.scrapeableCompensationSalarySummary] : [];
}

function summarize(j: AshbyJob): JobSummary {
	const secondary = j.secondaryLocations ?? [];
	const locations = uniq([j.location, ...secondary.map((s) => s.location)]);
	return {
		id: j.id,
		title: (j.title ?? "").trim(),
		location: locations.join("; ") || undefined,
		places: uniq([...addressParts(j.address?.postalAddress), ...secondary.flatMap((s) => addressParts(s.address?.postalAddress))]),
		department: j.department?.trim() || undefined,
		team: j.team?.trim() || undefined,
		employmentType: (j.employmentType && EMPLOYMENT[j.employmentType]) || j.employmentType || undefined,
		workplace: workplace(j, locations),
		published: toIso(j.publishedAt),
		url: j.jobUrl,
		pay: payLines(j)[0],
	};
}

async function fetchJobs(up: Upstream, slug: string): Promise<AshbyJob[] | null> {
	const data = await up.json<{ jobs?: AshbyJob[] }>(`${API}/${encodeURIComponent(slug)}?includeCompensation=true`);
	if (!data) return null;
	return (Array.isArray(data.jobs) ? data.jobs : []).filter((j) => j?.id && j.isListed !== false);
}

export const ashby: ProviderAdapter = {
	id: "ashby",
	careersUrl,

	async fetchBoard(up, slug) {
		const jobs = await fetchJobs(up, slug);
		if (!jobs) return null;
		return {
			board: `ashby:${slug}`,
			provider: "ashby",
			slug,
			url: careersUrl(slug),
			fetchedAt: new Date().toISOString(),
			jobs: jobs.map(summarize),
		};
	},

	// The public posting API has no single-job endpoint: read the board and pick the job.
	async fetchJob(up, slug, jobId): Promise<JobDetail | null> {
		const jobs = await fetchJobs(up, slug);
		const j = jobs?.find((x) => x.id.toLowerCase() === jobId.toLowerCase());
		if (!j) return null;
		const { places: _places, pay: _pay, ...summary } = summarize(j);
		const notes = uniq((j.compensation?.compensationTiers ?? []).map((t) => t.additionalInformation?.trim())).join("\n");
		return {
			...summary,
			board: `ashby:${slug}`,
			applyUrl: j.applyUrl,
			pay: payLines(j),
			payNotes: notes || undefined,
			description: htmlToText(j.descriptionHtml) || (j.descriptionPlain ?? "").trim(),
		};
	},
};
