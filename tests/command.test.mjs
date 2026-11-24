/**
 * Command and tool integration tests: /write grammar execution, writer_* tool
 * behavior, followup injection, project layout, and edge cases — all over the
 * in-memory ctx mock in helpers.mjs.
 *
 * Run: node --test tests/command.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../index.js";
import { mount, seedAlignedProject, assertRejectsWith } from "./helpers.mjs";

/** Fresh harness with one aligned "demo" project seeded. */
function harness(config = {}) {
	const seeded = new Map();
	seedAlignedProject(seeded);
	return mount(apply, config, seeded);
}

// ────────────────────────────────────────────────────────────────────────────
// /write status
// ────────────────────────────────────────────────────────────────────────────

test("status: 无项目时给出创建指引", async () => {
	const { invoke } = mount(apply);
	const result = await invoke("");
	assert.equal(result.kind, "success");
	assert.ok(result.text.includes("还没有写作项目"));
	assert.ok(result.text.includes("/write init"));
});

test("status: 列出项目与对齐概况", async () => {
	const { invoke } = harness();
	const result = await invoke("status");
	assert.equal(result.kind, "success");
	assert.ok(result.text.includes("demo"));
	assert.ok(result.text.includes("正文"));
	assert.ok(result.text.includes("主张"));
});

test("status: 含问题的项目显示待修计数", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	seeded.set("/ws/writing/demo/manuscript.md", "# 只有标题\n\n正文空。");
	const { invoke } = mount(apply, {}, seeded);
	const result = await invoke("");
	assert.ok(result.text.includes("待修问题"));
});

// ────────────────────────────────────────────────────────────────────────────
// /write init
// ────────────────────────────────────────────────────────────────────────────

test("init: 生成 intent.md 与 manuscript.md 脚手架", async () => {
	const { invoke, fs } = mount(apply);
	const result = await invoke("init demo");
	assert.equal(result.kind, "success");
	const intent = fs.files.get("/ws/writing/demo/intent.md");
	const manuscript = fs.files.get("/ws/writing/demo/manuscript.md");
	assert.ok(intent.includes("## Why"));
	assert.ok(intent.includes("## Claims"));
	assert.ok(intent.includes("[C1]"));
	assert.ok(intent.includes("## Log"));
	assert.ok(manuscript.length > 0);
});

test("init: 重复创建报错", async () => {
	const { invoke } = harness();
	const result = await invoke("init demo");
	assert.equal(result.kind, "error");
	assert.ok(result.text.includes("已存在"));
});

test("init: 非法项目名被拒", async () => {
	const { invoke } = mount(apply);
	assert.equal((await invoke("init ../etc")).kind, "error");
	assert.equal((await invoke("init a/b")).kind, "error");
	assert.equal((await invoke("init .hidden")).kind, "error");
	assert.equal((await invoke("init demo extra")).kind, "error");
});

test("init: 中文项目名合法", async () => {
	const { invoke, fs } = mount(apply);
	const result = await invoke("init 架构白皮书");
	assert.equal(result.kind, "success");
	assert.ok(fs.files.has("/ws/writing/架构白皮书/intent.md"));
});

test("init: 缺动词参数提示用法", async () => {
	const { invoke } = mount(apply);
	const result = await invoke("init");
	assert.equal(result.kind, "error");
	assert.ok(result.text.includes("用法"));
});

// ────────────────────────────────────────────────────────────────────────────
// /write audit
// ────────────────────────────────────────────────────────────────────────────

test("audit: 对齐项目通过", async () => {
	const { invoke } = harness();
	const result = await invoke("audit demo");
	assert.equal(result.kind, "success");
	assert.ok(result.text.includes("对齐检查：通过"));
});

test("audit: 缺失主张时报错并指明编号", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	seeded.set("/ws/writing/demo/intent.md", seeded.get("/ws/writing/demo/intent.md").replace("[C1] Dispatcher 负责准入仲裁", "[C1] 毫无关联的区块链主张"));
	const { invoke } = mount(apply, {}, seeded);
	const result = await invoke("audit demo");
	assert.equal(result.kind, "success");
	assert.ok(result.text.includes("✗ C1"));
});

test("audit: 项目不存在报错", async () => {
	const { invoke } = mount(apply);
	const result = await invoke("audit nope");
	assert.equal(result.kind, "error");
	assert.ok(result.text.includes("不存在"));
});

test("audit: 只有 intent 无 manuscript 报“正文为空”", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	seeded.delete("/ws/writing/demo/manuscript.md");
	const { invoke } = mount(apply, {}, seeded);
	const result = await invoke("audit demo");
	assert.equal(result.kind, "success");
	assert.ok(result.text.includes("正文为空"));
});

