# Evacode 自研 AI 编程智能体 · 实施方案与任务清单

> 状态：**方案已定；P0 基本完成（2 项阻塞），P1 骨架已落地，待真机验收**　|　制定日期：2026-10-15　|　代码基线：`a2e2cca6`（branch `main`）
> 上游文档：`.docs/04_evacode自研AI编程智能体头脑风暴.md`（发散与决策记录）
>
> **任务标记**：✅ 已完成　♋ 正在做　❌ 未开始
> 已完成的条目只留结论；正在做的条目展开到可执行的细粒度。

---

## 0. 结论摘要（TL;DR）

| 结论 | 依据 | 影响 |
|---|---|---|
| **自研智能体做成内置扩展 `extensions/eva-agent`，不进 agent host 核心** | Q2：以插件形式存在 | 核心 fork diff **可为 0** |
| **这条路是官方 API 支持的一等路径** | Copilot CLI 会话**本身就是扩展实现的**（`extensions/copilot/src/extension/chatSessions/`） | 有生产级样板可抄 |
| **前沿原语平台已具备大半，自研范围收敛为 5 件事** | §2 对照分析 | 不需要重造平台，只需要造"脑" |
| **第一目标是"用起来最好"** | Q1 | 评测体系升格为核心工程，P0 启动 |
| **商业第一诉求是任务处理能力与质量** | Q3 | 接地 + 验证闭环 + 上下文压缩 为三大支柱 |
| **模型侧是 DeepSeek / Qwen 最新版** | Q4 | 需针对性适配，长程工具能力须实测 |
| **必须支持内网部署与自定义模型来源** | Q5 | D8：模型来源可配置（发布阻塞项） |
| **评测从零自建** | Q6 | W-Eval 工作线 |
| **Copilot / Claude / Codex 三家保留并存** | Q7 | 第四种并列会话类型；三家天然构成评测对照组 |

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

## 2. 前沿编程智能体架构对照分析（本文核心）

> 本节回答一个问题：**以 2026 年最强的编程智能体（Claude Code / Codex / 同类）为参照，evacode 还缺什么。**
> 结论先说：**平台的"身体"已经很完整，缺的是"脑"——而脑只有 5 块。**

### 2.1 前沿架构的十二条原则

| # | 原则 | 为什么重要 |
|---|---|---|
| 1 | **单一主循环 + 工具使用**，默认不用多智能体 | 编码任务上下文高度耦合，多智能体拆不开；多智能体只适合可并行、只读的探索 |
| 2 | **即时上下文（Just-in-Time）**：给指针不给内容 | 预灌 RAG 已被淘汰；正确做法是给 grep/glob/read，让智能体自己拉 |
| 3 | **上下文隔离**：子任务用干净上下文，只回传蒸馏结果 | 探索性搜索会污染主上下文；隔离是长任务的生命线 |
| 4 | **阈值触发压缩**（compaction） | 长任务必然超窗；没有压缩就没有长任务 |
| 5 | **验证闭环是最大的单一杠杆** | 智能体的能力上限 = **它验证自己结果的能力**；不能验证就必然堆积错误 |
| 6 | **长任务工件化**：进度文件 + 结构化任务清单 + 逐次提交 | 否则长任务必然"失忆"和跑偏 |
| 7 | **工具描述即提示词** | 工具要少而精；`modelDescription` 的投入回报最高 |
| 8 | **思考与工具交织**（interleaved thinking） | 复杂工具调用前先想，显著提升成功率 |
| 9 | **提示词缓存** | 决定成本结构，不只是优化 |
| 10 | **渐进披露**（Skills：name/description 常驻，正文按需） | 能力可以很多，上下文代价必须很小 |
| 11 | **计划先行 / plan mode** | 先对齐再动手，比边想边干可控得多 |
| 12 | **项目级长期记忆** | 跨会话记住"这个项目的坑" |

### 2.2 evacode 现状对照（代码事实）

