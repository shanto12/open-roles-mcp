import { formatPay, htmlToText, titleSaysRemote, toIso, uniq, workplaceFromText } from "../text";
import type { JobDetail, JobSummary, ProviderAdapter, Workplace } from "../types";

const WIDGET_API = "https://apply.workable.com/api/v1/widget/accounts";
const JOB_API = "https://apply.workable.com/api/v2/accounts";
const careersUrl = (slug: string) => `https://apply.workable.com/${encodeURIComponent(slug)}/`;
const jobUrl = (slug: string, shortcode: string) => `${careersUrl(slug)}j/${shortcode}/`;

interface WkLocation {
	city?: string | null;
	region?: string | null;
	country?: string | null;
	countryCode?: string | null;
	hidden?: boolean | null;
}

/** Job as listed by the v1 widget endpoint. */
interface WkListedJob {
	title?: string;
	shortcode?: string;
	employment_type?: string | null;
	telecommuting?: boolean | null;
	department?: string | null;
	url?: string;
	application_url?: string;
	published_on?: string | null;
	created_at?: string | null;
	city?: string | null;
	state?: string | null;
	country?: string | null;
	locations?: WkLocation[] | null;
}

/** Job as returned by the v2 job endpoint. */
interface WkJob {
	shortcode?: string;
	title?: string;
	remote?: boolean | null;
	workplace?: string | null;
	location?: WkLocation | null;
	locations?: WkLocation[] | null;
	published?: string | null;
	type?: string | null;
	department?: string[] | string | null;
	description?: string | null;
	requirements?: string | null;
	benefits?: string | null;
	salary_from?: number | null;
	salary_to?: number | null;
	salary_currency_iso_code?: string | null;
	salary_frequency?: string | null;
}

const EMPLOYMENT: Record<string, string> = {
	full: "Full-time",
	part: "Part-time",
	contract: "Contract",
	temporary: "Temporary",
	internship: "Internship",
	other: "Other",
};

function place(l: WkLocation): string {
	return uniq([l.city, l.region, l.country]).join(", ");
}

function visibleLocations(list: WkLocation[] | null | undefined, fallback?: WkLocation): WkLocation[] {
	const visible = (list ?? []).filter((l) => !l.hidden);
	return visible.length ? visible : fallback ? [fallback] : [];
}

function summarize(slug: string, j: WkListedJob): JobSummary {
	const locs = visibleLocations(j.locations, { city: j.city, region: j.state, country: j.country });
	const location = uniq(locs.map(place)).join("; ") || undefined;
	// The widget only says whether a job is remote ("telecommuting"); hybrid shows up in get_job.
	const workplace: Workplace = j.telecommuting
		? "remote"
		: workplaceFromText(location) === "remote" || titleSaysRemote(j.title)
			? "remote"
			: "unknown";
	return {
		id: j.shortcode ?? "",
		title: (j.title ?? "").trim(),
		location,
		places: uniq(locs.map((l) => l.countryCode)),
		department: j.department?.trim() || undefined,
		employmentType: j.employment_type?.trim() || undefined,
		workplace,
		published: toIso(j.published_on ?? j.created_at),
		url: j.shortcode ? jobUrl(slug, j.shortcode) : j.url,
	};
}

function workplace(j: WkJob, location?: string): Workplace {
	switch (j.workplace?.toLowerCase()) {
		case "remote":
			return "remote";
		case "hybrid":
			return "hybrid";
		case "on_site":
		case "onsite":
			return "onsite";
	}
	if (j.remote === true) return "remote";
	return workplaceFromText(location) ?? (titleSaysRemote(j.title) ? "remote" : "unknown");
}

export const workable: ProviderAdapter = {
	id: "workable",
	careersUrl,

	async fetchBoard(up, slug) {
		const data = await up.json<{ name?: string; jobs?: WkListedJob[] }>(`${WIDGET_API}/${encodeURIComponent(slug)}`);
		if (!data) return null;
		return {
			board: `workable:${slug}`,
			provider: "workable",
			slug,
			company: data.name?.trim() || undefined,
			url: careersUrl(slug),
			fetchedAt: new Date().toISOString(),
			jobs: (Array.isArray(data.jobs) ? data.jobs : []).filter((j) => j?.shortcode).map((j) => summarize(slug, j)),
		};
	},

	async fetchJob(up, slug, jobId): Promise<JobDetail | null> {
		if (!/^[A-Za-z0-9]{4,24}$/.test(jobId)) return null;
		const j = await up.json<WkJob>(`${JOB_API}/${encodeURIComponent(slug)}/jobs/${jobId}`);
		if (!j?.shortcode) return null;
		const location = uniq(visibleLocations(j.locations, j.location ?? undefined).map(place)).join("; ") || undefined;
		const department = uniq(Array.isArray(j.department) ? j.department : [j.department]).join(" / ") || undefined;
		const sections: [string, string | null | undefined][] = [
			["", j.description],
			["Requirements", j.requirements],
			["Benefits", j.benefits],
		];
		const pay = formatPay(
			j.salary_from,
			j.salary_to,
			j.salary_currency_iso_code,
			j.salary_frequency ? `per ${j.salary_frequency.toLowerCase()}` : undefined,
		);
		const url = jobUrl(slug, j.shortcode);
		return {
			id: j.shortcode,
			title: (j.title ?? "").trim(),
			board: `workable:${slug}`,
			location,
			department,
			employmentType: (j.type && EMPLOYMENT[j.type.toLowerCase()]) || j.type || undefined,
			workplace: workplace(j, location),
			published: toIso(j.published),
			url,
			applyUrl: `${url}apply/`,
			pay: pay ? [pay] : [],
			description: sections
				.map(([heading, html]) => {
					const text = htmlToText(html);
					return text && heading ? `${heading}\n${text}` : text;
				})
				.filter(Boolean)
				.join("\n\n"),
		};
	},
};
