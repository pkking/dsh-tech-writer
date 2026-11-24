# dsh-tech-writer

**Intent-Driven Writing（意图驱动写作）** 的 DeepSeek Harness 插件：为文章、长文、技术架构说明书等维护两份关联文档——

- **intent.md（意图模型，作者侧）**：Why、Audience、Claims `[C#]`、Structure `[S#]`、Decisions `[D#]`、Acceptance `[A#]`、Log。
- **manuscript.md（正文，读者侧）**：最终向读者呈现的论证与结论。

核心命题：**正文是意图的有损表达**——正文无法唯一还原作者的目标、推理与取舍，因此意图必须作为独立、持久、可追溯的知识资产单独保存（相当于文档的 ADR / Design Rationale）。

## 理论基础

| 理论 / 实践 | 与本插件的关系 |
|---|---|
| Flower & Hayes（1981）写作认知过程模型 | 意图与正文是写作过程的不同认知层次 |
| Reiter & Dale《Building Natural Language Generation Systems》 | intent.md ≈ Content Determination + Document Planning；manuscript.md ≈ Surface Realisation |
| Design Rationale / ADR（Nygard 2011） | intent.md 是文档的设计决策记录：选了什么、放弃了什么、为什么 |
| Book Proposal / Story Bible（出版业实践） | 提案保存设计意图，正文是面向读者的表达 |
| Knowledge Transforming + Reverse Outlining | 双向演进：意图→正文（brief）、正文→意图（sync，反向提纲） |

## 功能

| 入口 | 作用 |
|---|---|
| `/write` 或 `/write status` | 列出写作项目及各项目对齐概况 |
| `/write init <项目>` | 在 `writing/<项目>/` 脚手架生成 intent.md + manuscript.md（手工模式） |
| `/write plan <项目> [一句话]` | **推荐入口**：从一句话起草意图——分诊后低赌注直接起草+〔假设〕标注，高赌注拷问式访谈（≤5 轮一问），模型写好 intent.md 供用户审阅，立场红线防意图外包 |
| `/write brief <项目>` | 把 intent.md（+CONVENTION.md +research.md）注入下一轮对话，驱动模型按意图写作 |
| `/write audit <项目>` | 反向提纲对齐检查：主张覆盖 `[C#]`、结构映射 `[S#]`（**双向**：含意图外章节漂移检测）、薄节、**长句**、**Glossary 术语违规**、意图小节完整性、确定性断言（含 `facts-from` 防编造） |
| `/write figures <项目>` | **图表补全**：未满足的 `[F#]`/断链/空 alt 排队给模型生成（落盘 `assets/`、插入对应节、复验） |
| `/write figtest <项目>` | **视觉读者测试**：无上下文 subagent 用 read_image 看图答题，验证 `[F#]` 图意，引用视觉元素为证（禁脑补） |
| `/write readtest <项目>` | **独立读者测试**：无上下文 subagent 只读正文，逐条回答 `[A#]` 验收问题——验收从人工核对变为可验证 |
| `/write doctest <项目>` | **示例执行**：正文代码块排队给模型，在沙箱与审批体系内逐块执行、归因 pass/fail、修后复跑 |
| `/write sync <项目>` | 把 manuscript.md 注入下一轮，让模型做反向提纲并回写 intent.md |
| 工具 `writer_read_intent` | 读意图模型与正文统计（模型自主调用） |
| 工具 `writer_outline` | 提取正文实际提纲与逐节统计 |
| 工具 `writer_check_alignment` | 意图↔正文对齐检查（audit 的工具形态） |
| 系统提示小节 | 向模型注入方法说明：何时读意图、何时跑对齐、何时读者测试、何时回写 |

文件布局（`CONVENTION.md` 与 `research.md` 均为可选）：

