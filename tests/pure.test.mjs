/**
 * Pure-function test cases: keywords, coverage, parseIntent, parseManuscript,
 * checkAlignment, renderReport, validProject, parseWriteCommand, resolveConfig.
 *
 * Run: node --test tests/pure.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	keywords,
	coverage,
	parseIntent,
	parseManuscript,
	checkAlignment,
	renderReport,
	validProject,
	parseWriteCommand,
	resolveConfig,
} from "../index.js";

// ────────────────────────────────────────────────────────────────────────────
// keywords()
// ────────────────────────────────────────────────────────────────────────────

test("keywords: 空输入返回空数组", () => {
	assert.deepEqual(keywords(""), []);
	assert.deepEqual(keywords(null), []);
	assert.deepEqual(keywords(undefined), []);
});

test("keywords: 停用词与单字符被剔除", () => {
	assert.deepEqual(keywords("the a an and or of to is"), []);
	assert.deepEqual(keywords("x y z"), []);
});

test("keywords: 拉丁词保序去重", () => {
	assert.deepEqual(keywords("Karmada dispatcher karmada Dispatcher"), ["karmada", "dispatcher"]);
});

test("keywords: 连字符与撇号词保留为单 token", () => {
	assert.deepEqual(keywords("state-of-the-art don't"), ["state-of-the-art", "don't"]);
});

test("keywords: 版本号按 [a-z0-9] 边界拆分（v4.1 → v4，1 丢弃）——锁定启发式行为", () => {
	assert.deepEqual(keywords("v4.1"), ["v4"]);
});

test("keywords: CJK 逐字成 token 且去重", () => {
	assert.deepEqual(keywords("调度调度"), ["调", "度"]);
	assert.deepEqual(keywords("跨集群 调度"), ["跨", "集", "群", "调", "度"]);
});

test("keywords: 中英混合按出现顺序交错收集", () => {
	assert.deepEqual(keywords("Karmada 负责 dispatcher"), ["karmada", "dispatcher", "负", "责"]);
});

// ────────────────────────────────────────────────────────────────────────────
// coverage()
// ────────────────────────────────────────────────────────────────────────────

test("coverage: 空关键词文本视为全覆盖（无信息量）", () => {
	const result = coverage("", "任意正文");
	assert.equal(result.ratio, 1);
	assert.equal(result.total, 0);
});

test("coverage: 词边界——cat 不匹配 category", () => {
	const result = coverage("cat", "the category is large");
	assert.equal(result.ratio, 0);
});

test("coverage: 词边界——复数形式不匹配单数", () => {
	assert.equal(coverage("cluster", "clusters of nodes").ratio, 0);
	assert.equal(coverage("clusters", "clusters of nodes").ratio, 1);
});

test("coverage: 大小写不敏感", () => {
	assert.equal(coverage("Karmada Dispatcher", "karmada DISPATCHER").ratio, 1);
});

test("coverage: 部分覆盖按比例计算", () => {
	const result = coverage("alpha beta gamma delta", "alpha and beta only");
	assert.equal(result.total, 4);
	assert.equal(result.matched.length, 2);
	assert.equal(result.ratio, 0.5);
});

test("coverage: CJK 子串命中（单字 token 按子串匹配——锁定设计）", () => {
	assert.equal(coverage("准入", "Dispatcher 的准入控制").ratio, 1);
	assert.equal(coverage("准", "标准").ratio, 1); // “标准”包含“准”：单字即子串
	assert.equal(coverage("氦", "标准").ratio, 0);
});

test("coverage: 正则元字符 token 转义安全", () => {
	// “ax.bx*cx” 拆成 ax / bx / cx 三个 token；`.` 与 `*` 是分隔符
	assert.equal(coverage("ax.bx*cx", "contains ax.bx*cx literal").ratio, 1);
	assert.equal(coverage("ax.bx*cx", "contains abc literal").ratio, 0);
});

// ────────────────────────────────────────────────────────────────────────────
// parseIntent()
// ────────────────────────────────────────────────────────────────────────────

test("parseIntent: 空文档返回 null 标题与空小节，全文进 intro", () => {
	const intent = parseIntent("");
	assert.equal(intent.title, null);
	assert.deepEqual(intent.sections, []);
	assert.equal(intent.intro, "");
});

test("parseIntent: 无小节时正文进 intro", () => {
	const intent = parseIntent("只有一段自由文本");
	assert.equal(intent.sections.length, 0);
	assert.equal(intent.intro, "只有一段自由文本");
});

test("parseIntent: 一级标题提取，## 前的文本不属于任何小节", () => {
	const intent = parseIntent("# 标题\n\n前言行\n\n## Why\n- 要点");
	assert.equal(intent.title, "标题");
	assert.equal(intent.sections.length, 1);
	assert.equal(intent.intro, "");
});

test("parseIntent: bullet id 解析（大小写归一、三位编号、无 id）", () => {
	const intent = parseIntent("## Claims\n- [c1] 小写归一\n- [C12] 两位\n- [C123] 三位\n- 无编号要点\n- [X9] 他字母");
	const bullets = intent.sections[0].bullets;
	assert.equal(bullets[0].id, "C1");
	assert.equal(bullets[1].id, "C12");
	assert.equal(bullets[2].id, "C123");
	assert.equal(bullets[3].id, null);
	assert.equal(bullets[3].text, "无编号要点");
	assert.equal(bullets[4].id, "X9");
});

test("parseIntent: 非 bullet 行不进入 bullets 但保留在 body", () => {
	const intent = parseIntent("## Why\n普通段落\n- 要点一\n\n另一段");
	const section = intent.sections[0];
	assert.equal(section.bullets.length, 1);
	assert.ok(section.body.includes("普通段落"));
});

test("parseIntent: 三级标题不切小节", () => {
	const intent = parseIntent("## Why\n- a\n### 嵌套\n- b");
	assert.equal(intent.sections.length, 1);
	assert.equal(intent.sections[0].bullets.length, 2);
});

test("parseIntent: CRLF 换行正常解析", () => {
	const intent = parseIntent("## Why\r\n- [C1] 主张\r\n");
	assert.equal(intent.sections[0].bullets[0].id, "C1");
});

test("parseIntent: UTF-8 BOM 被剥离，标题可识别", () => {
	const intent = parseIntent("\uFEFF# 意图\n\n## Why\n- a");
	assert.equal(intent.title, "意图");
	assert.equal(intent.sections.length, 1);
});

test("parseIntent: fence 块内的 ## 不是小节标题", () => {
	const intent = parseIntent("# t\n\n## Why\n- a\n\n```\n## Claims\n- [C1] 假的\n```\n\n## Structure\n- [S1] 真的");
	assert.equal(intent.sections.length, 2);
	assert.equal(intent.sections[0].title, "Why");
	assert.equal(intent.sections[1].title, "Structure");
});

test("parseIntent: 同名小节取第一个（锁定行为）", () => {
	const intent = parseIntent("## Why\n- 第一\n\n## Why\n- 第二");
	assert.equal(intent.sections.length, 2);
	assert.equal(intent.sections[0].bullets[0].text, "第一");
});

test("parseIntent: 小节标题带中文括号注释仍归一为规范 key", () => {
	const intent = parseIntent("## Why（为什么写）\n- a");
	assert.equal(intent.sections[0].title, "Why（为什么写）");
});

// ────────────────────────────────────────────────────────────────────────────
// parseManuscript()
// ────────────────────────────────────────────────────────────────────────────

test("parseManuscript: 空文本零标题零词", () => {
	const manuscript = parseManuscript("");
	assert.equal(manuscript.words, 0);
	assert.deepEqual(manuscript.headings, []);
	assert.deepEqual(manuscript.sections, []);
	assert.equal(manuscript.preambleWords, 0);
});

test("parseManuscript: 只有前言无标题", () => {
	const manuscript = parseManuscript("一段没有标题的正文。");
	assert.equal(manuscript.headings.length, 0);
	assert.equal(manuscript.preambleWords, manuscript.words);
});

test("parseManuscript: 1–6 级标题全部识别", () => {
	const source = ["# 一", "## 二", "### 三", "#### 四", "##### 五", "###### 六", "正文"].join("\n");
	const manuscript = parseManuscript(source);
	assert.deepEqual(manuscript.headings.map((heading) => heading.level), [1, 2, 3, 4, 5, 6]);
});

test("parseManuscript: 需要空格的 # 才是标题（#tag 不算）", () => {
	const manuscript = parseManuscript("#tag not heading\n# real heading");
	assert.equal(manuscript.headings.length, 1);
	assert.equal(manuscript.headings[0].text, "real heading");
});

test("parseManuscript: 小节统计（词数、段落数、行号）", () => {
	const manuscript = parseManuscript("# 题\n\n第一段文字内容较多。\n\n第二段也有内容。\n\n## 次题\n\n次节正文。");
	assert.equal(manuscript.sections.length, 2);
	const first = manuscript.sections[0];
	assert.equal(first.heading, "题");
	assert.equal(first.line, 1);
	assert.equal(first.paragraphs, 2);
	assert.ok(first.words > 0);
});

test("parseManuscript: 连续标题产生空节（words 0）", () => {
	const manuscript = parseManuscript("# A\n\n# B\n\n正文只在 B。");
	assert.equal(manuscript.sections[0].words, 0);
	assert.ok(manuscript.sections[1].words > 0);
});

test("parseManuscript: fence 内的 # 不是标题，但 fence 内容计入词数", () => {
	const source = "# 标题\n\n```bash\n# 这是注释不是标题\necho hi\n```\n\n正文继续。";
	const manuscript = parseManuscript(source);
	assert.equal(manuscript.headings.length, 1);
	assert.equal(manuscript.words > 0, true);
});

test("parseManuscript: ~~~ fence 同样生效", () => {
	const manuscript = parseManuscript("# T\n\n~~~\n# not heading\n~~~\n");
	assert.equal(manuscript.headings.length, 1);
});

test("parseManuscript: 不成对的 fence（文件在块内结束）不抛异常", () => {
	const manuscript = parseManuscript("# T\n\n```\n# still inside\n");
	assert.equal(manuscript.headings.length, 1);
});

test("parseManuscript: BOM 被剥离，首行标题可识别", () => {
	const manuscript = parseManuscript("\uFEFF# 标题\n正文");
	assert.equal(manuscript.headings[0].text, "标题");
});

test("parseManuscript: CRLF 换行", () => {
	const manuscript = parseManuscript("# 标题\r\n\r\n正文段落。\r\n");
	assert.equal(manuscript.sections[0].heading, "标题");
	assert.equal(manuscript.sections[0].paragraphs, 1);
});

test("parseManuscript: 中英混合词数（拉丁词 + CJK 字）", () => {
	const manuscript = parseManuscript("karmada 调度 two words");
	// karmada, two, words = 3 拉丁词；调 度 = 2 CJK 字
	assert.equal(manuscript.words, 5);
});

// ────────────────────────────────────────────────────────────────────────────
// checkAlignment()
// ────────────────────────────────────────────────────────────────────────────

/** A fully populated intent document. */
function fullIntent(overrides = {}) {
	const claims = overrides.claims ?? ["- [C1] Dispatcher 负责准入仲裁", "- [C2] Volcano 支持组级调度"];
	const structure = overrides.structure ?? ["- [S1] 背景：调度痛点", "- [S2] 设计：组件职责"];
	const acceptance = overrides.acceptance ?? ["- [A1] 读者能复述组件分工"];
	const decisions = overrides.decisions ?? ["- [D1] 复用 Karmada 而非自研"];
	return parseIntent(`# Intent

## Why
- 说明多集群调度之难

## Audience
- 架构师

## Claims
${claims.join("\n")}

## Structure
${structure.join("\n")}

## Decisions
${decisions.join("\n")}

## Acceptance
${acceptance.join("\n")}
`);
}

