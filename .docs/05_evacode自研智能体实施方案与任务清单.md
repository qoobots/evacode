# Evacode 自研 AI 编程智能体 · 实施方案与任务清单

> 状态：**方案已定，待执行**　|　制定日期：2026-10-15　|　代码基线：`a2e2cca6`（branch `main`）
> 上游文档：`.docs/04_evacode自研AI编程智能体头脑风暴.md`（发散与决策记录）
> 本文是 04 的收敛产物：把已拍板的 7 条结论落成可执行的技术路径与任务清单。

---

## 0. 结论摘要（TL;DR）

| 结论 | 依据 | 影响 |
|---|---|---|
| **自研智能体做成内置扩展 `extensions/eva-agent`，不进 agent host 核心** | Q2：以插件形式存在 | 核心 fork diff **可为 0** |
| **这条路是官方 API 支持的一等路径，不是绕路** | `extensions/copilot/src/extension/chatSessions/` 里的 Copilot CLI 会话**本身就是扩展实现的** | 有生产级样板可抄 |
| **第一目标是"用起来最好"，不是"架构自主"** | Q1 | **评测体系升格为核心工程，P0 就启动** |
| **商业第一诉求是任务处理能力与质量** | Q3 | D3 接地 / D2 上下文 为两大支柱；合规降为及格线 |
| **模型侧是 DeepSeek / Qwen 最新版** | Q4 | 需针对性适配其脾气，长程工具能力须实测 |
| **必须支持内网部署与自定义模型来源** | Q5 | 新增 D8：模型来源可配置（硬需求） |
| **评测从零自建** | Q6 | 新增 W-Eval 工作线 |
| **Copilot / Claude / Codex 三家保留并存** | Q7 | 我们是**第四种并列会话类型**；且三家天然构成评测对照组 |

**一句话方案**：
> 做一个内置扩展 `eva-agent`，用 `chatSessionsProvider` 提案 API 拿到完整会话体验，
> 在扩展宿主内跑自研 loop，通过 `vscode.lm.selectChatModels()` 用 EVA（DeepSeek/Qwen）或用户自定义端点推理，
> 用自研的接地工具与上下文引擎把"任务处理能力和质量"做上去，并用自建评测体系证明它真的更好。

---

## 1. 决策基线（来自 04 §8）

| # | 拍板结果 |
|---|---|
| Q1 | 用起来最好的智能体（结果导向） |
| Q2 | 接受 fork diff；**自研智能体以插件形式存在** |
| Q3 | 商业看重：**强大的任务处理能力和质量** |
| Q4 | 模型 = 接入最新版国内大模型（DeepSeek、Qwen） |
| Q5 | **要求内网部署可用**；支持自定义接入本地大模型或 Qwen/DeepSeek apikey |
| Q6 | **没有评测，需要我们自己做** |
| Q7 | 保留 Copilot / Claude / Codex 三家并存 |

---

## 2. 架构：`extensions/eva-agent` 插件

### 2.1 为什么插件形态能成立（代码事实）

Copilot CLI 的会话**不是**在 agent host 核心里实现的，而是一个扩展：

| 能力 | 扩展 API | 声明位置 |
|---|---|---|
| 拥有一种会话类型的**内容**与**默认参与者** | `vscode.chat.registerChatSessionContentProvider(scheme, provider, defaultParticipant, capabilities?)` | `src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts:599`；实际调用 `extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts:187` |
| 拥有**会话列表** | `vscode.chat.createChatSessionItemController`（新）/`registerChatSessionItemProvider`（旧，`:45` 已标记 deprecated） | 同 d.ts `:48`；实际调用 `copilotCLIChatSessions.ts:179` |
| 声明会话类型（名称/图标/欢迎语/能力开关/`when`） | `contributes.chatSessions` | `extensions/copilot/package.json:6701-6726` |
| 启用提案 API | `enabledApiProposals` | `extensions/copilot/package.json:145` 含 `chatSessionsProvider` |
| **在扩展内选模型** | `vscode.lm.selectChatModels()` — **稳定 API** | `src/vscode-dts/vscode.d.ts:20770` |
| **贡献工具** | `vscode.lm.registerTool(name, tool)` — **稳定 API** | `src/vscode-dts/vscode.d.ts:20778` |
| 声明式注册工具 | `contributes.languageModelTools` | `extensions/copilot/package.json:158` |

