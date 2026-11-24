/**
 * End-to-end tests: the plugin mounted through a REAL Cordis runtime with the
 * REAL first-party services — dsh-fs-local (real atomic disk writes),
 * dsh-commands (real registry + parse/dispatch + lifecycle events),
 * dsh-system-prompt (real assembly), dsh-tools (real execution pipeline) —
 * over a real temp directory. No in-memory mocks for the service seams.
 *
 * The only harness-owned seams kept as test doubles, by necessity:
 *   - workingDirectory: a real Cordis Service instance, but a trivial
 *     implementation (the real one requires the session-projection stack).
 *   - agent/session/followup: narrow doubles matching the documented Agent
 *     seams the command registry touches (`view(agent)`, `session.append`,
 *     `agent.followup`); the agent loop itself is external to this plugin.
 *
 * Run: node --test tests/e2e.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolsService from "@deepseek-ai/dsh-tools";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import { apply as executorApply, name as executorName, inject as executorInject } from "@deepseek-ai/dsh-tool-executor-native";
import * as plugin from "../index.js";

/** The exact row config shipped in cordis.patch.yml. */
const ROW_CONFIG = { projectsDir: "writing", command: "write", enableTools: true, enablePrompt: true };

let ctx;
let dir;
let sessionLog;
let followups;
let agent;
let signal;

before(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "tech-writer-e2e-"));
	ctx = new Context();
	ctx.plugin(LocalFileSystem, { cwd: dir, diffBasisMaxBytes: 65536 });
	ctx.plugin(SystemPrompt, {});
	ctx.plugin(ToolsService, {});
	ctx.plugin(CommandRuntime, {});
	// The real native tool executor: assembly and dispatch both require one.
	ctx.plugin({ name: executorName, inject: executorInject, apply: executorApply });
	// Minimal real Cordis service standing in for dsh-working-directory.
	class WorkingDirectory extends Service {
		defaultDirectory = dir;
		constructor(context) {
			super(context, "workingDirectory");
		}
		get() {
			return this.defaultDirectory;
		}
		async ensure() {
			return this.defaultDirectory;
		}
		async set() {
			return this.defaultDirectory;
		}
	}
	ctx.plugin(WorkingDirectory);
	// Mount the plugin exactly as the loader mounts the shipped row.
	ctx.plugin(plugin, ROW_CONFIG);
	sessionLog = [];
	followups = [];
	agent = {
		ctx,
		followup(message) {
			followups.push(message);
		},
		session: {
			append(type, data) {
				sessionLog.push({ type, data });
				return sessionLog.length;
			},
		},
	};
	signal = new AbortController().signal;
	await new Promise((resolve) => setTimeout(resolve, 50));
});

after(async () => {
	await ctx.dispose?.();
	await rm(dir, { recursive: true, force: true });
});

/** Run one command line through the REAL command registry. */
const runCommand = (line) => ctx.commands.execute(agent, line, [], signal);

/** Run one tool call through the REAL execution pipeline (no agent). */
async function runTool(name, args) {
	const batch = await ctx.tools.execute({
		calls: [{ type: "tool-call", id: `call-${name}`, name, arguments: JSON.stringify(args) }],
		signal,
	});
	const settled = batch.results[0]?.result;
	if (settled === undefined) throw new Error(`no settled result for ${name}: ${JSON.stringify(batch).slice(0, 300)}`);
	return settled;
}

/** First settled result of a batch as the tool's JSON value. */
async function runToolValue(name, args) {
	const settled = await runTool(name, args);
	if (settled.isError) throw new Error(`tool ${name} errored: ${JSON.stringify(settled.content)}`);
	return settled.value;
}

// ────────────────────────────────────────────────────────────────────────────
// 真实注册面
// ────────────────────────────────────────────────────────────────────────────

test("真实命令注册表：/write 描述符可见", async () => {
	const descriptors = ctx.commands.list(agent);
	const write = descriptors.find((descriptor) => descriptor.name === "write");
	assert.ok(write, `write command missing from: ${descriptors.map((d) => d.name).join(", ")}`);
	assert.ok(write.description.length > 10);
	assert.ok(write.input.hint.includes("sync"));
});

test("真实工具注册表：三个 writer 工具 schema 可见", async () => {
	const schemas = ctx.tools.schemas(agent);
	const names = schemas.map((schema) => schema.name);
	for (const expected of ["writer_read_intent", "writer_outline", "writer_check_alignment"]) {
		assert.ok(names.includes(expected), `${expected} missing from: ${names.join(", ")}`);
	}
	const outline = schemas.find((schema) => schema.name === "writer_outline");
	assert.equal(outline.parameters.required.includes("project"), true);
});

test("真实系统提示装配：方法小节进入最终 prompt", async () => {
	const assembly = await ctx.systemPrompt.assemble({});
	const text = JSON.stringify(assembly);
	assert.ok(text.includes("Intent-driven writing"), "section content missing from assembled prompt");
	assert.ok(text.includes("lossy expression"));
	assert.ok(text.includes("writing/"));
	assert.ok(text.includes("writer_check_alignment"));
});

