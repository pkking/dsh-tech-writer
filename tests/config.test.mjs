/**
 * Plugin wiring tests: what apply() registers under each configuration and
 * what the prompt section teaches.
 *
 * Run: node --test tests/config.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apply, name, inject } from "../index.js";
import { mount, seedAlignedProject } from "./helpers.mjs";

test("插件元数据：name 与 inject 声明五个服务", () => {
	assert.equal(name, "tech-writer");
	assert.deepEqual(inject, ["fs", "workingDirectory", "tools", "commands", "systemPrompt"]);
});

test("默认配置：3 个工具 + /write 命令 + 1 个提示小节", () => {
	const { tools, commands, sections } = mount(apply);
	assert.deepEqual([...tools.keys()].sort(), ["writer_check_alignment", "writer_outline", "writer_read_intent"]);
	assert.deepEqual([...commands.keys()], ["write"]);
	assert.equal(sections.length, 1);
});

test("enableTools=false 不注册工具，命令保留", () => {
	const { tools, commands, sections } = mount(apply, { enableTools: false });
	assert.equal(tools.size, 0);
	assert.deepEqual([...commands.keys()], ["write"]);
	assert.equal(sections.length, 1);
});

test("enablePrompt=false 不注册提示小节，工具保留", () => {
	const { tools, commands, sections } = mount(apply, { enablePrompt: false });
	assert.equal(sections.length, 0);
	assert.equal(tools.size, 3);
	assert.deepEqual([...commands.keys()], ["write"]);
});

test("自定义命令名注册对应命令", () => {
	const { commands } = mount(apply, { command: "draft" });
	assert.deepEqual([...commands.keys()], ["draft"]);
});

test("非法命令名回落 /write", () => {
	const { commands } = mount(apply, { command: "写稿" });
	assert.deepEqual([...commands.keys()], ["write"]);
});

test("提示小节：名称、顺序、正文要点", () => {
	const { sections } = mount(apply);
	const [section] = sections;
	assert.equal(section.name, "tech-writer:intent-driven-writing");
	assert.equal(section.order, 3050);
	assert.ok(section.text.includes("Intent-driven writing"));
	assert.ok(section.text.includes("lossy expression"));
	assert.ok(section.text.includes("writing/"));
	assert.ok(section.text.includes("writer_read_intent"));
	assert.ok(section.text.includes("writer_check_alignment"));
	assert.ok(section.text.includes("Log"));
});

test("提示小节随 projectsDir 与 command 配置变化", () => {
	const { sections } = mount(apply, { projectsDir: "docs/book", command: "draft" });
	assert.ok(sections[0].text.includes("docs/book"));
	assert.ok(sections[0].text.includes("/draft"));
});

test("命令描述与输入提示已本地化声明", () => {
	const { commands } = mount(apply);
	const command = commands.get("write");
	assert.ok(command.description.length > 10);
	assert.ok(command.input.hint.includes("status"));
	assert.ok(command.input.hint.includes("sync"));
});

test("自定义 projectsDir：init 与 audit 落在新目录", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded); // /ws/writing/...
	// 把种子复制到 docs/book/ 布局
	for (const [key, value] of [...seeded]) seeded.set(key.replace("/ws/writing/", "/ws/docs/book/"), value);
	const { invoke, fs } = mount(apply, { projectsDir: "docs/book" }, seeded);
	const audit = await invoke("audit demo");
	assert.equal(audit.kind, "success");
	assert.ok(audit.text.includes("对齐检查"));
	const init = await invoke("init fresh");
	assert.equal(init.kind, "success");
	assert.ok(fs.files.has("/ws/docs/book/fresh/intent.md"));
});

test("命令 handler 返回 Promise（异步执行）", async () => {
	const { commands } = mount(apply);
	const handler = commands.get("write").handler;
	const result = handler({ rawInput: "", agent: { session: { id: "x" }, followup() {} }, signal: new AbortController().signal, attachments: [] });
	assert.ok(result instanceof Promise);
	await result;
});
