/**
 * Figure tests: 「一图胜千言」— images as first-class intent assets.
 * Forward drift (declared [F#] unreferenced), reverse drift (unsanctioned
 * images), broken links, alt-text presence, orphan assets, and the
 * /write figures generation orchestration.
 *
 * Run: node --test tests/figures.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseIntent, parseManuscript, checkAlignment, parseWriteCommand, renderReport } from "../index.js";
import { apply } from "../index.js";
import { mount, seedAlignedProject } from "./helpers.mjs";

function intentWithFigures(figureLines) {
	return parseIntent(`# I

## Why
- a

## Audience
- b

## Claims
- [C1] x

## Structure
- [S1] 背景：调度痛点

## Figures
${figureLines.join("\n")}

## Acceptance
- [A1] 读者能理解架构
`);
}

const MANUSCRIPT_WITH_FLOW = `# 文档

## 背景：调度痛点
围绕调度痛点展开的正文，词数超过薄节门槛，内容足够丰富。

![两级调度数据流](assets/flow.svg)
`;

// ────────────────────────────────────────────────────────────────────────────
// 解析
// ────────────────────────────────────────────────────────────────────────────

test("parseManuscript：提取图片引用（alt/path/行号），fence 内不提取", () => {
	const manuscript = parseManuscript("# T\n\n![架构图](assets/flow.svg)\n\n```md\n![fence 里的](assets/fake.png)\n```\n\n![第二张](img/a.png)\n");
	assert.equal(manuscript.images.length, 2);
	assert.deepEqual(manuscript.images[0], { alt: "架构图", path: "assets/flow.svg", line: 3 });
	assert.equal(manuscript.images[1].path, "img/a.png");
});

test("figuresOf：`描述 | 路径` 与无路径两种条目", () => {
	const intent = intentWithFigures(["- [F1] 两级调度数据流 | assets/flow.svg", "- [F2] 部署拓扑示意"]);
	const report = checkAlignment(intent, parseManuscript(MANUSCRIPT_WITH_FLOW), MANUSCRIPT_WITH_FLOW, { imageFiles: ["assets/flow.svg"] });
	assert.equal(report.figures.length, 2);
	assert.equal(report.figures[0].path, "assets/flow.svg");
	assert.equal(report.figures[1].path, null);
});

// ────────────────────────────────────────────────────────────────────────────
// 正向：[F#] 未引用
// ────────────────────────────────────────────────────────────────────────────

test("正向漂移：声明的 F 无引用 → problem", () => {
	const intent = intentWithFigures(["- [F1] 两级调度数据流 | assets/flow.svg"]);
	const manuscript = "## 背景：调度痛点\n正文足够长，没有图片，用来验证图表意图未满足的判定逻辑。";
	const report = checkAlignment(intent, parseManuscript(manuscript), manuscript, {});
	assert.equal(report.figures[0].status, "unmatched");
	assert.ok(report.problems.some((problem) => problem.includes("图表 F1 未在正文中引用")), JSON.stringify(report.problems));
});

test("路径精确匹配 → matched", () => {
	const intent = intentWithFigures(["- [F1] 两级调度数据流 | assets/flow.svg"]);
	const report = checkAlignment(intent, parseManuscript(MANUSCRIPT_WITH_FLOW), MANUSCRIPT_WITH_FLOW, { imageFiles: ["assets/flow.svg"] });
	assert.equal(report.figures[0].status, "matched");
	assert.equal(report.figures[0].reference.path, "assets/flow.svg");
});

test("无路径 F 用描述↔alt 关键词匹配", () => {
	const intent = intentWithFigures(["- [F1] 两级调度数据流"]);
	const report = checkAlignment(intent, parseManuscript(MANUSCRIPT_WITH_FLOW), MANUSCRIPT_WITH_FLOW, { imageFiles: ["assets/flow.svg"] });
	assert.equal(report.figures[0].status, "matched");
});

test("alt 与描述无关 → unmatched（弱关键词不足）", () => {
	const intent = intentWithFigures(["- [F1] 部署拓扑"]);
	const report = checkAlignment(intent, parseManuscript(MANUSCRIPT_WITH_FLOW), MANUSCRIPT_WITH_FLOW, { imageFiles: ["assets/flow.svg"] });
	assert.equal(report.figures[0].status, "unmatched");
});

// ────────────────────────────────────────────────────────────────────────────
// 反向：意图外图片（门控于 Figures 小节存在）
// ────────────────────────────────────────────────────────────────────────────

test("反向漂移：有 Figures 声明时，无对应 F 的图片 → warning", () => {
	const manuscript = `# T\n\n## 背景：调度痛点\n正文足够长，配两张图，其中一张有 F 对应。\n\n![两级调度数据流](assets/flow.svg)\n\n![随手截图](assets/random.png)\n`;
	const intent = intentWithFigures(["- [F1] 两级调度数据流 | assets/flow.svg"]);
	const report = checkAlignment(intent, parseManuscript(manuscript), manuscript, { imageFiles: ["assets/flow.svg", "assets/random.png"] });
	assert.ok(report.warnings.some((warning) => warning.includes("意图外图片") && warning.includes("random.png")), JSON.stringify(report.warnings));
});

test("反向漂移：无 Figures 小节时不检查意图外图片", () => {
	const manuscript = "# T\n\n## 背景：调度痛点\n正文若干，长度达标。\n\n![随意一图](assets/x.png)\n";
	const intent = parseIntent(`# I\n\n## Why\n- a\n\n## Audience\n- b\n\n## Claims\n- [C1] x\n\n## Structure\n- [S1] 背景：调度痛点\n\n## Acceptance\n- [A1] y\n`);
	const report = checkAlignment(intent, parseManuscript(manuscript), manuscript, { imageFiles: ["assets/x.png"] });
	assert.ok(report.warnings.every((warning) => !warning.includes("意图外图片")));
});

// ────────────────────────────────────────────────────────────────────────────
// 断链、空 alt、非法路径、孤儿
// ────────────────────────────────────────────────────────────────────────────

test("断链：引用的图片文件不存在 → problem", () => {
	const manuscript = "# T\n\n## 背景：调度痛点\n正文足够长，配一张不存在的图。\n\n![架构](assets/ghost.svg)\n";
	const intent = parseIntent(`# I\n\n## Why\n- a\n\n## Audience\n- b\n\n## Claims\n- [C1] x\n\n## Structure\n- [S1] 背景：调度痛点\n\n## Acceptance\n- [A1] y\n`);
	const report = checkAlignment(intent, parseManuscript(manuscript), manuscript, { imageFiles: [] });
	assert.ok(report.problems.some((problem) => problem.includes("图片断链") && problem.includes("ghost.svg")), JSON.stringify(report.problems));
});

test("存在性检查仅在提供 imageFiles 时执行（纯文本模式不误报）", () => {
	const manuscript = "# T\n\n## 背景：调度痛点\n正文足够长。\n\n![架构](assets/a.svg)\n";
	const intent = parseIntent(`# I\n\n## Why\n- a\n\n## Audience\n- b\n\n## Claims\n- [C1] x\n\n## Structure\n- [S1] 背景：调度痛点\n\n## Acceptance\n- [A1] y\n`);
	const report = checkAlignment(intent, parseManuscript(manuscript), manuscript, {});
	assert.ok(report.problems.every((problem) => !problem.includes("断链")));
});

test("空替代文本 → warning", () => {
	const manuscript = "# T\n\n## 背景：调度痛点\n正文足够长。\n\n![](assets/a.svg)\n";
	const intent = parseIntent(`# I\n\n## Why\n- a\n\n## Audience\n- b\n\n## Claims\n- [C1] x\n\n## Structure\n- [S1] 背景：调度痛点\n\n## Acceptance\n- [A1] y\n`);
	const report = checkAlignment(intent, parseManuscript(manuscript), manuscript, { imageFiles: ["assets/a.svg"] });
	assert.ok(report.warnings.some((warning) => warning.includes("缺少替代文本")), JSON.stringify(report.warnings));
});

test("非法路径（绝对路径/../URL 协议）→ warning 且不做存在性判定", () => {
	const manuscript = "# T\n\n## 背景：调度痛点\n正文足够长。\n\n![a](/etc/passwd)\n\n![b](../outside.png)\n\n![c](https://cdn.example.com/x.png)\n";
	const intent = parseIntent(`# I\n\n## Why\n- a\n\n## Audience\n- b\n\n## Claims\n- [C1] x\n\n## Structure\n- [S1] 背景：调度痛点\n\n## Acceptance\n- [A1] y\n`);
	const report = checkAlignment(intent, parseManuscript(manuscript), manuscript, { imageFiles: [] });
	const pathWarnings = report.warnings.filter((warning) => warning.includes("路径不合法"));
	assert.equal(pathWarnings.length, 3);
	assert.ok(report.problems.every((problem) => !problem.includes("断链")));
});

test("孤儿资产：assets/ 中未被引用的图片 → warning（fs 层提供）", () => {
	const manuscript = "# T\n\n## 背景：调度痛点\n正文足够长。\n\n![架构](assets/used.svg)\n";
	const intent = parseIntent(`# I\n\n## Why\n- a\n\n## Audience\n- b\n\n## Claims\n- [C1] x\n\n## Structure\n- [S1] 背景：调度痛点\n\n## Acceptance\n- [A1] y\n`);
	const report = checkAlignment(intent, parseManuscript(manuscript), manuscript, { imageFiles: ["assets/used.svg"], orphanAssets: ["unused-2024.png"] });
	assert.ok(report.warnings.some((warning) => warning.includes("未被正文引用") && warning.includes("unused-2024.png")), JSON.stringify(report.warnings));
});

// ────────────────────────────────────────────────────────────────────────────
// 报告与 stats
// ────────────────────────────────────────────────────────────────────────────

test("renderReport：图表覆盖节渲染 ✓/✗", () => {
	const intent = intentWithFigures(["- [F1] 两级调度数据流 | assets/flow.svg"]);
	const report = checkAlignment(intent, parseManuscript(MANUSCRIPT_WITH_FLOW), MANUSCRIPT_WITH_FLOW, { imageFiles: ["assets/flow.svg"] });
	const text = renderReport(report);
	assert.ok(text.includes("图表覆盖"));
	assert.ok(text.includes("✓ F1 → assets/flow.svg"), text);
});

// ────────────────────────────────────────────────────────────────────────────
// /write figures 命令
// ────────────────────────────────────────────────────────────────────────────

function harnessWithFigures(figureLines, manuscript, extraFiles = {}) {
	const seeded = new Map();
	seedAlignedProject(seeded);
	const intent = seeded.get("/ws/writing/demo/intent.md");
	seeded.set("/ws/writing/demo/intent.md", intent.replace("## Log", `## Figures\n${figureLines.join("\n")}\n\n## Log`));
	seeded.set("/ws/writing/demo/manuscript.md", manuscript);
	for (const [key, value] of Object.entries(extraFiles)) seeded.set(key, value);
	return mount(apply, {}, seeded);
}

test("figures 命令：排队生成指令，含 F 待办、插入要求与 alt 规则", async () => {
	const { invoke, followups } = harnessWithFigures(
		["- [F1] 两级调度数据流 | assets/flow.svg"],
		"# 多集群调度\n\n## 背景：调度痛点\n两个集群资源规格不同，统一调度长期靠人工排期，出错率高，发布周期被显著拉长。\n\n## 设计：组件职责\nDispatcher 集中负责准入仲裁，Volcano 承接组级调度，两级配合完成联邦视图。\n",
	);
	const result = await invoke("figures demo");
	assert.equal(result.kind, "success");
	const text = followups[0].content[0].text;
	assert.ok(text.includes("一图胜千言"), text.slice(0, 200));
	assert.ok(text.includes("[F] F1：两级调度数据流"), "todo must list F1");
	assert.ok(text.includes("assets/"));
	assert.ok(text.includes("替代文本必须是有信息量的一句话"), "alt-text rule");
	assert.ok(text.includes("/write audit 复验"), "must re-audit");
	assert.ok(text.includes("archify、mermaid、matplotlib"), "must suggest tooling");
});

test("figures 命令：断链与空 alt 进入待办", async () => {
	const { invoke, followups } = harnessWithFigures(
		["- [F1] 架构图 | assets/flow.svg"],
		"# 多集群调度\n\n## 背景：调度痛点\n配一张断链图。\n\n![](assets/flow.svg)\n",
	);
	const result = await invoke("figures demo");
	assert.equal(result.kind, "success");
	const text = followups[0].content[0].text;
	assert.ok(text.includes("[修]"), text.slice(0, 400));
});

test("figures 命令：无意图无图片报错并教写法", async () => {
	const { invoke } = mount(apply, {}, (() => {
		const seeded = new Map();
		seedAlignedProject(seeded);
		return seeded;
	})());
	const result = await invoke("figures demo");
	assert.equal(result.kind, "error");
	assert.ok(result.text.includes("## Figures"), result.text);
	assert.ok(result.text.includes("[F1]"), result.text);
});

test("figures 命令：audit 全通过时提示无遗漏", async () => {
	const { invoke, followups } = harnessWithFigures(
		["- [F1] 架构图 | assets/flow.svg"],
		"# 多集群调度\n\n## 背景：调度痛点\n![架构图](assets/flow.svg)\n两个集群资源规格不同，统一调度长期靠人工排期。\n",
		{ "/ws/writing/demo/assets/flow.svg": "<svg/>" },
	);
	const result = await invoke("figures demo");
	assert.equal(result.kind, "success");
	const text = followups[0].content[0].text;
	assert.ok(text.includes("全部通过"), text.slice(-200));
});

test("audit 命令链：真实 stat 断链检测与 assets 孤儿检测", async () => {
	const { invoke } = harnessWithFigures(
		["- [F1] 架构图 | assets/flow.svg"],
		"# 多集群调度\n\n## 背景：调度痛点\n![架构图](assets/flow.svg)\n![断链](assets/ghost.svg)\n两个集群资源规格不同，统一调度靠人工排期，出错率高周期长。\n",
		{ "/ws/writing/demo/assets/flow.svg": "<svg/>", "/ws/writing/demo/assets/orphan.png": "PNG" },
	);
	const audit = await invoke("audit demo");
	assert.ok(audit.text.includes("图表覆盖"), audit.text.slice(0, 200));
	assert.ok(audit.text.includes("✓ F1 → assets/flow.svg"), audit.text);
	assert.ok(audit.text.includes("图片断链") && audit.text.includes("ghost.svg"), audit.text.slice(0, 500));
	assert.ok(audit.text.includes("未被正文引用") && audit.text.includes("orphan.png"), audit.text.slice(0, 600));
	assert.ok(audit.text.includes("意图外图片") && audit.text.includes("ghost.svg"), audit.text.slice(0, 600));
});

test("parseWriteCommand：figures 解析", () => {
	assert.deepEqual(parseWriteCommand("figures demo"), { kind: "figures", project: "demo" });
	assert.deepEqual(parseWriteCommand("figures"), { kind: "usage", verb: "figures" });
});
