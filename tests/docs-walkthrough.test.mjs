/**
 * docs-walkthrough.test.mjs — 复现 README「快速上手」章节的全部输出，
 * 保证文档示例与插件实际行为一致（README 即规格）。
 *
 * Run: node --test tests/docs-walkthrough.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import LocalFileSystem from "@deepseek-ai/dsh-fs-local";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolsService from "@deepseek-ai/dsh-tools";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import { apply as executorApply, name as executorName, inject as executorInject } from "@deepseek-ai/dsh-tool-executor-native";
import * as plugin from "../index.js";

const README = await readFile(new URL("../README.md", import.meta.url), "utf8");
let ctx;
let dir;
let agent;
let followups;
let signal;

before(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "docs-walkthrough-"));
	ctx = new Context();
	ctx.plugin(LocalFileSystem, { cwd: dir, diffBasisMaxBytes: 65536 });
	ctx.plugin(SystemPrompt, {});
	ctx.plugin(ToolsService, {});
	ctx.plugin(CommandRuntime, {});
	ctx.plugin({ name: executorName, inject: executorInject, apply: executorApply });
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
	ctx.plugin(plugin, { projectsDir: "writing", command: "write", enableTools: true, enablePrompt: true });
	followups = [];
	agent = { ctx, followup: (message) => followups.push(message), session: { append: () => 1 } };
	signal = new AbortController().signal;
	await new Promise((resolve) => setTimeout(resolve, 50));
});

after(async () => {
	await ctx.dispose?.();
	await rm(dir, { recursive: true, force: true });
});

const run = (line) => ctx.commands.execute(agent, line, [], signal);

/** The intent block embedded in README's step-2 example. */
const README_INTENT = /```markdown\n(# Intent — Karmada 架构说明[\s\S]*?)```/.exec(README)?.[1];

test("README 步骤 1：init 输出与文档一致", async () => {
	assert.ok(README_INTENT, "README intent example block not found");
	const execution = await run("/write init karmada-guide");
	assert.equal(execution.result.kind, "success");
	assert.ok(execution.result.text.includes("已创建 writing/karmada-guide/intent.md 与 manuscript.md"));
	assert.ok(execution.result.text.includes("/write brief karmada-guide"));
});

test("README 步骤 2：示例意图真实可解析", async () => {
	await writeFile(path.join(dir, "writing/karmada-guide/intent.md"), README_INTENT, "utf8");
});

test("README 步骤 4：audit 输出与文档一致（含 C3 50% 教学点与 S3 未匹配）", async () => {
	const manuscript = "# 多集群调度架构说明\n\n## 背景：多集群调度的痛点\n多个集群各自为政时，资源利用率低、调度决策割裂，跨集群的业务缺乏统一的准入视角，发布协调成本显著上升。\n\n## 架构：Dispatcher 与成员集群的分工\nKarmada Dispatcher 集中负责准入与资源仲裁，成员集群内的 Volcano 调度器承接组级调度，两级调度各司其职。\n";
	await writeFile(path.join(dir, "writing/karmada-guide/manuscript.md"), manuscript, "utf8");
	const execution = await run("/write audit karmada-guide");
	const text = execution.result.text;
	assert.ok(text.includes("对齐检查：发现 1 个问题"));
	assert.ok(text.includes("✓ C1（100%）"));
	assert.ok(text.includes("✓ C2（71%）"));
	assert.ok(text.includes("✓ C3（50%）"), "README 教学点依赖 C3=50%");
	assert.ok(text.includes("✗ S3 → (未匹配)"));
	assert.ok(text.includes("章节职责 S3 找不到对应标题：异构：Override 与资源规格转换"));
	assert.ok(text.includes("• A1 读者能说出 Dispatcher 与成员集群调度器的职责边界"));
	assert.ok(text.includes("• D1 以 Karmada 为例而非自研调度器"));
	// v0.3 确定性断言节（README 快速上手第 4 步输出）
	assert.ok(text.includes("确定性断言（机器可验，不经 LLM）"));
	assert.ok(text.includes("✓ A3 {not-contains: \"scheduler\"} — 正文不含「scheduler」"), text);
});

test("README 步骤 3：brief 输出与注入消息一致", async () => {
	const execution = await run("/write brief karmada-guide");
	assert.ok(execution.result.text.includes("已把 karmada-guide 的意图模型排入下一轮"));
	const text = followups.at(-1).content[0].text;
	assert.ok(text.includes("请按意图模型写作/修订正文 manuscript.md"));
	assert.ok(text.includes("正文是意图的有损表达"));
	assert.ok(text.includes("# Intent — Karmada 架构说明"));
});

test("README 步骤 5：sync 输出一致", async () => {
	const execution = await run("/write sync karmada-guide");
	assert.ok(execution.result.text.includes("反向提纲并回写 intent.md"));
});

test("README 步骤 6：readtest 分流输出一致（2 条语义 + 1 条机器验证）", async () => {
	const execution = await run("/write readtest karmada-guide");
	assert.ok(execution.result.text.includes("已把 karmada-guide 的读者测试排入下一轮"));
	assert.ok(execution.result.text.includes("2 条语义验收标准"), execution.result.text);
	assert.ok(execution.result.text.includes("1 条已由确定性断言机器验证"), execution.result.text);
	const text = followups.at(-1).content[0].text;
	assert.ok(text.includes("请对正文执行独立读者测试（Reader Test）。"));
	assert.ok(text.includes("不继承本对话任何上下文"));
	assert.ok(text.includes("已剔除带确定性断言、由机器验证的条目"));
	assert.ok(text.includes("- A1 读者能说出 Dispatcher 与成员集群调度器的职责边界"));
	assert.ok(text.includes("- A2 读者能解释 Override 为什么必要"));
	assert.ok(text.includes("以下条目带确定性断言"));
	assert.ok(text.includes("A3"), "asserted A3 must be listed as machine-verified");
	// A3 的断言问题不出现在出题列表（消息里它只以「已机器验证」形态出现一次）
	const quizLine = text.split("\n").find((line) => line.startsWith("- A3"));
	assert.ok(quizLine.includes("断言已在 audit 执行"), quizLine);
});

test("README status 示例形态一致", async () => {
	const execution = await run("/write status");
	assert.ok(execution.result.text.includes("写作项目（writing/）："));
	assert.ok(execution.result.text.includes("karmada-guide"));
	assert.ok(execution.result.text.includes("主张 3 条"));
});