const ALIGNED_MANUSCRIPT = `# 多集群调度

## 背景：调度痛点
两个集群资源规格不同，统一调度长期靠人工排期，出错率高，发布周期被显著拉长。

## 设计：组件职责
Dispatcher 集中负责准入与资源仲裁，成员集群内的 Volcano 承接组级调度。
`;

test("checkAlignment: 全对齐项目 ok=true 且无警告", () => {
	const report = checkAlignment(fullIntent(), parseManuscript(ALIGNED_MANUSCRIPT), ALIGNED_MANUSCRIPT);
	assert.equal(report.ok, true);
	assert.deepEqual(report.problems, []);
	assert.deepEqual(report.warnings, []);
	assert.equal(report.claims.every((claim) => claim.status === "covered"), true);
	assert.equal(report.structure.every((entry) => entry.status === "matched"), true);
});

test("checkAlignment: 主张近零覆盖判 missing 并入 problems", () => {
	const intent = fullIntent({ claims: ["- [C1] 完全不相关的量子纠缠主张"] });
	const report = checkAlignment(intent, parseManuscript(ALIGNED_MANUSCRIPT), ALIGNED_MANUSCRIPT);
	assert.equal(report.ok, false);
	assert.ok(report.problems.some((problem) => problem.includes("C1")));
	assert.equal(report.claims[0].status, "missing");
	// 高频字（的/集）可能偶然命中，但比率必须低于 partial 阈值
	assert.ok(report.claims[0].ratio < 0.25, `ratio=${report.claims[0].ratio}`);
});

