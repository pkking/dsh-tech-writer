/**
 * Deterministic-assertion tests: the machine-verifiable layer that keeps
 * LLM judgment out of every intent dimension a checker can decide.
 *
 * Run: node --test tests/assertions.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	parseIntent,
	parseManuscript,
	checkAlignment,
	renderReport,
} from "../index.js";
import { apply } from "../index.js";
import { mount, seedAlignedProject } from "./helpers.mjs";

/** Intent fixture with asserted bullets in several sections. */
function assertedIntent(acceptanceLines) {
	return parseIntent(`# I

## Why
- a

## Audience
- b

## Claims
- [C1] Dispatcher 负责准入仲裁

## Structure
- [S1] 背景：调度痛点

## Decisions
- [D1] 取舍说明

## Acceptance
${acceptanceLines.join("\n")}
`);
}

const MANUSCRIPT = `# 文档

## 背景：调度痛点
围绕调度痛点展开的正文，词数超过薄节门槛，内容足够丰富。

## 设计说明
这里出现「调度器」一词，全文术语保持中文表述。
`;

const MANUSCRIPT_TEXT = MANUSCRIPT;

// ────────────────────────────────────────────────────────────────────────────
// 断言解析（parseBullets 尾注提取）
// ────────────────────────────────────────────────────────────────────────────

test("解析：行尾断言块被提取，文本剥离干净", () => {
	const intent = assertedIntent(["- [A1] 术语统一 { not-contains: \"scheduler\" }"]);
	const bullet = intent.sections.find((s) => s.title === "Acceptance").bullets[0];
	assert.equal(bullet.id, "A1");
	assert.equal(bullet.text, "术语统一");
	assert.deepEqual(bullet.assertions, { "not-contains": "scheduler" });
});

test("解析：多断言逗号分隔", () => {
	const intent = assertedIntent(["- [A1] x { contains: \"调度器\", max-words: 500 }"]);
	const bullet = intent.sections.find((s) => s.title === "Acceptance").bullets[0];
	assert.deepEqual(bullet.assertions, { contains: "调度器", "max-words": 500 });
});

test("解析：数值与字符串断言值类型", () => {
	const intent = assertedIntent(["- [A1] x { min-words: 100, contains: \"y\" }"]);
	const assertions = intent.sections.find((s) => s.title === "Acceptance").bullets[0].assertions;
	assert.equal(assertions["min-words"], 100);
	assert.equal(assertions.contains, "y");
});

test("解析：无断言条目为 null（向后兼容）", () => {
	const intent = assertedIntent(["- [A1] 纯文本条目"]);
	assert.equal(intent.sections.find((s) => s.title === "Acceptance").bullets[0].assertions, null);
});

test("解析：正文里的普通花括号不误判为断言", () => {
	const intent = assertedIntent(["- [A1] 使用 JSON 配置 {a: 1} 的示例"]);
	const bullet = intent.sections.find((s) => s.title === "Acceptance").bullets[0];
	assert.equal(bullet.assertions, null);
	assert.ok(bullet.text.includes("{a: 1}"), "ordinary braces must stay in text");
});

test("解析：断言可出现在任何小节（Decisions 亦然）", () => {
	const intent = parseIntent(`# I\n\n## Decisions\n- [D1] 术语约束 { contains: "Karmada" }\n`);
	const bullet = intent.sections[0].bullets[0];
	assert.deepEqual(bullet.assertions, { contains: "Karmada" });
});

// ────────────────────────────────────────────────────────────────────────────
// 断言执行（各 key 的 pass/fail/invalid）
// ────────────────────────────────────────────────────────────────────────────

function runAssertions(acceptanceLine, manuscript = MANUSCRIPT, text = MANUSCRIPT_TEXT) {
	const intent = assertedIntent([acceptanceLine]);
	const report = checkAlignment(intent, parseManuscript(manuscript), text);
	return { report, assertions: report.assertions };
}