test("audit: 只有 manuscript 无 intent 报缺失小节", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	seeded.delete("/ws/writing/demo/intent.md");
	const { invoke } = mount(apply, {}, seeded);
	const result = await invoke("audit demo");
	assert.ok(result.text.includes("缺少"));
});

test("audit: '.' 项目直查 writing/ 根", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded, ".");
	const { invoke } = mount(apply, {}, seeded);
	const result = await invoke("audit .");
	assert.equal(result.kind, "success");
	assert.ok(result.text.includes("对齐检查"));
});

test("audit: CRLF 文件正常解析", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	seeded.set("/ws/writing/demo/manuscript.md", "# 多集群调度\r\n\r\n## 背景：调度痛点\r\n两个集群资源规格不同，统一调度长期靠人工排期，出错率高。\r\n\r\n## 设计：组件职责\r\nDispatcher 集中负责准入与资源仲裁，Volcano 承接组级调度。\r\n");
	const { invoke } = mount(apply, {}, seeded);
	const result = await invoke("audit demo");
	assert.equal(result.kind, "success");
	assert.ok(result.text.includes("对齐检查：通过"));
});

// ────────────────────────────────────────────────────────────────────────────
// /write brief 与 /write sync（followup 注入）
// ────────────────────────────────────────────────────────────────────────────

test("brief: 排队一条携带意图的用户消息", async () => {
	const { invoke, followups } = harness();
	const result = await invoke("brief demo");
	assert.equal(result.kind, "success");
	assert.equal(followups.length, 1);
	const message = followups[0];
	assert.equal(message.role, "user");
	assert.ok(message.id.startsWith("tech-writer-"));
	assert.equal(message.source.kind, "tech-writer");
	assert.ok(message.content[0].text.includes("意图模型"));
	assert.ok(message.content[0].text.includes("Dispatcher 负责准入仲裁"));
	assert.ok(message.content[0].text.includes("[S1]"));
});

test("brief: 缺 intent.md 报错且不排队", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	seeded.delete("/ws/writing/demo/intent.md");
	const { invoke, followups } = mount(apply, {}, seeded);
	const result = await invoke("brief demo");
	assert.equal(result.kind, "error");
	assert.equal(followups.length, 0);
});

test("brief: 超长 intent 被截断到上限并标注总长", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	const intent = seeded.get("/ws/writing/demo/intent.md");
	seeded.set("/ws/writing/demo/intent.md", `${intent}\n${"很长的填充内容。".repeat(4000)}`);
	const { invoke, followups } = mount(apply, {}, seeded);
	const result = await invoke("brief demo");
	assert.equal(result.kind, "success");
	const text = followups[0].content[0].text;
	assert.ok(text.includes("截断"));
	assert.ok(text.length < 30000);
});

test("sync: 排队一条反向提纲指令消息", async () => {
	const { invoke, followups } = harness();
	const result = await invoke("sync demo");
	assert.equal(result.kind, "success");
	assert.equal(followups.length, 1);
	const text = followups[0].content[0].text;
	assert.ok(text.includes("反向提纲"));
	assert.ok(text.includes("步骤"));
	assert.ok(text.includes("Dispatcher"));
});

test("sync: 缺 manuscript.md 报错且不排队", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	seeded.delete("/ws/writing/demo/manuscript.md");
	const { invoke, followups } = mount(apply, {}, seeded);
	const result = await invoke("sync demo");
	assert.equal(result.kind, "error");
	assert.equal(followups.length, 0);
});

test("brief 与 sync 各自独立排队", async () => {
	const { invoke, followups } = harness();
	await invoke("brief demo");
	await invoke("sync demo");
	assert.equal(followups.length, 2);
	assert.ok(followups[0].content[0].text.includes("意图模型"));
	assert.ok(followups[1].content[0].text.includes("反向提纲"));
});

// ────────────────────────────────────────────────────────────────────────────
// 命令错误路径
// ────────────────────────────────────────────────────────────────────────────

test("未知子命令报错并附用法", async () => {
	const { invoke } = mount(apply);
	const result = await invoke("frobnicate");
	assert.equal(result.kind, "error");
	assert.ok(result.text.includes("frobnicate"));
	assert.ok(result.text.includes("用法"));
});

test("status 忽略尾随参数（锁定行为）", async () => {
	const { invoke } = mount(apply);
	const result = await invoke("status whatever");
	assert.equal(result.kind, "success");
});

// ────────────────────────────────────────────────────────────────────────────
// 工具：writer_read_intent
// ────────────────────────────────────────────────────────────────────────────