| 前沿原语 | evacode 现状 | 证据 | 我们的动作 |
|---|---|---|---|
| ① 单一主循环 | **❌ 无**（loop 在三家 SDK 里） | 核心只注册 provider：`agentHostMain.ts:155/171/186` | **自研** |
| ② 即时上下文检索 | **🟡 部分**（copilot 扩展有 `copilot_searchCodebase`；核心无） | `extensions/copilot/package.json:158-1240` | **自研符号/依赖/测试映射工具** |
| ③ 子智能体上下文隔离 | **✅ 已有，且是核心内置** | `src/vs/workbench/contrib/chat/common/tools/builtinTools/runSubagentTool.ts:158-168`（`isolated subagent context`）、`:284/390/464`（独立 `subAgentInvocationId` 路由） | **复用** |
| ④ 上下文压缩 | **🟡 部分**：核心**只有** `PreCompact` 钩子；真正的压缩实现在 copilot 扩展 | 钩子 `common/promptSyntax/hookTypes.ts:18,98-100`、`vscode.proposed.chatHooks.d.ts:11`；实现 `extensions/copilot/src/extension/prompts/node/agent/summarizedConversationHistory.tsx:180-260,606,692` | **自研**（挂 `PreCompact` 钩子即可接入） |
| ⑤ **验证闭环** | **✅ 已有，且覆盖面意外地全** | 测试：`contrib/testing/common/testingChatAgentTool.ts:52-57,73-75,328-330`（`runTests`/`testFailure`）／终端：`common/tools/terminalToolIds.ts:14-25`（`run_in_terminal`/`get_terminal_output`/`run_task`/`get_task_output`）／**浏览器与截图**：`contrib/browserView/electron-browser/tools/`（`screenshotBrowserTool.ts`、`runPlaywrightCodeTool.ts`、`clickBrowserTool.ts` 等 14 个） | **复用并接进 loop** — 最高性价比 |
| ⑥ 长任务工件 | **❌ 无** | — | **自研**（进度文件 + 结构化任务清单） |
| ⑦ 工具描述质量 | **✅ 框架支持** | `modelDescription` 字段；`contributes.languageModelTools` | 精心写即可 |
| ⑧ 交织思考 | **🟡 取决于模型** | 需实测 DeepSeek/Qwen 是否支持思考链与工具交织 | 适配（P0-0.5 实测） |
| ⑨ 提示词缓存 | **✅ 双层已有** | 宿主 `agentHostPromptCache.ts:11-59`；模型侧 `extensions/copilot/src/platform/endpoint/node/messagesApi.ts:271-273`（`cache_control: ephemeral`）、`responsesApi.ts:134-188` | **复用** |
| ⑩ 渐进披露 Skills | **✅ 已有** | 元数据 `promptsService.ts:439-470`；命中才读全文 `extensions/copilot/src/extension/tools/node/skillTool.ts:58-105` | **复用** |
| ⑪ Plan mode | **✅ 已有（核心内置工具）** | `common/tools/builtinTools/reviewPlanTool.ts`；UI `chatPlanReviewData.ts`、`planReviewFeedbackService.ts` | **复用** |
| ⑫ 项目记忆 | **🟡 仅 copilot 扩展有**（`copilot_memory`）；核心无统一服务 | `extensions/copilot/package.json:1139` + `tools/node/memoryTool.tsx` | **自研** |
| ⑬ MCP 工具生态 | **✅ 完整链路** | `vscode.d.ts:20842` `registerMcpServerDefinitionProvider`；配置 `.mcp.json`（`platform/mcp/common/mcpWorkspaceConfiguration.ts:18`）；进 lm 注册表 `contrib/mcp/common/mcpLanguageModelToolContribution.ts:119-120,150` | **复用** |
| ⑭ AGENTS.md 自动加载 | **✅ 已有** | `common/promptSyntax/computeAutomaticInstructions.ts:266-290`；开关 `chat.useAgentsMdFile` | **复用** |
| ⑮ 终端/文件能力（扩展宿主） | **✅ 已有** | `vscode.d.ts:11665` `createTerminal`；`:7885/:7941` `shellIntegration.executeCommand`；`:9603` `FileSystemProvider` | **复用** |

### 2.3 由此收敛：自研范围只有 5 块脑 + 1 条评测线

