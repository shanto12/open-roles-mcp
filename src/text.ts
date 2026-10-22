import type { Workplace } from "./types";

// ---------------------------------------------------------------------------
// HTML -> plain text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
	ndash: "–", mdash: "—", minus: "−", hellip: "…", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“",
	rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", bull: "•", middot: "·", copy: "©", reg: "®",
	trade: "™", deg: "°", euro: "€", pound: "£", yen: "¥", cent: "¢", times: "×", divide: "÷",
	plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾", sect: "§", para: "¶", dagger: "†",
	iexcl: "¡", iquest: "¿", larr: "←", rarr: "→", uarr: "↑", darr: "↓", check: "✓", star: "☆",
	szlig: "ß", aelig: "æ", AElig: "Æ", oslash: "ø", Oslash: "Ø", eth: "ð", thorn: "þ", oelig: "œ",
	shy: "", zwj: "", zwnj: "", lrm: "", rlm: "",
};

const COMBINING: Record<string, string> = {
	acute: "́", grave: "̀", circ: "̂", uml: "̈", tilde: "̃", ring: "̊", cedil: "̧",
};

function decodeNamed(name: string): string | undefined {
	const direct = NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()];
	if (direct !== undefined) return direct;
	const m = /^([a-zA-Z])(acute|grave|circ|uml|tilde|ring|cedil)$/.exec(name);
	return m ? (m[1] + COMBINING[m[2]]).normalize("NFC") : undefined;
}

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, ent: string) => {
		if (ent[0] === "#") {
			const cp = ent[1] === "x" || ent[1] === "X" ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
			if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return match;
			return cp === 0xa0 ? " " : String.fromCodePoint(cp);
		}
		return decodeNamed(ent) ?? match;
	});
}

const BLOCK_TAGS = "p|div|section|article|header|footer|main|aside|ul|ol|table|blockquote|pre|h[1-6]|hr|figure";

/** Converts job-description HTML to readable plain text (paragraphs and "- " bullets kept). */
export function htmlToText(input: string | null | undefined): string {
	if (!input) return "";
	let s = input;
	// Greenhouse returns entity-encoded HTML ("&lt;p&gt;..."): decode it once first.
	if (!/<[a-z!/]/i.test(s) && /&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s);
	s = s
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|head|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/\s+/g, " ") // source whitespace is insignificant in HTML
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<\/(li|tr|dt|dd)\s*>/gi, "\n")
		.replace(/<\/t[dh]\s*>/gi, " ")
		.replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n\n")
		.replace(/<[^>]*>/g, "");
	return decodeEntities(s)
		.replace(/[   ]/g, " ")
		.replace(/[​-‍⁠﻿]/g, "")
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/(^|\n)- *\n+(?=\S)/g, "$1- ") // "<li><p>text" -> "- text"
		.replace(/(^|\n)-\s*(?=\n|$)/g, "$1") // empty bullets
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Trims text to `max` characters on a word boundary. */
export function truncate(s: string, max: number, suffix = "…"): string {
	if (s.length <= max) return s;
	const cut = s.slice(0, max - suffix.length);
	const space = cut.lastIndexOf(" ");
	return `${space > max * 0.8 ? cut.slice(0, space) : cut}${suffix}`;
}

// ---------------------------------------------------------------------------
// Normalisation for matching
// ---------------------------------------------------------------------------

