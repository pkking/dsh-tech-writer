/**
 * Prose-quality tests: the output-side quality pyramid — faithfulness
 * (facts-from anti-fabrication), glossary enforcement (CONVENTION becomes
 * executable), sentence-level clarity (long sentences), and doctest
 * orchestration (code examples executed through the sandboxed bash tool).
 *
 * Run: node --test tests/quality.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	parseIntent,
	parseManuscript,
	checkAlignment,
	extractFacts,
	extractCodeBlocks,
	parseWriteCommand,
} from "../index.js";
import { apply } from "../index.js";
import { mount, seedAlignedProject } from "./helpers.mjs";

// ────────────────────────────────────────────────────────────────────────────
// 1. 忠实性：extractFacts + facts-from 断言
// ────────────────────────────────────────────────────────────────────────────

test("extractFacts：提取百分比/倍数/版本/年份/带单位量", () => {
	const facts = extractFacts("延迟降低 40%，吞吐 3.5x，需要 v1.21 以上，2024 年发布，占用 128MB，集群 3 个节点");
	for (const expected of ["40%", "3.5x", "v1.21", "2024年", "128MB"]) {
		assert.ok(facts.includes(expected), `${expected} missing from ${JSON.stringify(facts)}`);
	}
});

test("extractFacts：纯叙述数字不误提（无数化语义不进事实集）", () => {
	const facts = extractFacts("本章讨论三个层面的问题，首先看第一种情况。");
	assert.equal(facts.length, 0, JSON.stringify(facts));
});

test("extractFacts：去重与空输入", () => {
	assert.deepEqual(extractFacts(""), []);
	assert.deepEqual(extractFacts("提升 40%，再提升 40%"), ["40%"]);
});

function intentWithAssertion(acceptanceLine) {
	return parseIntent(`# I

## Why
- a

## Audience
- b

## Claims
- [C1] x

## Structure
- [S1] 背景：调度痛点

## Acceptance
${acceptanceLine}
`);
}

function reportFor(acceptanceLine, manuscript, evidenceText) {
	return checkAlignment(intentWithAssertion(acceptanceLine), parseManuscript(manuscript), manuscript, { evidenceText });
}

test("facts-from：全部量化声称可溯源 → pass", () => {
	const report = reportFor(
		"- [A1] 数据有出处 { facts-from: \"research.md\" }",
		"## 背景：调度痛点\n实验表明延迟降低 40%，这是 2024 年的结论，正文文字足够长不判薄节，这里再补一些内容凑长度。",
		"# 研究\n\n- 延迟降低 40%（SIGCOMM 2024 年）\n",
	);
	assert.equal(report.assertions[0].status, "pass", JSON.stringify(report.assertions));
	assert.ok(report.assertions[0].detail.includes("溯源"));
});

test("facts-from：编造数字 → fail 并列出未溯源项", () => {
	const report = reportFor(
		"- [A1] 数据有出处 { facts-from: \"research.md\" }",
		"## 背景：调度痛点\n实测延迟降低 99%，吞吐提升 12x，正文足够长不判薄节，这里补齐长度以避免薄节误报干扰。",
		"# 研究\n\n- 延迟降低 40%\n",
	);
	const assertion = report.assertions[0];
	assert.equal(assertion.status, "fail");
	assert.ok(assertion.detail.includes("99%"), assertion.detail);
	assert.ok(assertion.detail.includes("12x"), assertion.detail);
	assert.ok(report.problems.some((problem) => problem.includes("确定性断言失败 A1")));
});

test("facts-from：无量化声称 → 平凡 pass", () => {
	const report = reportFor(
		"- [A1] 数据有出处 { facts-from: \"research.md\" }",
		"## 背景：调度痛点\n这一段没有任何数字声称，只有定性描述，长度足够不判薄节，补充说明文字。",
		"# 研究\n- 定性结论若干\n",
	);
	assert.equal(report.assertions[0].status, "pass");
	assert.ok(report.assertions[0].detail.includes("无量化声称"));
});

test("facts-from：证据源缺失 → invalid（而非静默 pass）", () => {
	const report = checkAlignment(intentWithAssertion("- [A1] x { facts-from: \"research.md\" }"), parseManuscript("## 背景\n正文若干字，长度达标。"), "## 背景\n正文若干字，长度达标。", { evidenceText: null });
	assert.equal(report.assertions[0].status, "invalid");
	assert.ok(report.assertions[0].detail.includes("不存在"));
});

test("facts-from：fence 内的代码数字不参与溯源", () => {
	const manuscript = "## 背景：调度痛点\n正文定性描述若干，这里长度足够了。\n\n```bash\nsleep 99\n```\n";
	const report = reportFor("- [A1] x { facts-from: \"research.md\" }", manuscript, "# 研究\n- 无数字\n");
	assert.equal(report.assertions[0].status, "pass", JSON.stringify(report.assertions));
});

test("facts-from：不支持的其他证据源 → invalid", () => {
	const report = reportFor("- [A1] x { facts-from: \"web.md\" }", "## 背景\n正文若干字，长度达标。", "# 研究\n- x\n");
	assert.equal(report.assertions[0].status, "invalid");
	assert.ok(report.assertions[0].detail.includes("仅支持"));
});

// ────────────────────────────────────────────────────────────────────────────
// 2. 一致性：Glossary 执行（CONVENTION 从注入升级为强制）
// ────────────────────────────────────────────────────────────────────────────

const GLOSSARY = [{ canonical: "调度器", banned: ["scheduler", "Scheduler"] }];

test("glossary：正文出现禁用词 → problem 并指明规范词", () => {
	const manuscript = "## 背景：调度痛点\n正文的 scheduler 组件负责准入，本节文字足够长，补充说明以免薄节告警干扰本用例。";
	const report = checkAlignment(intentWithAssertion("- [A1] x"), parseManuscript(manuscript), manuscript, { glossary: GLOSSARY });
	assert.ok(report.problems.some((problem) => problem.includes("术语违规") && problem.includes("scheduler") && problem.includes("调度器")), JSON.stringify(report.problems));
});

test("glossary：统一使用规范词 → 无违规", () => {
	const manuscript = "## 背景：调度痛点\n正文的调度器组件负责准入，本节文字足够长，补充说明以免薄节告警干扰本用例。";
	const report = checkAlignment(intentWithAssertion("- [A1] x"), parseManuscript(manuscript), manuscript, { glossary: GLOSSARY });
	assert.ok(report.problems.every((problem) => !problem.includes("术语违规")));
});

test("glossary：代码块内的禁用词不违规（代码不是散文）", () => {
	const manuscript = "## 背景：调度痛点\n正文用调度器一词，长度足够不判薄。\n\n```bash\nkubectl get scheduler\n```\n";
	const report = checkAlignment(intentWithAssertion("- [A1] x"), parseManuscript(manuscript), manuscript, { glossary: GLOSSARY });
	assert.ok(report.problems.every((problem) => !problem.includes("术语违规")), JSON.stringify(report.problems));
});

test("glossary：经命令链从 CONVENTION.md 真实解析并执行", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	seeded.set("/ws/writing/CONVENTION.md", "# 约束\n\n## Glossary\n- 调度器 | scheduler, Scheduler\n");
	seeded.set("/ws/writing/demo/manuscript.md", "## 背景：调度痛点\n联邦 scheduler 负责准入仲裁，本节文字足够长，补充说明避免薄节干扰本用例判定。\n");
	const { invoke } = mount(apply, {}, seeded);
	const audit = await invoke("audit demo");
	assert.ok(audit.text.includes("术语违规"), audit.text.slice(0, 300));
	assert.ok(audit.text.includes("应统一为「调度器」"), audit.text.slice(0, 300));
});

test("glossary：无 Glossary 小节时零开销", () => {
	const manuscript = "## 背景：调度痛点\n正文若干字，长度达标即可。";
	const report = checkAlignment(intentWithAssertion("- [A1] x"), parseManuscript(manuscript), manuscript, { glossary: [] });
	assert.ok(report.problems.every((problem) => !problem.includes("术语违规")));
});

// ────────────────────────────────────────────────────────────────────────────
// 3. 清晰性：长句检测
// ────────────────────────────────────────────────────────────────────────────

test("长句：超过 100 字的单句告警并给摘录", () => {
	const long = "这是一句非常长的句子".repeat(12); // 120 字
	const manuscript = `## 背景：调度痛点\n${long}。\n`;
	const report = checkAlignment(intentWithAssertion("- [A1] x"), parseManuscript(manuscript), manuscript, {});
	assert.ok(report.warnings.some((warning) => warning.includes("长句") && warning.includes("120")), JSON.stringify(report.warnings));
});

test("长句：短句与 fence 内长行不触发", () => {
	const manuscript = "## 背景：调度痛点\n第一句。第二句。第三句都短。\n\n```bash\necho 这一行很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长\n```\n";
	const report = checkAlignment(intentWithAssertion("- [A1] x"), parseManuscript(manuscript), manuscript, {});
	assert.ok(report.warnings.every((warning) => !warning.includes("长句")), JSON.stringify(report.warnings));
});

// ────────────────────────────────────────────────────────────────────────────
// 4. 正确性：/write doctest 编排（执行走沙箱治理，插件不 spawn）
// ────────────────────────────────────────────────────────────────────────────

test("extractCodeBlocks：语言、行号、完整代码", () => {
	const blocks = extractCodeBlocks("# T\n\n```bash\nls\nwhoami\n```\n\n正文\n\n```python\nprint(1)\n```\n");
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].language, "bash");
	assert.equal(blocks[0].line, 3);
	assert.equal(blocks[0].code, "ls\nwhoami");
	assert.equal(blocks[1].language, "python");
});

test("doctest：排队执行指令，含块清单、沙箱要求与归因规则", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	seeded.set("/ws/writing/demo/manuscript.md", "# 多集群调度\n\n## 背景：调度痛点\n两个集群资源规格不同，统一调度长期靠人工排期，出错率高，发布周期被显著拉长。\n\n## 设计：组件职责\nDispatcher 集中负责准入与资源仲裁，成员集群内的 Volcano 调度器承接组级调度。\n\n```bash\nkubectl get deployments\n```\n");
	const { invoke, followups } = mount(apply, {}, seeded);
	const result = await invoke("doctest demo");
	assert.equal(result.kind, "success");
	assert.ok(result.text.includes("1 个代码块"), result.text);
	const text = followups[0].content[0].text;
	assert.ok(text.includes("doctest 式验证"));
	assert.ok(text.includes("bash 工具（沙箱与审批体系内）"), "must route through sandboxed bash");
	assert.ok(text.includes("mktemp -d"), "must require temp dir");
	assert.ok(text.includes("环境限制"), "must have environment-limit attribution lane");
	assert.ok(text.includes("kubectl get deployments"), "must embed the code block");
	assert.ok(text.includes("共 1 块"));
});

test("doctest：无代码块报错", async () => {
	const { invoke } = mount(apply, {}, (() => {
		const seeded = new Map();
		seedAlignedProject(seeded);
		return seeded;
	})());
	const result = await invoke("doctest demo");
	assert.equal(result.kind, "error");
	assert.ok(result.text.includes("没有代码块"), result.text);
});

test("doctest：缺 manuscript 报错", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	seeded.delete("/ws/writing/demo/manuscript.md");
	const { invoke } = mount(apply, {}, seeded);
	const result = await invoke("doctest demo");
	assert.equal(result.kind, "error");
});

test("parseWriteCommand：doctest 解析与缺参", () => {
	assert.deepEqual(parseWriteCommand("doctest demo"), { kind: "doctest", project: "demo" });
	assert.deepEqual(parseWriteCommand("doctest"), { kind: "usage", verb: "doctest" });
});

test("命令注册与提示小节含 doctest 与 facts-from", () => {
	const { commands, sections } = mount(apply);
	assert.ok(commands.get("write").input.hint.includes("doctest"));
	assert.ok(sections[0].text.includes("doctest"));
	assert.ok(sections[0].text.includes("facts-from"));
	assert.ok(sections[0].text.includes("anti-fabrication"));
});
