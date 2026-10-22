import type { Provider, ProviderAdapter } from "../types";
import { ashby } from "./ashby";
import { greenhouse } from "./greenhouse";
import { lever } from "./lever";
import { workable } from "./workable";

export const ADAPTERS: Record<Provider, ProviderAdapter> = { greenhouse, lever, ashby, workable };

export interface BoardRef {
	provider: Provider;
	slug: string;
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function ref(provider: Provider, slug: string | null | undefined): BoardRef | null {
	if (!slug) return null;
	let s = slug.trim();
	try {
		s = decodeURIComponent(s);
	} catch {
		return null;
	}
	return SLUG_RE.test(s) ? { provider, slug: s } : null;
}

/** "greenhouse:anthropic" (also "greenhouse/anthropic"). */
export function parseBoardId(input: string): BoardRef | null {
	const m = /^\s*(greenhouse|lever|ashby|workable)\s*[:/]\s*([^\s/?#]+)\s*$/i.exec(input);
	return m ? ref(m[1].toLowerCase() as Provider, m[2]) : null;
}

/** True for "foo:bar" inputs whose provider we do not support (so we can say so). */
export function looksLikeBoardId(input: string): boolean {
	return /^\s*[a-z][a-z-]*\s*:\s*[^\s/]+\s*$/i.test(input) && !/^\s*https?:/i.test(input);
}

/** Recognises careers-page and API URLs of the supported providers. */
export function parseBoardUrl(input: string): BoardRef | null {
	const raw = input.trim();
	if (!raw || /\s/.test(raw)) return null;
	let url: URL;
	try {
		url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
	} catch {
		return null;
	}
	const host = url.hostname.toLowerCase();
	const seg = url.pathname.split("/").filter(Boolean);

	if (host === "greenhouse.io" || host.endsWith(".greenhouse.io")) {
		const embedded = url.searchParams.get("for"); // boards.greenhouse.io/embed/job_board?for=acme
		if (embedded) return ref("greenhouse", embedded);
		if (seg[0] === "v1" && seg[1] === "boards") return ref("greenhouse", seg[2]);
		return seg[0] && seg[0] !== "embed" ? ref("greenhouse", seg[0]) : null;
	}
	if (host === "jobs.lever.co") return ref("lever", seg[0]);
	if (host === "api.lever.co") return seg[0] === "v0" && seg[1] === "postings" ? ref("lever", seg[2]) : null;
	if (host === "jobs.ashbyhq.com") return ref("ashby", seg[0]);
	if (host === "api.ashbyhq.com") return seg[0] === "posting-api" && seg[1] === "job-board" ? ref("ashby", seg[2]) : null;
	if (host === "apply.workable.com") {
		if (seg[0] === "api") {
			const i = seg.indexOf("accounts");
			return i >= 0 ? ref("workable", seg[i + 1]) : null;
		}
		return seg[0] && seg[0] !== "j" ? ref("workable", seg[0]) : null;
	}
	const workableSub = /^([a-z0-9-]+)\.workable\.com$/.exec(host);
	if (workableSub && !["www", "apply", "jobs", "help", "resources"].includes(workableSub[1])) return ref("workable", workableSub[1]);
	return null;
}

/** Extracts a job id from a job URL, or returns the input unchanged. */
export function normalizeJobId(provider: Provider, input: string): string {
	const s = input.trim();
	if (!/[/?]/.test(s)) return s;
	const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(s);
	switch (provider) {
		case "greenhouse":
			return /[?&]gh_jid=(\d+)/.exec(s)?.[1] ?? /\/jobs\/(\d+)/.exec(s)?.[1] ?? s;
		case "lever":
		case "ashby":
			return uuid?.[0] ?? s;
		case "workable":
			return /\/j\/([A-Za-z0-9]+)/.exec(s)?.[1] ?? s;
	}
}