test("checkAlignment: 弱覆盖（25%–50%）给 warning 不给 problem", () => {
	// 4 个 token 命中 1 个 = 25% → partial 下界
	const intent = fullIntent({ claims: ["- [C1] alpha beta gamma dispatcher"] });
	const manuscript = "dispatcher 一词命中，其余未出现。";
	const report = checkAlignment(intent, parseManuscript(manuscript), manuscript);
	assert.equal(report.claims[0].status, "partial");
	assert.ok(report.warnings.some((warning) => warning.includes("C1")));
	assert.ok(report.problems.every((problem) => !problem.includes("C1")));
});

test("checkAlignment: 精确阈值边界（0.5 covered，0.25 partial，0.2 missing）", () => {
	const half = fullIntent({ claims: ["- [C1] alpha beta"] });
	const quarter = fullIntent({ claims: ["- [C1] alpha beta gamma delta"] });
	const fifth = fullIntent({ claims: ["- [C1] alpha beta gamma delta epsilon"] });
	const text = "alpha 出现了。";
	assert.equal(checkAlignment(half, parseManuscript(text), text).claims[0].status, "covered"); // 1/2 = 0.50
	assert.equal(checkAlignment(quarter, parseManuscript(text), text).claims[0].status, "partial"); // 1/4 = 0.25
	assert.equal(checkAlignment(fifth, parseManuscript(text), text).claims[0].status, "missing"); // 1/5 = 0.20
});

