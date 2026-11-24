/**
 * Shared test fixtures: an in-memory ctx.fs mock matching the seam the plugin
 * uses (resolve/stat/readText/writeText/listDir), plus a context that captures
 * tool/command/section registrations and agent followups.
 *
 * Import from test files as: import { createHarness } from "./helpers.mjs";
 */
import assert from "node:assert/strict";
import path from "node:path";

export const INTENT_FILE = "intent.md";
export const MANUSCRIPT_FILE = "manuscript.md";

/** In-memory filesystem implementing the ctx.fs methods the plugin calls. */
export function createMemoryFs(seed = new Map()) {
	const files = new Map(seed); // absolute posix path -> content
	const normalize = (p) => path.posix.normalize(String(p).replace(/\/+/g, "/"));
	return {
		files,
		async resolve(raw, opts) {
			const base = opts?.cwd ?? "/ws";
			const joined = String(raw).startsWith("/") ? String(raw) : `${base}/${raw}`;
			return { targetKey: normalize(joined), displayPath: normalize(joined) };
		},
		async stat(target) {
			if (files.has(target.targetKey)) {
				const content = files.get(target.targetKey);
				return { version: `v${content.length}`, type: "file", size: content.length };
			}
			for (const key of files.keys()) {
				if (key.startsWith(`${target.targetKey}/`)) return { version: "d", type: "directory" };
			}
			return undefined;
		},
		async readText(target) {
			const content = files.get(target.targetKey);
			if (content === undefined) throw new Error(`missing: ${target.targetKey}`);
			return Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
		},
		async readBytes(target, signal, maxBytes) {
			const content = files.get(target.targetKey);
			if (content === undefined) throw new Error(`missing: ${target.targetKey}`);
			const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
			return buffer.subarray(0, maxBytes);
		},
		async writeText(target, content) {
			files.set(target.targetKey, String(content));
			return { operation: "create", version: `v${content.length}` };
		},
		async listDir(target) {
			const entries = new Map();
			for (const key of files.keys()) {
				if (!key.startsWith(`${target.targetKey}/`)) continue;
				const rest = key.slice(target.targetKey.length + 1);
				const [head, ...tail] = rest.split("/");
				const type = tail.length === 0 ? "file" : "directory";
				const existing = entries.get(head);
				// A name that is both a file and a directory parent wins as directory.
				entries.set(head, existing === "directory" ? "directory" : type);
			}
			return [...entries].map(([name, type]) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name));
		},
	};
}

/** Build one plugin test harness: mock ctx, registrations, and one agent. */

/** Mount the plugin on a mock context and return the registrations. */
export function mount(applyFn, config = {}, seed) {
	const fs = createMemoryFs(seed);
	const tools = new Map();
	const commands = new Map();
	const sections = [];
	const followups = [];
	const ctx = {
		fs,
		workingDirectory: { defaultDirectory: "/ws", get: () => "/ws" },
		tools: {
			register(definition) {
				tools.set(definition.name, definition);
				return () => tools.delete(definition.name);
			},
		},
		commands: {
			register(definition) {
				commands.set(definition.name, definition);
				return () => commands.delete(definition.name);
			},
		},
		systemPrompt: {
			section(section) {
				sections.push(section);
				return () => {};
			},
		},
	};
	applyFn(ctx, config);
	const agent = {
		session: { id: "s-test" },
		followup(message) {
			followups.push(message);
		},
	};
	const signal = new AbortController().signal;
	const invoke = (rawInput) => commands.get("write")?.handler({ rawInput, agent, signal, attachments: [] });
	const tool = (name, args, exec = { agent, signal }) => tools.get(name)?.execute(args, exec);
	return { ctx, fs, tools, commands, sections, followups, agent, signal, invoke, tool };
}

/** Seed one full aligned project and return the file map entries. */
export function seedAlignedProject(files, project = "demo") {
	const dir = project === "." ? "/ws/writing" : `/ws/writing/${project}`;
	files.set(`${dir}/intent.md`, `# Intent — ${project}

## Why
- 说明异构多集群调度为什么难

## Audience
- 平台架构师

## Claims
- [C1] Dispatcher 负责准入仲裁
- [C2] Volcano 支持组级调度

## Structure
- [S1] 背景：调度痛点
- [S2] 设计：组件职责

## Decisions
- [D1] 复用 Karmada 而非自研

## Acceptance
- [A1] 读者能复述组件分工

## Log
- 初稿
`);
	files.set(`${dir}/manuscript.md`, `# 多集群调度方案

## 背景：调度痛点
两个集群资源规格不同，统一调度长期靠人工排期，出错率高，发布周期被显著拉长，业务方抱怨不断。

## 设计：组件职责
Dispatcher 集中负责准入与资源仲裁，成员集群内的 Volcano 承接组级调度，二者配合完成联邦视图。
`);
	return files;
}

/** assert helper: rejects with a message containing a substring. */
export async function assertRejectsWith(promise, substring) {
	await assert.rejects(promise, (error) => {
		assert.ok(String(error?.message ?? error).includes(substring), `expected message to include "${substring}", got: ${error?.message}`);
		return true;
	});
}
