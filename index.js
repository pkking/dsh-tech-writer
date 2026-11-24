/**
 * dsh-tech-writer — Intent-Driven Writing for the DeepSeek Harness.
 *
 * Theory mapping (see README.md):
 *   - Flower & Hayes (1981) cognitive process model: intent and text are
 *     different layers of the writing process.
 *   - Reiter & Dale, "Building Natural Language Generation Systems":
 *     content determination → document planning → microplanning/realisation;
 *     intent.md holds the first two, manuscript.md is the realised surface.
 *   - Design Rationale / ADR (Nygard 2011): intent.md is the ADR of a document.
 *   - Knowledge Transforming + Reverse Outlining: the pair evolves
 *     bidirectionally; writer_check_alignment is the reverse-outline check.
 *
 * The manuscript is a lossy expression of the intent model: the text cannot
 * uniquely reconstruct the author's goals, reasoning, and trade-offs, so the
 * intent document is kept as an independent, durable, traceable asset.
 *
 * Cordis plugin form `apply(ctx, config)` with `inject`. No @deepseek-ai/*
 * imports: every capability arrives through ctx services, so the bundle
 * installs into any profile without extra dependencies.
 */

import { randomUUID } from "node:crypto";

/** Cordis plugin name used in loader diagnostics. */
export const name = "tech-writer";

/** Required services; the plugin stays pending (not failing) where absent. */
export const inject = ["fs", "workingDirectory", "tools", "commands", "systemPrompt"];

const DEFAULT_PROJECTS_DIR = "writing";
const DEFAULT_COMMAND = "write";
const INTENT_FILE = "intent.md";
const MANUSCRIPT_FILE = "manuscript.md";
/** Optional per-project research/evidence base (STORM-inspired). */
const RESEARCH_FILE = "research.md";
/** Optional persistent cross-document constraints (Spec Kit constitution-inspired). */
const CONVENTION_FILE = "CONVENTION.md";
/** Canonical intent sections the method requires. */
const REQUIRED_SECTIONS = [
	{ key: "why", label: "Why（整篇与各章要解决什么问题）" },
	{ key: "audience", label: "Audience（目标读者、已知、关切）" },
	{ key: "claims", label: "Claims（必须传递的核心主张 [C#]）" },
	{ key: "structure", label: "Structure（章节职责 [S#]）" },
	{ key: "acceptance", label: "Acceptance（怎样算写对 [A#]）" },
];
const REQUIRED_SECTION_KEYS = REQUIRED_SECTIONS.map((section) => section.key);
/** Coverage thresholds for keyword matching. */
const COVERED_THRESHOLD = 0.5;
const PARTIAL_THRESHOLD = 0.25;
/** A manuscript section below this many words is flagged as thin. */
const THIN_SECTION_WORDS = 20;
/** Cap on document text embedded into tool results and briefs. */
const MAX_TEXT_CHARS = 20000;
/** English stopwords so keyword coverage is not trivially satisfied. */
const STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "is", "are", "be", "for", "on", "with", "that", "this", "as", "by", "at", "from", "it", "its", "we", "you", "your", "how", "what", "why", "not", "can", "will"]);

//#region pure helpers (exported for testing)

/** Whether a code point counts as a CJK word unit. */
function isCjk(codePoint) {
	return (codePoint >= 0x4e00 && codePoint <= 0x9fff) || (codePoint >= 0x3040 && codePoint <= 0x30ff) || (codePoint >= 0xac00 && codePoint <= 0xd7af);
}

/**
 * Extract significant keyword tokens from text for coverage matching.
 * Latin tokens of length >= 2 (minus stopwords) plus every CJK character.
 * @returns unique tokens in first-appearance order
 */
