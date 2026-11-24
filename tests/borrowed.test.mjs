/**
 * Borrowed-mechanism tests: the four practices adopted after comparing
 * Anthropic doc co-authoring / Spec Kit / Scrivener / STORM against the
 * plugin's goals (OpenSpec's multi-stage pipeline was deliberately not
 * adopted).
 *
 * Run: node --test tests/borrowed.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	parseWriteCommand,
	parseIntent,
	parseManuscript,
	checkAlignment,
} from "../index.js";
import { apply } from "../index.js";
import { mount, seedAlignedProject } from "./helpers.mjs";

// ────────────────────────────────────────────────────────────────────────────
// 1. Scrivener/Spec Kit 借鉴：反向结构漂移（意图外章节检测）
// ────────────────────────────────────────────────────────────────────────────

function fullIntent() {
	return parseIntent(`# I

## Why
- a

## Audience
- b

## Claims
- [C1] Dispatcher 负责准入仲裁

## Structure
- [S1] 背景：调度痛点

## Acceptance
- [A1] x
`);
}

test("反向漂移：正文冒出意图外章节 → warning", () => {
	const text = `# 题\n\n## 背景：调度痛点\n正文足够长，两句话以上，不判薄节，内容围绕调度痛点的背景展开。\n\n## 附录：安装指南\n这一节在意图的 Structure 里没有对应的 [S#] 条目，属于结构漂移。`;
	const report = checkAlignment(fullIntent(), parseManuscript(text), text);
	assert.ok(report.warnings.some((warning) => warning.includes("意图外章节") && warning.includes("附录：安装指南")), JSON.stringify(report.warnings));
	assert.equal(report.stats.unsanctionedSections, 1);
});

test("反向漂移：全部章节有 [S#] 对应 → 无该类 warning", () => {
	const text = `# 题\n\n## 背景：调度痛点\n正文足够长，两句话以上，不判薄节，内容围绕调度痛点的背景展开。`;
	const report = checkAlignment(fullIntent(), parseManuscript(text), text);
	assert.ok(report.warnings.every((warning) => !warning.includes("意图外章节")));
	assert.equal(report.stats.unsanctionedSections, 0);
});

test("反向漂移：文档主标题（H1）不算章节", () => {
	const text = `# 任意主标题\n\n## 背景：调度痛点\n正文足够长，两句话以上，不判薄节，内容围绕调度痛点的背景展开。`;
	const report = checkAlignment(fullIntent(), parseManuscript(text), text);
	assert.equal(report.stats.unsanctionedSections, 0);
});

test("反向漂移：意图无 Structure 小节时不误报（避免噪声）", () => {
	const intent = parseIntent(`# I\n\n## Why\n- a\n\n## Audience\n- b\n\n## Claims\n- [C1] x\n\n## Acceptance\n- [A1] y\n`);
	const text = `# 题\n\n## 任意章节\n正文若干，超过薄节门槛的长度，确保这条测试只考察反向漂移逻辑本身。\n`;
	const report = checkAlignment(intent, parseManuscript(text), text);
	assert.equal(report.stats.unsanctionedSections, 0);
});

test("反向漂移：warning 不影响 ok（问题仍由正向检查独占）", () => {
	const text = `# 题\n\n## 背景：调度痛点\n正文足够长。\n\n## 附录：额外\n额外一节，正文够长不判薄，只验证漂移不升级为 problem。\n`;
	const report = checkAlignment(fullIntent(), parseManuscript(text), text);
	assert.ok(report.problems.every((problem) => !problem.includes("意图外章节")));
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Spec Kit 借鉴：CONVENTION.md 注入 brief
// ────────────────────────────────────────────────────────────────────────────

function harnessWithFiles(extra) {
	const seeded = new Map();
	seedAlignedProject(seeded);
	for (const [key, value] of Object.entries(extra)) seeded.set(key, value);
	return mount(apply, {}, seeded);
}

test("brief：全局 CONVENTION.md 注入（写作约束优先声明）", async () => {
	const { invoke, followups } = harnessWithFiles({
		"/ws/writing/CONVENTION.md": "# 约束\n\n- 全部文档使用「调度器」而非「scheduler」\n- 术语首现给出英文\n",
	});
	const result = await invoke("brief demo");
	assert.equal(result.kind, "success");
	const text = followups[0].content[0].text;
	assert.ok(text.includes("写作约束"), "constraint header missing");
	assert.ok(text.includes("跨文档持久约束"), "priority declaration missing");
	assert.ok(text.includes("调度器"), "convention content missing");
	// 约束先于意图出现
	assert.ok(text.indexOf("写作约束") < text.indexOf("intent.md 内容"));
});

test("brief：项目级 CONVENTION.md 与全局同时注入并标注层级", async () => {
	const { invoke, followups } = harnessWithFiles({
		"/ws/writing/CONVENTION.md": "- 全局约束一",
		"/ws/writing/demo/CONVENTION.md": "- 项目约束一",
	});
	const result = await invoke("brief demo");
	assert.equal(result.kind, "success");
	const text = followups[0].content[0].text;
	assert.ok(text.includes("〔全局〕"));
	assert.ok(text.includes("全局约束一"));
	assert.ok(text.includes("〔项目〕"));
	assert.ok(text.includes("项目约束一"));
	assert.ok(text.indexOf("全局约束一") < text.indexOf("项目约束一"));
});

test("brief：无 CONVENTION.md 时消息不含约束段", async () => {
	const { invoke, followups } = harnessWithFiles({});
	await invoke("brief demo");
	const text = followups[0].content[0].text;
	assert.ok(!text.includes("写作约束"));
});

// ────────────────────────────────────────────────────────────────────────────
// 3. STORM 借鉴：research.md 作为证据基础注入 brief
// ────────────────────────────────────────────────────────────────────────────

test("brief：research.md 存在时作为证据基础注入", async () => {
	const { invoke, followups } = harnessWithFiles({
		"/ws/writing/demo/research.md": "# 研究\n\n## Karmada 论文数据\n- 联邦调度延迟降低 40%（来源：SIGCOMM'24）\n",
	});
	const result = await invoke("brief demo");
	assert.equal(result.kind, "success");
	const text = followups[0].content[0].text;
	assert.ok(text.includes("研究材料"), "research header missing");
	assert.ok(text.includes("证据基础"), "evidence framing missing");
	assert.ok(text.includes("SIGCOMM'24"), "research content missing");
	assert.ok(text.indexOf("intent.md 内容") < text.indexOf("研究材料"), "research should follow intent");
});

test("brief：无 research.md 时消息不含研究段", async () => {
	const { invoke, followups } = harnessWithFiles({});
	await invoke("brief demo");
	assert.ok(!followups[0].content[0].text.includes("研究材料"));
});

test("audit：research.md 缺失不影响审计（可选文件）", async () => {
	const { invoke } = harnessWithFiles({});
	const result = await invoke("audit demo");
	assert.equal(result.kind, "success");
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Anthropic 借鉴：/write readtest 独立读者测试
// ────────────────────────────────────────────────────────────────────────────

test("readtest：排队无上下文读者测试指令", async () => {
	const { invoke, followups } = harnessWithFiles({});
	const result = await invoke("readtest demo");
	assert.equal(result.kind, "success");
	assert.ok(result.text.includes("1 条语义验收标准"), result.text);
	assert.ok(result.text.includes("0 条已由确定性断言机器验证"), result.text);
	const text = followups[0].content[0].text;
	assert.ok(text.includes("独立读者测试"));
	assert.ok(text.includes("不继承本对话任何上下文"));
	assert.ok(text.includes("- A1 读者能复述组件分工"), "acceptance item missing");
	assert.ok(text.includes("manuscript.md 内容"));
	// 读者测试只含正文：不得泄露 intent 内容
	assert.ok(!text.includes("复用 Karmada 而非自研"), "intent Decisions leaked into reader test");
});

test("readtest：正文里出现的内容属于读者可见（不算泄露）", async () => {
	const { invoke, followups } = harnessWithFiles({});
	await invoke("readtest demo");
	const text = followups[0].content[0].text;
	// 正文本身含 Dispatcher/Volcano 词（这是正常的：读者就是读这份正文）
	assert.ok(text.includes("Dispatcher"));
});

test("readtest：缺 manuscript.md 报错", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	seeded.delete("/ws/writing/demo/manuscript.md");
	const { invoke, followups } = mount(apply, {}, seeded);
	const result = await invoke("readtest demo");
	assert.equal(result.kind, "error");
	assert.equal(followups.length, 0);
});

test("readtest：intent 缺 [A#] 时报「无从出题」", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	seeded.set("/ws/writing/demo/intent.md", seeded.get("/ws/writing/demo/intent.md").replace("## Acceptance\n- [A1] 读者能复述组件分工\n", ""));
	const { invoke } = mount(apply, {}, seeded);
	const result = await invoke("readtest demo");
	assert.equal(result.kind, "error");
	assert.ok(result.text.includes("无从出题"));
});

test("readtest：缺动词参数提示用法", async () => {
	const { invoke } = mount(apply);
	const result = await invoke("readtest");
	assert.equal(result.kind, "error");
	assert.ok(result.text.includes("用法"));
});

// ────────────────────────────────────────────────────────────────────────────
// 5. 语法与提示小节同步
// ────────────────────────────────────────────────────────────────────────────

test("parseWriteCommand：readtest 子命令解析", () => {
	assert.deepEqual(parseWriteCommand("readtest demo"), { kind: "readtest", project: "demo" });
	assert.deepEqual(parseWriteCommand("READTEST demo"), { kind: "readtest", project: "demo" });
	assert.deepEqual(parseWriteCommand("readtest"), { kind: "usage", verb: "readtest" });
});

test("命令描述与提示小节包含新能力", () => {
	const { commands, sections } = mount(apply);
	assert.ok(commands.get("write").input.hint.includes("readtest"));
	assert.ok(commands.get("write").description.includes("reader test"));
	assert.ok(sections[0].text.includes("readtest"));
	assert.ok(sections[0].text.includes("CONVENTION.md"));
	assert.ok(sections[0].text.includes("research.md"));
	assert.ok(sections[0].text.includes("independent reader test"));
});
