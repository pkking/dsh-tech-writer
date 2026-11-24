import { apply, name, inject } from "./index.js";
import assert from "node:assert/strict";
import path from "node:path";

// ---- in-memory fs mock matching the ctx.fs seam used by the plugin ----
const files = new Map(); // absolute path -> content
const signal = new AbortController().signal;
function normalize(p) {
	return path.posix.normalize(p.replace(/\/+/g, "/"));
}
const fs = {
	async resolve(raw, opts) {
		const base = opts?.cwd ?? "/ws";
		const joined = raw.startsWith("/") ? raw : `${base}/${raw}`;
		return { targetKey: normalize(joined), displayPath: normalize(joined) };
	},
	async stat(target) {
		const content = files.get(target.targetKey);
		if (content === undefined) {
			// directory detection: any file under it?
			for (const key of files.keys()) if (key.startsWith(`${target.targetKey}/`)) return { version: "d", type: "directory" };
			return undefined;
		}
		return { version: `v${content.length}`, type: "file", size: content.length };
	},
	async readText(target) {
		const content = files.get(target.targetKey);
		if (content === undefined) throw new Error("missing");
		return content;
	},
	async writeText(target, content) {
		files.set(target.targetKey, content);
		return { operation: "create", version: `v${content.length}` };
	},
	async listDir(target) {
		const names = new Set();
		for (const key of files.keys()) {
			if (!key.startsWith(`${target.targetKey}/`)) continue;
			const rest = key.slice(target.targetKey.length + 1);
			const [head, ...tail] = rest.split("/");
			names.add(tail.length === 0 ? { name: head, type: "file" } : { name: head, type: "directory" });
		}
		return [...names].sort((a, b) => a.name.localeCompare(b.name));
	},
};

// ---- service mocks capturing registrations ----
const registeredTools = new Map();
const registeredCommands = new Map();
const sections = [];
const followups = [];
const ctx = {
	fs,
	workingDirectory: {
		defaultDirectory: "/ws",
		get: () => "/ws",
	},
	tools: { register: (definition) => { registeredTools.set(definition.name, definition); return () => registeredTools.delete(definition.name); } },
	commands: { register: (definition) => { registeredCommands.set(definition.name, definition); return () => registeredCommands.delete(definition.name); } },
	systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
};

apply(ctx, { projectsDir: "writing", command: "write" });

assert.equal(name, "tech-writer");
assert.deepEqual(inject, ["fs", "workingDirectory", "tools", "commands", "systemPrompt"]);
assert.deepEqual([...registeredTools.keys()].sort(), ["writer_check_alignment", "writer_outline", "writer_read_intent"]);
assert.ok(registeredCommands.has("write"));
assert.equal(sections.length, 1);
assert.ok(sections[0].text.includes("Intent-driven writing"));

const agent = { session: { id: "s1" }, followup: (message) => followups.push(message) };
const invocation = (rawInput) => ({ rawInput, agent, signal, attachments: [] });

// /write status with no projects
let result = await registeredCommands.get("write").handler(invocation(""));
assert.equal(result.kind, "success");
assert.ok(result.text.includes("还没有写作项目"));

// /write init demo
result = await registeredCommands.get("write").handler(invocation("init demo"));
assert.equal(result.kind, "success");
assert.ok(files.has("/ws/writing/demo/intent.md"));
assert.ok(files.has("/ws/writing/demo/manuscript.md"));
const scaffold = files.get("/ws/writing/demo/intent.md");
assert.ok(scaffold.includes("## Claims"));
assert.ok(scaffold.includes("[C1]"));

// duplicate init
result = await registeredCommands.get("write").handler(invocation("init demo"));
assert.equal(result.kind, "error");

// fill intent + manuscript
files.set("/ws/writing/demo/intent.md", `# Intent — demo

## Why
- 说明双集群调度

## Audience
- 架构师

## Claims
- [C1] Dispatcher 负责准入仲裁
- [C2] Volcano 支持组级调度

## Structure
- [S1] 背景：调度痛点
- [S2] 设计：组件职责

## Decisions
- [D1] 复用 Karmada

## Acceptance
- [A1] 能复述组件分工

## Log
- 初稿
`);
files.set("/ws/writing/demo/manuscript.md", `# 双集群调度

## 背景：调度痛点
两个集群资源规格不同，统一调度长期靠人工，出错率高，发布周期被拉长。

## 设计：组件职责
Dispatcher 集中负责准入与资源仲裁。成员集群内 Volcano 承接组级调度。
`);

// /write status lists project
result = await registeredCommands.get("write").handler(invocation(""));
assert.ok(result.text.includes("demo"));

// /write audit
result = await registeredCommands.get("write").handler(invocation("audit demo"));
assert.equal(result.kind, "success");
assert.ok(result.text.includes("对齐检查"));
assert.ok(result.text.includes("C1"));

// tools: read intent
let value = await registeredTools.get("writer_read_intent").execute({ project: "demo" }, { agent, signal });
assert.equal(value.exists, true);
assert.equal(value.claims.length, 2);
assert.ok(value.summary.includes("claims: 2"));

// tools: list projects (project omitted)
value = await registeredTools.get("writer_read_intent").execute({}, { agent, signal });
assert.deepEqual(value.projects, ["demo"]);

// tools: reverse outline
value = await registeredTools.get("writer_outline").execute({ project: "demo" }, { agent, signal });
assert.equal(value.exists, true);
assert.ok(value.headings.length === 3);

// tools: alignment
value = await registeredTools.get("writer_check_alignment").execute({ project: "demo" }, { agent, signal });
assert.equal(value.exists, true);
assert.equal(typeof value.ok, "boolean");

// invalid project names rejected
await assert.rejects(() => registeredTools.get("writer_outline").execute({ project: "../etc" }, { agent, signal }));
await assert.rejects(() => registeredTools.get("writer_outline").execute({}, { agent, signal }));

// /write brief queues followup with intent
result = await registeredCommands.get("write").handler(invocation("brief demo"));
assert.equal(result.kind, "success");
assert.equal(followups.length, 1);
assert.equal(followups[0].role, "user");
assert.ok(followups[0].content[0].text.includes("Dispatcher"));
assert.ok(followups[0].content[0].text.includes("意图模型"));

// /write sync queues followup with manuscript
result = await registeredCommands.get("write").handler(invocation("sync demo"));
assert.equal(result.kind, "success");
assert.equal(followups.length, 2);
assert.ok(followups[1].content[0].text.includes("反向提纲"));

// unknown subcommand
result = await registeredCommands.get("write").handler(invocation("frobnicate"));
assert.equal(result.kind, "error");

// missing project audit
result = await registeredCommands.get("write").handler(invocation("audit nope"));
assert.equal(result.kind, "error");

// "." project (docs directly under writing/)
files.set("/ws/writing/intent.md", scaffold);
result = await registeredCommands.get("write").handler(invocation("audit ."));
assert.equal(result.kind, "success");

// output schema + render sanity
const tool = registeredTools.get("writer_read_intent");
assert.equal(typeof tool.output.render, "function");
const blocks = tool.output.render({}, { project: "x", summary: "y" });
assert.equal(blocks[0].type, "text");
assert.ok(JSON.parse(blocks[0].text).project === "x");

console.log("ALL MOCK INTEGRATION TESTS PASSED");
console.log(`tools: ${[...registeredTools.keys()].join(", ")}; command: /write; section: ${sections[0].name}`);