```
┌──────────────────────────── 平台已有（全部复用，不重造） ────────────────────────────┐
│ 会话 UI · 模型选择器 · 工具注册表 · 子智能体隔离 · Plan Mode · Skills 渐进披露        │
│ 终端/任务 · 测试运行 · Playwright 截图 · MCP · 提示词缓存 · AGENTS.md · 变更集/检查点 │
└────────────────────────────────────────────────────────────────────────────────────┘
                                        ▲
                                        │ 全部经扩展 API 拿到
┌──────────────────────────── eva-agent（我们要写的） ───────────────────────────────┐
│  ① Loop        主循环：思考 → 工具 → 观察 → 终止判定；**强制验证闸门**              │
│  ② Grounding   即时上下文：符号检索 / 依赖影响面 / 测试映射                          │
│  ③ Context     上下文引擎：预算分层 + 阈值压缩（挂 PreCompact）+ 工具结果驱逐         │
│  ④ Memory      项目记忆 + 长任务工件（进度文件 / 结构化任务清单 / 逐次提交）          │
│  ⑤ Model       模型来源抽象（D8）+ 国产模型适配（参数降级 / 思考链归一）              │
│  ⚙ W-Eval      评测体系（任务集 + 自动判定 + 四家对照 + 回归门禁）                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**三个由此产生的判断：**

1. **优先级要调整**：原方案把合规/编排排得靠前，但按前沿架构，**"验证闭环"是单一最大杠杆，而它平台已经给了**——所以 P1 就要把 `runTests` / 终端 / 截图接进 loop，而不是等到 P5。
2. **长任务是分水岭**：④（压缩 + 记忆 + 工件）决定能不能做"大活"，这是 Q3「强大的任务处理能力」的真正落点。
3. **不要做多智能体编排**：前沿共识是编码任务用单一主循环，多智能体只用于**可并行的只读探索**。⑤ 里若做编排，只做"并行探索"这一件事。

---

## 3. 架构：extensions/eva-agent

### 3.1 为什么插件形态能成立

Copilot CLI 的会话**不是**在核心里实现的，而是一个扩展：

| 能力 | 扩展 API | 声明位置 |
|---|---|---|
| 会话内容 + 默认参与者 | `vscode.chat.registerChatSessionContentProvider(scheme, provider, defaultParticipant, capabilities?)` | `vscode.proposed.chatSessionsProvider.d.ts:599`；实际调用 `extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts:187` |
| 会话列表 | `vscode.chat.createChatSessionItemController` | 同 d.ts `:48`；实际调用 `copilotCLIChatSessions.ts:179` |
| 会话类型声明 | `contributes.chatSessions` | `extensions/copilot/package.json:6701-6726` |
| 提案 API 开关 | `enabledApiProposals` | `extensions/copilot/package.json:145` 含 `chatSessionsProvider` |
| 扩展内选模型 | `vscode.lm.selectChatModels()` — **稳定 API** | `vscode.d.ts:20770` |
| 贡献工具 | `vscode.lm.registerTool()` — **稳定 API** | `vscode.d.ts:20778` |

### 3.2 Loop 设计（含强制验证闸门）

```
输入
 │
 ├─► [Plan]  reviewPlanTool（复用核心）── 人工确认 ──┐
 │                                                   │
 ├─► ContextEngine：装配上下文（预算分层 + 接地检索 + 记忆）│
 │                                                   ▼
 └─► model.sendRequest(messages, { tools }, token)
        │
        ├─ thinking ──► 流式展示
        ├─ text     ──► 流式展示
        └─ tool_calls ──► ToolRouter
                            ├─ 接地工具（自研）
                            ├─ 编辑/终端/测试/浏览器（复用平台）
                            └─ 子智能体（复用 runSubagentTool，只回传蒸馏结果）
                                   │
                                   ▼
                        ┌──── 验证闸门 ★ ────┐
                        │ 改动后必须验证：    │
                        │ · 代码 → runTests  │
                        │ · UI  → 截图       │
                        │ · 构建 → 终端任务   │
                        │ 未通过 → 回灌错误   │
                        └────────────────────┘
                                   │
              循环，直到无 tool_call 或达终止条件 ◄┘
                                   │
                        [阈值触发] ContextEngine.compact()（挂 PreCompact）