**结论**：会话 UI、模型选择器、工具注册表、附件能力**全是白拿的**，自研 loop 只需在扩展宿主内跑。

### 2.2 Loop 流程（扩展宿主内闭环）

```
用户在 eva-agent 会话输入
        │
        ▼
  ChatParticipant（我们自己的 default participant）
        │
        ├─► ContextEngine：组装本次请求的上下文（预算分层/压缩/接地检索结果）
        │
        ├─► selectChatModels({ vendor: 'eva-ai' })  ← 或直接走自定义端点适配器
        │
        ▼
  model.sendRequest(messages, { tools }, token)
        │
        ├─ 文本/思考 → 流式回 ChatResponseStream
        │
        ├─ tool_calls ──► ToolRouter：执行（含权限确认）──► 结果回灌 messages
        │                                                        │
        └──────────────────── 循环，直到无 tool_call 或达终止条件 ◄┘
```

关键点：**prompt 怎么组装、工具怎么调度、什么时候停，全部由我们决定**——这正是 04 里 V1（SDK 能否自定义 prompt 组装）在路线 I 下的阻塞点，在 I′ 下自动消解。

### 2.3 目录结构（建议）

```
extensions/eva-agent/
├─ package.json                # contributes.chatSessions / languageModelTools / configuration
│                              # enabledApiProposals: ["chatSessionsProvider", ...]
├─ esbuild.mts                 # 照抄 eva-ai 的打包方式（注意 95af276c 踩过的 main 指向坑）
└─ src/
   ├─ extension.ts             # activate：注册会话 provider + 工具 + 命令
   ├─ evaAgentSession.ts       # ChatSessionContentProvider：会话内容、历史、恢复
   ├─ evaAgentSessions.ts      # ChatSessionItemController：会话列表
   ├─ evaAgentParticipant.ts   # 默认 ChatParticipant：请求入口
   ├─ loop/
   │  ├─ agentLoop.ts          # 规划—工具—观察 主循环、终止判定
   │  ├─ toolRouter.ts         # 工具选择、参数校验、失败重试与降级
   │  └─ plan.ts               # 计划先行（可选，配合 ChatResponseStream 展示）
   ├─ context/
   │  ├─ contextEngine.ts      # 预算分层、引用化
   │  ├─ compaction.ts         # 结构化压缩（工具往返折叠为结论+引用）
   │  └─ tokenProfile.ts       # 中文 token 画像（沿用 learnCharsPerToken 思路）
   ├─ grounding/
   │  ├─ symbolIndex.ts        # 符号图
   │  ├─ dependencyGraph.ts    # 依赖/影响面
   │  └─ testMapping.ts        # 改动 → 该跑哪些测试
   ├─ tools/                   # 自研工具（registerTool 或 contributes.languageModelTools）
   ├─ model/
   │  ├─ modelSource.ts        # ★ D8：模型来源可配置（EVA/内网/本地/apikey）
   │  └─ adapters/             # 模型适配器：把各家脾气做成可插拔策略
   └─ eval/                    # ★ W-Eval：评测入口（见 §5）
```

### 2.4 与现有代码的关系

| 我们的模块 | 复用/依托 | 是否需改核心 |
|---|---|---|
| 模型推理 | `extensions/eva-ai` 已注册的 `eva-ai` vendor（`vscode.lm.selectChatModels({ vendor: 'eva-ai' })`） | ❌ |
| 接地数据源 | 编辑器已有语言服务、符号索引、git 状态 | ❌（经扩展 API 访问） |
| 会话 UI | `chatSessionsProvider` 提案 API | ❌（仅需 `enabledApiProposals`） |
| 工具生态 | `vscode.lm.registerTool`；也可复用内置工具集 | ❌ |
| 规约注入 | `.github/agents/*.agent.md` + Skill + Hook（含 `hookClaudeCompat.ts` 兼容层） | ❌ |
| 审批/审计 | 先看 `hookTypes.ts` 的 event 能否覆盖（V7）；不够再用核心的 `sessionPermissions.ts` | 🟡 待定 |

---

## 3. D8：模型来源可配置（Q5 硬需求）

目标场景：**内网机器上装好 evacode，不连外网也能用；用户可选的来源不止一家。**