test("contains：命中 pass，未命中 fail", () => {
	assert.equal(runAssertions("- [A1] x { contains: \"调度器\" }").assertions[0].status, "pass");
	const failing = runAssertions("- [A1] x { contains: \"不存在的词组\" }");
	assert.equal(failing.assertions[0].status, "fail");
	assert.ok(failing.report.problems.some((problem) => problem.includes("确定性断言失败 A1")), "failed assertion must be a problem");
});

test("not-contains：缺席 pass，出现 fail", () => {
	assert.equal(runAssertions("- [A1] x { not-contains: \"scheduler\" }").assertions[0].status, "pass");
	assert.equal(runAssertions("- [A1] x { not-contains: \"调度器\" }").assertions[0].status, "fail");
});

test("regex：匹配 pass；非法正则 invalid（非 fail）", () => {
	assert.equal(runAssertions("- [A1] x { regex: \"术语保持\" }").assertions[0].status, "pass");
	assert.equal(runAssertions("- [A1] x { regex: \"Karmada\" }").assertions[0].status, "fail");
	const invalid = runAssertions("- [A1] x { regex: \"([unclosed\" }");
	assert.equal(invalid.assertions[0].status, "invalid");
	assert.ok(invalid.report.problems.every((problem) => !problem.includes("确定性断言失败")), "invalid must not be a problem");
	assert.ok(invalid.report.warnings.some((warning) => warning.includes("无法执行")), "invalid must warn");
});

test("min-words / max-words：按总词数判定", () => {
	assert.equal(runAssertions("- [A1] x { min-words: 10 }").assertions[0].status, "pass");
	assert.equal(runAssertions("- [A1] x { min-words: 10000 }").assertions[0].status, "fail");
	assert.equal(runAssertions("- [A1] x { max-words: 10000 }").assertions[0].status, "pass");
	assert.equal(runAssertions("- [A1] x { max-words: 10 }").assertions[0].status, "fail");
});

test("headings-include：标题文本包含判定", () => {
	assert.equal(runAssertions("- [A1] x { headings-include: \"设计\" }").assertions[0].status, "pass");
	assert.equal(runAssertions("- [A1] x { headings-include: \"附录\" }").assertions[0].status, "fail");
});

test("code-lang：按围栏 info string 判定", () => {
	const withBash = "# t\n\n```bash\nls\n```\n\n正文若干字。";
	assert.equal(runAssertions("- [A1] x { code-lang: bash }", withBash, withBash).assertions[0].status, "pass");
	assert.equal(runAssertions("- [A1] x { code-lang: python }", withBash, withBash).assertions[0].status, "fail");
	assert.equal(runAssertions("- [A1] x { code-lang: bash }").assertions[0].status, "fail");
});

test("未知断言 key：整条不执行 + 疑似断言 warning（防静默失效）", () => {
	const { assertions, report } = runAssertions("- [A1] x { contain: \"调度器\" }");
	assert.equal(assertions.length, 0, "unknown key must not execute");
	assert.ok(report.warnings.some((warning) => warning.includes("疑似断言") && warning.includes("contain")), JSON.stringify(report.warnings));
	assert.ok(report.warnings.some((warning) => warning.includes("not-contains")), "warning must list the whitelist");
});

test("stats.assertions 计数 pass/fail/invalid", () => {
	const { report } = runAssertions("- [A1] x { contains: \"调度器\", code-lang: \"python\" }");
	// contains → pass；code-lang python → fail
	assert.deepEqual(report.stats.assertions, { pass: 1, fail: 1, invalid: 0 });
});

// ────────────────────────────────────────────────────────────────────────────
// 报告渲染与命令集成
// ────────────────────────────────────────────────────────────────────────────

test("renderReport：确定性断言节按 pass/fail/invalid 渲染", () => {
	const { report } = runAssertions("- [A1] x { contains: \"调度器\", regex: \"([bad\" }");
	const text = renderReport(report);
	assert.ok(text.includes("确定性断言（机器可验，不经 LLM）"));
	assert.ok(text.includes("✓ A1 {contains: \"调度器\"}"), text);
	assert.ok(text.includes("△ A1 {regex: \"([bad\"}"), text);
});