```

**验证闸门是设计上的硬约束**：不允许"改完就宣称完成"。这是前沿架构里公认的最大杠杆，也是平台已经把工具备好的地方。

### 3.3 目录结构

```
extensions/eva-agent/
├─ package.json              # contributes.chatSessions / languageModelTools / configuration
│                            # enabledApiProposals: ["chatSessionsProvider", ...]
├─ esbuild.mts               # 照抄 eva-ai（注意 95af276c 的 main 指向坑）
└─ src/
   ├─ extension.ts           # 注册会话 provider + 工具 + 命令
   ├─ session/
   │  ├─ evaAgentSession.ts  # ChatSessionContentProvider
   │  └─ evaAgentSessions.ts # ChatSessionItemController
   ├─ participant/evaAgentParticipant.ts
   ├─ loop/
   │  ├─ agentLoop.ts        # 主循环、终止判定
   │  ├─ toolRouter.ts       # 调度、参数校验、失败重试降级
   │  └─ verificationGate.ts # ★ 验证闸门
   ├─ context/
   │  ├─ contextEngine.ts    # 预算分层
   │  ├─ compaction.ts       # ★ 阈值压缩（挂 PreCompact 钩子）
   │  └─ tokenProfile.ts     # 中文 token 画像
   ├─ grounding/
   │  ├─ symbolIndex.ts      # 符号检索
   │  ├─ dependencyGraph.ts  # 影响面
   │  └─ testMapping.ts      # 改动 → 测试
   ├─ memory/
   │  ├─ projectMemory.ts    # ★ 项目长期记忆
   │  └─ taskArtifacts.ts    # ★ 进度文件 + 结构化任务清单
   ├─ tools/                 # 自研工具 + 精心写的 modelDescription
   └─ model/
      ├─ modelSource.ts      # ★ D8 来源可配置
      └─ adapters/           # 国产模型适配
   ```

   **已落地（P1）**：`package.json`、`tsconfig.json`、`esbuild.mts`、`.vscodeignore`、
   `src/extension.ts`、`src/sessions.ts`、`src/agentLoop.ts`、`src/vscode-api.d.ts`。

   ### 3.4 设计硬规则（来自 P0-0.3 实测，先写下来免得后面违反）

   > **压缩历史时，绝不能丢 `reasoning_content`，也不能让两条 assistant 消息相邻。**

   DeepSeek V4 在 Function Calling 时先下发 `reasoning_content` 再下发 `tool_calls`，
   下一轮必须原样回灌；一旦因为清理孤儿 tool_call 导致两条 assistant 相邻并被合并，
   `reasoning_content` 丢失，下一次请求直接 400。
   **工具调用越多、任务越长，触发概率越高** —— 这恰好是我们最想支持的长任务场景。

   因此 `ContextEngine` 与 `adapters/` 的分工定为：

   | 模块 | 职责 |
   |---|---|
   | `adapters/` | 写回历史前统一做**配对校验**：assistant(含 reasoning) ↔ tool 结果必须成对 |
   | `ContextEngine.compaction()` | 只能折叠**完整的往返**，不得破坏配对结构 |
   | `ToolRouter` | 工具失败时补一条占位结果，而不是丢弃这条 tool 消息 |

---

## 4. D8：模型来源可配置（Q5，发布阻塞项）

| 来源 | 形态 |
|---|---|
| ① 内置 EVA 网关（默认） | 沿用 `eva-ai.baseUrl` |
| ② 内网自建网关 | 同上改 URL |
| ③ 本地模型服务 | OpenAI 兼容端点（vLLM / Ollama / LM Studio） |
| ④ 直连厂商 | 填 DeepSeek / Qwen 的 apikey + 端点 |

要点：
1. 统一为 `eva-agent.modelSources` 数组：`{ id, 显示名, baseUrl, apiKey来源, 协议 }`
2. **apiKey 走 Secret Storage**，不落盘（参照 `extensions/copilot/src/extension/byok/vscode-node/byokStorageService.ts`）
3. **模型适配器**：把各家脾气做成可插拔策略，至少覆盖
   - `evaChat.ts:9-27` 记录的 EVA 网关三坑：**200 响应里返回错误**、**tool_calls 分片**、**扁平 tool_calls 与 wire 不一致**
   - `evaCliConfig.ts`：**kimi-k3 拒绝 temperature** → 参数降级重试
   - 各家思考链字段差异（`reasoning_content` vs `thinking`）
4. **离线不卡启动**：`src/vs/platform/agentHost/node/agentSdkDownloader.ts` 需审计
5. `extension.ts:330-335` 当前硬编码 `imageInput: false`；多模态待网关确认（P0-0.4）

---

## 5. W-Eval：自建评测体系（Q6）

| 组件 | 内容 |
|---|---|
| **任务集** | 30–50 个真实改动任务，优先从本仓库 `git log` 里挑"意图明确 + 可编译/可测试验证"的历史提交 |
| **自动判定** | `npm run typecheck-client` / 指定单测 / lint 无新增错误 |
| **指标** | ① 完成率 ② token 消耗 ③ 工具轮次 ④ 人工介入次数 ⑤ 首改延迟 |
| **横向对照** | 同一任务集跑 **Copilot / Claude / Codex / eva-agent**（Q7 给了天然对照组） |
| **回归** | 每次改 loop/提示词/工具后一键重跑，出对比表，指标回退阻断合并 |

---

## 6. 任务清单

### 阶段 0：验证与地基（P0）

- [x] **0.1** 确定 `enabledApiProposals` 清单 ✅
      → 权威清单在 `src/vs/platform/extensions/common/extensionsApiProposals.ts`（自动生成文件，`:551` 导出 `ApiProposalName` 类型）。
      已逐条确认存在：`chatSessionsProvider:99`、`chatHooks:69`、`mcpServerDefinitions:345`、
      `contribLanguageModelToolSets:165`、`languageModelThinkingPart:324`、`taskExecutionTerminal:450`。

      | 提案名 | 必要性 | 用途 |
      |---|---|---|
      | `chatSessionsProvider` | **必需** | 会话 provider（`registerChatSessionContentProvider` / `createChatSessionItemController`） |
      | `contribLanguageModelToolSets` | 建议 | 把自研工具打包成工具集 |
      | `chatHooks` | 建议 | 挂 `PreCompact` 做上下文压缩 |
      | `mcpServerDefinitions` | 按需 | 贡献 MCP server |
      | `taskExecutionTerminal` | 按需 | 验证闸门里的任务/终端输出捕获 |

      **结论：插件可零核心改动启动。** 不需要 `languageModelThinkingPart`（那是生产方用的，我们作为消费方不需要）。
- [x] **0.2** 审计内网/离线场景 ✅ —— **结论：离线不成问题，且插件形态比核心 provider 更抗离线**
      - [x] 0.2.1 `extensions/eva-ai` 无硬编码外网域名：默认值全本地 ——
            `evaConfig.ts:30` `IAM_DEFAULT = 'http://localhost:8080/api/governance'`；
            `evaProxy.ts:24/87/124` 全部 `127.0.0.1`；`evaAuth.ts:277` 回调 `http://127.0.0.1:<port>`
      - [x] 0.2.2 OAuth2 PKCE 可指向内网：`eva-ai.serverUrl` 与 `eva-ai.clientId` 均可配
            （`extensions/eva-ai/package.json` 配置段）。回调是 loopback，符合 PKCE loopback 规范，
            **不需要外网可达的回调地址**。唯一前置：内网 IAM 需登记同一个 `clientId`（默认 `eva-desktop`）
      - [x] 0.2.3 `agentSdkDownloader.ts` **不会阻塞启动**，且我们天然免疫：
            三级解析（`:187-190`）＝ ① `devOverrideEnvVar` → ② 磁盘缓存 `.complete` 哨兵 → ③ 从
            `product.agentSdks?.[pkg.id]` 的 urlTemplate 下载；
            `isSdkResolvableWithoutDownload()`（`:218`）专供"避免冷启动下载"的 eager 调用方；
            `isAvailable()`（`:204`）不触发下载；
            失败有 `LOAD_FAILURE_NEGATIVE_CACHE_MS = 30_000`（`:226`）负缓存防轮询风暴。
            核心侧 `agentHostMain.ts:170/182-186` 注册 Claude/Codex 时以 `isAvailable()` 为前置条件，
            → **离线且缓存冷时，Claude/Codex provider 直接不注册（优雅降级，不卡启动）**。
            **我们的 eva-agent 是扩展，不走 SDK 下载器，因此完全不受影响。**