test("checkAlignment: 结构条目无匹配标题判 unmatched", () => {
	const intent = fullIntent({ structure: ["- [S1] 量子化学导论"] });
	const report = checkAlignment(intent, parseManuscript(ALIGNED_MANUSCRIPT), ALIGNED_MANUSCRIPT);
	assert.equal(report.structure[0].status, "unmatched");
	assert.equal(report.structure[0].heading, null);
	assert.equal(report.structure[0].line, null);
	assert.ok(report.problems.some((problem) => problem.includes("S1")));
});

test("checkAlignment: 章节顺序与意图不符产生 warning", () => {
	const intent = fullIntent({ structure: ["- [S1] 设计：组件职责", "- [S2] 背景：调度痛点"] });
	const report = checkAlignment(intent, parseManuscript(ALIGNED_MANUSCRIPT), ALIGNED_MANUSCRIPT);
	assert.equal(report.ok, true); // 顺序错位是 warning 不是 problem
	assert.ok(report.warnings.some((warning) => warning.includes("顺序与意图不符")));
});

test("checkAlignment: 薄节（<20 词）逐节告警", () => {
	const thin = "# 题\n\n## 短\n\n太短。\n\n## 长\n\n这一节有足够多的词，超过二十个词的门槛，因此不会被判为薄节。";
	const report = checkAlignment(fullIntent(), parseManuscript(thin), thin);
	assert.equal(report.stats.thinSections, 1);
	assert.ok(report.warnings.some((warning) => warning.includes("《短》")));
});

test("checkAlignment: 空 manuscript 报“正文为空”", () => {
	const report = checkAlignment(fullIntent(), parseManuscript(""), "");
	assert.equal(report.ok, false);
	assert.ok(report.problems.includes("正文为空"));
});

test("checkAlignment: 缺失意图小节逐个报 problem", () => {
	const intent = parseIntent("# I\n\n## Why\n- a\n");
	const report = checkAlignment(intent, parseManuscript(ALIGNED_MANUSCRIPT), ALIGNED_MANUSCRIPT);
	const missing = report.problems.filter((problem) => problem.includes("缺少"));
	assert.equal(missing.length, 4); // audience claims structure acceptance
});

test("checkAlignment: 空 intent（无 sections）全部必需小节缺失", () => {
	const report = checkAlignment(parseIntent(""), parseManuscript(ALIGNED_MANUSCRIPT), ALIGNED_MANUSCRIPT);
	assert.equal(report.problems.filter((problem) => problem.includes("缺少")).length, 5);
});

test("checkAlignment: acceptance 全部 manual 状态，decisions 原样透出", () => {
	const report = checkAlignment(fullIntent(), parseManuscript(ALIGNED_MANUSCRIPT), ALIGNED_MANUSCRIPT);
	assert.equal(report.acceptance.length, 1);
	assert.equal(report.acceptance[0].status, "manual");
	assert.equal(report.decisions.length, 1);
	assert.equal(report.decisions[0].id, "D1");
});