test("writer_read_intent: 省略 project 列出项目", async () => {
	const { tool } = harness();
	const value = await tool("writer_read_intent", {});
	assert.deepEqual(value.projects, ["demo"]);
	assert.ok(value.summary.includes("demo"));
});

test("writer_read_intent: 返回意图小节与统计", async () => {
	const { tool } = harness();
	const value = await tool("writer_read_intent", { project: "demo" });
	assert.equal(value.exists, true);
	assert.equal(value.claims.length, 2);
	assert.equal(value.structure.length, 2);
	assert.deepEqual(value.intent.missingSections, []);
	assert.ok(value.manuscript.words > 0);
	assert.ok(value.intentPath.endsWith("intent.md"));
});

test("writer_read_intent: 项目不存在提示 init", async () => {
	const { tool } = mount(apply);
	const value = await tool("writer_read_intent", { project: "nope" });
	assert.equal(value.exists, false);
	assert.ok(value.summary.includes("init"));
});

test("writer_read_intent: 缺 Audience 小节被列出", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	seeded.set("/ws/writing/demo/intent.md", seeded.get("/ws/writing/demo/intent.md").replace("## Audience\n- 平台架构师\n", ""));
	assert.ok(!seeded.get("/ws/writing/demo/intent.md").includes("## Audience"), "fixture must actually remove the section");
	const { tool } = mount(apply, {}, seeded);
	const value = await tool("writer_read_intent", { project: "demo" });
	assert.deepEqual(value.intent.missingSections, ["audience"]);
});

test("writer_read_intent: 非法项目名拒绝，空对象列项目", async () => {
	const { tool } = mount(apply);
	await assertRejectsWith(tool("writer_read_intent", { project: "../etc" }), "非法项目名");
	await assertRejectsWith(tool("writer_read_intent", { project: "" }), "必填");
	await assertRejectsWith(tool("writer_read_intent", { project: "   " }), "必填");
	const listed = await tool("writer_read_intent", {});
	assert.equal(listed.project, "*");
});

// ────────────────────────────────────────────────────────────────────────────
// 工具：writer_outline
// ────────────────────────────────────────────────────────────────────────────

test("writer_outline: 提取标题与逐节统计", async () => {
	const { tool } = harness();
	const value = await tool("writer_outline", { project: "demo" });
	assert.equal(value.exists, true);
	assert.equal(value.headings.length, 3);
	assert.deepEqual(value.headings.map((heading) => heading.level), [1, 2, 2]);
	assert.ok(value.sections.every((section) => typeof section.words === "number"));
	assert.ok(value.summary.includes("3 headings"));
});

test("writer_outline: manuscript 缺失", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	seeded.delete("/ws/writing/demo/manuscript.md");
	const { tool } = mount(apply, {}, seeded);
	const value = await tool("writer_outline", { project: "demo" });
	assert.equal(value.exists, false);
	assert.ok(value.summary.includes("not found"));
});

// ────────────────────────────────────────────────────────────────────────────
// 工具：writer_check_alignment
// ────────────────────────────────────────────────────────────────────────────

test("writer_check_alignment: 对齐项目 ok=true", async () => {
	const { tool } = harness();
	const value = await tool("writer_check_alignment", { project: "demo" });
	assert.equal(value.ok, true);
	assert.deepEqual(value.problems, []);
	assert.equal(value.stats.claims, 2);
});

test("writer_check_alignment: 项目不存在", async () => {
	const { tool } = mount(apply);
	const value = await tool("writer_check_alignment", { project: "nope" });
	assert.equal(value.exists, false);
});

test("工具在无 agent 的 exec 下回落默认工作目录", async () => {
	const seeded = new Map();
	seedAlignedProject(seeded);
	const { tools, signal } = mount(apply, {}, seeded);
	const value = await tools.get("writer_outline").execute({ project: "demo" }, { signal });
	assert.equal(value.exists, true);
});

test("工具输出 render 返回文本块且 JSON 可解析", async () => {
	const { tools } = mount(apply);
	const tool = tools.get("writer_read_intent");
	const blocks = tool.output.render({}, { project: "demo", summary: "s" });
	assert.equal(blocks[0].type, "text");
	assert.equal(JSON.parse(blocks[0].text).project, "demo");
});

// ────────────────────────────────────────────────────────────────────────────
// 并发与重复调用（幂等只读）
// ────────────────────────────────────────────────────────────────────────────

test("同一工具并发调用互不干扰", async () => {
	const { tool } = harness();
	const results = await Promise.all([
		tool("writer_check_alignment", { project: "demo" }),
		tool("writer_outline", { project: "demo" }),
		tool("writer_read_intent", { project: "demo" }),
	]);
	assert.equal(results[0].ok, true);
	assert.equal(results[1].exists, true);
	assert.equal(results[2].exists, true);
});