- [x] **0.3** 调研 DeepSeek / Qwen 官方端点协议差异 ✅ —— **结论：有一条会反向约束上下文引擎设计的硬规则**

      | 发现 | 对设计的约束 |
      |---|---|
      | **DeepSeek V4：Function Calling 时先下发 `reasoning_content`，再下发 `tool_calls`；下一轮请求必须把 `reasoning_content` 一并回灌，否则报 400** | ★ **上下文压缩与历史清理时，绝不能丢 `reasoning_content`，也不能让两条 assistant 消息相邻**。这直接约束 `ContextEngine.compaction()` 的实现 |
      | **同一来源的已知故障模式**：清理孤儿 tool_call（tool 消息缺失/不匹配）→ 两条 assistant 变相邻 → 合并 → `reasoning_content` 丢失 → 下一轮 400。且"工具调用越多、跑越久，概率累积越高" | ★ 意味着**这正是长任务场景的高频故障**。压缩逻辑必须先保证 assistant/tool 消息配对完整，再做折叠 |
      | **Qwen3 的 tool calling 底层用 XML 标记（如 `<tool_call>`）分隔调用块** | 解析层不能只认 JSON；需容忍/剥离 XML 包裹 |
      | 两家均提供 OpenAI 兼容端点；DeepSeek 另有 Anthropic 协议端点（第三方平台已同时支持两种） | 适配器至少覆盖 OpenAI Chat Completions；Anthropic 端点作为可选 |

      → 落到设计上：**适配器接口必须把"历史消息的结构完整性"作为一等职责**，
      即在写回历史前统一做一次**配对校验 + reasoning_content 保留**，而不是让压缩模块随意裁剪。
- [x] **0.4** 探测 EVA 网关 ✅（部分）—— **结论：无法免凭据探测，且修正了 03 号文档的一处错误**

      - 网关在本机 `localhost:8080` **运行中**
      - ⚠️ **`/api/ai/**` 是前缀级鉴权**：对**任意**路径（包括完全不存在的路径）都返回
        `401 {"code":40101,"message":"未登录或令牌缺失"}`；而根路径下的任意路径返回 `200`。
        → **401 不能作为"端点存在"的证据**
      - ⚠️ **因此 `.docs/03` §5 第 5 项记载的"免凭据探测法"（"返回 401 说明端点存在，404 才是不存在"）在本网关上无效**，
        已实测证伪。该结论需要改用"登录后探测"或"查网关路由表"来确认（**待你确认是否要我回改 03 号文档**）
      - 多模态能力标记（`imageInput`）**仍未确认**，需登录后调用 `/api/ai/models/square` 才能看到
        → 拆出子项 0.4b，标记为**阻塞**（需要 EVA 登录态，非本机可自行完成）