test("checkAlignment: 无 Decisions 小节时 decisions 为空数组", () => {
	const intent = parseIntent(`# I

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
	const report = checkAlignment(intent, parseManuscript(ALIGNED_MANUSCRIPT), ALIGNED_MANUSCRIPT);
	assert.deepEqual(report.decisions, []);
});

test("checkAlignment: stats 汇总数字一致", () => {
	const report = checkAlignment(fullIntent(), parseManuscript(ALIGNED_MANUSCRIPT), ALIGNED_MANUSCRIPT);
	assert.equal(report.stats.claims, 2);
	assert.equal(report.stats.structureEntries, 2);
	assert.equal(report.stats.acceptanceCriteria, 1);
	assert.equal(report.stats.headings, 3);
	assert.equal(report.stats.manuscriptSections, 3);
});

test("checkAlignment: [C] 出现在错误小节不被计入 claims", () => {
	// [C9] 写在 Structure 小节里——只有 Claims 小节的 [C#] 算主张
	const intent = fullIntent({ structure: ["- [S1] 背景：调度痛点", "- [C9] 伪装成结构的 C 编号"] });
	const report = checkAlignment(intent, parseManuscript(ALIGNED_MANUSCRIPT), ALIGNED_MANUSCRIPT);
	assert.equal(report.claims.length, 2);
	assert.ok(report.claims.every((claim) => claim.id !== "C9"));
});

// ────────────────────────────────────────────────────────────────────────────
// renderReport()
// ────────────────────────────────────────────────────────────────────────────

test("renderReport: 通过时头部为“通过 ✓”", () => {
	const report = checkAlignment(fullIntent(), parseManuscript(ALIGNED_MANUSCRIPT), ALIGNED_MANUSCRIPT);
	const text = renderReport(report);
	assert.ok(text.startsWith("对齐检查：通过"));
	assert.ok(text.includes("C1"));
	assert.ok(text.includes("S1"));
	assert.ok(text.includes("A1"));
	assert.ok(text.includes("D1"));
	assert.ok(!text.includes("问题："));
});

test("renderReport: 失败时头部计数并列出问题与提醒", () => {
	const intent = fullIntent({ claims: ["- [C1] 无关主张"] });
	const report = checkAlignment(intent, parseManuscript("# 题\n\n## 短\n\n短。"), "# 题\n\n## 短\n\n短。");
	const text = renderReport(report);
	assert.ok(text.includes("对齐检查：发现"));
	assert.ok(text.includes("✗ C1"));
	assert.ok(text.includes("问题："));
	assert.ok(text.includes("提醒："));
});

test("renderReport: 空报告（无 claims/structure）不产生空节", () => {
	const report = checkAlignment(parseIntent(""), parseManuscript(""), "");
	const text = renderReport(report);
	assert.ok(text.includes("正文为空"));
	assert.ok(!text.includes("主张覆盖"));
	assert.ok(!text.includes("结构映射"));
	assert.ok(!text.includes("验收标准"));
});

// ────────────────────────────────────────────────────────────────────────────
// validProject()
// ────────────────────────────────────────────────────────────────────────────

test("validProject: 合法名称", () => {
	assert.equal(validProject("demo"), "demo");
	assert.equal(validProject("my-project_2.x"), "my-project_2.x");
	assert.equal(validProject("中文项目"), "中文项目");
	assert.equal(validProject("  spaced  "), "spaced");
	assert.equal(validProject(".".repeat(1)), ".");
	assert.equal(validProject("a".repeat(64)), "a".repeat(64));
});

test("validProject: 非法名称", () => {
	assert.equal(validProject(""), null);
	assert.equal(validProject(null), null);
	assert.equal(validProject(undefined), null);
	assert.equal(validProject(".."), null);
	assert.equal(validProject(".hidden"), null);
	assert.equal(validProject("a/b"), null);
	assert.equal(validProject("a\\b"), null);
	assert.equal(validProject("a".repeat(65)), null);
	assert.equal(validProject("🚀proj"), null); // emoji 非 \p{L}\p{N}
	assert.equal(validProject("-leading"), null); // 首字符必须字母数字
});

test("validProject: 空白整串 trim 后为空", () => {
	assert.equal(validProject("   "), null);
});

// ────────────────────────────────────────────────────────────────────────────
// parseWriteCommand()
// ────────────────────────────────────────────────────────────────────────────

test("parseWriteCommand: 空串与 status 都进 status", () => {
	assert.deepEqual(parseWriteCommand(""), { kind: "status" });
	assert.deepEqual(parseWriteCommand("status"), { kind: "status" });
	assert.deepEqual(parseWriteCommand("  status  "), { kind: "status" });
});

test("parseWriteCommand: status 忽略尾随参数（锁定行为）", () => {
	assert.deepEqual(parseWriteCommand("status extra"), { kind: "status" });
});

test("parseWriteCommand: 四个动词带参数解析", () => {
	assert.deepEqual(parseWriteCommand("init demo"), { kind: "init", project: "demo" });
	assert.deepEqual(parseWriteCommand("brief demo"), { kind: "brief", project: "demo" });
	assert.deepEqual(parseWriteCommand("audit demo"), { kind: "audit", project: "demo" });
	assert.deepEqual(parseWriteCommand("sync demo"), { kind: "sync", project: "demo" });
});

test("parseWriteCommand: 动词大小写不敏感", () => {
	assert.deepEqual(parseWriteCommand("INIT demo"), { kind: "init", project: "demo" });
	assert.deepEqual(parseWriteCommand("Audit demo"), { kind: "audit", project: "demo" });
});

test("parseWriteCommand: 多空格与尾随空格", () => {
	assert.deepEqual(parseWriteCommand("init   demo   "), { kind: "init", project: "demo" });
});

test("parseWriteCommand: 动词缺参数返回 usage", () => {
	assert.deepEqual(parseWriteCommand("init"), { kind: "usage", verb: "init" });
	assert.deepEqual(parseWriteCommand("init "), { kind: "usage", verb: "init" });
});

test("parseWriteCommand: 未知动词返回 usage", () => {
	assert.deepEqual(parseWriteCommand("frobnicate"), { kind: "usage", verb: "frobnicate" });
	assert.deepEqual(parseWriteCommand("frobnicate x"), { kind: "usage", verb: "frobnicate" });
});

test("parseWriteCommand: 多余参数并入项目名（随后由 validProject 拒绝）", () => {
	assert.deepEqual(parseWriteCommand("init demo extra"), { kind: "init", project: "demo extra" });
});

test("parseWriteCommand: null/undefined 输入按空串处理", () => {
	assert.deepEqual(parseWriteCommand(null), { kind: "status" });
	assert.deepEqual(parseWriteCommand(undefined), { kind: "status" });
});

// ────────────────────────────────────────────────────────────────────────────
// resolveConfig()
// ────────────────────────────────────────────────────────────────────────────

test("resolveConfig: 默认值", () => {
	assert.deepEqual(resolveConfig(undefined), { projectsDir: "writing", command: "write", enableTools: true, enablePrompt: true });
	assert.deepEqual(resolveConfig({}), { projectsDir: "writing", command: "write", enableTools: true, enablePrompt: true });
});

test("resolveConfig: 自定义合法值", () => {
	assert.deepEqual(resolveConfig({ projectsDir: "docs/projects", command: "draft" }), {
		projectsDir: "docs/projects",
		command: "draft",
		enableTools: true,
		enablePrompt: true,
	});
});

test("resolveConfig: 非法命令名回落 write", () => {
	assert.equal(resolveConfig({ command: "写" }).command, "write");
	assert.equal(resolveConfig({ command: "1abc" }).command, "write");
	assert.equal(resolveConfig({ command: "has space" }).command, "write");
	assert.equal(resolveConfig({ command: "" }).command, "write");
});

test("resolveConfig: 命令名大小写归一", () => {
	assert.equal(resolveConfig({ command: "Write" }).command, "write");
	assert.equal(resolveConfig({ command: "DRAFT" }).command, "draft");
});

test("resolveConfig: 开关显式 false 生效，其他假值不生效", () => {
	assert.equal(resolveConfig({ enableTools: false }).enableTools, false);
	assert.equal(resolveConfig({ enablePrompt: false }).enablePrompt, false);
	assert.equal(resolveConfig({ enableTools: 0 }).enableTools, true); // !== false
});

test("resolveConfig: projectsDir 空白回落默认", () => {
	assert.equal(resolveConfig({ projectsDir: "   " }).projectsDir, "writing");
	assert.equal(resolveConfig({ projectsDir: "" }).projectsDir, "writing");
});
