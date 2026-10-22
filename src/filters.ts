import { countryName, fold, timeOf } from "./text";
import type { JobSummary } from "./types";

export interface JobFilters {
	keyword?: string;
	location?: string;
	remote?: boolean;
	department?: string;
}

type Matcher = (foldedHaystack: string) => boolean;

/**
 * A term matches the start of a word ("engineer" matches "Engineering"); terms of one or two
 * characters must match a whole word so "us" doesn't match "Austin" and "ai" doesn't match "Air".
 */
function hasTerm(paddedHaystack: string, term: string): boolean {
	return term.length <= 2 ? paddedHaystack.includes(` ${term} `) : paddedHaystack.includes(` ${term}`);
}

/** "a | b" and "a OR b" are alternatives; within an alternative every word must match. */
function alternatives(query: string | undefined): string[] {
	return (query ?? "")
		.split(/\s+OR\s+|\|/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export function compileQuery(query: string | undefined): Matcher | undefined {
	const alts = alternatives(query)
		.map((a) => fold(a).split(" ").filter(Boolean))
		.filter((terms) => terms.length > 0);
	if (!alts.length) return undefined;
	return (hay) => {
		const h = ` ${hay} `;
		return alts.some((terms) => terms.every((t) => hasTerm(h, t)));
	};
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

const US_STATES: Record<string, string> = {
	AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
	CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
	HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
	LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
	MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
	NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
	OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
	SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
	VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

const CANADA_RE = /canada|ontario|quebec|british columbia|alberta|toronto|vancouver|montr[eé]al|ottawa|calgary/i;

// "City, XX" codes that are just as often a country (India, Germany, Israel, ...): not expanded.
const AMBIGUOUS_STATE_CODES = new Set(["AL", "AR", "CO", "DE", "GA", "ID", "IL", "IN", "LA", "MA", "MD", "ME", "MN", "MT", "NE", "PA", "SC", "SD", "TN", "VA"]);

const EUROPE =
	"europe|emea|eu|united kingdom|uk|england|scotland|ireland|germany|france|spain|portugal|italy|netherlands|belgium|luxembourg|switzerland|austria|poland|czech|czechia|slovakia|hungary|romania|bulgaria|greece|croatia|serbia|slovenia|sweden|norway|denmark|finland|iceland|estonia|latvia|lithuania|ukraine|cyprus|malta|london|dublin|paris|berlin|munich|hamburg|amsterdam|madrid|barcelona|lisbon|stockholm|copenhagen|oslo|helsinki|zurich|geneva|milan|rome|warsaw|krakow|prague|vienna|brussels|budapest|bucharest|athens|tallinn";
const APAC =
	"apac|asia|asia pacific|india|singapore|japan|china|hong kong|taiwan|south korea|korea|australia|new zealand|indonesia|philippines|vietnam|thailand|malaysia|bangalore|bengaluru|mumbai|delhi|hyderabad|pune|chennai|tokyo|seoul|sydney|melbourne|shanghai|beijing|manila|jakarta";
const LATAM =
	"latam|latin america|south america|mexico|brazil|argentina|colombia|chile|peru|uruguay|costa rica|sao paulo|buenos aires|bogota|mexico city|santiago|lima|montevideo|medellin";
const BAY_AREA =
	"bay area|san francisco|sf|south san francisco|palo alto|mountain view|menlo park|san mateo|redwood city|foster city|burlingame|oakland|berkeley|emeryville|sunnyvale|san jose|santa clara|cupertino|san carlos|san bruno";
const US = "us|usa|united states|united states of america";
const UK = "uk|united kingdom|great britain|britain|england|scotland|wales|northern ireland|london|manchester|edinburgh";
const REMOTE = "remote|anywhere|distributed|worldwide|work from home";

/** Query term -> alternative spellings / constituent places. Keys and values are folded. */
const PLACE_ALIASES: Record<string, string> = {
	...Object.fromEntries(Object.entries(US_STATES).map(([code, name]) => [code.toLowerCase(), `${code.toLowerCase()}|${fold(name)}`])),
	ca: "ca|california|canada", de: "de|delaware|germany", in: "in|indiana|india", il: "il|illinois|israel",
	co: "co|colorado|colombia", id: "id|idaho|indonesia",
	us: US, usa: US, "united states": US, "united states of america": US, america: US,
	uk: UK, "united kingdom": UK, "great britain": UK, britain: UK,
	nyc: "nyc|new york", "new york": "new york|nyc", "new york city": "new york|nyc",
	sf: BAY_AREA, "san francisco": "san francisco|sf", "bay area": BAY_AREA, "sf bay area": BAY_AREA, "silicon valley": BAY_AREA,
	la: "la|los angeles", "los angeles": "los angeles|la",
	dc: "dc|washington dc|washington d c|district of columbia", "washington dc": "dc|washington dc|district of columbia",
	uae: "uae|united arab emirates|dubai|abu dhabi", "united arab emirates": "uae|united arab emirates|dubai|abu dhabi",
	canada: "canada|can|toronto|vancouver|montreal|ottawa|calgary|ontario|quebec|british columbia|alberta",
	europe: EUROPE, eu: EUROPE, emea: EUROPE,
	apac: APAC, asia: APAC, "asia pacific": APAC,
	latam: LATAM, "latin america": LATAM, "south america": LATAM,
	"north america": `${US}|canada|mexico`,
	remote: REMOTE, anywhere: REMOTE, worldwide: REMOTE, global: REMOTE,
};

/** Like compileQuery, but commas separate parts ("Austin, TX") and each part may match via aliases. */
export function compileLocationQuery(query: string | undefined): Matcher | undefined {
	const alts = alternatives(query)
		.map((alt) =>
			alt
				.split(",")
				.map((part) => fold(part))
				.filter(Boolean)
				.map((part) => (PLACE_ALIASES[part] ?? part).split("|").map((option) => option.split(" "))),
		)
		.filter((parts) => parts.length > 0);
	if (!alts.length) return undefined;
	return (hay) => {
		const h = ` ${hay} `;
		return alts.some((parts) => parts.every((options) => options.some((terms) => terms.every((t) => hasTerm(h, t)))));
	};
}

function locationHaystack(job: JobSummary): string {
	const raw = [job.location, ...(job.places ?? [])].filter(Boolean).join(" ; ");
	const extra: string[] = [];
	// Greenhouse offices sometimes use "CA" for Canada ("Ontario, CA").
	const canadian = CANADA_RE.test(raw);
	// "Austin, TX" -> also "Texas United States"; "Berlin, DE" -> also "Delaware Germany".
	for (const m of raw.matchAll(/,\s*([A-Z]{2})\b/g)) {
		const code = m[1];
		if (code === "CA" && canadian) continue;
		const state = US_STATES[code];
		if (state && !AMBIGUOUS_STATE_CODES.has(code)) {
			extra.push(state, "United States");
			continue;
		}
		if (state) extra.push(state);
		const country = countryName(code);
		if (country) extra.push(country);
	}
	if (job.workplace === "remote" || job.workplace === "hybrid") extra.push(job.workplace);
	return fold(`${raw} ${extra.join(" ")}`);
}

// ---------------------------------------------------------------------------
// Filtering and ordering
// ---------------------------------------------------------------------------

export function filterJobs(jobs: JobSummary[], f: JobFilters): JobSummary[] {
	const keyword = compileQuery(f.keyword);
	const department = compileQuery(f.department);
	const location = compileLocationQuery(f.location);
	return jobs.filter((j) => {
		if (f.remote === true && j.workplace !== "remote") return false;
		if (f.remote === false && j.workplace === "remote") return false;
		if (keyword && !keyword(fold(j.title))) return false;
		if (department && !department(fold(`${j.department ?? ""} ${j.team ?? ""}`))) return false;
		if (location && !location(locationHaystack(j))) return false;
		return true;
	});
}

/** Newest first (by publish date, else update date); undated jobs last. */
export function sortNewestFirst(jobs: JobSummary[]): JobSummary[] {
	const t = (j: JobSummary) => timeOf(j.published) ?? timeOf(j.updated) ?? Number.NEGATIVE_INFINITY;
	return [...jobs].sort((a, b) => t(b) - t(a));
}

/** Department (or team) -> number of jobs, largest first. */
export function departmentCounts(jobs: JobSummary[], max = 25): Record<string, number> {
	const counts = new Map<string, number>();
	for (const j of jobs) {
		const name = j.department ?? j.team;
		if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max));
}