```
writing/
├── CONVENTION.md          # 可选：跨文档持久约束；`## Glossary`（规范词 | 禁用词）由 audit 强制执行
└── <项目>/
    ├── intent.md          # 意图模型（必需；可选 ## Figures 小节声明 [F#]）
    ├── manuscript.md      # 正文（必需）
    ├── CONVENTION.md      # 可选：本项目约束，叠加在全局之上
    ├── research.md        # 可选：研究材料，[C#] 主张的证据基础
    └── assets/            # 图表资产（/write figures 生成，audit 校验断链/孤儿）
```

模型只通过 `ctx` 服务（fs / tools / commands / systemPrompt）工作，工具均为**只读**，写作由模型自身完成——意图资产始终是普通 Markdown 文件，可被 git 跟踪、可手工维护。

## 快速上手

以下示例均为真实输出（`/tmp/usage-demo` 复现）。前提：插件已安装，工作目录下会有 `writing/` 目录。

### 第 1 步：创建项目（两种方式）

**方式 A（推荐）：从一句话开始，模型分诊后起草意图**

```
/write plan karmada-guide 写一篇 Karmada 联邦调度架构说明，给评估多集群方案的平台工程师
```
```
已创建 karmada-guide 的脚手架，并把意图起草排入下一轮：模型将基于你的
描述（必要时追问 ≤5 个问题），起草 intent.md 供你确认。你只需审阅与
修改，不必从零写。
```

模型先**分诊**（判断意图缺口与赌注），再选路径：

- **低赌注**（说明文、低冲突）→ 直接起草，凡替你做的判断都显式标〔假设 N〕——推翻假设比回答问题便宜；
- **高赌注**（说服、选型、立场）→ **拷问式访谈（grilling）**：逐轮一问、最多 5 轮，每问必须暴露一个具体缺口（立场冲突、缺失判据、没想过的读者反例）并附理由，禁填表式问题；
- 无论哪条路，**立场红线**：`[C#]` 主张必须源自你的原话或访谈回答，模型可以挑战但不得替你发明立场——否则整套验证就是在验证稻草人。

**你的角色从『意图作者』降为『意图审阅者』。**

**方式 B：手工模式**

```
/write init karmada-guide
```
```
已创建 writing/karmada-guide/intent.md 与 manuscript.md。

下一步：填好 intent.md 的 Why/Audience/Claims/Structure/Acceptance，
然后 /write brief karmada-guide 开始写作。
```

### 第 2 步：审阅意图（intent.md）

方式 A 下模型已起草草案，你逐节确认/修改即可；方式 B 下把脚手架占位符换成真实内容。一份完整的意图长这样（技术架构说明）：

```markdown
# Intent — Karmada 架构说明

## Why
- 读者不明白为什么多集群调度需要独立的准入组件，本文给出体系化解释

## Audience
- 有 Kubernetes 经验、正在评估多集群方案的平台工程师

## Claims
- [C1] Karmada Dispatcher 负责多集群的准入与资源仲裁
- [C2] 成员集群内 Volcano 提供组级调度能力
- [C3] Karmada Override 机制解决异构集群的资源规格差异

## Structure
- [S1] 背景：多集群调度的痛点
- [S2] 架构：Dispatcher 与成员集群的分工
- [S3] 异构：Override 与资源规格转换

## Decisions
- [D1] 以 Karmada 为例而非自研调度器，因为社区活跃且 CNCF 毕业

## Acceptance
- [A1] 读者能说出 Dispatcher 与成员集群调度器的职责边界
- [A2] 读者能解释 Override 为什么必要
- [A3] 术语统一：全文用「调度器」而非 scheduler { not-contains: "scheduler" }

## Log
- 2026-11-18 初稿意图
```

填写原则：`[C#]` 一句一个可验证的主张；`[S1]` 的文字要能和正文标题对上关键词；`[A#]` 写「读者读完应能……」。

**能机器验证的，用确定性断言**：任何条目行尾可加 `{ key: value }` 断言块，audit 以纯代码执行 pass/fail（不经 LLM，无幻觉面），失败的断言直接判为问题：

| 断言 | 语义 | 验证对象 |
|---|---|---|
| `{ contains: "x" }` / `{ not-contains: "x" }` | 正文包含 / 不得包含指定文本 | 词面（Vale 式） |
| `{ regex: "..." }` | 正文匹配正则 | 词面 |
| `{ min-words: N }` / `{ max-words: N }` | 总词数下/上限 | 规模 |
| `{ headings-include: "x" }` | 某个标题包含指定文本 | 结构 |
| `{ code-lang: bash }` | 至少存在一个该语言的代码块 | 可执行切片（真执行用 `/write doctest`） |
| `{ facts-from: "research.md" }` | 正文全部量化声称（百分比/倍数/版本/年份/带单位量）逐项在 research.md 中溯源 | **忠实性**：LLM 编数字当场 fail |

无法形式化的语义条目（如 A1/A2）保持纯文本，交给 `/write readtest` 的 LLM 读者测试——**机器能验的机器验，机器验不了的才给概率性验证**。

### 第 3 步：驱动写作（brief）

```
/write brief karmada-guide
```
```
已把 karmada-guide 的意图模型排入下一轮：模型将按 intent.md 写作/修订 manuscript.md。
```

这会向当前会话排入一条用户消息，下一轮模型收到：

```
请按意图模型写作/修订正文 manuscript.md。

方法（Intent-Driven Writing）：正文是意图的有损表达。写作时以 intent.md 为唯一
设计依据；结构按 Structure 小节的 [S#] 落成标题；每个 [C#] 主张必须有一处明确
的论证承载；取舍遵循 [D#]；写完对照 [A#] 自查。
若写作过程中发现意图本身要变（新增主张、调整章节职责、改变取舍），先更新
intent.md 再继续正文，并在 intent.md 的 Log 小节记一行。

intent.md 内容：
…（后接 intent.md 全文，上限 20000 字符）
```

之后正常对话即可（例如「开始写吧」或直接等模型动笔）。

### 第 4 步：审计（audit）

正文写出后跑反向提纲检查。假设模型写的正文漏了 `[S3]` 一节：

```
/write audit karmada-guide
```
```
对齐检查：发现 1 个问题
规模：正文 113 词 / 3 节；主张 3 条；章节职责 3 条；验收 3 条。

主张覆盖（反向提纲）：
  ✓ C1（100%）Karmada Dispatcher 负责多集群的准入与资源仲裁
  ✓ C2（71%）成员集群内 Volcano 提供组级调度能力
  ✓ C3（50%）Karmada Override 机制解决异构集群的资源规格差异

结构映射：
  ✓ S1 → 背景：多集群调度的痛点 ｜ 背景：多集群调度的痛点
  ✓ S2 → 架构：Dispatcher 与成员集群的分工 ｜ 架构：Dispatcher 与成员集群的分工
  ✗ S3 → (未匹配) ｜ 异构：Override 与资源规格转换

验收标准（需人工核对）：
  • A1 读者能说出 Dispatcher 与成员集群调度器的职责边界
  • A2 读者能解释 Override 为什么必要
  • A3 术语统一：全文用「调度器」而非 scheduler

确定性断言（机器可验，不经 LLM）：
  ✓ A3 {not-contains: "scheduler"} — 正文不含「scheduler」

关键取舍（供审查）：
  • D1 以 Karmada 为例而非自研调度器，因为社区活跃且 CNCF 毕业

问题：
  ✗ 章节职责 S3 找不到对应标题：异构：Override 与资源规格转换
```

⚠️ 注意上面这个真实例子里 C3 标了 50%「✓」——关键词（Karmada、资源、规格…）在前两节散落出现过，但 S3 这一节根本没写，主张其实没有被论证。**关键词覆盖是启发式，只用于快速定位可疑缺口；结构映射 ✗ 和人工核对 [A#] 才是可靠信号。**

### 第 5 步：迭代（两个方向）

- **正文偏离意图** → 继续对话让模型修（「把 S3 一节补上」），修完再 audit；
- **写作让你改变了想法**（比如写到一半发现还要加一条主张）→ `/write sync karmada-guide`，下一轮模型做反向提纲并回写 intent.md（记入 Log 小节），意图与正文双向演进。

随时 `/write status` 查看所有项目的对齐概况：

```
写作项目（writing/）：
  • demo — 正文 27 词，主张 2 条，4 个待修问题
```

### 第 6 步（可选）：独立读者测试

audit 的结构对齐与确定性断言通过后，用**没有作者上下文的读者**验证机器验不了的语义验收标准：

```
/write readtest karmada-guide
```
```
已把 karmada-guide 的读者测试排入下一轮：模型将用无上下文的 subagent
通读正文，并逐条验证 2 条语义验收标准（另有 1 条已由确定性断言机器验证）。
```

注意分流：A3 带 `{ not-contains: "scheduler" }` 断言，audit 已用纯代码验证，**不进入**读者测试出题范围；只有 A1/A2 这类语义条目交给读者。下一轮模型收到（节选）：

```
请对正文执行独立读者测试（Reader Test）。

原理：正文的作者知道太多，无法可靠判断读者能否看懂；用一个没有作者
上下文的「新读者」验证文档是否达成目标（源自 Anthropic 文档协作流程）。

步骤：
1. 启动一个全新 subagent（不继承本对话任何上下文），只发给它下面的
   manuscript.md 全文——不给 intent.md、不给任何背景说明。
2. 让它通读后逐条回答验收问题，要求逐字记录它的回答。
…
验收标准（来自 intent.md 的 Acceptance；已剔除带确定性断言、由机器验证的条目）：
- A1 读者能说出 Dispatcher 与成员集群调度器的职责边界
- A2 读者能解释 Override 为什么必要

以下条目带确定性断言，audit 已机器验证，无需读者测试：
- A3 术语统一：全文用「调度器」而非 scheduler（断言已在 audit 执行）
…
```

读者全 pass → `[A#]` 从「人工核对」升级为「已验证」；fail 的条目由模型区分「正文没写到」（修正文）还是「标准本身不合理」（回写 intent.md）。

### 验证器分级（本插件对幻觉问题的回答）

| 验证层 | 机制 | 确定性 | 理论依据 |
|---|---|---|---|
| 结构层 | heading 树、结构映射、意图外章节 | ✅ 纯代码 | 投影的结构不变量可判定 |
| 词面/风格层 | `{contains}/{not-contains}/{regex}` 断言 | ✅ 纯代码 | Vale / ASD-STE100 同类 |
| 规模层 | `{min-words}/{max-words}` | ✅ 纯代码 | 度量可计算 |
| 可执行切片 | `{code-lang}`（未来：真执行代码块，doctest 式） | ✅（当前仅存在性） | 文档示例可执行验证 |
| 语义层 | readtest：LLM 读者 + 逐字证据链 + 人工可复核 | ⚠️ 概率性 | 自然语言语义等价不可判定；这是不可形式化层的业界标准做法 |

原则：**能形式化的维度绝不交给 LLM；LLM 只承接不可判定的语义残差，且必须留下可人工复核的证据**（读者原话摘录）。业界同构：Lean+LLM（形式内核 + LLM 辅助）、PBT+LLM。

### 三种用法

| 场景 | 用法 |
|---|---|
| **plan 驱动**（推荐） | `/write plan <项目> <一句话>` → 模型访谈+起草意图 → 你审阅 → brief → audit/readtest → sync。你只维护意图与裁决 |
| **模型自主** | 装好插件后系统提示已含方法说明；对模型说「按意图驱动写作流程写一篇 X」，它会自己调 `writer_read_intent` → 写作 → `writer_check_alignment` |
| **纯手工 + 审计器** | 不用命令，手工维护两个文件，只在交付前 `/write audit <项目>` 当 lint 用 |

## 意图梳理为什么是「分诊」而不是单一模式

| 模式 | 何时用 | 为什么 |
|---|---|---|
| 用户直接写 | 已想清楚、格式熟练 | 零等待；但空白页问题 + 你不知道你不知道什么 |
| 模型直接起草 | 低赌注 | 最快；风险是**意图外包幻觉**——模型发明平庸意图，用户懒得改就接受，验证体系的地基变稻草人 |
| 拷问式反问（grilling） | 高赌注 | 意图从用户自己的话长出来；反问的价值不是收集信息而是**制造思考**（Flower & Hayes：planning 是生成想法不是记录想法；出版业 developmental editing；grilling skill 同构）——每问暴露一个冲突/判据缺失/读者反例 |

协议因此强制三件事，把不可形式化层的质量风险压到可发现：分诊结论必须先给出（不允许跳过）、〔假设〕必须显式列出（推翻比回答便宜）、立场必须源自用户原话（模型可挑战不可代写）。**梳理质量本身属于语义层，无法确定性验证**——能保证的是低质量梳理一定留下可见的痕迹（没有分诊结论、假设缺列、立场无出处），供人当场发现。

## 用户到底要维护什么

设计的北极星是「**用户只维护意图**」，v0.4 后的现实边界：

| 负担 | 归属 | 说明 |
|---|---|---|
| 写意图 | ✅ 已卸下 | plan 让模型起草，用户审阅修改——格式学习成本从「写」降为「读」 |
| 写正文 | ✅ 已卸下 | brief 之后模型写作，约束/证据随意图自动注入 |
| 结构/约束/规模验证 | ✅ 已卸下 | 确定性断言纯代码执行 |
| 语义验收 | ⚠️ 半卸下 | readtest 机器跑读者，但 pass/fail 证据留给人复核——这是设计上的保留（防 LLM 自证） |
| 触发节奏 | ⚠️ 半卸下 | 命令是精控模式；自驾模式下模型会自主调工具，但无强制 gate |
| 归因裁决 | ❌ 保留给人 | audit 报告的每个 ✗ 是「正文错」还是「意图过时了」——这是人独有的判断，自动化它恰恰会制造漂移 |

意图/正文就是磁盘上的 Markdown：可以直接用编辑器改、git diff、多人协作，插件随时基于当前文件状态重新审计。

## 借鉴分析（v0.2）

对照五个同类实践逐项评估后，采纳四项、明确不采纳一项：

| 来源 | 核心机制 | 与目标的匹配 | 决策 |
|---|---|---|---|
| Anthropic Doc Co-Authoring | 收集写作背景、逐节优化、独立读者测试 | 高：写作过程 | ✅ **采纳「独立读者测试」** → `/write readtest`。此前 `[A#]` 验收在 audit 里只能标注 "manual"；现在由无上下文 subagent 读正文、答题、判 pass/fail，验收闭环 |
| OpenSpec | Proposal → Specs → Design → Tasks 可定制产物流水线 | 高：意图管理 | ❌ **不采纳**。多级产物会稀释「意图 = 唯一设计资产」的极简模型，且阶段间 gate 职能已由 audit 承担；双文档是有意取舍而非缺陷 |
| GitHub Spec Kit | Constitution（跨文档约束）+ 一致性检查 | 高：约束与验证 | ✅ **采纳 Constitution** → `CONVENTION.md`（`writing/` 全局 + 项目级，叠加生效），brief 自动注入并声明优先级；一致性检查即 audit 本职 |
| STORM | 研究 → 大纲 → 带引用长文 | 中高：文章生成 | ✅ **轻量采纳「证据基础」** → 可选 `research.md`，brief 注入为 `[C#]` 的证据基础，主张可溯源；研究/检索本身不是本插件职责 |
| Scrivener | 正文、章节摘要、笔记、研究分离管理 | 中：书籍写作 | ✅ **采纳「结构漂移可见性」** → audit 新增反向检查：正文出现无 `[S#]` 对应的章节（H2+，主标题除外）时告警；多文件 binder 暂不做，单文件 + 意图已覆盖当前场景 |

## 图表（一图胜千言，v0.5/v0.6）

图表是意图的**视觉表达**，与正文同源同约束，走同一套双向漂移模型 + 分层质量保证：

**意图侧**（intent.md 可选小节）：

```markdown
## Figures
- [F1] 两级调度数据流 | assets/flow.svg
- [F2] 部署拓扑示意
```

**正文侧**：markdown 图片引用 `![有信息量的替代文本](assets/flow.svg)`。

**质量分层**（每层用最强可用验证器）：

| 层 | 检查 | 机制 | 确定性 |
|---|---|---|---|
| 资产完整性 | 未引用 `[F#]` → problem；断链 → problem；意图外图片 → warning；空 alt → warning；孤儿 → warning | audit 纯代码（路径精确 + 描述↔alt 关键词匹配） | ✅ |
| **技术有效性** | 0 字节 / 魔数非 PNG/JPEG/GIF/WebP / SVG 缺 `<svg>` 根 → problem「图片文件无效」 | `classifyImageBytes`：readBytes 读头部做魔数判定 | ✅ 纯代码 |
| **表达力** | 图是否表达了 `[F#]` 声明的意图 → `/write figtest` 视觉读者测试 | 无上下文 subagent 用 **read_image** 看图答题，**禁止凭描述脑补**——只准引用图里真实可见的元素（组件、箭头、标签）作证据；fail 归因分岔：图画错 → figures 重生成；`[F]` 要求不合理 → 回写 intent.md | ⚠️ LLM 判定 + 视觉证据链，人工可复核 |
| 美学 | 好不好看 | 不自动化（伪需求），人眼 | — |

**生成侧**：`/write figures <项目>` 把未满足的 `[F#]`、断链、空 alt 排队给模型——用环境可用的绘图技能（archify/mermaid/matplotlib…）生成到 `assets/`、以有信息量的 alt 插入对应小节、修后自动复验 audit。图表文件与正文同受 git 跟踪。

## 正文质量金字塔（v0.4，输出侧的质量保证）

意图闭环后，正文质量按层保证——每层用最强可用验证器，业界同构：

| 质量层 | 机制 | 确定性 | 业界同构 |
|---|---|---|---|
| **正确性** | `/write doctest`：正文代码块排队给模型，在**沙箱与审批体系内**用 bash 逐块执行，fail 归因（示例错→修正文；环境缺依赖→标注不改正文），修后复跑 | 执行即真值 | Rust doc-tests / Python doctest |
| **忠实性**（防编造） | 断言 `{ facts-from: "research.md" }`：确定性提取正文全部量化声称（百分比/倍数/版本/年份/带单位量，fence 内容除外），逐项验证在证据源中存在——LLM 编造「延迟降低 99%」当场 fail 并列出未溯源项 | ✅ 纯代码 | RAG faithfulness/groundedness 评测 |
| **一致性** | CONVENTUTION.md 的 `## Glossary` 小节（`- 规范词 \| 禁用词1, 禁用词2`）由 audit 自动执行：散文出现禁用词 → problem（代码块内不检查） | ✅ 纯代码 | 术语表 enforcement |
| **清晰性** | 长句检测：>100 字单句 → warning（fence 内容除外） | ✅ 纯代码 | 可读性度量的稳妥子集 |
| **结构性** | 结构映射（双向）、薄节、意图外章节 | ✅/启发式 | Spec Kit 一致性检查 |
| **说服力** | `/write readtest`：无上下文读者验证 `[A#]`，证据链人工可复核 | ⚠️ LLM 判定 | Anthropic reader test |

诚实边界：忠实性断言防的是**量化型编造**（数字、版本、年份）——这是 LLM 幻觉中最危险且可确定性提取的一类；定性叙述的事实性仍属语义层（readtest + 人工）。doctest 的执行质量取决于沙箱环境，协议强制「环境限制」与「示例错误」分道，防止把环境问题误改成文。

## 形式化验证层（v0.3，对「LLM 幻觉」的回答）

业界（Vale、ASD-STE100、doctest、RDF+SHACL、Lean+LLM 组合）的一致答案：**不是全部形式化，而是验证器分级**——能形式化的维度绝不交给 LLM，LLM 只承接不可判定的语义残差，且必须留下可人工复核的证据。理论边界：意图→正文是有损投影，确定性验证器只能检查投影的不变量（结构、词面、可执行切片）；自然语言语义等价不可判定，LLM 读者测试是该层的标准做法。

落地：intent.md 任意条目行尾可加 `{ key: value }` **确定性断言**，audit 纯代码执行（无 LLM、无幻觉面）；`/write readtest` 自动分流——带断言的条目机器验证，不出题；只有纯语义条目交给无上下文读者。语法表见「快速上手 · 第 2 步」。

| 断言 | 验证层 | 业界同构 |
|---|---|---|
| `{ contains }` / `{ not-contains }` / `{ regex }` | 词面 | Vale 规则、ASD-STE100 检查器 |
| `{ min-words }` / `{ max-words }` | 规模度量 | 可读性度量 |
| `{ headings-include }` | 结构 | Spec Kit 一致性检查 |
| `{ code-lang }` | 可执行切片 | doctest（存在性；真执行用 `/write doctest`） |
| `{ facts-from: "research.md" }` | **忠实性/防编造** | RAG faithfulness 评测：正文量化声称逐项溯源证据库 |

工程细节：断言块只有**全部 key 在白名单**才被提取（普通花括号如 JSON 示例零误判）；带 id 条目上拼错的 key 产生「疑似断言」warning，绝不静默失效；非法正则报 invalid 而非 fail。

## 配置

`cordis.patch.yml` 行内 config：

```yaml
- id: tech-writer
  name: dsh-tech-writer
  config:
    projectsDir: writing   # 项目根目录（相对会话工作目录），默认 writing
    command: write         # 斜杠命令名，默认 write
    enableTools: true      # 注册 writer_* 工具
    enablePrompt: true     # 注入系统提示方法小节
```

## intent.md 小节

| 小节 | 必填 | 内容 |
|---|---|---|
| `## Why` | ✓ | 整篇与各章要解决什么问题 |
| `## Audience` | ✓ | 目标读者、已知、关切 |
| `## Claims` | ✓ | 核心主张，编号 `[C1]`、`[C2]`… |
| `## Structure` | ✓ | 章节职责，编号 `[S1]`、`[S2]`… |
| `## Decisions` | — | 关键取舍 `[D1]`…（审计时列出供人工审查） |
| `## Acceptance` | ✓ | 验收标准 `[A1]`…（读者读完应能……） |
| `## Log` | — | 双向演进记录：正文写作改变了哪些认知、何时回写 |

## 工作流（双向演进）

```
意图 → brief → 正文 → audit（反向提纲对齐） → 
   ├─ 正文偏离意图 → 修正文
   └─ 意图过时（认知进化） → sync 回写 intent.md（记入 Log）
```

对齐算法（纯函数，可离线测试）：
- **主张覆盖**：`[C#]` 文本关键词在正文中的覆盖率（CJK 单字 + ≥2 字符拉丁词，去停用词）；≥50% 为覆盖，25%–50% 为弱覆盖，<25% 判缺失。
- **结构映射**：`[S#]` 与正文标题关键词匹配度；同时检查出现顺序与意图一致。
- **薄节检测**：正文小节 < 20 词告警。
- **意图完整性**：缺 Why/Audience/Claims/Structure/Acceptance 小节报错。

## 安装

```bash
dsh plugin install /home/lcr/dsh-tech-writer
# 或在 DSH 会话内：plugin_manager install_bundle，target 为本目录绝对路径
```

## 测试

```bash
npm test              # 243 例全量：纯函数 + mock 集成 + 配置 + E2E + 文档一致性 + 借鉴机制 + 断言 + 正文质量 + 图表 + 图片质量
npm run test:unit     # 108 例：pure + command + config（mock ctx，毫秒级）
npm run test:e2e      # 19 例：真实 Cordis 运行时 + 真实 DSH 服务 + 真实磁盘
npm run test:legacy   # 旧入口：selftest.mjs + mocktest.mjs
```

八个层次的分工：

| 套件 | 用例 | 覆盖 |
|---|---|---|
| `tests/pure.test.mjs` | 72 | 纯函数白盒：keywords/coverage（词边界、CJK 子串、阈值边界 0.5/0.25/0.2）、parseIntent/parseManuscript（BOM、fence、CRLF、`#tag` 非标题、容器标题不判薄）、checkAlignment（missing/partial/covered 分档、结构顺序、意图小节缺失）、validProject、parseWriteCommand、resolveConfig |
| `tests/command.test.mjs` | 26 | `/write` 全语法执行路径 + followup 注入（含截断）+ 三个工具（mock ctx） |
| `tests/config.test.mjs` | 10 | apply() 注册面：开关、命令名回落、提示小节文案、自定义 projectsDir |
| `tests/e2e.test.mjs` | 19 | **端到端**：真实 `dsh-fs-local` 原子写落盘、真实 `dsh-commands` 注册/解析/执行 + `command/run`↔`command/done` 生命周期配对、真实 `dsh-system-prompt.assemble()` 包含方法小节、真实 `dsh-tools` 执行管线（standalone 无 agent 调用、isError 错误结算、确定性断言 pass/fail）、native executor 装载、BOM+CRLF 真实文件、audit→修→过的完整闭环 |
| `tests/docs-walkthrough.test.mjs` | 6 | **文档即规格**：README「快速上手」每一步的输出（init/audit 含断言节/brief/sync/status/readtest 分流）与插件实际行为逐字一致 |
| `tests/borrowed.test.mjs` | 18 | **借鉴机制**：反向结构漂移（意图外章节、H1 豁免、无 Structure 不误报）、CONVENTION.md 注入（全局+项目级、层级顺序、缺失不出现）、research.md 证据注入、readtest 消息（不泄露意图、缺 A# 报错、缺正文报错） |
| `tests/assertions.test.mjs` | 18 | **确定性断言**：尾注解析（提取/剥离/多断言/裸词值/普通花括号零误判/任何小节）、七种断言 pass/fail/invalid、未知 key 疑似警告、stats 计数、报告渲染、audit/工具集成、readtest 双向分流、出厂脚手架演示 |
| `tests/quality.test.mjs` | 22 | **正文质量金字塔**：extractFacts（提取/去重/无数化不误提）、facts-from 溯源（pass/编造 fail/无声称平凡 pass/证据缺失 invalid/fence 豁免）、Glossary 执行（违规 problem/代码块豁免/命令链真实解析）、长句检测（fence 豁免）、doctest 编排（块清单/沙箱路由/归因分道/错误分支） |
| `tests/figures.test.mjs` | 20 | **图表（一图胜千言）**：图片引用解析（fence 豁免）、`[F#]` 匹配（路径精确/关键词退化/不匹配）、双向漂移（未引用 problem/意图外 warning/无小节不检查）、断链（含纯文本模式不误报）、空 alt、非法路径、孤儿资产、figures 命令编排（待办/alt 规则/复验） |
| `tests/figquality.test.mjs` | 12 | **图片质量**：classifyImageBytes（四魔数/SVG 前缀与自闭合/空文件/badmagic）、imageHealth 注入（problem 生成/ok 无噪/未提供跳过）、命令链真实 readBytes、figtest 编排（题目清单/禁脑补条款/无图错误分支） |

E2E 环境说明：`devDependencies` 以 `link:` 指向本机 DSH 安装（0.2.2-rc.1），真实服务用 `new Context()` + `ctx.plugin()` 装配；仅 `workingDirectory`（真实 Cordis Service、简化实现）与 agent/session/followup（命令注册表文档约定 的窄 seam）为测试替身——agent loop 本身不属于本插件边界。E2E 抓到的契约点：装配与执行都要求先装载 tool executor（`dsh-tool-executor-native`）；工具错误以 `isError` 结算而非 reject。

## 许可

MIT