export function keywords(text) {
	const raw = String(text ?? "").toLowerCase();
	const tokens = [];
	const seen = new Set();
	for (const token of raw.match(/[a-z0-9][a-z0-9'-]*/g) ?? []) {
		if (token.length < 2 || STOPWORDS.has(token)) continue;
		if (!seen.has(token)) {
			seen.add(token);
			tokens.push(token);
		}
	}
	for (const character of raw) {
		if (!isCjk(character.codePointAt(0))) continue;
		if (!seen.has(character)) {
			seen.add(character);
			tokens.push(character);
		}
	}
	return tokens;
}

/** Count words: latin word tokens plus CJK characters. */
function countWords(text) {
	const value = String(text ?? "");
	const latin = (value.match(/[A-Za-z0-9']+/g) ?? []).length;
	const cjk = (value.match(/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length;
	return latin + cjk;
}

/**
 * Parse markdown bullets; `[C1]`-style leading ids are lifted out, and a
 * trailing `{ key: "value" }` block is lifted into deterministic assertions.
 * A tail only counts as assertions when every key is in the whitelist, so
 * ordinary braces (JSON examples) never misparse; near-miss keys on id'd
 * bullets surface as `suspected` for an audit warning instead of silence.
 */
const ASSERTION_TAIL = /\s*\{\s*([a-z][a-z-]*)\s*:\s*(?:"([^"]*)"|-?\d+(?:\.\d+)?|[a-z][a-z0-9_-]*|true|false)\s*(?:,\s*[a-z][a-z-]*\s*:\s*(?:"([^"]*)"|-?\d+(?:\.\d+)?|[a-z][a-z0-9_-]*|true|false)\s*)*\}\s*$/;
const ASSERTION_ITEMS = /([a-z][a-z-]*)\s*:\s*(?:"([^"]*)"|(-?\d+(?:\.\d+)?)|([a-z][a-z0-9_-]*)|true|false)/g;

/** Parse one assertion tail; returns { assertions } when every key is known. */
function parseAssertionTail(tail) {
	const raw = tail.trim();
	if (!/^\{.*\}$/.test(raw)) return null;
	const entries = {};
	for (const match of raw.matchAll(ASSERTION_ITEMS)) {
		entries[match[1]] = match[2] !== undefined ? match[2] : match[3] !== undefined ? Number(match[3]) : match[4] ?? true;
	}
	if (Object.keys(entries).length === 0) return null;
	const unknown = Object.keys(entries).filter((key) => !ASSERTION_KEYS.has(key));
	if (unknown.length > 0) return { suspected: unknown };
	return { assertions: entries };
}

function parseBullets(body) {
	const bullets = [];
	for (const line of String(body ?? "").split(/\r?\n/)) {
		const match = /^\s*[-*+]\s+(.+?)\s*$/.exec(line);
		if (match === null) continue;
		let text = match[1];
		let assertions = null;
		let suspected = null;
		const tail = ASSERTION_TAIL.exec(text);
		if (tail !== null) {
			const parsed = parseAssertionTail(tail[0]);
			if (parsed === null) {
				// syntactically a key: value tail but with unparseable keys: keep as text
			} else if (parsed.suspected !== undefined) {
				suspected = parsed.suspected;
			} else {
				assertions = parsed.assertions;
				text = text.slice(0, tail.index).trim();
			}
		}
		const idMatch = /^\[([A-Za-z])([0-9]{1,3})\]\s*(.*)$/.exec(text);
		bullets.push(idMatch === null ? { id: null, text, assertions, suspected } : { id: `${idMatch[1].toUpperCase()}${idMatch[2]}`, text: idMatch[3], assertions, suspected });
	}
	return bullets;
}

/** Whether a line opens or closes a Markdown fence block. */
function isFenceLine(line) {
	return /^\s{0,3}(```|~~~)/.test(line);
}

/**
 * Parse an intent document into `## Title` sections and their bullets.
 * A UTF-8 BOM is tolerated; `##` inside fence blocks is not a heading.
 * @returns `{ title, sections: [{ title, body, bullets }], intro }`
 */
export function parseIntent(text) {
	const source = String(text ?? "").replace(/^\uFEFF/, "");
	const lines = source.split(/\r?\n/);
	const sections = [];
	let current = null;
	let buffer = [];
	let fenced = false;
	for (const line of lines) {
		if (isFenceLine(line)) fenced = !fenced;
		// `fenced ? null : …` keeps the heading an exec result or null;
		// `!fenced && …` would yield `false`, and `false !== null` below.
		const heading = fenced ? null : /^##\s+(.+?)\s*$/.exec(line);
		if (heading !== null) {
			if (current !== null) {
				current.body = buffer.join("\n");
				current.bullets = parseBullets(current.body);
			}
			current = { title: heading[1], body: "", bullets: [] };
			sections.push(current);
			buffer = [];
			continue;
		}
		buffer.push(line);
	}
	if (current !== null) {
		current.body = buffer.join("\n");
		current.bullets = parseBullets(current.body);
	}
	const titleMatch = /^#\s+(.+?)\s*$/m.exec(source);
	return {
		title: titleMatch === null ? null : titleMatch[1],
		sections: sections.map((section) => ({ title: section.title, body: section.body, bullets: section.bullets })),
		intro: sections.length === 0 ? source.trim() : "",
	};
}

/** Normalized section key: `Why（…）` → `why`. */
function sectionKey(title) {
	return String(title ?? "").trim().toLowerCase().split(/[\s(（:：]/)[0];
}

/** Find a parsed intent section by canonical key prefix. */
function findSection(intent, key) {
	return (intent?.sections ?? []).find((section) => sectionKey(section.title) === key) ?? null;
}

/** All bullets carrying ids of one section's letter, e.g. key `claims` → `[C#]`. */
function bulletsOf(intent, key) {
	const section = findSection(intent, key);
	if (section === null) return [];
	const letter = key[0].toUpperCase();
	return section.bullets.filter((bullet) => bullet.id !== null && bullet.id[0] === letter);
}

/**
 * Declared figures from the optional `## Figures` section:
 * `[F1] 描述 | assets/path.svg` → { id, text, path }（path 可省略）。
 */
function figuresOf(intent) {
	return bulletsOf(intent, "figures").map((bullet) => {
		const pipe = bullet.text.indexOf("|");
		return pipe === -1
			? { id: bullet.id, text: bullet.text.trim(), path: null }
			: { id: bullet.id, text: bullet.text.slice(0, pipe).trim(), path: bullet.text.slice(pipe + 1).trim() };
	});
}

/** Whether a manuscript image reference path is project-relative and safe. */
function safeImagePath(path) {
	const value = String(path ?? "");
	return value !== "" && !value.startsWith("/") && !value.startsWith("\\") && !value.includes("..") && !/^[a-z]+:/i.test(value);
}

/**
 * Classify raw image bytes for technical validity (pure, deterministic):
 * `ok` / `empty` / `badmagic`（非 PNG/JPEG/GIF/WebP 魔数）/ `badsvg`（缺 <svg> 根）。
 */
export function classifyImageBytes(bytes, fileName) {
	const data = bytes ?? new Uint8Array();
	if (data.length === 0) return { status: "empty", detail: "文件为空（0 字节）" };
	const isSvg = /\.svg$/i.test(String(fileName ?? ""));
	const magic = (offset, hex) => data.length >= offset + hex.length && hex.every((byte, index) => data[offset + index] === byte);
	if (magic(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { status: "ok", detail: "PNG" };
	if (magic(0, [0xff, 0xd8, 0xff])) return { status: "ok", detail: "JPEG" };
	if (magic(0, [0x47, 0x49, 0x46, 0x38])) return { status: "ok", detail: "GIF" };
	if (magic(0, [0x52, 0x49, 0x46, 0x46]) && magic(8, [0x57, 0x45, 0x42, 0x50])) return { status: "ok", detail: "WebP" };
	const text = Buffer.from(data).toString("utf8");
	if (isSvg || text.includes("<svg")) {
		if (/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s/>]/i.test(text)) return { status: "ok", detail: "SVG" };
		return { status: "badsvg", detail: "SVG 文件缺少 <svg> 根元素" };
	}
	return { status: "badmagic", detail: "魔数不是 PNG/JPEG/GIF/WebP/SVG（可能不是图片或已损坏）" };
}

/**
 * Match declared [F#] figures against manuscript image references.
 * Exact path match first; fallback to keyword coverage of description vs alt.
 */
function matchFigures(figures, images) {
	const results = [];
	const taken = new Set();
	for (const figure of figures) {
		let match = null;
		if (figure.path !== null) {
			const byPath = images.find((image, index) => image.path === figure.path && !taken.has(index));
			if (byPath !== undefined) match = { image: byPath, status: "matched" };
		}
		if (match === null) {
			let best = null;
			let bestIndex = -1;
			for (let index = 0; index < images.length; index += 1) {
				if (taken.has(index)) continue;
				const ratio = coverage(figure.text, images[index].alt).ratio;
				if (best === null || ratio > best.ratio) {
					best = { image: images[index], ratio };
					bestIndex = index;
				}
			}
			if (best !== null && best.ratio >= PARTIAL_THRESHOLD) {
				taken.add(bestIndex);
				match = { image: best.image, status: best.ratio >= COVERED_THRESHOLD ? "matched" : "partial" };
			}
		} else {
			taken.add(images.indexOf(match.image));
		}
		results.push({ id: figure.id, text: figure.text, path: figure.path, status: match === null ? "unmatched" : match.status, reference: match === null ? null : { alt: match.image.alt, path: match.image.path, line: match.image.line } });
	}
	return results;
}

/** Valid deterministic assertion keys (Vale/doctest-inspired, pure JS checks). */
const ASSERTION_KEYS = new Set(["contains", "not-contains", "regex", "min-words", "max-words", "headings-include", "code-lang", "facts-from"]);

/** Sentence length beyond which a sentence is flagged as hard to read. */
const LONG_SENTENCE_CHARS = 100;

/**
 * Extract quantitative claims from prose: percentages, multipliers, versions,
 * years, and unit-bearing measurements — the tokens an LLM is most likely to
 * fabricate. Fence content is excluded by the caller.
 */
export function extractFacts(text) {
	const source = String(text ?? "");
	const facts = new Set();
	const push = (match) => {
		const normalized = match.replace(/\s+/g, "");
		if (normalized.length > 0) facts.add(normalized);
	};
	for (const match of source.matchAll(/(?:\d+(?:\.\d+)?)\s*%/g)) push(match[0]);
	for (const match of source.matchAll(/(?:\d+(?:\.\d+)?)\s*(?:x|X|倍)/g)) push(match[0]);
	for (const match of source.matchAll(/v\d+(?:\.\d+){1,2}/g)) push(match[0]);
	for (const match of source.matchAll(/(?:19|20)\d{2}\s*年/g)) push(match[0]);
	for (const match of source.matchAll(/(?:\d+(?:\.\d+)?)\s*(?:ms|μs|us|ns|GHz|MHz|GB|MB|KB|TB|核|节点|副本|replicas|nodes)/gi)) push(match[0]);
	return [...facts];
}

/** Manuscript text with fenced code blocks removed (prose-only view). */
function stripFences(text) {
	const lines = String(text ?? "").split(/\r?\n/);
	let fenced = false;
	const kept = [];
	for (const line of lines) {
		if (/^\s{0,3}(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (!fenced) kept.push(line);
	}
	return kept.join("\n");
}

/** Split prose into sentences and flag ones beyond LONG_SENTENCE_CHARS. */
function longSentences(text) {
	const prose = stripFences(text);
	const sentences = [];
	for (const piece of prose.split(/[\n。！？!?；;]+/)) {
		const sentence = piece.trim();
		if (sentence.length > LONG_SENTENCE_CHARS) sentences.push(sentence);
	}
	return sentences;
}

/**
 * Extract complete fenced code blocks (language, start line, code) for
 * doctest-style execution reports.
 */
export function extractCodeBlocks(text) {
	const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r?\n/);
	const blocks = [];
	let current = null;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const fence = /^(\s{0,3})(```|~~~)(.*)$/.exec(line);
		if (fence !== null) {
			if (current === null) {
				current = { language: fence[3].trim(), line: index + 1, code: [] };
			} else {
				blocks.push({ language: current.language, line: current.line, code: current.code.join("\n") });
				current = null;
			}
			continue;
		}
		if (current !== null) current.code.push(line);
	}
	return blocks;
}

/**
 * Parse `## Glossary` sections out of CONVENTION texts into enforcement
 * entries: `{ canonical, banned: [...] }` from `- 规范词 | 禁用词1, 禁用词2`.
 */
function parseGlossary(conventionTexts) {
	const entries = new Map();
	for (const convention of conventionTexts ?? []) {
		const section = (parseIntent(convention.text).sections ?? []).find((candidate) => sectionKey(candidate.title) === "glossary");
		for (const bullet of section?.bullets ?? []) {
			const parts = bullet.text.split("|");
			if (parts.length < 2) continue;
			const canonical = parts[0].trim();
			if (canonical === "") continue;
			const banned = parts[1].split(/[,，、]/).map((term) => term.trim()).filter((term) => term !== "");
			entries.set(canonical, banned);
		}
	}
	return [...entries].map(([canonical, banned]) => ({ canonical, banned }));
}

/**
 * Execute one bullet's deterministic assertions against the manuscript.
 * Returns one result per key: pass / fail / invalid (unknown key or bad regex).
 */
function executeAssertion(item, key, value, manuscript, manuscriptText, evidenceText) {
	const text = String(manuscriptText ?? "");
	switch (key) {
		case "contains":
			return { status: text.includes(String(value)) ? "pass" : "fail", detail: `正文${text.includes(String(value)) ? "包含" : "不包含"}「${value}」` };
		case "not-contains": {
			const present = text.includes(String(value));
			return { status: present ? "fail" : "pass", detail: present ? `正文不应包含「${value}」` : `正文不含「${value}」` };
		}
		case "regex":
			try {
				const matched = new RegExp(String(value), "u").test(text);
				return { status: matched ? "pass" : "fail", detail: matched ? `匹配 /${value}/` : `不匹配 /${value}/` };
			} catch {
				return { status: "invalid", detail: `非法正则 /${value}/` };
			}
		case "min-words":
			return { status: manuscript.words >= value ? "pass" : "fail", detail: `${manuscript.words} 词（要求 ≥ ${value}）` };
		case "max-words":
			return { status: manuscript.words <= value ? "pass" : "fail", detail: `${manuscript.words} 词（要求 ≤ ${value}）` };
		case "headings-include": {
			const found = manuscript.headings.some((heading) => heading.text.includes(String(value)));
			return { status: found ? "pass" : "fail", detail: found ? `标题含「${value}」` : `无标题含「${value}」` };
		}
		case "code-lang": {
			const found = manuscript.codeBlocks.some((block) => block.language === String(value));
			return { status: found ? "pass" : "fail", detail: found ? `存在 ${value} 代码块` : `无 ${value} 代码块` };
		}
		case "facts-from": {
			// 确定性幻觉检测（faithfulness）：正文的量化声称必须可溯源到证据库。
			if (String(value) !== "research.md") {
				return { status: "invalid", detail: `facts-from 目前仅支持 "research.md"（唯一证据源）` };
			}
			if (evidenceText === undefined || evidenceText === null) {
				return { status: "invalid", detail: `证据源 ${value} 不存在，无法溯源` };
			}
			const facts = extractFacts(stripFences(manuscriptText));
			if (facts.length === 0) return { status: "pass", detail: "正文无量化声称" };
			const haystack = String(evidenceText).replace(/[ \t]/g, "");
			const unsourced = facts.filter((fact) => !haystack.includes(fact));
			return unsourced.length === 0
				? { status: "pass", detail: `${facts.length} 项量化声称全部溯源到 ${value}` }
				: { status: "fail", detail: `${unsourced.length}/${facts.length} 项未在 ${value} 中找到：${unsourced.join("、")}` };
		}
		default:
			return { status: "invalid", detail: `未知断言字段「${key}」（可用：${[...ASSERTION_KEYS].join(", ")}）` };
	}
}

/** Run every asserted bullet across all intent sections; deterministic layer. */
function executeAssertions(intent, manuscript, manuscriptText, extras) {
	const results = [];
	for (const section of intent?.sections ?? []) {
		for (const bullet of section.bullets) {
			if (bullet.assertions === null) continue;
			for (const [key, value] of Object.entries(bullet.assertions)) {
				const outcome = executeAssertion(bullet, key, value, manuscript, manuscriptText, extras?.evidenceText);
				results.push({ id: bullet.id, key, value, status: outcome.status, detail: outcome.detail });
			}
		}
	}
	return results;
}

/**
 * Parse a manuscript into headings and per-section statistics.
 * A section spans one heading up to the next heading of any level.
 * A UTF-8 BOM is tolerated; `#` lines inside fence blocks are not headings;
 * fenced code blocks are collected (language + line) for code-lang checks.
 */
export function parseManuscript(text) {
	const source = String(text ?? "").replace(/^\uFEFF/, "");
	const lines = source.split(/\r?\n/);
	const headings = [];
	const codeBlocks = [];
	const images = [];
	let fenced = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const fence = /^(\s{0,3})(```|~~~)(.*)$/.exec(line);
		if (fence !== null) {
			if (!fenced) codeBlocks.push({ language: fence[3].trim(), line: index + 1 });
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (match !== null) headings.push({ level: match[1].length, text: match[2], line: index + 1 });
		for (const image of line.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
			images.push({ alt: image[1].trim(), path: image[2].trim(), line: index + 1 });
		}
	}
	const sections = [];
	const bounds = [...headings.map((heading) => heading.line), lines.length + 1];
	for (let index = 0; index < headings.length; index += 1) {
		const heading = headings[index];
		const body = lines.slice(heading.line, bounds[index + 1] - 1).join("\n");
		const paragraphs = body.split(/\n\s*\n/).map((part) => part.trim()).filter((part) => part.length > 0);
		sections.push({ heading: heading.text, level: heading.level, line: heading.line, words: countWords(body), paragraphs: paragraphs.length });
	}
	const preambleEnd = (headings[0]?.line ?? lines.length + 1) - 1;
	const preamble = lines.slice(0, preambleEnd).join("\n");
	return { headings, codeBlocks, images, sections, words: countWords(source), preambleWords: countWords(preamble) };
}

/** Whether one keyword token occurs in the lowercase haystack. */
function tokenPresent(token, haystack) {
	if (isCjk(token.codePointAt(0))) return haystack.includes(token);
	return new RegExp(`(?<![\\p{L}\\p{N}])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(haystack);
}

/** Fraction of `text`'s keywords present in `corpus` (0..1). */
export function coverage(text, corpus) {
	const tokens = keywords(text);
	if (tokens.length === 0) return { ratio: 1, matched: [], total: 0 };
	const haystack = String(corpus ?? "").toLowerCase();
	const matched = tokens.filter((token) => tokenPresent(token, haystack));
	return { ratio: matched.length / tokens.length, matched, total: tokens.length };
}

/** Best manuscript heading for one structure entry, by keyword overlap. */
function matchHeading(entryText, headings) {
	let best = null;
	for (const heading of headings) {
		const ratio = coverage(entryText, heading.text).ratio;
		if (best === null || ratio > best.ratio) best = { heading, ratio };
	}
	return best;
}

/**
 * Reverse-outline alignment between the intent model and the manuscript.
 * @param intent - parseIntent result
 * @param manuscript - parseManuscript result
 * @param manuscriptText - full manuscript text, for claims coverage
 */
export function checkAlignment(intent, manuscript, manuscriptText, extras = {}) {
	const problems = [];
	const warnings = [];
	const claims = [];
	const structure = [];
	const acceptance = [];
	for (const key of REQUIRED_SECTION_KEYS) {
		if (findSection(intent, key) === null) problems.push(`intent 缺少 ${key.toUpperCase()} 小节（## ${key}）`);
	}
	const corpus = String(manuscriptText ?? "");
	for (const claim of bulletsOf(intent, "claims")) {
		const ratio = coverage(claim.text, corpus).ratio;
		const status = ratio >= COVERED_THRESHOLD ? "covered" : ratio >= PARTIAL_THRESHOLD ? "partial" : "missing";
		claims.push({ id: claim.id, text: claim.text, status, ratio: Math.round(ratio * 100) / 100 });
		if (status === "missing") problems.push(`主张 ${claim.id} 未在正文中体现：${claim.text}`);
		else if (status === "partial") warnings.push(`主张 ${claim.id} 覆盖较弱（${Math.round(ratio * 100)}%）：${claim.text}`);
	}
	let previousLine = -1;
	const structureEntries = bulletsOf(intent, "structure");
	for (const entry of structureEntries) {
		const best = matchHeading(entry.text, manuscript.headings);
		const status = best === null || best.ratio < PARTIAL_THRESHOLD ? "unmatched" : best.ratio >= COVERED_THRESHOLD ? "matched" : "partial";
		const line = status === "unmatched" ? null : best.heading.line;
		if (status === "unmatched") problems.push(`章节职责 ${entry.id} 找不到对应标题：${entry.text}`);
		else if (line < previousLine) warnings.push(`章节职责 ${entry.id} 对应标题顺序与意图不符：${entry.text}`);
		if (line !== null) previousLine = Math.max(previousLine, line);
		structure.push({ id: entry.id, text: entry.text, status, heading: status === "unmatched" ? null : best.heading.text, line });
	}
	// Reverse structure drift (Scrivener/Spec Kit consistency): manuscript
	// sections no [S#] entry sanctions. Warning-level: the forward direction
	// owns problems; document titles (H1) are not sections.
	const unsanctioned = [];
	if (structureEntries.length > 0) {
		for (const heading of manuscript.headings) {
			if (heading.level < 2) continue;
			let best = 0;
			for (const entry of structureEntries) best = Math.max(best, coverage(heading.text, entry.text).ratio);
			if (best < PARTIAL_THRESHOLD) unsanctioned.push(heading.text);
		}
	}
	for (const headingText of unsanctioned) warnings.push(`正文存在意图外章节（无 [S#] 对应）：《${headingText}》`);
	for (const criterion of bulletsOf(intent, "acceptance")) acceptance.push({ id: criterion.id, text: criterion.text, status: "manual" });
	// A 0-word section immediately followed by a deeper heading is a container
	// title (e.g. `# Title` directly before `## Sub`), not a thin section.
	const thin = [];
	for (let index = 0; index < manuscript.sections.length; index += 1) {
		const section = manuscript.sections[index];
		if (section.words >= THIN_SECTION_WORDS) continue;
		const next = manuscript.sections[index + 1];
		if (section.words === 0 && next !== undefined && next.level > section.level) continue;
		thin.push(section);
	}
	for (const section of thin) warnings.push(`正文小节内容过薄（${section.words} 词）：《${section.heading}》`);
	if (manuscript.words === 0) problems.push("正文为空");
	// Deterministic assertion layer (Vale/doctest-inspired): machine-verifiable
	// intents execute here with pass/fail; only unverifiable semantics reach
	// the LLM-judged reader test.
	const assertions = executeAssertions(intent, manuscript, manuscriptText, extras);
	// 句级清晰性：超长单句（fence 内容不计）。
	for (const sentence of longSentences(manuscriptText)) {
		warnings.push(`长句（${sentence.length} 字，>${LONG_SENTENCE_CHARS} 判难读）：「${sentence.slice(0, 20)}…」`);
	}
	// ── 图片层（一图胜千言，同构于结构检查的双向漂移）──
	const figures = figuresOf(intent);
	const imageResults = [];
	if (figures.length > 0) {
		for (const result of matchFigures(figures, manuscript.images)) {
			imageResults.push(result);
			if (result.status === "unmatched") problems.push(`图表 ${result.id} 未在正文中引用：${result.text}`);
			else if (result.status === "partial") warnings.push(`图表 ${result.id} 仅弱匹配（描述与替代文本关键词重叠低）：${result.text}`);
		}
		// 反向漂移：意图外图片（有 Figures 声明时才检查，与 Structure 门控一致）
		for (const image of manuscript.images) {
			const sanctioned = imageResults.some((result) => result.reference !== null && result.reference.line === image.line);
			if (!sanctioned) warnings.push(`意图外图片（无 [F#] 对应）：${image.path}`);
		}
	}
	const existingImages = new Set(extras.imageFiles ?? []);
	const imageHealth = extras.imageHealth ?? {};
	for (const image of manuscript.images) {
		if (!safeImagePath(image.path)) {
			warnings.push(`图片路径不合法（须为项目内相对路径）：${image.path}`);
			continue;
		}
		if (image.alt === "") warnings.push(`图片缺少替代文本（无障碍且断链排查无从下手）：${image.path}`);
		// 存在性检查：extras.imageFiles 为 undefined 时未做磁盘检查（纯文本模式）；
		// 提供数组（含空数组）即执行断链判定。
		if (extras.imageFiles !== undefined && !existingImages.has(image.path)) {
			problems.push(`图片断链：正文引用 ${image.path} 但文件不存在`);
		}
		// 技术有效性：fs 层用 readBytes 做魔数/根元素检查，结果注入 extras.imageHealth。
		const health = imageHealth[image.path];
		if (health !== undefined && health.status !== "ok") {
			problems.push(`图片文件无效：${image.path}（${health.detail}）`);
		}
	}
	for (const orphan of extras.orphanAssets ?? []) {
		warnings.push(`assets/ 存在未被正文引用的图片：${orphan}`);
	}
	// 术语一致性（Glossary enforcement）：CONVENTION 的禁用词是显式契约，违反即 problem。
	const glossary = extras.glossary ?? [];
	if (glossary.length > 0) {
		const prose = stripFences(manuscriptText).toLowerCase();
		for (const entry of glossary) {
			for (const banned of entry.banned) {
				if (prose.includes(banned.toLowerCase())) problems.push(`术语违规：正文出现「${banned}」，按 CONVENTION 应统一为「${entry.canonical}」`);
			}
		}
	}
	for (const assertion of assertions) {
		if (assertion.status === "fail") problems.push(`确定性断言失败 ${assertion.id} {${assertion.key}}：${assertion.detail}`);
		else if (assertion.status === "invalid") warnings.push(`断言无法执行 ${assertion.id} {${assertion.key}}：${assertion.detail}`);
	}
	// Near-miss assertion keys on id'd bullets: keep ordinary braces safe from
	// misparsing while never letting a typo'd assertion fail silently.
	for (const section of intent?.sections ?? []) {
		for (const bullet of section.bullets) {
			if (bullet.id === null || bullet.suspected === null) continue;
			warnings.push(`条目 ${bullet.id} 尾部的 {${bullet.suspected.join(", ")}} 疑似断言但字段不在白名单，未执行（可用：${[...ASSERTION_KEYS].join(", ")}）`);
		}
	}
	return {
		ok: problems.length === 0,
		problems,
		warnings,
		claims,
		structure,
		acceptance,
		assertions,
		figures: imageResults,
		images: manuscript.images,
		decisions: bulletsOf(intent, "decisions").map((decision) => ({ id: decision.id, text: decision.text })),
		stats: {
			manuscriptWords: manuscript.words,
			manuscriptSections: manuscript.sections.length,
			headings: manuscript.headings.length,
			claims: claims.length,
			structureEntries: structure.length,
			acceptanceCriteria: acceptance.length,
			thinSections: thin.length,
			unsanctionedSections: unsanctioned.length,
			assertions: { pass: assertions.filter((a) => a.status === "pass").length, fail: assertions.filter((a) => a.status === "fail").length, invalid: assertions.filter((a) => a.status === "invalid").length },
			figures: imageResults.length,
			images: manuscript.images.length,
		},
	};
}

/** Human-readable report from a checkAlignment result (zh labels). */
export function renderReport(report) {
	const lines = [];
	lines.push(report.ok ? "对齐检查：通过 ✓" : `对齐检查：发现 ${report.problems.length} 个问题`);
	const { stats } = report;
	lines.push(`规模：正文 ${stats.manuscriptWords} 词 / ${stats.manuscriptSections} 节；主张 ${stats.claims} 条；章节职责 ${stats.structureEntries} 条；验收 ${stats.acceptanceCriteria} 条。`);
	if (report.claims.length > 0) {
		lines.push("", "主张覆盖（反向提纲）：");
		for (const claim of report.claims) {
			const mark = claim.status === "covered" ? "✓" : claim.status === "partial" ? "△" : "✗";
			lines.push(`  ${mark} ${claim.id}（${Math.round(claim.ratio * 100)}%）${claim.text}`);
		}
	}
	if (report.structure.length > 0) {
		lines.push("", "结构映射：");
		for (const entry of report.structure) {
			const mark = entry.status === "matched" ? "✓" : entry.status === "partial" ? "△" : "✗";
			lines.push(`  ${mark} ${entry.id} → ${entry.heading ?? "(未匹配)"}${entry.text ? ` ｜ ${entry.text}` : ""}`);
		}
	}
	if (report.acceptance.length > 0) {
		lines.push("", "验收标准（需人工核对）：");
		for (const criterion of report.acceptance) lines.push(`  • ${criterion.id} ${criterion.text}`);
	}
	if (report.figures.length > 0) {
		lines.push("", "图表覆盖（一图胜千言）：");
		for (const figure of report.figures) {
			const mark = figure.status === "matched" ? "✓" : figure.status === "partial" ? "△" : "✗";
			lines.push(`  ${mark} ${figure.id} → ${figure.reference === null ? "(未引用)" : `${figure.reference.path}${figure.status === "partial" ? "（弱匹配）" : ""}`} ｜ ${figure.text}`);
		}
	}
	if (report.assertions.length > 0) {
		lines.push("", "确定性断言（机器可验，不经 LLM）：");
		for (const assertion of report.assertions) {
			const mark = assertion.status === "pass" ? "✓" : assertion.status === "fail" ? "✗" : "△";
			const rendered = typeof assertion.value === "string" ? `"${assertion.value}"` : String(assertion.value);
			lines.push(`  ${mark} ${assertion.id} {${assertion.key}: ${rendered}} — ${assertion.detail}`);
		}
	}
	if (report.decisions.length > 0) {
		lines.push("", "关键取舍（供审查）：");
		for (const decision of report.decisions) lines.push(`  • ${decision.id} ${decision.text}`);
	}
	if (report.problems.length > 0) {
		lines.push("", "问题：");
		for (const problem of report.problems) lines.push(`  ✗ ${problem}`);
	}
	if (report.warnings.length > 0) {
		lines.push("", "提醒：");
		for (const warning of report.warnings) lines.push(`  △ ${warning}`);
	}
	return lines.join("\n");
}

//#endregion

//#region filesystem access

/** Resolve configuration with defaults and validation (exported for testing). */
export function resolveConfig(config) {
	const source = config ?? {};
	const projectsDir = typeof source.projectsDir === "string" && source.projectsDir.trim() !== "" ? source.projectsDir.trim() : DEFAULT_PROJECTS_DIR;
	let command = typeof source.command === "string" && source.command.trim() !== "" ? source.command.trim().toLowerCase() : DEFAULT_COMMAND;
	if (!/^[a-z][a-z0-9_-]*$/.test(command)) command = DEFAULT_COMMAND;
	return {
		projectsDir,
		command,
		enableTools: source.enableTools !== false,
		enablePrompt: source.enablePrompt !== false,
	};
}

/** Validate a user-supplied project name; `.` means the projects directory itself (exported for testing). */
export function validProject(project) {
	const name = String(project ?? "").trim();
	if (name === ".") return name;
	if (name === "" || name.length > 64) return null;
	if (name.startsWith(".") || name.includes("/") || name.includes("\\")) return null;
	if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(name)) return null;
	return name;
}

/** Directory prefix for one project: `writing/foo/` or `writing/` for `.`. */
function projectPrefix(projectsDir, project) {
	return project === "." ? `${projectsDir}/` : `${projectsDir}/${project}/`;
}

/** Resolve both document targets of one project. */
async function projectTargets(ctx, cwd, resolved, project) {
	const prefix = projectPrefix(resolved.projectsDir, project);
	return {
		root: await ctx.fs.resolve(prefix.replace(/\/$/, ""), { cwd }),
		intent: await ctx.fs.resolve(`${prefix}${INTENT_FILE}`, { cwd }),
		manuscript: await ctx.fs.resolve(`${prefix}${MANUSCRIPT_FILE}`, { cwd }),
	};
}

/** Read one text file, or null when absent. */
async function readOptional(ctx, target, signal) {
	const info = await ctx.fs.stat(target, signal);
	if (info === undefined || info.type !== "file") return null;
	return ctx.fs.readText(target, signal);
}

/** Load both documents plus optional research and convention files of one project. */
async function loadProject(ctx, cwd, resolved, project, signal) {
	const targets = await projectTargets(ctx, cwd, resolved, project);
	const prefix = projectPrefix(resolved.projectsDir, project);
	const research = await ctx.fs.resolve(`${prefix}${RESEARCH_FILE}`, { cwd });
	const globalConvention = await ctx.fs.resolve(`${resolved.projectsDir}/${CONVENTION_FILE}`, { cwd });
	const projectConvention = project === "." ? globalConvention : await ctx.fs.resolve(`${prefix}${CONVENTION_FILE}`, { cwd });
	const conventionTexts = [];
	const globalConventionText = await readOptional(ctx, globalConvention, signal);
	if (globalConventionText !== null) conventionTexts.push({ scope: "全局", text: globalConventionText });
	if (project !== ".") {
		const localConventionText = await readOptional(ctx, projectConvention, signal);
		if (localConventionText !== null) conventionTexts.push({ scope: "项目", text: localConventionText });
	}
	return {
		project,
		targets: { ...targets, research, globalConvention, projectConvention },
		intentText: await readOptional(ctx, targets.intent, signal),
		manuscriptText: await readOptional(ctx, targets.manuscript, signal),
		researchText: await readOptional(ctx, research, signal),
		conventionTexts,
		glossary: parseGlossary(conventionTexts),
	};
}

/** List project names under the configured projects directory. */
async function listProjects(ctx, cwd, resolved, signal) {
	const base = await ctx.fs.resolve(resolved.projectsDir, { cwd });
	const info = await ctx.fs.stat(base, signal);
	if (info === undefined || info.type !== "directory") return [];
	const names = new Set();
	for (const entry of await ctx.fs.listDir(base, signal)) {
		if (entry.type === "directory") names.add(entry.name);
		else if (entry.type === "file" && (entry.name === INTENT_FILE || entry.name === MANUSCRIPT_FILE)) names.add(".");
	}
	return [...names].sort();
}

/** Cut text to a bounded length for embedding into results and briefs. */
function bound(text) {
	const value = String(text ?? "");
	if (value.length <= MAX_TEXT_CHARS) return value;
	return `${value.slice(0, MAX_TEXT_CHARS)}\n…（截断，共 ${value.length} 字符）`;
}

/** Parse both documents and run the alignment check. */
async function analyzeProject(ctx, cwd, resolved, project, signal) {
	const documents = await loadProject(ctx, cwd, resolved, project, signal);
	if (documents.intentText === null && documents.manuscriptText === null) {
		return { documents, intent: null, manuscript: null, report: null };
	}
	const intent = parseIntent(documents.intentText ?? "");
	const manuscript = parseManuscript(documents.manuscriptText ?? "");
	// 图片资产：正文引用逐一 stat（存在性 + 技术有效性）；assets/ 目录列表（孤儿检测）。
	const imageFiles = [];
	const imageHealth = {};
	for (const image of manuscript.images) {
		if (!safeImagePath(image.path)) continue;
		const target = await ctx.fs.resolve(`${projectPrefix(resolved.projectsDir, project)}${image.path}`, { cwd });
		const info = await ctx.fs.stat(target, signal);
		if (info === undefined || info.type !== "file") continue;
		imageFiles.push(image.path);
		// 技术有效性：读头部做魔数/SVG 根元素判定（readBytes 契约：返回 ≤maxBytes 的原始字节）。
		try {
			const head = await ctx.fs.readBytes(target, signal, 16384);
			imageHealth[image.path] = classifyImageBytes(head, image.path);
		} catch {
			imageHealth[image.path] = { status: "badmagic", detail: "无法读取文件内容" };
		}
	}
	let orphanAssets = [];
	const assetsDir = await ctx.fs.resolve(`${projectPrefix(resolved.projectsDir, project)}assets`, { cwd });
	const assetsInfo = await ctx.fs.stat(assetsDir, signal);
	if (assetsInfo !== undefined && assetsInfo.type === "directory") {
		const referenced = new Set(manuscript.images.map((image) => image.path));
		orphanAssets = (await ctx.fs.listDir(assetsDir, signal))
			.filter((entry) => entry.type === "file" && /\.(png|jpe?g|gif|svg|webp)$/i.test(entry.name))
			.filter((entry) => !referenced.has(`assets/${entry.name}`))
			.map((entry) => entry.name);
	}
	const report = checkAlignment(intent, manuscript, documents.manuscriptText ?? "", {
		evidenceText: documents.researchText,
		glossary: documents.glossary,
		imageFiles,
		orphanAssets,
		imageHealth,
	});
	return { documents, intent, manuscript, report };
}

//#endregion

//#region scaffolds and queued instructions

/** Scaffold the intent document for one project. */
function intentScaffold(project) {
	return `# Intent — ${project === "." ? "（本项目）" : project}

> 意图模型（Intent Model）：正文 manuscript.md 是本文档的有损表达。
> 本文件是可追溯的设计资产：改结构先改这里，再改正文；写作中发现新认知，回写到这里（见 Log）。
> 条目行尾可加确定性断言（audit 纯代码验证，不经 LLM）：
> { contains: "文本" } / { not-contains: "文本" } / { regex: "…" } /
> { min-words: 100 } / { max-words: 500 } / { headings-include: "标题" } / { code-lang: bash }

## Why
- （这份文档要解决什么问题？为什么值得写？）

## Audience
- （目标读者是谁？他们已知什么、关心什么、会被什么说服？）

## Claims
- [C1] （核心主张 1：必须让读者接受的一句话）
- [C2] （核心主张 2）

## Structure
- [S1] （章节 1 职责：承担哪个主张/哪段论证）
- [S2] （章节 2 职责）

## Decisions
- [D1] （关键取舍：选了什么、放弃了什么、为什么）

## Acceptance
- [A1] （语义标准：读者读完应能……——交给 /write readtest 的无上下文读者验证）
- [A2] （机器标准示例：全文不得出现禁词）{ not-contains: "TODO" }

## Log
- （双向演进记录：正文写作改变了哪些认知，何时回写）
`;
}

/** Scaffold the manuscript document. */
function manuscriptScaffold(project) {
	return `# ${project === "." ? "未命名文稿" : project}

（正文。每个 [S#] 对应一个标题；提交前用 /write audit 做反向提纲对齐检查。）
`;
}

/**
 * The instruction text queued by plan: the missing half of Anthropic doc
 * co-authoring — gathering writing context, then drafting the intent so the
 * human reviews instead of authoring from scratch. The user descends from
 * "intent author" to "intent maintainer".
 *
 * Triage protocol: the model first judges the intent gap and the stakes, then
 * picks a lane — low stakes draft with explicit 〔assumptions〕 the user can
 * overturn (cheaper than answering questions), high stakes grilling with one
 * adversarial question per round (each must expose a concrete conflict or
 * missing criterion, never form-filling). Claims must originate from the
 * user's own words: the model may challenge positions but never author them —
 * the anti-"intent outsourcing hallucination" rule that keeps the whole
 * verification stack meaningful.
 */
function planMessage(project, description) {
	return [
		`请为写作项目 ${project} 起草意图模型 intent.md（已建好脚手架，请直接覆写各小节）。`,
		"",
		`用户的一句话描述：${description === "" ? "（未提供——先走拷问式访谈）" : description}`,
		"",
		"第 0 步（分诊，先做）：从描述判断「意图缺口」与「赌注」。赌注低 = 说明性/低冲突/读者宽容；赌注高 = 说服、选型、立场、要读者改变行为。给出你的分诊结论（缺口清单 + 赌注判断）再进对应分支。",
		"",
		"分支 A（低赌注）：直接起草。凡是你替用户做的判断，在 intent.md 里显式标注〔假设 N：…〕，并在汇报时逐条列出请用户确认或推翻——推翻假设比回答问题便宜。",
		"",
		"分支 B（高赌注 或 描述为空）：拷问式访谈（grilling），不是问卷：",
		"- 用 ask_user_question 逐轮提问，一次只问一个问题，最多 5 轮。",
		"- 每问必须暴露一个具体缺口：立场冲突、缺失的判据、没考虑过的读者反例（例：「读者现在用什么方案？你的主张会推翻它，他们凭什么信你？」）。禁止「你想要什么风格/长度」这类填表问题，禁止问能从描述直接推出的信息。",
		"- 每问附一句为什么问这个（暴露的是什么风险）。",
		"- 逐轮吸收回答，直到缺口闭合或轮次用尽。",
		"",
		"起草规则（两分支相同）：",
		"1. 覆写 intent.md 全部小节：Why / Audience / Claims / Structure / Decisions / Acceptance / Log。主张 [C1]…、章节职责 [S1]…、验收 [A1]… 编号；Structure 条目文字要能与未来正文标题对上关键词。",
		"2. **立场红线**：[C#] 主张必须源自用户原话或访谈回答的语义；你可以挑战、追问、指出冲突，但不得替用户发明立场或取舍。这是整个验证体系的前提——意图必须是用户的，否则后续一切验证都在验证稻草人。",
		"3. 验证器分级：能机器验证的标准写成行尾确定性断言，不要散文。可用：{ contains: \"文本\" }、{ not-contains: \"文本\" }、{ regex: \"…\" }、{ min-words: N }、{ max-words: N }、{ headings-include: \"标题\" }、{ code-lang: bash }。「读者能说出/理解」类语义标准保持纯文本，交给 /write readtest。",
		"4. 写入后汇报：分诊结论 + 逐小节一句话 + 〔假设〕清单或访谈纪要 + 哪些 [A#] 机器验、哪些读者验，请用户确认或修改。此后用户的角色是审阅，不是从零写。",
		"5. 不要写 manuscript.md——那是 /write brief 之后的正文阶段的事。",
	].join("\n");
}

/**
 * The instruction text queued by doctest: execute the manuscript's code
 * examples for real (Rust doc-tests / Python doctest practice). Execution
 * stays inside the model's sandboxed, approval-governed bash tool — the
 * plugin never spawns processes itself.
 */
function doctestMessage(project, blocks, manuscriptPath) {
	const listing = blocks.map((block, index) => `〔块 ${index + 1} · ${block.language === "" ? "无语言标注" : block.language} · 正文第 ${block.line} 行起〕\n\`\`\`\n${block.code}\n\`\`\``).join("\n\n");
	return [
		`请执行写作项目 ${project} 正文中的全部代码示例（doctest 式验证，正文位于 ${manuscriptPath}）。`,
		"",
		"步骤：",
		"1. 逐块执行：用 bash 工具（沙箱与审批体系内）运行下面每个代码块；优先在临时目录（mktemp -d）执行以防副作用；每块设 ≤60 秒超时；块间相互独立。",
		"2. 记录每块结果：pass/fail + 关键输出摘录（错误给前几行即可）。",
		"3. 对 fail 的块归因：示例本身错误（命令、参数、依赖写错）→ 修 manuscript.md 的示例；环境缺依赖（沙箱没装某工具）→ 不改正文，在报告标注「环境限制」。",
		"4. 输出汇总表（块号/语言/结果/归因）后，把属于示例错误的块修好并复跑确认。",
		"5. 修复只动代码示例本身，不动周边论述文字。",
		"",
		`代码块清单（共 ${blocks.length} 块）：`,
		"",
		listing,
	].join("\n");
}

/**
 * The instruction text queued by figures: generate the missing/unmatched
 * [F#] figures (one image is worth a thousand words), fix broken references
 * and empty alt texts — all inside the sandbox-governed tools, then re-audit.
 */
function figuresMessage(project, report, documents) {
	const todo = [];
	for (const figure of report.figures) {
		if (figure.status === "unmatched") todo.push(`- [F] ${figure.id}：${figure.text}（目标路径：${figure.path ?? "assets/ 下自选，如 assets/fig.svg"}）`);
		else if (figure.status === "partial") todo.push(`- [F] ${figure.id}：${figure.text}——已有弱匹配引用（${figure.reference.path}），确认是否替换或补充`);
	}
	for (const problem of report.problems) {
		if (problem.includes("图片断链")) todo.push(`- [修] ${problem}`);
	}
	for (const warning of report.warnings) {
		if (warning.includes("缺少替代文本")) todo.push(`- [修] ${warning}`);
	}
	return [
		`请为写作项目 ${project} 补全图表（一图胜千言：图表是意图的视觉表达，与正文同源同约束）。`,
		"",
		"步骤：",
		"1. 对下面每个未满足的 [F#]：按其描述生成图表。优先用当前环境可用的绘图/图表技能（如 archify、mermaid、matplotlib 等）生成 SVG/PNG，落盘到项目的 assets/ 目录；图的内容必须服务于该 [F] 声明的意图（说明什么、给谁看），不是装饰。",
		"2. 把引用插入 manuscript.md 对应小节（与 Structure 的 [S#] 语义匹配处），格式 `![图意一句话描述](assets/文件名)` —— 替代文本必须是有信息量的一句话，不得为空。",
		"3. 顺手修复列出的断链与空 alt 引用。",
		"4. 完成后运行 /write audit 复验图表覆盖与断链检查。",
		"5. 图表文件与正文同受 git 跟踪；不要生成意图之外的图。",
		"",
		`待办清单：`,
		...todo,
		todo.length === 0 ? "（图表检查已全部通过——运行本命令可能只是想确认无遗漏）" : "",
	].filter((line) => line !== "").join("\n");
}

/**
 * The instruction text queued by figtest: the visual reader test. A fresh
 * subagent reads each figure with the read_image tool and answers whether it
 * expresses the [F#] intent, citing the visual elements it saw as evidence —
 * the same evidence-chain discipline as the textual readtest.
 */
function figtestMessage(project, quiz) {
	return [
		`请对写作项目 ${project} 的图表执行视觉读者测试（Visual Reader Test）。`,
		"",
		"原理：同文字读者测试——图的作者知道太多，无法可靠判断图是否达意；用没有作者上下文的「新读者」看图验证（多模态版 readtest）。",
		"",
		"步骤：",
		"1. 启动一个全新 subagent（不继承本对话任何上下文）。",
		"2. 给它下面的题目清单：每题一张图片文件路径 + 该图声明的意图描述。让它用 read_image 工具读图后回答：图是否表达了该意图？",
		"3. 要求逐字记录读者看到的视觉元素作为证据：组件名、连接关系、箭头方向、层级、标签文字、图例。禁止它凭描述脑补——只准引用图里真实可见的东西。",
		"4. 判定：图包含意图声明的核心元素且关系正确 → pass；缺核心元素、画错关系、图文不符 → fail，以读者描述为证。",
		"5. 对 fail 的条目归因分岔：图画错 → 用 /write figures 重新生成该 [F#]；[F#] 描述本身不合理（画不出来/过载）→ 更新 intent.md 的 Figures 并在 Log 记一行。",
		"6. 汇总：逐 [F#] 判定 + 视觉证据摘录；全部 pass 才算通过。",
		"",
		"题目清单：",
		...quiz.map((item) => `- ${item.id} ${item.path} —— ${item.text}`),
	].join("\n");
}

/** The instruction text queued by brief (intent → manuscript). */
function briefMessage(documents) {
	const lines = [
		"请按意图模型写作/修订正文 manuscript.md。",
		"",
		"方法（Intent-Driven Writing）：正文是意图的有损表达。写作时以 intent.md 为唯一设计依据；结构按 Structure 小节的 [S#] 落成标题；每个 [C#] 主张必须有一处明确的论证承载；取舍遵循 [D#]；写完对照 [A#] 自查。",
		"若写作过程中发现意图本身要变（新增主张、调整章节职责、改变取舍），先更新 intent.md 再继续正文，并在 intent.md 的 Log 小节记一行。",
	];
	if (documents.conventionTexts.length > 0) {
		lines.push("", "写作约束（CONVENTION.md，跨文档持久约束，优先级高于个人行文偏好）：");
		for (const convention of documents.conventionTexts) {
			lines.push(`〔${convention.scope}〕`, bound(convention.text));
		}
	}
	lines.push("", "intent.md 内容：", "", bound(documents.intentText));
	if (documents.researchText !== null) {
		lines.push("", "研究材料（research.md，主张的证据基础；[C#] 的论证应可溯源到此处，引用时注明来源小节）：", "", bound(documents.researchText));
	}
	return lines.join("\n");
}

/**
 * The instruction text queued by readtest (Anthropic doc co-authoring's
 * independent reader test): a fresh subagent reads only the manuscript and is
 * quizzed on [A#] acceptance criteria. Bullets carrying deterministic
 * assertions are excluded — the machine already verified those; only
 * unverifiable semantics are delegated to the LLM reader.
 */
function readtestMessage(semanticAcceptance, assertedAcceptance, manuscriptText) {
	const lines = [
		"请对正文执行独立读者测试（Reader Test）。",
		"",
		"原理：正文的作者知道太多，无法可靠判断读者能否看懂；用一个没有作者上下文的「新读者」验证文档是否达成目标（源自 Anthropic 文档协作流程）。",
		"",
		"步骤：",
		"1. 启动一个全新 subagent（不继承本对话任何上下文），只发给它下面的 manuscript.md 全文——不给 intent.md、不给任何背景说明。",
		"2. 让它通读后逐条回答验收问题，要求逐字记录它的回答。",
		"3. 对照每条 [A#] 判定：读者回答覆盖标准要求 → pass；答不出/答错/仅部分理解 → fail，并引用读者原话作为证据。",
		"4. 输出汇总：逐条 [A#] 的判定 + 读者原话摘录；全部 pass 才算通过。",
		"5. 对 fail 的条目区分两类处理：正文没写到 → 修正文；验收标准本身不合理 → 更新 intent.md 的 Acceptance 并在 Log 记一行。",
		"",
		"验收标准（来自 intent.md 的 Acceptance；已剔除带确定性断言、由机器验证的条目）：",
		...semanticAcceptance.map((criterion) => `- ${criterion.id} ${criterion.text}`),
	];
	if (assertedAcceptance.length > 0) {
		lines.push("", "以下条目带确定性断言，audit 已机器验证，无需读者测试：");
		for (const criterion of assertedAcceptance) lines.push(`- ${criterion.id} ${criterion.text}（断言已在 audit 执行）`);
	}
	lines.push("", "manuscript.md 内容：", "", bound(manuscriptText));
	return lines.join("\n");
}

/** The instruction text queued by sync (manuscript → intent, reverse outline). */
function syncMessage(manuscriptText) {
	return [
		"请做反向提纲（Reverse Outlining）并回写意图模型 intent.md。",
		"",
		"步骤：",
		"1. 从 manuscript.md 的实际正文提取提纲：逐节概括该节实际承担的论点与功能（不是复述标题）。",
		"2. 与 intent.md 的 Structure/Claims 逐条对照：正文多出了什么、丢掉了什么、顺序为何不同。",
		"3. 区分两类差异并分别处理：正文偏离意图 → 修正文；意图已过时（写作中认知进化）→ 更新 intent.md 的 Why/Claims/Structure，并在 Log 小节记录这次回写。",
		"",
		"manuscript.md 内容：",
		"",
		bound(manuscriptText),
	].join("\n");
}

//#endregion

//#region tools

/** Shared output schema: strict on the two core fields, open at depth. */
const OBJECT_OUTPUT = {
	type: "object",
	additionalProperties: true,
	properties: {
		project: { type: "string" },
		summary: { type: "string" },
	},
	required: ["project", "summary"],
};

/** Render a tool value as text blocks for the model and the transcript. */
function renderValue(_args, value) {
	return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/** Validate the `project` argument of a tool call. */
function requireProject(args) {
	const project = (args ?? {}).project;
	if (typeof project !== "string" || project.trim() === "") throw new Error("writer: 参数 project（项目名）必填");
	const valid = validProject(project);
	if (valid === null) throw new Error(`writer: 非法项目名 "${project}"（只允许字母数字、中文、点、下划线、连字符）`);
	return valid;
}

/** Working directory for a tool execution, falling back to the default. */
function execCwd(ctx, exec) {
	if (exec?.agent?.session !== undefined) return ctx.workingDirectory.get(exec.agent.session);
	return ctx.workingDirectory.defaultDirectory;
}

/** Register the three read-only writer tools on the plugin context. */
function registerWriterTools(ctx, resolved) {
	ctx.tools.register({
		name: "writer_read_intent",
		description: "Read the intent model (intent.md) and manuscript stats of one writing project. Returns Why/Audience/Claims [C#]/Structure [S#]/Decisions [D#]/Acceptance [A#] sections. Use before drafting or restructuring a long document; omit project to list projects.",
		parameters: {
			type: "object",
			properties: {
				project: { type: "string", description: "Project name under the writing directory; omit to list projects." },
			},
			additionalProperties: false,
		},
		output: { schema: OBJECT_OUTPUT, render: renderValue },
		presentCall: (args) => ({ card: "generic", title: "writer: read intent", rawInput: String(args?.project ?? "") }),
		async execute(args, exec) {
			const cwd = execCwd(ctx, exec);
			if (args?.project === undefined) {
				const projects = await listProjects(ctx, cwd, resolved, exec.signal);
				return { project: "*", summary: `projects: ${projects.join(", ") || "(none)"}`, projects };
			}
			const project = requireProject(args);
			const { documents, intent, manuscript } = await analyzeProject(ctx, cwd, resolved, project, exec.signal);
			if (documents.intentText === null && documents.manuscriptText === null) {
				return { project, summary: `not found; scaffold with /${resolved.command} init`, exists: false, intentPath: documents.targets.intent.displayPath, manuscriptPath: documents.targets.manuscript.displayPath };
			}
			const claims = bulletsOf(intent, "claims").map((claim) => ({ id: claim.id, text: claim.text }));
			const structure = bulletsOf(intent, "structure").map((entry) => ({ id: entry.id, text: entry.text }));
			const missing = REQUIRED_SECTION_KEYS.filter((key) => findSection(intent, key) === null);
			return {
				project,
				exists: true,
				intentPath: documents.targets.intent.displayPath,
				manuscriptPath: documents.targets.manuscript.displayPath,
				intent: {
					title: intent.title,
					sections: intent.sections.map((section) => ({ title: section.title, bullets: section.bullets })),
					missingSections: missing,
				},
				claims,
				structure,
				manuscript: {
					words: manuscript.words,
					sections: manuscript.sections.map((section) => ({ heading: section.heading, words: section.words, paragraphs: section.paragraphs })),
				},
				summary: `intent sections: ${intent.sections.length}; claims: ${claims.length}; structure: ${structure.length}; manuscript words: ${manuscript.words}${documents.intentText === null ? "; intent.md missing" : ""}${documents.manuscriptText === null ? "; manuscript.md missing" : ""}`,
			};
		},
	});
	ctx.tools.register({
		name: "writer_outline",
		description: "Reverse-outline one manuscript: extract headings and per-section word/paragraph statistics. Use to inspect what the text actually argues before comparing it against intent.md.",
		parameters: {
			type: "object",
			properties: {
				project: { type: "string", description: "Project name under the writing directory." },
			},
			required: ["project"],
			additionalProperties: false,
		},
		output: { schema: OBJECT_OUTPUT, render: renderValue },
		presentCall: (args) => ({ card: "generic", title: "writer: reverse outline", rawInput: String(args?.project ?? "") }),
		async execute(args, exec) {
			const project = requireProject(args);
			const cwd = execCwd(ctx, exec);
			const documents = await loadProject(ctx, cwd, resolved, project, exec.signal);
			if (documents.manuscriptText === null) {
				return { project, summary: "manuscript.md not found", exists: false, manuscriptPath: documents.targets.manuscript.displayPath };
			}
			const manuscript = parseManuscript(documents.manuscriptText);
			return {
				project,
				exists: true,
				manuscriptPath: documents.targets.manuscript.displayPath,
				headings: manuscript.headings.map((heading) => ({ level: heading.level, text: heading.text, line: heading.line })),
				sections: manuscript.sections.map((section) => ({ heading: section.heading, words: section.words, paragraphs: section.paragraphs })),
				words: manuscript.words,
				summary: `${manuscript.headings.length} headings, ${manuscript.words} words`,
			};
		},
	});
	ctx.tools.register({
		name: "writer_check_alignment",
		description: "Check manuscript.md against intent.md (reverse-outline alignment): claims [C#] keyword coverage, structure [S#] → heading mapping and order, thin sections, missing intent sections. Run after drafting or restructuring, before delivery.",
		parameters: {
			type: "object",
			properties: {
				project: { type: "string", description: "Project name under the writing directory." },
			},
			required: ["project"],
			additionalProperties: false,
		},
		output: { schema: OBJECT_OUTPUT, render: renderValue },
		presentCall: (args) => ({ card: "generic", title: "writer: check alignment", rawInput: String(args?.project ?? "") }),
		async execute(args, exec) {
			const project = requireProject(args);
			const cwd = execCwd(ctx, exec);
			const { documents, report } = await analyzeProject(ctx, cwd, resolved, project, exec.signal);
			if (report === null) {
				return { project, summary: `not found; scaffold with /${resolved.command} init`, exists: false, intentPath: documents.targets.intent.displayPath, manuscriptPath: documents.targets.manuscript.displayPath };
			}
			return {
				project,
				exists: true,
				ok: report.ok,
				problems: report.problems,
				warnings: report.warnings,
				claims: report.claims,
				structure: report.structure,
				acceptance: report.acceptance,
				assertions: report.assertions,
				decisions: report.decisions,
				stats: report.stats,
				summary: report.ok ? `aligned: ${report.stats.claims} claims, ${report.stats.manuscriptWords} words` : `${report.problems.length} problems`,
			};
		},
	});
}

//#endregion

//#region command

const usageLine = (command) => `用法：/${command} [status|init <项目>|plan <项目> [一句话]|brief <项目>|audit <项目>|figures <项目>|figtest <项目>|sync <项目>|readtest <项目>|doctest <项目>]`;

/** Parse the command grammar owned by /write (exported for testing). */
export function parseWriteCommand(rawInput) {
	const input = String(rawInput ?? "").trim();
	if (input.length === 0) return { kind: "status" };
	const space = /\s+/.exec(input);
	const verb = (space === null ? input : input.slice(0, space.index)).toLowerCase();
	const rest = space === null ? "" : input.slice(space.index).trim();
	if (verb === "status") return { kind: "status" };
	if (verb === "plan") {
		if (rest === "") return { kind: "usage", verb };
		// `/write plan <项目> [一句话描述]`：首个词是项目名，其余是描述
		const space = /\s+/.exec(rest);
		return space === null
			? { kind: "plan", project: rest, description: "" }
			: { kind: "plan", project: rest.slice(0, space.index), description: rest.slice(space.index).trim() };
	}
	if (verb === "init" || verb === "brief" || verb === "audit" || verb === "sync" || verb === "readtest" || verb === "doctest" || verb === "figures" || verb === "figtest") {
		if (rest === "") return { kind: "usage", verb };
		return { kind: verb, project: rest };
	}
	return { kind: "usage", verb };
}

/** Queue one follow-up turn carrying instruction text for the agent. */
function queueFollowup(agent, text, summary) {
	agent.followup({
		id: `tech-writer-${randomUUID()}`,
		role: "user",
		content: [{ type: "text", text }],
		source: { kind: "tech-writer", form: "brief", summary },
	});
}

/** Execute one /write invocation against the project store. */
async function executeWriteCommand(ctx, resolved, invocation) {
	const command = parseWriteCommand(invocation.rawInput);
	if (command.kind === "usage") {
		return { kind: "error", text: `未知子命令${command.verb ? ` "${command.verb}"` : ""}。\n${usageLine(resolved.command)}` };
	}
	const cwd = ctx.workingDirectory.get(invocation.agent.session);
	if (command.kind === "status") {
		const projects = await listProjects(ctx, cwd, resolved, invocation.signal);
		if (projects.length === 0) {
			return { kind: "success", text: `还没有写作项目（目录 ${resolved.projectsDir}/ 下无 intent.md）。用 /${resolved.command} init <项目> 创建。\n${usageLine(resolved.command)}` };
		}
		const lines = [`写作项目（${resolved.projectsDir}/）：`];
		for (const project of projects) {
			const { report } = await analyzeProject(ctx, cwd, resolved, project, invocation.signal);
			lines.push(`  • ${project}${report === null ? "（空）" : ` — 正文 ${report.stats.manuscriptWords} 词，主张 ${report.stats.claims} 条${report.ok ? "" : `，${report.problems.length} 个待修问题`}`}`);
		}
		lines.push("", usageLine(resolved.command));
		return { kind: "success", text: lines.join("\n") };
	}
	const project = validProject(command.project);
	if (project === null) return { kind: "error", text: `非法项目名 "${command.project}"。${usageLine(resolved.command)}` };
	if (command.kind === "init") {
		const existing = await loadProject(ctx, cwd, resolved, project, invocation.signal);
		if (existing.intentText !== null || existing.manuscriptText !== null) {
			return { kind: "error", text: `项目 ${project} 已存在（${resolved.projectsDir}/${project === "." ? "" : `${project}/`}）。用 /${resolved.command} audit ${project} 检查，或直接编辑。` };
		}
		await ctx.fs.writeText(existing.targets.intent, intentScaffold(project), undefined, invocation.signal);
		await ctx.fs.writeText(existing.targets.manuscript, manuscriptScaffold(project), undefined, invocation.signal);
		return {
			kind: "success",
			text: `已创建 ${projectPrefix(resolved.projectsDir, project)}intent.md 与 manuscript.md。\n\n下一步：填好 intent.md 的 Why/Audience/Claims/Structure/Acceptance，然后 /${resolved.command} brief ${project} 开始写作。`,
		};
	}
	if (command.kind === "plan") {
		const existing = await loadProject(ctx, cwd, resolved, project, invocation.signal);
		if (existing.intentText !== null || existing.manuscriptText !== null) {
			return { kind: "error", text: `项目 ${project} 已存在。要修订意图请直接编辑 intent.md，或写作后用 /${resolved.command} sync ${project} 做反向回写。` };
		}
		await ctx.fs.writeText(existing.targets.intent, intentScaffold(project), undefined, invocation.signal);
		await ctx.fs.writeText(existing.targets.manuscript, manuscriptScaffold(project), undefined, invocation.signal);
		const description = String(command.description ?? "");
		queueFollowup(invocation.agent, planMessage(project, description), "intent planning");
		return {
			kind: "success",
			text: `已创建 ${project} 的脚手架，并把意图起草排入下一轮：模型将${description === "" ? "先访谈你补全背景，" : "基于你的描述（必要时追问 ≤5 个问题），"}起草 intent.md 供你确认。你只需审阅与修改，不必从零写。`,
		};
	}
	const { documents, intent, report } = await analyzeProject(ctx, cwd, resolved, project, invocation.signal);
	if (command.kind === "audit") {
		if (report === null) return { kind: "error", text: `项目 ${project} 不存在。先 /${resolved.command} init ${project}。` };
		return { kind: "success", text: renderReport(report) };
	}
	if (command.kind === "brief") {
		if (documents.intentText === null) return { kind: "error", text: `项目 ${project} 缺少 intent.md。先 /${resolved.command} init ${project} 并填写意图。` };
		queueFollowup(invocation.agent, briefMessage(documents), "intent brief");
		return { kind: "success", text: `已把 ${project} 的意图模型排入下一轮：模型将按 intent.md 写作/修订 manuscript.md。` };
	}
	if (command.kind === "readtest") {
		if (documents.manuscriptText === null) return { kind: "error", text: `项目 ${project} 缺少 manuscript.md。` };
		const acceptance = bulletsOf(intent, "acceptance");
		if (acceptance.length === 0) return { kind: "error", text: `项目 ${project} 的 intent.md 缺少验收标准（## Acceptance 下的 [A#] 条目），读者测试无从出题。` };
		const semanticAcceptance = acceptance.filter((criterion) => criterion.assertions === null);
		const assertedAcceptance = acceptance.filter((criterion) => criterion.assertions !== null);
		if (semanticAcceptance.length === 0) {
			return { kind: "error", text: `项目 ${project} 的验收标准全部带确定性断言，audit 已机器验证，无需读者测试。要启用语义验证，请为其中至少一条移除断言。` };
		}
		queueFollowup(invocation.agent, readtestMessage(semanticAcceptance, assertedAcceptance, documents.manuscriptText), "reader test");
		return { kind: "success", text: `已把 ${project} 的读者测试排入下一轮：模型将用无上下文的 subagent 通读正文，并逐条验证 ${semanticAcceptance.length} 条语义验收标准（另有 ${assertedAcceptance.length} 条已由确定性断言机器验证）。` };
	}
	if (command.kind === "figtest") {
		if (report === null) return { kind: "error", text: `项目 ${project} 不存在。先 /${resolved.command} init ${project}。` };
		if (report.figures.length === 0) return { kind: "error", text: `项目 ${project} 的 intent.md 没有 ## Figures 小节，无图表意图可测。` };
		const quiz = report.figures.filter((figure) => figure.reference !== null && figure.status !== "unmatched");
		if (quiz.length === 0) return { kind: "error", text: `项目 ${project} 的图表均未在正文引用，无可测图片。先 /${resolved.command} figures ${project} 生成。` };
		queueFollowup(invocation.agent, figtestMessage(project, quiz.map((figure) => ({ id: figure.id, path: figure.reference.path, text: figure.text }))), "visual reader test");
		return { kind: "success", text: `已把 ${project} 的视觉读者测试排入下一轮：模型将用无上下文 subagent 读图，逐条验证 ${quiz.length} 张图是否表达了 [F#] 意图，并引用视觉证据。` };
	}
	if (command.kind === "figures") {
		if (report === null) return { kind: "error", text: `项目 ${project} 不存在。先 /${resolved.command} init ${project}。` };
		const hasFigureIntent = report.figures.length > 0;
		const hasImages = report.images.length > 0;
		if (!hasFigureIntent && !hasImages) {
			return { kind: "error", text: `项目 ${project} 既无 ## Figures 意图小节也无正文图片引用。先在 intent.md 声明 [F#]（如 - [F1] 架构示意 | assets/flow.svg）再执行。` };
		}
		queueFollowup(invocation.agent, figuresMessage(project, report, documents), "figure generation");
		return { kind: "success", text: `已把 ${project} 的图表补全排入下一轮：模型将生成/修复图表并插入正文对应小节，完成后自动复验。` };
	}
	if (command.kind === "doctest") {
		if (documents.manuscriptText === null) return { kind: "error", text: `项目 ${project} 缺少 manuscript.md。` };
		const blocks = extractCodeBlocks(documents.manuscriptText);
		if (blocks.length === 0) return { kind: "error", text: `项目 ${project} 的正文没有代码块，无可执行示例（doctest 适用于含代码示例的正文）。` };
		queueFollowup(invocation.agent, doctestMessage(project, blocks, documents.targets.manuscript.displayPath), "doctest");
		return { kind: "success", text: `已把 ${project} 的示例执行排入下一轮：模型将在沙箱内执行 ${blocks.length} 个代码块并逐块报告 pass/fail 与归因。` };
	}
	if (command.kind === "sync") {
		if (documents.manuscriptText === null) return { kind: "error", text: `项目 ${project} 缺少 manuscript.md。` };
		queueFollowup(invocation.agent, syncMessage(documents.manuscriptText), "reverse outline sync");
		return { kind: "success", text: `已把 ${project} 的正文排入下一轮：模型将做反向提纲并回写 intent.md。` };
	}
	return { kind: "error", text: usageLine(resolved.command) };
}

//#endregion

/** Prompt section teaching the method, placed beside tool guidance. */
function promptSectionText(resolved) {
	return [
		"Intent-driven writing: for articles, long-form docs, and books, keep two linked files per project — intent.md (the intent model: Why, Audience, Claims [C#], Structure [S#], Decisions [D#], Acceptance [A#], Log) and manuscript.md (the reader-facing text). The manuscript is a lossy expression of intent.md and cannot reconstruct it, so intent.md is the durable design rationale (the ADR of the document).",
		"Machine-verifiable intents: any bullet may end with deterministic assertions in braces — { contains: \"...\" }, { not-contains: \"...\" }, { regex: \"...\" }, { min-words: N }, { max-words: N }, { headings-include: \"...\" }, { code-lang: bash }, { facts-from: \"research.md\" } (every quantitative claim in the prose must trace to research.md — the anti-fabrication check). audit executes them with pass/fail (Vale/doctest-style) without an LLM; failed assertions are problems. Prefer assertions over prose criteria whenever the intent has a mechanical form; reserve the LLM reader test for semantics no checker can decide.",
		`Writing projects live under ${resolved.projectsDir}/. Before drafting or restructuring, read intent.md with writer_read_intent. After drafting or restructuring, run writer_check_alignment (reverse outline: claims coverage, structure mapping both ways, thin sections, deterministic assertions) and fix mismatches in the manuscript — or, when writing genuinely changed your understanding, update intent.md first and note it in Log; the pair evolves bidirectionally.`,
		`Optional persistent artifacts the same directory understands: CONVENTION.md (cross-document constraints, global under ${resolved.projectsDir}/ and per-project) and research.md (the evidence base for [C#] claims). /${resolved.command} brief injects both when present.`,
		`/${resolved.command} (status|init <name>|plan <name> [pitch]|brief <name>|audit <name>|figures <name>|figtest <name>|sync <name>|readtest <name>|doctest <name>) scaffolds projects, drafts intent.md from a one-line pitch (optionually interviewing the user), queues intent→manuscript briefs, audits alignment (figure coverage, broken links, image byte health, alt-text presence), queues figure generation and the visual reader test on [F#] figures, queues manuscript→intent reverse-outline syncs, runs an independent reader test on [A#] acceptance, and executes manuscript code examples through the sandboxed bash tool. The human maintains the intent; the machine drafts, writes, and checks.`,
	].join("\n");
}

/**
 * Register the prompt section, the writer tools, and the /write command.
 * @param ctx - plugin context carrying fs, workingDirectory, tools, commands, systemPrompt.
 * @param config - row config: projectsDir, command, enableTools, enablePrompt.
 */
export function apply(ctx, config) {
	const resolved = resolveConfig(config);
	if (resolved.enablePrompt) {
		ctx.systemPrompt.section({
			name: "tech-writer:intent-driven-writing",
			order: 3050,
			text: promptSectionText(resolved),
		});
	}
	if (resolved.enableTools) registerWriterTools(ctx, resolved);
	ctx.commands.register({
		name: resolved.command,
		description: "Intent-driven writing: plan/scaffold, brief, audit, figures, visual reader test, sync, reader test, and doctest for intent.md + manuscript.md projects",
		input: { hint: "[status|init <name>|plan <name> [pitch]|brief <name>|audit <name>|figures <name>|figtest <name>|sync <name>|readtest <name>|doctest <name>]" },
		handler: (invocation) => executeWriteCommand(ctx, resolved, invocation),
	});
}
