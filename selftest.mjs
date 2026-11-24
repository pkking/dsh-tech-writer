import { parseIntent, parseManuscript, checkAlignment, renderReport, coverage, keywords } from "./index.js";
import assert from "node:assert/strict";

// --- keywords / coverage ---
assert.deepEqual(keywords("The Karmada dispatcher"), ["karmada", "dispatcher"]);
assert.deepEqual(keywords("跨集群调度"), ["跨", "集", "群", "调", "度"]);
const cov = coverage("Karmada dispatcher admission", "The Karmada dispatcher owns admission control.");
assert.equal(cov.ratio, 1);
assert.ok(coverage("totally unrelated words", "nothing here matches").ratio < 0.25);

// --- parseIntent ---
const intentText = `# Intent — demo

> note line

## Why
- 解决异构集群调度问题

## Audience
- 平台架构师

## Claims
- [C1] Karmada dispatcher 负责准入仲裁
- [C2] Volcano 提供组级调度

## Structure
- [S1] 背景与问题：集群异构带来的痛点
- [S2] 方案设计：Dispatcher 准入与仲裁

## Decisions
- [D1] 选择 Karmada 而非自研调度器

## Acceptance
- [A1] 读者能说出 Dispatcher 的职责

## Log
- 2026-11-18 初稿`;
const intent = parseIntent(intentText);
assert.equal(intent.title, "Intent — demo");
assert.equal(intent.sections.length, 7);
assert.deepEqual(intent.sections[2].bullets.map((b) => b.id), ["C1", "C2"]);
assert.equal(intent.sections[2].bullets[0].text, "Karmada dispatcher 负责准入仲裁");

// --- parseManuscript ---
const manuscriptText = `# 联邦调度方案

## 背景与问题
集群规模扩大后，异构集群的资源规格差异使调度成为痛点。多集群联邦需要统一准入，避免成员集群各自为政。

## 方案设计
Dispatcher 统一负责准入与资源仲裁。成员集群使用 Volcano 提供组级调度能力。`;
const manuscript = parseManuscript(manuscriptText);
assert.equal(manuscript.words > 40, true);
assert.equal(manuscript.sections.length, 3);
assert.equal(manuscript.sections[1].heading, "背景与问题");
assert.ok(manuscript.sections[1].paragraphs >= 1);

// --- checkAlignment: aligned case ---
const report = checkAlignment(intent, manuscript, manuscriptText);
assert.equal(report.ok, true, `problems: ${JSON.stringify(report.problems)}\nwarnings: ${JSON.stringify(report.warnings)}`);
assert.equal(report.claims.length, 2);
assert.equal(report.claims.every((c) => c.status === "covered"), true, JSON.stringify(report.claims));
assert.equal(report.structure.length, 2);
assert.equal(report.structure[0].heading, "背景与问题");

// --- checkAlignment: missing claim + thin section + missing intent section ---
const brokenManuscript = `# 联邦调度方案

## 背景与问题
集群异构。

## 方案设计
本文提出一种联邦调度参考架构。`;
const brokenReport = checkAlignment(intent, parseManuscript(brokenManuscript), brokenManuscript);
assert.equal(brokenReport.ok, false);
assert.ok(brokenReport.problems.some((p) => p.includes("C1")));
assert.ok(brokenReport.warnings.some((w) => w.includes("过薄")));

const noAudience = parseIntent(intentText.replace("## Audience", "## 读者画像"));
const report2 = checkAlignment(noAudience, manuscript, manuscriptText);
assert.ok(report2.problems.some((p) => p.includes("AUDIENCE")), JSON.stringify(report2.problems));

// --- renderReport smoke ---
const text = renderReport(report);
assert.ok(text.includes("对齐检查：通过"));
assert.ok(text.includes("C1"));
assert.ok(text.includes("S1"));

console.log("ALL PURE TESTS PASSED");
console.log("=== sample report ===");
console.log(renderReport(brokenReport));