- [ ] **0.4b** 登录后确认 EVA 网关的能力标记（多模态 / 上下文长度 / 工具调用）❌ **阻塞：需 EVA 登录态**
- [ ] **0.5** 实测 DeepSeek / Qwen 的长程工具使用能力基线 ❌ **阻塞：需在 0.4b 之后，且需可用凭据**
- [x] **0.6** W-Eval：评测任务集 ✅ —— **首批 8 条已定**，见 `.docs/06_evacode智能体评测任务集.md`
      - 判定方法采用 **SWE-bench 式 FAIL_TO_PASS**：本仓库近期提交普遍"改代码的同时补测试"
        （如 `93a4da42` 改 2 文件、其中一个是 +148 行的测试），
        因此**回滚代码改动、保留测试改动**即可自动判定，不必人工写验收标准
      - 首批：E1 `93a4da42`／E2 `51ddf6e1`／E3 `530e1ec8`／E4 `d0c15616`／
        E5 `22494fc3`／E6 `06024a09`／E7 `00500f51`／E8 `3f07e1ab`（14 文件的长任务探针）
      - 剩 22 条待按同样筛选条件继续扫 `git log`
- [ ] **0.7** W-Eval：搭最小 runner（跑一个任务 + 出五项指标）❌
      - [ ] 0.7.1 **先验证测试入口在本机可用**（`test-node` 等）—— 这是 §1 判定方法的前提，尚未实测
      - [ ] 0.7.2 跑通最小任务 E3（`530e1ec8`，2 文件）
      - [ ] 0.7.3 输出五项指标（完成率/token/轮次/介入次数/首改延迟）
      - 降级预案：若测试入口跑不通，先上"人工打勾 + 四家双跑对照"的最小版本，不等完美
- [x] **0.8** 抄读样板 ✅ —— **结论：最小实现面比预期小得多**
      - 注册三件套（`extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts:186-187`）：
        `createChatParticipant(id, handler)` → `registerChatSessionContentProvider(sessionType, contentProvider, participant)`
      - 会话列表（`copilotCLIChatSessions.ts:179-213`）：`createChatSessionItemController(type, refreshHandler)`；
        `controller.items.replace()/add()`、`createChatSessionItem(resource, label)`；
        可选 `newChatSessionItemHandler`（`:191`）、`forkHandler`（`:212`）
      - 声明形态 `contributes.chatSessions`（`extensions/copilot/package.json:6701-6726`）
      - **构建自动接入**：`build/gulpfile.extensions.ts:170` 为每个 `extensions/*/` 自动生成
        `compile-extension:<name>` → 新建 `extensions/eva-agent` 无需改任何构建脚本
- [x] **0.9** 确认 `ChatSessionContentProvider` 契约 ✅
      - **唯一必填成员**是 `provideChatSessionContent(resource, token, context)`（`vscode.proposed.chatSessionsProvider.d.ts:556-558`）；
        `onDidChangeChatSessionOptions`、`provideChatSessionProviderOptions`、`provideHandleOptionsChange` **全部已 deprecated**（`:529/543/567/574`）
      - `ChatSessionCapabilities` 目前**只有** `supportsInterruptions?`（`:626-631`）
      - ⚠️ **附件/多模态能力不在这里**，而在 `package.json` 的 `contributes.chatSessions[].capabilities`：
        `supportsFileAttachments` / `supportsImageAttachments` / `supportsSymbolAttachments` / `supportsSourceControlAttachments` 等
        （`extensions/copilot/package.json:6716-6726`）——两处 `capabilities` 不是一回事，别混
      - **结论：P1 骨架 = 1 个必填方法 + 1 个 controller + 1 个 participant，工作量很小**

### 阶段 1：插件骨架（P1）—— 能跑通闭环，且**验证闸门必须在此阶段接上**

- [x] 1.1 建 `extensions/eva-agent` 骨架 ✅ —— `package.json` + `esbuild.mts` + `tsconfig.json` + `.vscodeignore`
- [x] 1.2 声明 `contributes.chatSessions` + `enabledApiProposals` ✅ —— 类型 `eva-agent`，`order: 10`；
      仅启用 `chatSessionsProvider` 一个提案