// ────────────────────────────────────────────────────────────────────────────
// 真实磁盘：/write init → 原子写落地
// ────────────────────────────────────────────────────────────────────────────

test("/write init 通过真实命令执行链创建真实文件", async () => {
	const execution = await runCommand("/write init demo");
	assert.equal(execution.result.kind, "success");
	// 直接从真实磁盘读（不经 ctx.fs），证明原子写真的落地
	const intent = await readFile(path.join(dir, "writing/demo/intent.md"), "utf8");
	const manuscript = await readFile(path.join(dir, "writing/demo/manuscript.md"), "utf8");
	assert.ok(intent.includes("## Claims"));
	assert.ok(intent.includes("[C1]"));
	assert.ok(manuscript.length > 0);
});

test("命令生命周期事件真实落日志（command/run + command/done 成对）", async () => {
	await runCommand("/write status");
	const runs = sessionLog.filter((entry) => entry.type === "command/run");
	const dones = sessionLog.filter((entry) => entry.type === "command/done");
	assert.ok(runs.length >= 1);
	assert.equal(dones.length, runs.length);
	assert.equal(runs[0].data.name, "write");
	assert.equal(runs[0].data.source.kind, "user");
});

test("未知命令行返回 undefined（真实 registry 语义）", async () => {
	const result = await runCommand("/frobnicate");
	assert.equal(result, undefined);
});

// ────────────────────────────────────────────────────────────────────────────
// 真实磁盘：对抗性编码（BOM + CRLF）完整 audit 链
// ────────────────────────────────────────────────────────────────────────────

test("audit：BOM intent + CRLF manuscript 真实落盘后通过", async () => {
	const intent = `# Intent — demo

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
`;
	// UTF-8 BOM 前缀（Windows 编辑器常见）
	await writeFile(path.join(dir, "writing/demo/intent.md"), `\uFEFF${intent}`, "utf8");
	// CRLF 换行的正文
	const manuscript = "# 多集群调度\r\n\r\n## 背景：调度痛点\r\n两个集群资源规格不同，统一调度长期靠人工排期，出错率高，发布周期被显著拉长。\r\n\r\n## 设计：组件职责\r\nDispatcher 集中负责准入与资源仲裁，成员集群内的 Volcano 承接组级调度。\r\n";
	await writeFile(path.join(dir, "writing/demo/manuscript.md"), manuscript, "utf8");
	const execution = await runCommand("/write audit demo");
	assert.equal(execution.result.kind, "success");
	assert.ok(execution.result.text.includes("对齐检查：通过"), execution.result.text);
});

test("audit：正文丢失主张后真实报告问题", async () => {
	const manuscript = "# 多集群调度\r\n\r\n## 背景：调度痛点\r\n两个集群资源规格不同，统一调度长期靠人工排期。\r\n\r\n## 设计：组件职责\r\n本文提出一种联邦调度参考架构。\r\n";
	await writeFile(path.join(dir, "writing/demo/manuscript.md"), manuscript, "utf8");
	const execution = await runCommand("/write audit demo");
	assert.equal(execution.result.kind, "success");
	assert.ok(execution.result.text.includes("✗ C1"), execution.result.text.slice(0, 300));
});

test("status：真实列目录并显示项目", async () => {
	const execution = await runCommand("/write status");
	assert.ok(execution.result.text.includes("demo"));
});

// ────────────────────────────────────────────────────────────────────────────
// 真实工具执行管线（无 agent 的 standalone 调用）
// ────────────────────────────────────────────────────────────────────────────

test("writer_outline 经真实管线执行并返回结构化结果", async () => {
	const value = await runToolValue("writer_outline", { project: "demo" });
	assert.equal(value.exists, true);
	assert.ok(value.manuscriptPath.endsWith("writing/demo/manuscript.md"));
	assert.ok(value.headings.some((heading) => heading.text === "背景：调度痛点"));
	assert.ok(value.words > 0);
});

test("writer_read_intent 无 agent 调用回落默认工作目录并列项目", async () => {
	const value = await runToolValue("writer_read_intent", {});
	assert.ok(value.projects.includes("demo"));
});

test("writer_check_alignment 经真实管线返回对齐报告", async () => {
	const value = await runToolValue("writer_check_alignment", { project: "demo" });
	assert.equal(typeof value.ok, "boolean");
	assert.ok(Array.isArray(value.claims));
	assert.ok(value.stats.claims >= 1);
});

test("真实管线拒绝非法项目名（isError 结果）", async () => {
	const settled = await runTool("writer_outline", { project: "../etc" });
	assert.equal(settled.isError, true);
	assert.ok(settled.content.some((block) => block.text.includes("非法项目名")), JSON.stringify(settled.content).slice(0, 300));
});