| 来源 | 形态 | 说明 |
|---|---|---|
| ① 内置 EVA 网关（默认） | `eva-ai.baseUrl` 现已在手 | 沿用现有登录与模型目录 |
| ② 内网自建网关 | 同上，改 URL | 需确认 IAM 的 OAuth2 PKCE 能指向内网（**V10**） |
| ③ 本地模型服务 | OpenAI 兼容端点（vLLM / Ollama / LM Studio） | 填 baseUrl + 模型名，可不填 key |
| ④ 直连厂商 | 填 DeepSeek / Qwen 的 apikey + 端点 | 走各家官方 OpenAI 兼容端点 |

设计要点：

1. **统一为"模型来源"列表**，每项含 `{ id, 显示名, baseUrl, apiKey来源, 协议 }`。配置结构建议做成 `eva-agent.modelSources`（数组）。
2. **apiKey 走 Secret Storage**，不落盘——沿用 `eva-ai` 的做法（参照 `extensions/copilot/src/extension/byok/vscode-node/byokStorageService.ts`）。
3. **模型适配器抽象一层**（V11）：把各家差异做成策略，至少覆盖——
   - `evaChat.ts:9-27` 记录的 EVA 网关三特性：**200 响应里返回错误**、**tool_calls 分片**、**扁平 tool_calls 结构与 wire 不一致**
   - `evaCliConfig.ts` 记录的 **kimi-k3 拒绝 temperature** → 需要"参数降级重试"
   - 各家思考链字段差异（`reasoning_content` vs `thinking`）
4. **离线不卡启动**：审计 `src/vs/platform/agentHost/node/agentSdkDownloader.ts` 在离线时是否会阻塞（**V10**）。
5. **多模态待定**：`extension.ts:330-335` 当前硬编码 `imageInput: false`。若 Qwen 最新版支持视觉，需先确认网关能给出能力标记（V4），否则"截图改 UI"做不了。

---

## 4. W-Eval：自建评测体系（Q6）

因为 Q1 定的是"用起来最好"，**评测不是收尾工作，是方向盘**。与开发并行启动。

| 组件 | 内容 |
|---|---|
| **任务集** | 30–50 个真实改动任务。**优先从本仓库 `git log` 里挑**：意图明确 + 可编译/可测试验证的历史提交。每条附人工写好的验收标准 |
| **自动判定** | 优先选可自动判定的任务：`npm run typecheck-client` 通过 / 指定单测通过 / lint 无新增错误 |
| **指标** | ① 任务完成率 ② token 消耗 ③ 工具调用轮次 ④ 人工介入次数 ⑤ 从提问到首个正确编辑的延迟 |
| **横向对照** | 同一任务集分别跑 **Copilot / Claude / Codex / eva-agent** —— **Q7 保留三家恰好给了天然对照组** |
| **回归** | 每次改 loop / 提示词 / 工具后都能一键重跑，出对比表 |

**降级预案**：若自动判定覆盖率不足，先用"人工打分 + 双跑对照"的最小版本启动，不要等完美。

**可复用的现成东西**（待确认，V12）：`src/vs/platform/agentHost/test/` 下有大量 yaml 仿真（含 `src/vs/platform/agentHost/node/codex/` 的 912 文件协议层），仓库已有仿真测试框架，需确认能否直接拿来驱动回归。

---

## 5. 任务清单

### 阶段 0：验证与地基（P0）

- [ ] 0.1 **V9**：确定 `enabledApiProposals` 清单（对照 `extensions/copilot/package.json:138-156`），确认插件可零核心改动启动
- [ ] 0.2 **V10**：审计内网/离线场景——OAuth2 PKCE 能否指向内网 IAM；`agentSdkDownloader.ts` 离线是否阻塞；有无硬编码外网域名
- [ ] 0.3 **V11**：调研 DeepSeek / Qwen 官方端点的协议差异（思考链字段、tool_calls 行为、流式分片）
- [ ] 0.4 **V4**：确认 EVA 网关能否返回模型能力标记（多模态）
- [ ] 0.5 **V5**：用最小任务集实测 DeepSeek / Qwen 的**长程工具使用**能力基线
- [ ] 0.6 **W-Eval 启动**：从 `git log` 挑出 30 个候选任务，写好验收标准
- [ ] 0.7 **W-Eval 启动**：搭最小 runner（能跑一个任务 + 出四项指标）
- [ ] 0.8 抄读样板：通读 `extensions/copilot/src/extension/chatSessions/vscode-node/` 的 `chatSessions.ts`、`copilotCLIChatSessions.ts`、`sessionRequestLifecycle.ts`、`sessionOptionGroupBuilder.ts`