- [x] 1.3 实现 `ChatSessionContentProvider` + `ChatSessionItemController` ✅（见 `src/sessions.ts`）
      - [ ] **1.3b** 历史回放 ♋ **待定**：`ChatSession.history` 目前返回 `[]`，
            重开会话时 UI 是空的（`messages` 里的模型侧记录仍在）。
            要实现需启用 `chatParticipantPrivate` 提案以拿到 `ChatResponseTurn2`。
            类型已通过 `src/vscode-api.d.ts` 的三斜杠引用备好，只差运行时启用这个决定
- [x] 1.4 实现默认 `ChatParticipant`，接 `selectChatModels({ vendor: 'eva-ai' })` ✅
      —— vendor 走 `eva-agent.modelVendor` 配置，默认 `eva-ai`
- [x] 1.5 实现最朴素 loop ✅（见 `src/agentLoop.ts`）
      发送 → 收流式 → 文本回显 / 收集 tool_calls → 回灌结果 → 循环；
      终止条件为「本轮无 tool_call」；另设 `eva-agent.maxTurns`（默认 24）防跑飞
- [ ] 1.6 **验证闸门** ❌ —— **结论需要先修正**：因为当前把 `vscode.lm.tools` 全量交给模型，
      `runTests` / 终端任务 / 浏览器截图**已经在模型的可选范围内**，不存在"接不通"的问题。
      真正缺的是**策略**：改完必须验证、没验证不许宣称完成。这是一个 loop 策略而非 API 集成，
      且需要真机验证才有意义 → 与 P2 接地一起做（见 P2-2.7）
- [x] 1.7 打包坑规避 ✅ —— `main` 指向 `./dist/extension.js`；
      **已实测** `npx tsx esbuild.mts` 产出 `dist/extension.js`（3.9 KB）；
      `.vscodeignore` 排除 `src/**`、`out/**`
- [x] 1.8 类型检查通过 ✅ —— `tsc --noEmit -p extensions/eva-agent/tsconfig.json` 零错误
      - [ ] **1.8b** 真机验收 ❌ **阻塞：需打包后实机运行**（完成一次跨多文件改动；三家不受影响）

### 阶段 2：接地（P2）—— 即时上下文检索

- [ ] 2.1 符号级检索工具（`registerTool`，写好 `modelDescription`）❌
- [ ] 2.2 影响面工具：给定文件/符号返回调用链 ❌
- [ ] 2.3 测试映射：改动 → 建议运行的测试 ❌
- [ ] 2.4 git 语义接入 ❌
- [ ] 2.5 评测对照：记录轮次/耗时改善 ❌
- [ ] 2.6 验收：指标②③相对 P1 有可测下降 ❌

### 阶段 3：上下文引擎（P3）—— 长任务的分水岭

- [ ] 3.1 预算分层（系统/规约/检索/历史/工具输出分区配额）❌
- [ ] 3.2 阈值压缩：挂 `PreCompact` 钩子，把工具往返折叠为"结论 + 引用" ❌
- [ ] 3.3 引用化：大文件只放签名 + 行号，按需再取 ❌
- [ ] 3.4 中文 token 画像 ❌
- [ ] 3.5 评测对照：token 节省与长会话完成率 ❌

### 阶段 4：记忆与长任务工件（P4）

- [ ] 4.1 项目长期记忆（文件化，跨会话）❌
- [ ] 4.2 进度文件 + 结构化任务清单 ❌
- [ ] 4.3 逐次提交与可回滚 ❌
- [ ] 4.4 评测对照：长任务完成率 ❌

### 阶段 5：模型来源可配置（P5，发布阻塞）

- [ ] 5.1 `eva-agent.modelSources` 配置结构 + Secret Storage ❌
- [ ] 5.2 模型适配器抽象（EVA / 通用 OpenAI 兼容）❌
- [ ] 5.3 支持四种来源 ❌
- [ ] 5.4 参数降级重试与思考链归一 ❌
- [ ] 5.5 验收：**断外网**后仍能完成一次完整改动 ❌

### 阶段 6：打磨与可选编排（P6）

- [ ] 6.1 并行只读探索（子智能体，只做这一件事）❌
- [ ] 6.2 失败自愈回路 ❌
- [ ] 6.3 分层选模（系统化 `CLI_TIER_MODELS` 经验）❌
- [ ] 6.4 Hook 覆盖工具执行前后，用于审批与审计 ❌

### 阶段 7：评测驱动迭代（贯穿）

- [ ] 7.1 每阶段结束跑全量评测，出四家对比表 ❌
- [ ] 7.2 评测做成回归门禁 ❌
- [ ] 7.3 任务集扩到 50+ ❌

