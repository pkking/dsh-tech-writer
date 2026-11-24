/**
 * Image-quality tests: technical validity (byte health: magic numbers, SVG
 * root, zero-byte) and the visual reader test orchestration (/write figtest).
 *
 * Run: node --test tests/figquality.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyImageBytes, parseIntent, parseManuscript, checkAlignment, parseWriteCommand } from "../index.js";
import { apply } from "../index.js";
import { mount, seedAlignedProject } from "./helpers.mjs";

// ────────────────────────────────────────────────────────────────────────────
// 1. classifyImageBytes：纯函数技术层
// ────────────────────────────────────────────────────────────────────────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF_MAGIC = Buffer.from("GIF89a");
const WEBP_MAGIC = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

test("classifyImageBytes：四种位图魔数判 ok", () => {
	assert.equal(classifyImageBytes(PNG_MAGIC, "a.png").status, "ok");
	assert.equal(classifyImageBytes(JPEG_MAGIC, "a.jpg").status, "ok");
	assert.equal(classifyImageBytes(GIF_MAGIC, "a.gif").status, "ok");
	assert.equal(classifyImageBytes(WEBP_MAGIC, "a.webp").status, "ok");
});

test("classifyImageBytes：SVG 判定（含 xml 声明/注释/DOCTYPE 前缀与坏 SVG）", () => {
	assert.equal(classifyImageBytes(Buffer.from("<svg/>"), "a.svg").status, "ok");
	assert.equal(classifyImageBytes(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="…">'), "a.svg").status, "ok");
	assert.equal(classifyImageBytes(Buffer.from("<!-- generated -->\n<svg>"), "a.svg").status, "ok");
	assert.equal(classifyImageBytes(Buffer.from("<html><body></body></html>"), "a.svg").status, "badsvg");
});

test("classifyImageBytes：空文件与损坏魔数", () => {
	assert.deepEqual(classifyImageBytes(new Uint8Array(), "a.png"), { status: "empty", detail: "文件为空（0 字节）" });
	assert.equal(classifyImageBytes(Buffer.from("not an image at all, just prose text"), "a.png").status, "badmagic");
});

// ────────────────────────────────────────────────────────────────────────────
// 2. checkAlignment 消费 imageHealth
// ────────────────────────────────────────────────────────────────────────────

const PLAIN_INTENT = `# I

## Why
- a

## Audience
- b

## Claims
- [C1] x

## Structure
- [S1] 背景：调度痛点

## Acceptance
- [A1] y
`;

function reportFor(manuscript, extras) {
	return checkAlignment(parseIntent(PLAIN_INTENT), parseManuscript(manuscript), manuscript, extras);
}

test("健康检查：badmagic/badsvg/empty 注入后各产生 problem", () => {
	const manuscript = "# T\n\n## 背景：调度痛点\n正文足够长。\n\n![a](assets/x.svg)\n\n![b](assets/y.svg)\n";
	const report = reportFor(manuscript, {
		imageFiles: ["assets/x.svg", "assets/y.svg"],
		imageHealth: {
			"assets/x.svg": { status: "badmagic", detail: "魔数不是 PNG/JPEG/GIF/WebP/SVG（可能不是图片或已损坏）" },
			"assets/y.svg": { status: "badsvg", detail: "SVG 文件缺少 <svg> 根元素" },
		},
	});
	assert.ok(report.problems.some((problem) => problem.includes("图片文件无效") && problem.includes("x.svg") && problem.includes("魔数")), JSON.stringify(report.problems));
	assert.ok(report.problems.some((problem) => problem.includes("y.svg") && problem.includes("<svg> 根元素")));
});

test("健康检查：ok 状态无 problem；未提供 health 时跳过（向后兼容）", () => {
	const manuscript = "# T\n\n## 背景：调度痛点\n正文足够长。\n\n![a](assets/x.svg)\n";
	const okReport = reportFor(manuscript, { imageFiles: ["assets/x.svg"], imageHealth: { "assets/x.svg": { status: "ok", detail: "SVG" } } });
	assert.ok(okReport.problems.every((problem) => !problem.includes("图片文件无效")));
	const noHealth = reportFor(manuscript, { imageFiles: ["assets/x.svg"] });
	assert.ok(noHealth.problems.every((problem) => !problem.includes("图片文件无效")));
});

// ────────────────────────────────────────────────────────────────────────────
// 3. 命令链：analyzeProject 真实 readBytes → health → audit
// ────────────────────────────────────────────────────────────────────────────

function harnessWithAssets(assets, manuscript) {
	const seeded = new Map();
	seedAlignedProject(seeded);
	const intent = seeded.get("/ws/writing/demo/intent.md");
	seeded.set("/ws/writing/demo/intent.md", intent.replace("## Log", `## Figures\n- [F1] 两级调度数据流 | assets/flow.svg\n\n## Log`));
	seeded.set("/ws/writing/demo/manuscript.md", manuscript);
	for (const [key, value] of Object.entries(assets)) seeded.set(key, value);
	return mount(apply, {}, seeded);
}

const FIG_MANUSCRIPT = "# 多集群调度\n\n## 背景：调度痛点\n![两级调度数据流](assets/flow.svg)\n两个集群资源规格不同，统一调度长期靠人工排期，出错率高。\n";

test("命令链：健康 SVG 通过，坏文件报「图片文件无效」", async () => {
	const { invoke } = harnessWithAssets(
		{ "/ws/writing/demo/assets/flow.svg": "<svg xmlns=\"…\"></svg>" },
		FIG_MANUSCRIPT,
	);
	const audit = await invoke("audit demo");
	assert.ok(audit.text.includes("✓ F1 → assets/flow.svg"), audit.text.slice(0, 300));
	assert.ok(!audit.text.includes("图片文件无效"), audit.text.slice(0, 300));

	const { invoke: invokeBad } = harnessWithAssets(
		{ "/ws/writing/demo/assets/flow.svg": "<html>假图</html>" },
		FIG_MANUSCRIPT,
	);
	const badAudit = await invokeBad("audit demo");
	assert.ok(badAudit.text.includes("图片文件无效") && badAudit.text.includes("<svg> 根元素"), badAudit.text.slice(0, 500));
});

test("命令链：PNG 魔数资产判健康", async () => {
	const { invoke } = harnessWithAssets(
		{ "/ws/writing/demo/assets/flow.svg": PNG_MAGIC },
		FIG_MANUSCRIPT,
	);
	const audit = await invoke("audit demo");
	assert.ok(!audit.text.includes("图片文件无效"), audit.text.slice(0, 400));
});

// ────────────────────────────────────────────────────────────────────────────
// 4. /write figtest：视觉读者测试编排
// ────────────────────────────────────────────────────────────────────────────

test("figtest：排队视觉测试，题目只含已引用图，禁脑补条款在场", async () => {
	const { invoke, followups } = harnessWithAssets(
		{ "/ws/writing/demo/assets/flow.svg": "<svg></svg>" },
		FIG_MANUSCRIPT,
	);
	const result = await invoke("figtest demo");
	assert.equal(result.kind, "success");
	assert.ok(result.text.includes("1 张图"), result.text);
	const text = followups[0].content[0].text;
	assert.ok(text.includes("视觉读者测试"), text.slice(0, 200));
	assert.ok(text.includes("read_image"), "must instruct the read_image tool");
	assert.ok(text.includes("不继承本对话任何上下文"));
	assert.ok(text.includes("禁止它凭描述脑补"), "anti-hallucination clause for visual evidence");
	assert.ok(text.includes("- F1 assets/flow.svg —— 两级调度数据流"), "quiz entry with path and intent");
	assert.ok(text.includes("视觉证据"), "evidence discipline");
});

test("figtest：无 Figures 小节报错", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	const { invoke } = mount(apply, {}, seeded);
	const result = await invoke("figtest demo");
	assert.equal(result.kind, "error");
	assert.ok(result.text.includes("## Figures"), result.text);
});

test("figtest：图表未引用无可测图报错并指向 figures", async () => {
	const { invoke } = harnessWithAssets(
		{},
		"# 多集群调度\n\n## 背景：调度痛点\n两个集群资源规格不同，统一调度长期靠人工排期，出错率高，没有配图。\n",
	);
	const result = await invoke("figtest demo");
	assert.equal(result.kind, "error");
	assert.ok(result.text.includes("未在正文引用") && result.text.includes("/write figures"), result.text);
});

test("parseWriteCommand：figtest 解析", () => {
	assert.deepEqual(parseWriteCommand("figtest demo"), { kind: "figtest", project: "demo" });
	assert.deepEqual(parseWriteCommand("figtest"), { kind: "usage", verb: "figtest" });
});

test("命令注册与提示小节含 figtest", () => {
	const { commands, sections } = mount(apply);
	assert.ok(commands.get("write").input.hint.includes("figtest"));
	assert.ok(commands.get("write").description.includes("visual reader test"));
	assert.ok(sections[0].text.includes("figtest"));
	assert.ok(sections[0].text.includes("image byte health"));
});