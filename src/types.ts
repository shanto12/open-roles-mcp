import type { Upstream } from "./upstream";

/** Applicant-tracking systems with public, unauthenticated job-board APIs. */
export const PROVIDERS = ["greenhouse", "lever", "ashby", "workable"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Where the work happens, normalised across providers. */
export type Workplace = "remote" | "hybrid" | "onsite" | "unknown";

/** Compact, provider-neutral job record. Boards are cached as arrays of these. */
export interface JobSummary {
	id: string;
	title: string;
	/** Location as posted (may name several places). */
	location?: string;
	/** Extra searchable place names: offices, secondary locations, countries. */
	places?: string[];
	department?: string;
	team?: string;
	employmentType?: string;
	workplace: Workplace;
	/** ISO 8601 (date or date-time). */
	published?: string;
	updated?: string;
	url?: string;
	/** Short pay summary when the list endpoint exposes one. */
	pay?: string;
}

export interface Board {
	/** "provider:slug" */
	board: string;
	provider: Provider;
	slug: string;
	/** Company display name, when the provider exposes it. */
	company?: string;
	/** Public careers page. */
	url: string;
	/** When the data was fetched from the provider (ISO 8601). */
	fetchedAt: string;
	jobs: JobSummary[];
}

export interface JobDetail extends Omit<JobSummary, "places" | "pay"> {
	board: string;
	company?: string;
	applyUrl?: string;
	/** Pay ranges from structured provider fields, formatted for display. */
	pay: string[];
	/** Free-text notes attached to the structured pay fields. */
	payNotes?: string;
	/** Plain-text description (HTML stripped). */
	description: string;
}

export interface ProviderAdapter {
	id: Provider;
	careersUrl(slug: string): string;
	/** Resolves null when the board does not exist. */
	fetchBoard(up: Upstream, slug: string): Promise<Board | null>;
	/** Resolves null when the board or the job does not exist. */
	fetchJob(up: Upstream, slug: string, jobId: string): Promise<JobDetail | null>;
}