### 阶段 1：插件骨架（P1）—— 目标是"能跑通闭环"，不追求质量

- [ ] 1.1 建 `extensions/eva-agent` 骨架（`package.json` + `esbuild.mts` + `tsconfig`）
- [ ] 1.2 `package.json` 声明 `contributes.chatSessions`（type `eva-agent`，名称/图标/欢迎语）+ `enabledApiProposals`
- [ ] 1.3 实现 `ChatSessionContentProvider` + `ChatSessionItemController`（会话能创建、能列出来）
- [ ] 1.4 实现默认 `ChatParticipant`，接上 `selectChatModels({ vendor: 'eva-ai' })`
- [ ] 1.5 实现最朴素的 loop：文本流 + 工具调用 + 回灌循环 + 终止判定
- [ ] 1.6 接 1–2 个自研工具（先用现成能力，验证工具闭环）
- [ ] 1.7 **打包坑规避**：确认 `main` 指向构建实际产物目录（参照 `95af276c` 修过的 `dist/` vs `out/` 问题）
- [ ] 1.8 验收：能在 eva-agent 会话里完成一个跨多文件的简单改动；三家原有 agent 不受影响（Q7）

### 阶段 2：接地与工具（P2）—— 对应 D3，Q3 的第一支柱

- [ ] 2.1 符号级检索工具（注册为 `vscode.lm.registerTool`，写好 `modelDescription`）
- [ ] 2.2 「改动影响面」工具：给定文件/符号，返回调用链
- [ ] 2.3 测试映射：改动 → 建议运行的测试集合
- [ ] 2.4 git 语义接入（最近变更、责任人、关联提交）
- [ ] 2.5 **评测对照**：同一任务集跑三家 + 我们，记录接地带来的轮次/耗时改善
- [ ] 2.6 验收：指标②（token）与③（轮次）相对 P1 有可测下降

### 阶段 3：上下文引擎（P3）—— 对应 D2，第二支柱

- [ ] 3.1 上下文预算分层（系统/规约/检索/历史/工具输出分区配额）
- [ ] 3.2 结构化压缩：把已完成的工具往返折叠成"结论 + 引用"
- [ ] 3.3 引用化：大文件只放签名 + 行号，按需再取
- [ ] 3.4 中文 token 画像（沿用 `extension.ts:455-464` `learnCharsPerToken` 的思路）
- [ ] 3.5 上下文画像可视化（消费 `eva-ai.trace` 数据，先确认字段够用 —— V8）
- [ ] 3.6 **评测对照**：记录 token 节省与长会话完成率变化

### 阶段 4：模型来源可配置（P4）—— 对应 D8 / Q5

- [ ] 4.1 设计 `eva-agent.modelSources` 配置结构 + Secret Storage 存 key
- [ ] 4.2 实现模型适配器抽象，内置 EVA / 通用 OpenAI 兼容两套
- [ ] 4.3 支持来源：内网网关、本地 vLLM/Ollama、DeepSeek / Qwen 官方 apikey
- [ ] 4.4 参数降级重试与思考链字段归一（覆盖 0.3 调研到的差异）
- [ ] 4.5 验收：**断外网**后仍能完成一次完整改动任务

### 阶段 5：质量打磨与编排（P5）

- [ ] 5.1 计划先行：先出计划 → 人工调整 → 再执行
- [ ] 5.2 失败自愈：编辑 → 编译/类型检查 → 自动修 → 再验证 的收敛循环
- [ ] 5.3 分层选模（复用 `evaCliConfig.ts` `CLI_TIER_MODELS` 的经验，系统化）
- [ ] 5.4 V7：确认 Hook 能否覆盖工具执行前后，用于审批与审计
- [ ] 5.5 （可选）多智能体编排：用 `.github/agents/*.agent.md` 定义角色，由编排器调度

### 阶段 6：评测驱动迭代（贯穿）

- [ ] 6.1 每个阶段结束跑一次全量评测，出四家对比表
- [ ] 6.2 把评测做成回归门禁：指标回退时阻断合并
- [ ] 6.3 持续扩充任务集（目标 50+）

### 明确不做

- ❌ **不替代 Copilot / Claude / Codex**（Q7：三家保留并存）；我们是第四种并列会话类型
- ❌ **不动 Copilot 商标**（既有决策：Copilot 与 `@vscode` 聊天参与者保留不动）
- ❌ **不进 agent host 核心注册第四个 provider**（Q2：插件形态）
- ❌ 不自建私有扩展市场（沿用 doc 02 决策）
- ❌ 不修改 evaswitch（CC Switch）工程（沿用 doc 01 决策）