### 明确不做

- ❌ **不替代 Copilot / Claude / Codex**（Q7）；我们是第四种并列会话类型
- ❌ **不动 Copilot 商标**（既有决策）
- ❌ **不进核心注册第四个 provider**（Q2）
- ❌ **不做通用多智能体编排**（前沿共识：编码任务用单一主循环；只做并行只读探索）
- ❌ 不重造平台已有能力（终端/测试/浏览器/MCP/Skills/子智能体/Plan Mode/缓存）
- ❌ 不自建私有扩展市场；不改 evaswitch（沿用 doc 01/02 决策）

---

## 7. 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| **提案 API 不稳定** | 中 | 对提案 API 的依赖收敛到 `session/` 两个文件；`enabledApiProposals` 锁版本 |
| **国产模型长程工具能力不足** | 高 | P0-0.5 实测；若不足，重心放在接地与上下文（减少模型需要"想"的量） |
| **评测建不起来** → 无法证明"更好" | 高 | Q1 是结果导向，这条是命门；P0 启动，接受最小可用版本 |
| **插件能力受扩展 API 边界限制** | 中 | P1 列"想要但拿不到"清单，逐条评估：绕开 / 提 API 需求 / 才动核心（Q2 已授权） |
| **离线场景被 SDK 下载/登录卡住** | 中 | P0-0.2 专项审计 |
| **多模态缺失 → 截图验证做不了** | 中 | 若 `imageInput` 不可用，验证闸门退化为测试 + 构建，仍成立 |
| 三家并存的 UI 与默认策略复杂度 | 低 | 用 `contributes.chatSessions` 的 `order` / `when` 控制 |

---

## 8. 附录：代码索引

**前沿原语（平台已有，复用）**
- 子智能体隔离：`src/vs/workbench/contrib/chat/common/tools/builtinTools/runSubagentTool.ts:158-168,284,390,464`
- 核心内置工具目录：`.../builtinTools/`（`editFileTool`、`runSubagentTool`、`reviewPlanTool`、`manageTodoListTool`、`askQuestionsTool`、`taskCompleteTool`、`setArtifactsTool`）
- 验证：测试 `src/vs/workbench/contrib/testing/common/testingChatAgentTool.ts:52-57,73-75,328-330`；终端 `common/tools/terminalToolIds.ts:14-25`；浏览器 `contrib/browserView/electron-browser/tools/`（14 个，含 `screenshotBrowserTool`、`runPlaywrightCodeTool`）
- 压缩钩子：`common/promptSyntax/hookTypes.ts:18,98-100`、`vscode.proposed.chatHooks.d.ts:11`；参考实现 `extensions/copilot/src/extension/prompts/node/agent/summarizedConversationHistory.tsx:180-260,606,692`
- 提示词缓存：`src/vs/platform/agentHost/node/agentHostPromptCache.ts:11-59`；模型侧 `extensions/copilot/src/platform/endpoint/node/messagesApi.ts:271-273`、`responsesApi.ts:134-188`
- Skills 渐进披露：`common/promptSyntax/service/promptsService.ts:439-470`；`extensions/copilot/src/extension/tools/node/skillTool.ts:58-105`
- AGENTS.md：`common/promptSyntax/computeAutomaticInstructions.ts:266-290`
- MCP：`vscode.d.ts:20842`；`.mcp.json` `platform/mcp/common/mcpWorkspaceConfiguration.ts:18`；进注册表 `contrib/mcp/common/mcpLanguageModelToolContribution.ts:119-120,150`

**插件形态样板**
- `extensions/copilot/src/extension/chatSessions/vscode-node/chatSessions.ts:187`、`copilotCLIChatSessions.ts:179`
- `extensions/copilot/package.json:145`（enabledApiProposals）、`:158`（languageModelTools）、`:6701-6726`（chatSessions）
- `src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts:45/48/599`；`vscode.d.ts:20770/20778/20851`

**模型侧**
- `extensions/eva-ai/src/extension.ts:283-370`、`:330-335`、`:455-464`；`evaChat.ts:9-27`；`evaCliConfig.ts`
- `extensions/copilot/src/extension/byok/vscode-node/byokStorageService.ts`（Secret Storage 参考）
- `src/vs/platform/agentHost/node/agentSdkDownloader.ts`（离线风险点）

**相关文档**
- `.docs/04_evacode自研AI编程智能体头脑风暴.md`
- `.docs/01`、`02`、`03`
- 仓库记忆：《Windows 构建环境陷阱》《打包流程与耗时》《用真值，不要估算》《遇到疑点就修》《Evacode rebrand: keep Copilot & plugin trademarks》
