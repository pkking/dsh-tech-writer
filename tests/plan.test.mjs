/**
 * Plan-mode tests: /write plan drafts the intent from a one-line pitch, so the
 * human reviews intent instead of authoring it from scratch.
 *
 * Run: node --test tests/plan.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apply, parseWriteCommand } from "../index.js";
import { mount, seedAlignedProject } from "./helpers.mjs";

test("parseWriteCommand：plan 首词项目名，其余描述", () => {
	assert.deepEqual(parseWriteCommand("plan demo"), { kind: "plan", project: "demo", description: "" });
	assert.deepEqual(parseWriteCommand("plan demo 我要写一篇联邦调度说明，给平台工程师看"), {
		kind: "plan",
		project: "demo",
		description: "我要写一篇联邦调度说明，给平台工程师看",
	});
	assert.deepEqual(parseWriteCommand("PLAN demo x"), { kind: "plan", project: "demo", description: "x" });
});

test("parseWriteCommand：plan 缺参数提示用法", () => {
	assert.deepEqual(parseWriteCommand("plan"), { kind: "usage", verb: "plan" });
});

test("plan：新建项目 + 排队分诊式起草指令", async () => {
	const { invoke, followups, fs } = mount(apply);
	const result = await invoke("plan karmada-guide 写一篇 Karmada 联邦调度架构说明，给评估多集群方案的平台工程师");
	assert.equal(result.kind, "success");
	// 脚手架已落盘
	assert.ok(fs.files.has("/ws/writing/karmada-guide/intent.md"));
	assert.ok(fs.files.has("/ws/writing/karmada-guide/manuscript.md"));
	// 起草指令已排队
	assert.equal(followups.length, 1);
	const text = followups[0].content[0].text;
	assert.ok(text.includes("起草意图模型 intent.md"));
	assert.ok(text.includes("写一篇 Karmada 联邦调度架构说明，给评估多集群方案的平台工程师"));
	// 分诊协议
	assert.ok(text.includes("第 0 步（分诊，先做）"), "must require triage first");
	assert.ok(text.includes("赌注"), "must judge stakes");
	assert.ok(text.includes("〔假设 N：…〕"), "low-stakes lane must mark assumptions");
	// grilling 协议
	assert.ok(text.includes("拷问式访谈"), "high-stakes lane must grill");
	assert.ok(text.includes("一次只问一个问题"), "one question per round");
	assert.ok(text.includes("最多 5 轮"), "round cap");
	assert.ok(text.includes("禁止「你想要什么风格/长度」这类填表问题"), "must forbid form-filling questions");
	assert.ok(text.includes("每问附一句为什么问这个"), "questions must carry rationale");
	// 立场红线（防意图外包）
	assert.ok(text.includes("立场红线"), "anti-outsourcing rule must be stated");
	assert.ok(text.includes("不得替用户发明立场"), text);
	// 断言分级与正文禁令
	assert.ok(text.includes("{ not-contains: \"文本\" }"), "must teach assertions");
	assert.ok(text.includes("readtest"), "must route semantic criteria to reader test");
	assert.ok(text.includes("不要写 manuscript.md"), "must not write the manuscript yet");
	assert.ok(text.includes("用户的角色是审阅"), "must frame the maintainer role");
});

test("plan：无描述强制走高赌注拷问分支", async () => {
	const { invoke, followups } = mount(apply);
	const result = await invoke("plan bare-idea");
	assert.equal(result.kind, "success");
	const text = followups[0].content[0].text;
	assert.ok(text.includes("（未提供——先走拷问式访谈）"), text);
	assert.ok(result.text.includes("先访谈你补全背景"), result.text);
});

test("plan：已有项目拒绝（防覆盖已维护的意图）", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	const { invoke, followups } = mount(apply, {}, seeded);
	const result = await invoke("plan demo 重新起草");
	assert.equal(result.kind, "error");
	assert.ok(result.text.includes("已存在"), result.text);
	assert.ok(result.text.includes("sync"), "must point to sync instead");
	assert.equal(followups.length, 0);
});

test("plan：非法项目名被拒且不建文件", async () => {
	const { invoke, fs, followups } = mount(apply);
	const result = await invoke("plan ../etc x");
	assert.equal(result.kind, "error");
	assert.equal([...fs.files.keys()].length, 0);
	assert.equal(followups.length, 0);
});

test("plan：命令输出描述用户的新角色（审阅而非从零写）", async () => {
	const { invoke } = mount(apply);
	const result = await invoke("plan demo 一句话");
	assert.ok(result.text.includes("你只需审阅与修改，不必从零写"), result.text);
});

test("命令注册与提示小节含 plan", () => {
	const { commands, sections } = mount(apply);
	assert.ok(commands.get("write").input.hint.includes("plan"));
	assert.ok(commands.get("write").description.includes("plan/scaffold"), "description must still mention plan");
	assert.ok(sections[0].text.includes("plan <name> [pitch]"));
	assert.ok(sections[0].text.includes("The human maintains the intent; the machine drafts, writes, and checks."));
});