---

## 6. 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| **提案 API 不稳定**：`chatSessionsProvider` 是 proposed，升级可能变 | 中 | 把对提案 API 的依赖收敛到 `evaAgentSession(s).ts` 两个文件；`enabledApiProposals` 需锁版本（P0-0.1） |
| **国产模型长程工具能力不足** | 高 | P0-0.5 先实测；若不足，先把重心放在接地与上下文（减少模型需要"想"的量），而不是硬上复杂 loop |
| **评测建不起来** → 无法证明"更好" | 高 | Q1 是结果导向，这条是命门。P0 就启动，接受最小可用版本 |
| **插件能力受扩展 API 边界限制**（某些宿主能力没暴露） | 中 | P1 阶段列一张"想要但拿不到"的清单，逐条评估：绕开 / 提 API 需求 / 才动核心（Q2 已授权可动） |
| **离线场景被 SDK 下载/登录流程卡住** | 中 | P0-0.2 专项审计 |
| **多模态能力缺失导致"截图改 UI"做不了** | 低 | P0-0.4 确认；不做也不阻塞主线 |
| **三家并存带来的 UI 与默认策略复杂度** | 低 | 我们的会话类型用 `contributes.chatSessions` 的 `order` / `when` 控制位置与可见性 |

---

## 7. 附录：代码索引

**插件形态的样板（最重要）**
- `extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts:187` — `registerChatSessionContentProvider` 实际调用
- 同目录 `copilotCLIChatSessions.ts:179` — `createChatSessionItemController` 实际调用
- 同目录 `sessionRequestLifecycle.ts`、`sessionOptionGroupBuilder.ts`、`taskTurnStreamer.ts` — 请求生命周期与选项组构造
- `extensions/copilot/package.json:145`（`enabledApiProposals` 含 `chatSessionsProvider`）、`:158`（`languageModelTools`）、`:6701-6726`（`chatSessions` 贡献）

**扩展 API 声明**
- `src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts:45/48/599` — 会话 provider API
- `src/vscode-dts/vscode.d.ts:20770`（`selectChatModels`）、`:20778`（`registerTool`）、`:20851`（`registerLanguageModelChatProvider`）

**模型侧（已有资产）**
- `extensions/eva-ai/src/extension.ts:283-370`（模型目录）、`:330-335`（`imageInput: false`）、`:455-464`（token 校准）
- `extensions/eva-ai/src/evaChat.ts:9-27` — EVA 网关三个坑（200 里返回错误 / tool_calls 分片 / 扁平结构）
- `extensions/eva-ai/src/evaCliConfig.ts` — `CLI_TIER_MODELS`（kimi-k3 拒绝 temperature 的记录）
- `extensions/eva-ai/src/evaProxy.ts`、`evaTrace.ts` — 本地代理与交互日志
- `extensions/copilot/src/extension/byok/vscode-node/byokStorageService.ts` — Secret Storage 做法参考

**接地与工具**
- `src/vs/workbench/contrib/chat/browser/tools/languageModelToolsService.ts`、`common/tools/languageModelToolsService.ts`
- `src/vs/workbench/contrib/chat/common/promptSyntax/hookTypes.ts`、`hookSchema.ts` — Hook（V7 待读）
- `.github/agents/*.agent.md`、`.github/skills/*/SKILL.md` — 自定义 agent 与技能

**核心（原则上不动，仅备查）**
- `src/vs/platform/agentHost/node/agentHostMain.ts:155/171/186` — 三家 provider 注册
- `src/vs/platform/agentHost/node/sessionPermissions.ts`、`sessionSandbox.ts`、`commandAutoApprover.ts`
- `src/vs/platform/agentHost/node/agentSdkDownloader.ts` — 离线风险点（V10）
- `src/vs/platform/agentHost/test/` — yaml 仿真（V12 待评估）

**相关文档**
- `.docs/04_evacode自研AI编程智能体头脑风暴.md` — 发散过程与决策记录
- `.docs/01`、`02`、`03` — 模型接入 / 界面品牌 / 大模型转接
- 仓库记忆：《Windows 构建环境陷阱》《打包流程与耗时》《用真值，不要估算》《遇到疑点就修》《Evacode rebrand: keep Copilot & plugin trademarks》