function harnessWithAssertedAcceptance(acceptanceLines, manuscript = MANUSCRIPT) {
	const seeded = new Map();
	seedAlignedProject(seeded);
	const intent = seeded.get("/ws/writing/demo/intent.md");
	const replaced = intent.replace(/## Acceptance[\s\S]*?(?=## Log|$)/, `## Acceptance\n${acceptanceLines.join("\n")}\n\n`);
	seeded.set("/ws/writing/demo/intent.md", replaced);
	seeded.set("/ws/writing/demo/manuscript.md", manuscript);
	return mount(apply, {}, seeded);
}

test("audit 命令：断言结果进入报告与工具输出", async () => {
	const { invoke, tool } = harnessWithAssertedAcceptance(["- [A1] 术语 { not-contains: \"不存在词\" }"]);
	const audit = await invoke("audit demo");
	assert.ok(audit.text.includes("确定性断言"));
	assert.ok(audit.text.includes("✓ A1"));
	const value = await tool("writer_check_alignment", { project: "demo" });
	assert.ok(Array.isArray(value.assertions));
	assert.equal(value.assertions[0].status, "pass");
	assert.deepEqual(value.stats.assertions, { pass: 1, fail: 0, invalid: 0 });
});

// ────────────────────────────────────────────────────────────────────────────
// readtest 分流：机器已验的条目不出题
// ────────────────────────────────────────────────────────────────────────────

test("readtest 分流：带断言条目不出题，消息中说明已机器验证", async () => {
	const { invoke, followups } = harnessWithAssertedAcceptance([
		"- [A1] 语义标准：读者能复述分工",
		"- [A2] 术语 { not-contains: \"不存在词\" }",
	]);
	const result = await invoke("readtest demo");
	assert.equal(result.kind, "success");
	assert.ok(result.text.includes("1 条语义验收标准"), result.text);
	assert.ok(result.text.includes("1 条已由确定性断言机器验证"), result.text);
	const text = followups[0].content[0].text;
	assert.ok(text.includes("- A1 语义标准：读者能复述分工"));
	assert.ok(!text.includes("- A2 术语\n"), "asserted item must not be a quiz question");
	assert.ok(text.includes("以下条目带确定性断言"));
	assert.ok(text.includes("- A2 术语（断言已在 audit 执行）"));
});

test("readtest 分流：全部条目带断言时拒绝执行", async () => {
	const { invoke, followups } = harnessWithAssertedAcceptance(["- [A1] x { not-contains: \"不存在词\" }"]);
	const result = await invoke("readtest demo");
	assert.equal(result.kind, "error");
	assert.ok(result.text.includes("全部带确定性断言"), result.text);
	assert.equal(followups.length, 0);
});

test("出厂脚手架：init 后首次 audit 即演示断言层（A2 机器验证、A1 留给读者）", async () => {
	const { invoke, tool } = mount(apply);
	const init = await invoke("init fresh-demo");
	assert.equal(init.kind, "success");
	const audit = await invoke("audit fresh-demo");
	assert.ok(audit.text.includes("确定性断言（机器可验，不经 LLM）"), audit.text.slice(0, 200));
	assert.ok(audit.text.includes("✓ A2 {not-contains: \"TODO\"}"), audit.text.slice(0, 400));
	const readtest = await invoke("readtest fresh-demo");
	assert.equal(readtest.kind, "success");
	assert.ok(readtest.text.includes("1 条语义验收标准"), readtest.text);
	assert.ok(readtest.text.includes("1 条已由确定性断言机器验证"), readtest.text);
	// 脚手架断言行真实解析（文档即规格：模板教的语法必须能跑）
	const value = await tool("writer_check_alignment", { project: "fresh-demo" });
	assert.equal(value.assertions[0].key, "not-contains");
	assert.equal(value.assertions[0].status, "pass");
});