test("真实管线拒绝缺参调用（isError 结果）", async () => {
	const settled = await runTool("writer_outline", {});
	assert.equal(settled.isError, true);
	assert.ok(settled.content.some((block) => block.text.includes("必填") || block.text.includes("INVALID")), JSON.stringify(settled.content).slice(0, 300));
});

test("真实管线执行确定性断言（fail 为 problem，pass 无需 LLM）", async () => {
	// intent 增加 A#：一条 pass 的 not-contains + 一条 fail 的 code-lang
	const intent = await readFile(path.join(dir, "writing/demo/intent.md"), "utf8");
	await writeFile(path.join(dir, "writing/demo/intent.md"), `${intent.replace("## Log", "## Acceptance\n- [A1] 术语约束 { not-contains: \"不存在的禁词\" }\n- [A2] 示例要求 { code-lang: bash }\n\n## Log")}`, "utf8");
	const value = await runToolValue("writer_check_alignment", { project: "demo" });
	assert.ok(Array.isArray(value.assertions));
	const statuses = value.assertions.map((assertion) => `${assertion.key}:${assertion.status}`);
	assert.ok(statuses.includes("not-contains:pass"), JSON.stringify(statuses));
	assert.ok(statuses.includes("code-lang:fail"), JSON.stringify(statuses));
	assert.ok(value.problems.some((problem) => problem.includes("确定性断言失败 A2")), JSON.stringify(value.problems));
	assert.ok(value.problems.every((problem) => !problem.includes("A1")), "passing assertion must not be a problem");
	// 恢复原始 intent，避免污染后续用例（e2e 共享同一磁盘状态）
	await writeFile(path.join(dir, "writing/demo/intent.md"), intent, "utf8");
});

// ────────────────────────────────────────────────────────────────────────────
// brief / sync 的完整链路（真实命令执行 + followup 注入 + 生命周期日志）
// ────────────────────────────────────────────────────────────────────────────

test("/write brief：followup 携带真实意图内容", async () => {
	const execution = await runCommand("/write brief demo");
	assert.equal(execution.result.kind, "success");
	assert.equal(followups.length, 1);
	const message = followups[0];
	assert.equal(message.role, "user");
	assert.ok(message.content[0].text.includes("Dispatcher 负责准入仲裁"));
	assert.ok(message.content[0].text.includes("[S1]"));
});

test("/write sync：followup 携带反向提纲指令与真实正文", async () => {
	// 自带 fixture，避免依赖前序测试留下的正文
	const manuscript = "# 独立样本\r\n\r\n## 背景：调度痛点\r\n两个集群资源规格不同，统一调度长期靠人工排期，出错率高。\r\n\r\n## 设计：组件职责\r\nDispatcher 集中负责准入与资源仲裁，成员集群内的 Volcano 承接组级调度。\r\n";
	await writeFile(path.join(dir, "writing/demo/manuscript.md"), manuscript, "utf8");
	const execution = await runCommand("/write sync demo");
	assert.equal(execution.result.kind, "success");
	assert.equal(followups.length, 2);
	const text = followups[1].content[0].text;
	assert.ok(text.includes("反向提纲"));
	assert.ok(text.includes("Dispatcher"));
	assert.ok(text.includes("独立样本"));
});

test("每个命令的 run/done 事件按 commandId 精确配对", async () => {
	const byId = new Map();
	for (const entry of sessionLog) {
		const id = entry.data.commandId;
		if (!byId.has(id)) byId.set(id, []);
		byId.get(id).push(entry.type);
	}
	for (const [id, types] of byId) {
		assert.deepEqual(types.sort(), ["command/done", "command/run"], `unpaired events for ${id}`);
	}
	assert.ok(byId.size >= 4, `expected at least 4 command executions, got ${byId.size}`);
});

// ────────────────────────────────────────────────────────────────────────────
// 完整写作闭环：init → 填意图 → audit 修问题 → 达标
// ────────────────────────────────────────────────────────────────────────────

test("闭环：audit 发现问题 → 修正文 → audit 通过", async () => {
	const broken = "# 多集群调度\r\n\r\n## 背景与设计\r\n内容不足。\r\n";
	await writeFile(path.join(dir, "writing/demo/manuscript.md"), broken, "utf8");
	const first = await runCommand("/write audit demo");
	assert.ok(first.result.text.includes("对齐检查：发现"), first.result.text.slice(0, 200));

	const fixed = "# 多集群调度\r\n\r\n## 背景：调度痛点\r\n两个集群资源规格不同，统一调度长期靠人工排期，出错率高，发布周期被显著拉长。\r\n\r\n## 设计：组件职责\r\nDispatcher 集中负责准入与资源仲裁，成员集群内的 Volcano 承接组级调度。\r\n";
	await writeFile(path.join(dir, "writing/demo/manuscript.md"), fixed, "utf8");
	const second = await runCommand("/write audit demo");
	assert.ok(second.result.text.includes("对齐检查：通过"), second.result.text.slice(0, 300));
});