/** Lower-cases, strips diacritics and punctuation: "Zürich, CH (Hybrid)" -> "zurich ch hybrid". */
export function fold(s: string | null | undefined): string {
	if (!s) return "";
	return s
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/['’]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

export function uniq<T>(items: Iterable<T | null | undefined>): T[] {
	const out: T[] = [];
	for (const item of items) {
		if (item === null || item === undefined || (typeof item === "string" && !item.trim())) continue;
		const v = (typeof item === "string" ? item.trim() : item) as T;
		if (!out.includes(v)) out.push(v);
	}
	return out;
}

let regionNames: Intl.DisplayNames | null | undefined;

/** ISO 3166 alpha-2 code -> English country name ("DE" -> "Germany"), if known. */
export function countryName(code: string | null | undefined): string | undefined {
	if (!code || !/^[A-Za-z]{2}$/.test(code)) return undefined;
	if (regionNames === undefined) {
		try {
			regionNames = new Intl.DisplayNames(["en"], { type: "region" });
		} catch {
			regionNames = null;
		}
	}
	try {
		const name = regionNames?.of(code.toUpperCase());
		return name && name.toUpperCase() !== code.toUpperCase() ? name : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Workplace classification
// ---------------------------------------------------------------------------

const REMOTE_RE = /\bremote\b|\banywhere\b|work(?:ing)? from home|\bwfh\b|\bdistributed\b|telecommut|home[- ]based/i;
const HYBRID_RE = /\bhybrid\b/i;
const ONSITE_RE = /\bon[- ]?site\b|\bin[- ]office\b|\bin[- ]person\b|\boffice[- ]based\b/i;
// Titles say "Remote" for remote roles, but also "Remote Sensing Engineer".
const TITLE_REMOTE_RE = /\bremote\b(?!\s+(?:sensing|control|operat|pilot|monitor|support|access|vehicle|surgery|patient|inspection))/i;

/** Classifies free text such as a location ("Remote-Friendly, US") or a metadata value ("On-Site"). */
export function workplaceFromText(...texts: (string | null | undefined)[]): Workplace | undefined {
	const s = texts.filter(Boolean).join(" | ");
	if (!s) return undefined;
	if (REMOTE_RE.test(s)) return "remote";
	if (HYBRID_RE.test(s)) return "hybrid";
	if (ONSITE_RE.test(s)) return "onsite";
	return undefined;
}

export function titleSaysRemote(title: string | undefined): boolean {
	return !!title && TITLE_REMOTE_RE.test(title);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Accepts ISO dates/date-times and relative shorthands like "7d", "48h", "2w". */
export function parseSince(input: string, now = Date.now()): number | undefined {
	const s = input.trim();
	const rel = /^(\d{1,4})\s*([hdw])$/i.exec(s);
	if (rel) {
		const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2].toLowerCase() as "h" | "d" | "w"];
		return now - Number(rel[1]) * unit;
	}
	if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return undefined;
	const t = Date.parse(s);
	return Number.isNaN(t) ? undefined : t;
}

export function toIso(value: string | number | null | undefined): string | undefined {
	if (value === null || value === undefined || value === "") return undefined;
	if (typeof value === "number") return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined;
	return Number.isNaN(Date.parse(value)) ? undefined : value;
}

export function timeOf(iso: string | undefined): number | undefined {
	if (!iso) return undefined;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? undefined : t;
}

/** "2026-10-19T11:17:24-04:00" -> "2026-10-19" (the date as posted). */
export function day(iso: string | undefined): string | undefined {
	return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined;
}

// ---------------------------------------------------------------------------
// Pay
// ---------------------------------------------------------------------------

function money(amount: number, currency: string): string {
	if (/^[A-Z]{3}$/.test(currency)) {
		try {
			return new Intl.NumberFormat("en-US", {
				style: "currency",
				currency,
				maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
			}).format(amount);
		} catch {
			// Unknown currency code: fall through to plain formatting.
		}
	}
	return amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const isAmount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Formats a pay range: "$190,000 – $230,000 USD per year". */
export function formatPay(
	min: number | null | undefined,
	max: number | null | undefined,
	currency?: string | null,
	interval?: string | null,
): string | undefined {
	const cur = (currency ?? "").trim().toUpperCase();
	let s: string;
	if (isAmount(min) && isAmount(max) && min !== max) s = `${money(min, cur)} – ${money(max, cur)}`;
	else if (isAmount(min)) s = `${isAmount(max) ? "" : "from "}${money(min, cur)}`;
	else if (isAmount(max)) s = `up to ${money(max, cur)}`;
	else return undefined;
	if (cur) s += ` ${cur}`;
	return interval ? `${s} ${interval}` : s;
}

const MONEY_RE =
	/(?:[$€£¥₹]|\b(?:USD|EUR|GBP|CAD|AUD|CHF|SEK|NOK|DKK|INR|JPY|SGD|NZD|PLN|BRL|MXN)\b)\s?\d|\d[\d,.]*\s?[kK]?\s?(?:USD|EUR|GBP|CAD|AUD|CHF|SEK|NOK|DKK|INR|JPY|SGD|NZD|PLN|BRL|MXN)\b/;
const PAY_WORD_RE = /salary|compensation|\bpay\b|wage|\bbase\b|\bote\b|\brange\b|per (?:hour|year|annum|month)|hourly|annual|stipend|\/\s?(?:hr|hour|year|yr)\b/i;
const RANGE_RE = /\d\s?[kK]?\s*(?:-|–|—|to)\s*[$€£]?\s?\d/;

/** Fallback when no structured pay exists: lines of the description that state an amount. */
export function payMentions(text: string, limit = 3): string[] {
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/^- /, "").trim();
		if (line.length < 4 || !MONEY_RE.test(line)) continue;
		if (!PAY_WORD_RE.test(line) && !RANGE_RE.test(line)) continue;
		const t = truncate(line, 240);
		if (!out.includes(t)) out.push(t);
		if (out.length >= limit) break;
	}
	return out;
}
