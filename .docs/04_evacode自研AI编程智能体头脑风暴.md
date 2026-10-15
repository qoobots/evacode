# Evacode 自研 AI 编程智能体 · 头脑风暴

> **文档性质：发散稿，不是方案书。**
> 本文的目的是把「自研 AI 编程智能体」这件事的**可能形态、可选路径、代价与坑**一次性摊开，供后续收敛成正式方案。文中所有代码结论都标注了位置；标注「待验证」的是尚未确认、动手前必须查清的。
>
> 头脑风暴日期：2026-10-15　|　代码基线：`a2e2cca6`（branch `main`）
> 前序文档：`.docs/01`（国内大模型接入）、`.docs/02`（界面品牌化）、`.docs/03`（大模型转接方案）

---

## 0. 先定义问题：「自研」到底要自研哪一层？

「自研智能体」这四个字至少能拆成四层。混淆层次是这类项目最常见的翻车方式——做了很多，但以为自己在做 A，实际上做的是 B。

| 层 | 是什么 | 现在是谁的 | evacode 的所有权 |
|---|---|---|---|
| **L0 模型** | 推理本身（权重、服务端） | EVA 网关 | ✅ 自有（已接入） |
| **L1 接入层** | 模型目录、凭据、协议转换、本地代理 | `extensions/eva-ai` | ✅ 自有（已建成） |
| **L2 智能体循环** | 规划、工具调度、上下文组装、记忆、重试/自愈、终止判定 | Copilot SDK / Claude Agent SDK / Codex app-server | ❌ **完全是别人的** |
| **L3 宿主与体验** | 会话、changeset、审批、UI、持久化 | `src/vs/platform/agentHost/` + `workbench/contrib/chat/` | 🟡 平台自有，但被三家 SDK 的假设塑形 |

**一句话现状**：今天我们自研的是「模型」和「管道」，**不是智能体**。大脑是 EVA 的，小脑和神经是三家 SDK 的，我们只接管了血管（BYOK）。

所以本文真正要回答的问题是：**要不要往 L2 走，走多深，用什么姿势走。**

---

## 1. 现状盘点：我们手上已经握住的牌

先列资产，再谈野心。以下均为代码事实。

### 1.1 平台骨架（可复用，不是要从零写）

| 资产 | 位置 | 说明 |
|---|---|---|
| Agent Host 进程外平台 | `src/vs/platform/agentHost/node/agentHostMain.ts` | 独立 node utility process，通过 IPC + MessagePort + 本地 WebSocket（AHP）与渲染进程通信 |
| Provider 注册点 | `agentHostMain.ts:155`（Copilot）、`:171`（Claude）、`:186`（Codex） | **加第四个 provider 的入口就在这里** |
| Agent 服务契约 | `src/vs/platform/agentHost/common/agentService.ts:872` `IAgentService` | 会话/轮次的状态机接口 |
| 本地端点发现协议 | `src/vs/platform/agentHost/LOCAL_ENDPOINT.md`、`common/agentHostEndpointRegistry.ts` | 外部进程可被发现并连上 agent host（Windows 命名管道 / Unix socket），**意味着自研 runtime 可以外挂** |
| 会话持久化 | `node/sessionDatabase.ts`、`sessionDataService.ts`、`agentHostChatCatalogV2.ts` | 会话落库、迁移已有版本化机制 |
| 变更集与检查点 | `node/agentHostChangesetService.ts`、`agentHostCheckpointService.ts`、`chatContributions/checkpointAndChangeset/` | 「改了什么、能回滚」已有基建 |
| 权限与自动批准 | `node/sessionPermissions.ts`、`sessionSandbox.ts`、`commandAutoApprover.ts` | 沙箱与审批已有落点 |
| Prompt 缓存 | `node/agentHostPromptCache.ts:18-58` | 按 session 记录 `promptCache` 状态（含 `modelId`、`cacheExpiresAt`） |
| 工具调用追踪 | `node/agentHostToolCallTracker.ts` | 工具调用画像已有埋点 |
| 后台/定时 | `node/automationCron.ts`、`agentHostAutomationService.ts` | 已存在定时驱动 agent 的机制 |
| 可观测性 | `src/vs/platform/agentHost/OTEL.md`、`PERFORMANCE.md`、`node/otel/`、`agentHostSessionOpenTelemetry.ts` | OTEL 埋点体系已成型 |
| 插件管理 | `node/agentPluginManager.ts` | 已有 agent 插件/扩展加载概念 |
| Mission Control | `node/missionControl/`（10 文件 + 3 篇 MD） | 会话镜像/外部控制面，含 `MISSION_CONTROL_PRODUCTION_GAPS.md` |

### 1.2 智能体行为的可编程面（已经能"不写代码就改智能体"）

| 机制 | 位置 | 价值 |
|---|---|---|
| 自定义 agent 文件 | `.github/agents/*.agent.md`（`PromptsType.agent`） | 用 md 定义角色/工具/约束，**这是一条现成的"造智能体"产线** |
| Skill | `.github/skills/<name>/SKILL.md` | 可插拔能力包 |
| Hook | `src/vs/workbench/contrib/chat/common/promptSyntax/hookSchema.ts`、`hookTypes.ts`、`hookClaudeCompat.ts`、`browser/promptSyntax/hookUtils.ts` | 生命周期钩子，**已做了 Claude/Copilot CLI 兼容层** |
| Chat 自定义管理 | `src/vs/workbench/contrib/chat/browser/promptSyntax/`、`aiCustomizationManagementEditor` | 统一编辑/启用入口 |
| 设置键 | `chat.agentFilesLocations`（`contrib/preferences/browser/settingsLayout.ts:258`） | agent 文件可配置位置 |

### 1.3 我们自己的模型侧

| 资产 | 位置 | 状态 |
|---|---|---|
| 模型目录 + Auto | `extensions/eva-ai/src/extension.ts:283-370` | 16+1 个模型，`isBYOK: true` |
| 流式客户端 | `extensions/eva-ai/src/evaChat.ts` | 处理了 EVA 网关两个坑：200 里返回错误、tool_calls 分片 |
| 本地代理（接外部 CLI） | `extensions/eva-ai/src/evaProxy.ts` + 命令 `eva-ai.applyToClaudeCode` / `applyToCodex` | ✅ 已能接管 Claude Code / Codex |
| 分层选模 | `extensions/eva-ai/src/evaCliConfig.ts` `CLI_TIER_MODELS` | Opus/Haiku/Fable 分层，**已声明式而非启发式** |
| 交互日志 | `extensions/eva-ai/src/evaTrace.ts` + 设置 `eva-ai.trace.*`（默认关闭） | 最近一次提交 `a2e2cca6` 加的，**为上下文分析而生** |
| token 估算自校准 | `extension.ts:455-464` `learnCharsPerToken` | 用真实 `prompt_tokens` 修正 chars/token（中文场景关键） |

### 1.4 盘点的三个判断

1. **平台基建远比"缺一个 agent"值钱**。会话、changeset、审批、OTEL、AHP 外挂协议都在，重造这些是纯浪费。
2. **我们已经有了一条"不写 TS 就能造 agent"的产线**（agent.md + Skill + Hook）。这是最被低估的资产。
3. **最薄弱的是 L2 的"上下文工程"与"仓库接地"**——恰恰是决定体感的地方，也恰恰是我们可以不依赖 SDK 就做的地方。

---

## 2. 头脑风暴：七个值得争的方向

> 每条给出：想法 → 为什么现在有机会 → 要动什么 → 主要风险 → **我的直觉判断**（待你推翻）。

### D1 · 自研 Agent Loop（把 L2 拿回来）

**想法**：实现 `EvaAgent`，作为第四个 provider 注册进 `agentHostMain.ts`，自己写规划—工具—观察循环。

**为什么现在有机会**：模型、凭据、协议转换、会话壳、工具注册表全是现成的；缺的只是"循环"本身。参考 `codex/` 目录（912 个文件）已知这件事的规模上限。

**要动什么**：一个新的 `node/eva/` 目录（agent、launch config、协议、模型目录、工具桥）+ 一个把 `ILanguageModelToolsService` 暴露给循环内调用的桥。

**风险**：规模最大。`codex/` 目录 912 文件说明这条路不是"几周"的事；工具语义、流式中断、取消、恢复都是深水区。

**直觉判断**：🟡 方向正确但**不该是第一步**。先做 D2/D3，等"没有自己的 loop 就做不下去"的那一刻真的出现再启动。

---

### D2 · 上下文引擎（Context Engine）—— 我认为性价比最高的一条

**想法**：把"每次请求该往窗口里放什么"做成一等公民服务，而不是散在 SDK 里的 heuristic。

**为什么现在有机会**：
- `a2e2cca6` 刚加了交互日志，**动机就是分析上下文构成**——说明痛点已经被感知到了。
- `evaChat.ts:455` 已经在用真实 `prompt_tokens` 校准 token 估算（中文场景 chars/4 会低估约 3 倍）。
- `agentHostPromptCache.ts` 已有缓存状态位可接。
- EVA 侧（eva-desktop）已有上下文压缩实现（`apps/agent-ts/src/context.ts`，默认 256k 窗口 / 0.8 压缩比），**可直接移植经验，不必从头设计**。

**具体子想法**：
| 子项 | 说明 |
|---|---|
| 预算分层 | 系统/规约/检索结果/历史/工具输出各有配额，而非一锅炖 |
| 结构化压缩 | 不是简单截断，而是把"已完成的工具往返"折叠成结论 + 引用 |
| 中文 token 画像 | 沿用 `learnCharsPerToken` 的思路，按仓库语言构成动态校准 |
| 引用而非内联 | 大文件只放符号签名 + 行号，需要时再取（配合 D3） |
| 上下文画像 UI | 把 trace 数据变成"这次请求窗口里装了什么"的可视化 |

**风险**：改造点跨 L2（SDK 内部组装 prompt，我们插不进去）。**这是最大的落地障碍**——若 SDK 不支持自定义 prompt 组装，D2 只能在"自研 loop"或"代理层改写请求"里二选一。

**直觉判断**：✅ 最值得做；但**它反过来是推动 D1 的最强理由**（见 §3）。

---

### D3 · 仓库接地（Repo Grounding）：让智能体"认识这个仓库"

**想法**：为工作区建一套自己的索引——符号图、依赖图、测试↔源码映射、构建产物关系，供智能体按需检索。

**为什么现在有机会**：编辑器进程里已经有语言服务、符号索引、git 状态、文件监听（`agentHostFileMonitorService.ts`），数据源是现成的；只是没有被组织成"给智能体用"的形态。

**子想法**：
| 子项 | 说明 |
|---|---|
| 符号级检索工具 | 暴露成一个 `vscode.lm.registerTool`，任何 agent 都能用（**不依赖自研 loop**） |
| 依赖影响面 | 改 A 影响谁，直接给调用链而非让模型猜 |
| 测试映射 | 改了哪个文件 → 该跑哪些测试（比"全跑一遍"省一个数量级） |
| git 语义 | 最近变更、责任人、关联 PR（`agentHostGitService.ts` 已有） |
| 规约注入 | 把 lint 规则/架构约束转成检索可得的知识 |

**风险**：索引体积与新鲜度；单仓 10 万文件级项目的构建耗时。

**直觉判断**：✅✅ **最高优先**。它是一个"工具"，不需要换 loop 就能交付价值，且立刻提升所有三家 agent 的表现。

---

### D4 · 可控性：沙箱、审批、成本闸、审计

**想法**：把"能不能干、花了多少、改了什么"做成平台级能力而非 SDK 各自的设置。

**已有落点**：`sessionPermissions.ts`、`sessionSandbox.ts`、`commandAutoApprover.ts`、`agentHostChangeset*`、`agentToolCallTracker.ts`。

**子想法**：
| 子项 | 说明 |
|---|---|
| 成本闸 | 按会话/天设 token 预算，超阈值降级到廉价模型并提示 |
| 危险动作分级 | 删文件/强制推送/改 CI 必人工确认（可做成 hook 规则） |
| 全程审计 | 每次工具调用落 audit 日志，可回溯、可导出（企业客户刚需） |
| 数据边界 | 明码标注"哪些内容会离开本机"，私有化部署场景下可强制本地小模型 |

**风险**：过度拦截会毁掉体感，需要精细的默认策略。

**直觉判断**：✅ 商业价值最高的**非技术差异化点**。国内企业客户对"代码出不出内网"极度敏感，这是外资产品给不了的。

---

### D5 · 编排：多智能体 / 后台 / 定时

**想法**：一个任务拆成"规划者—执行者—审查者"，或长任务后台跑、定时跑。

**已有落点**：`automationCron.ts`、`agentHostAutomationService.ts`、`chatContributions/turnDelegation/`、`agentHostLocalTurns.ts`、`missionControl/`。

**子想法**：
| 子项 | 说明 |
|---|---|
| 角色分工 | 用 `.github/agents/*.agent.md` 定义角色，由编排器调度——**复用现成产线** |
| 后台长任务 | 提交任务 → 关窗口 → 回来看结果（changeset 审阅） |
| 定时巡检 | 依赖升级、lint 回归、测试覆盖率，cron 触发 |
| 评审智能体 | 专门的 reviewer agent，产出结构化评审意见而非直接改代码 |

**风险**：多智能体容易变成"token 焚烧炉"；编排失败时的可观测性要求高。

**直觉判断**：🟡 有想象空间，但优先级低于 D3/D4。可作为 D3 成熟后的增值层。

---

### D6 · 领域化：把企业资产变成智能体的"内行"

**想法**：让 evacode 不只是一个通用编程智能体，而是"懂这家公司代码库"的智能体。

**子想法**：
| 子项 | 说明 |
|---|---|
| 团队规约包 | 架构约束、命名规范、PR 模板，做成可分发的 Skill 包 |
| 内部知识接入 | 内部文档/API 目录/组件库作为检索源 |
| 项目记忆 | 跨会话长期记忆：这个项目的坑、约定俗成、历史决策（**这是"记忆"而非"上下文"**） |
| 迁移/升级专用智能体 | 例如"把仓库从 X 框架迁到 Y"的专用流水线 |

**风险**：高度定制 → 每个客户一套，维护成本线性增长。

**直觉判断**：✅ 商业化角度最划算（可复制的方法论 + 不可复制的数据），但需要先有 D3 的检索底座。

---

### D7 · 边缘层：用小模型做高频低价值动作

**想法**：不是所有步骤都需要旗舰模型。标题生成、摘要、文件分类、简单格式化交给便宜/端侧模型。

**已有基础**：`evaCliConfig.ts` 的 `CLI_TIER_MODELS` 已经在做分层（Haiku 只写标题和摘要），且明确"按成本而非峰值能力"选模。

**子想法**：分层路由器（按动作类型选模型）、结果缓存（同一输入不重复付费）、本地小模型兜底（离线可用）。

**风险**：路由判断本身也会出错；本地模型的可用性落差。

**直觉判断**：✅ 低成本高回报，且**已经在做**，值得系统化。

---

### 方向优先级速览（我的主观排序，待推翻）

| 方向 | 价值 | 成本 | 是否依赖自研 loop | 建议顺位 |
|---|---|---|---|---|
| D3 仓库接地 | 高 | 中 | ❌ 不依赖 | **1** |
| D2 上下文引擎 | 高 | 中 | 🟡 部分依赖 | **2** |
| D4 可控性与合规 | 高（商业） | 中 | ❌ 不依赖 | **3** |
| D7 分层/成本控制 | 中 | 低 | ❌ 不依赖 | **4** |
| D6 领域化/记忆 | 高（商业） | 高 | ❌ 不依赖 | 5 |
| D5 编排 | 中 | 高 | 🟡 部分依赖 | 6 |
| D1 自研 Loop | 高（战略） | **极高** | — | 7（但可能是终局） |

**关键洞察**：前 4 顺位**都不需要自研 loop**。这意味着"自研智能体"这件事可以先不当成自研 loop 来做——先做成"任何 loop 都变得更强"的增强层。

---

## 3. 收敛：三条候选路线

### 路线 I · 内置第四 Provider（`EvaAgent`）

在 `agentHostMain.ts` 里再注册一个 provider，与 Copilot/Claude/Codex 并列，自研完整 loop。

- ✅ 完全可控（上下文、工具、终止、成本全在自己手里）
- ✅ 复用平台全部基建（会话、changeset、审批、OTEL、UI）
- ❌ 规模最大；要做协议兼容，否则 UI 侧各种特判会咬人
- ❌ 与上游 fork 的 diff 面积暴增，未来合入上游的成本上升

### 路线 II · 外挂自研 Runtime（独立进程，走 AHP）

自研一个独立可执行文件（像 `codex.exe app-server`），通过已文档化的本地端点发现协议（`LOCAL_ENDPOINT.md`）接入。

- ✅ 与编辑器解耦，可独立迭代、独立发版、可给外部 CLI 复用
- ✅ 不侵入 `agentHostMain.ts` 的 provider 注册逻辑
- ❌ 要自己实现 AHP 客户端侧；能力受协议约束（协议没暴露的宿主能力用不了）
- ❌ 进程管理、版本匹配、崩溃恢复都是新工作量

### 路线 III · 双轨渐进（推荐）

**短期**：继续 BYOK 通路（已跑通），把力气花在 D3/D2/D4/D7 这些**增强件**上——它们以"工具 + 服务"的形式存在，三家 SDK 的 loop 都能吃到。
**中期**：用增强件的实测数据回答一个问题——"卡住我们的到底是模型能力，还是 loop 策略？"
**长期**：若答案是 loop（例如上下文组装插不进去、工具调度策略无法定制），再启动路线 I；此时自研 loop 已有一个成熟的接地/上下文/工具底座等着它，风险大幅降低。

| | 路线 I | 路线 II | 路线 III |
|---|---|---|---|
| 首个可用产出 | 慢（月级） | 中 | **快（周级）** |
| 与上游 diff | 大 | 小 | **小 → 可控增长** |
| 战略自主性 | 最高 | 高 | 渐进达到 |
| 沉没成本风险 | **高** | 中 | **低** |
| 对现有三家 agent 的增益 | 无 | 无 | **有（立刻）** |

**推荐：路线 III**，并在第一阶段结束时用明确指标（见 §6）决定是否转向路线 I。

---

## 4. 点子池：差异化能力（先摊开，不排序）

> 这些是"如果产品要在众多 coding agent 里被记住，可以靠什么"。每条后标注依赖哪个方向。

**接地与理解**
- 仓库符号图检索工具（D3）
- 「改动影响面」一键给出调用链（D3）
- 测试映射：改哪个文件 → 跑哪些测试（D3）
- 从失败日志反查最可能的几个文件（D3 + D7）
- 架构约束检查器：改完立刻告诉你违反了哪条规约（D6）

**记忆与连续性**
- 项目长期记忆：坑、约定、历史决策，跨会话保留（D6）
- 「上次做到哪」的会话续接与压缩摘要（D2）
- 个人偏好学习：代码风格、注释语言、提交习惯（D6）
- 决策日志：为什么这么改，可回溯（D4）

**闭环与自愈**
- 编辑 → 编译/类型检查 → 自动修 → 再验证 的收敛循环（D1/D5）
- 测试失败自动归因（是改动引入的还是原本就红）（D3）
- lint/format 自动收尾（低成本，D7）
- CI 失败日志解析与修复建议（`.github/skills/ci-fix/SKILL.md` 已有原型！）

**成本与性能**
- 分层模型路由（已在做，系统化）（D7）
- 结果缓存：相同输入不重复付费（D7）
- token 预算与实时用量显示（D4）
- 大任务先给"预计成本"再执行（D4）

**体验**
- 计划先行：先出计划 → 人工调整 → 再执行（比边想边干可控得多）
- 变更集审阅优先于聊天流（已有 changeset 基建）
- 上下文画像可视化："这次请求窗口里装了什么"（D2）
- 多模态：截图 → 定位组件 → 改 UI（**注意**：当前 `eva-ai` 模型目录里 `imageInput: false`，需 EVA 侧先支持）

**合规与部署**
- 数据边界声明：明确哪些内容离开本机（D4）
- 私有化/内网部署，模型可换（L0 已自有，优势）
- 操作审计导出（企业刚需）（D4）
- 「只用国内模型」的一键配置（L1 已具备）

**组织级**
- 团队规约包分发（D6）
- 评审智能体：结构化评审意见（D5）
- 新人 onboarding：让智能体解释这个仓库（D3 + D6）

---

## 5. 若启动自研 Loop：架构草案（路线 I 的形态）

```
┌─────────────────────────── 渲染进程 (workbench) ───────────────────────────┐
│  Chat UI / Session List / Changeset Review / Approval                       │
│  ILanguageModelToolsService  ← 工具注册表（内置 + 扩展贡献 + 我们新增）       │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ IPC / MessagePort（agentService.ts 契约）
┌───────────────▼──────────────── Agent Host (node) ─────────────────────────┐
│  providerService.registerProvider(EvaAgent)   ← agentHostMain.ts:155 附近    │
│  ┌────────────────────────── EvaAgent ─────────────────────────────────┐   │
│  │ Planner        任务分解 / 终止判定 / 计划审批                          │   │
│  │ ContextEngine  ★ 预算分层 / 压缩 / 引用化 / 中文 token 画像（D2）      │   │
│  │ Grounding      ★ 符号图 / 依赖图 / 测试映射（D3）                     │   │
│  │ ToolRouter     工具选择 / 参数校验 / 失败重试与降级                    │   │
│  │ PolicyGate     权限 / 成本闸 / 审计（D4）                             │   │
│  │ Memory         项目长期记忆（D6）                                     │   │
│  │ ModelRouter    分层选模 / 缓存（D7）                                  │   │
│  └───────────────────────────────┬──────────────────────────────────────┘   │
│                                  │ IByokLmChatRequest（现成线协议）          │
│                    IByokLmBridgeRegistry                                    │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   ▼
                    扩展宿主 eva-ai → EVA 网关
```

**接缝点（具体到文件）**

| 模块 | 依托的现有代码 |
|---|---|
| Provider 注册 | `node/agentHostMain.ts:155/171/186`（照抄注册模式） |
| 模型目录 | 照 `copilotAgent.ts` 的 `_refreshByokModels`；复用 `getByokLmAgentModelId` |
| 推理通路 | `common/agentHostByokLm.ts` + `node/byokLmBridgeRegistry.ts`（**现成，已跑通**） |
| 工具调用 | `workbench/contrib/chat/common/tools/languageModelToolsService.ts`（需新增一条 node 侧可达的桥） |
| 会话状态 | `node/agentHostStateManager.ts`、`sessionDatabase.ts` |
| 变更与回滚 | `node/agentHostChangesetService.ts`、`chatContributions/checkpointAndChangeset/` |
| 审批 | `sessionPermissions.ts`、`commandAutoApprover.ts` |
| 缓存 | `agentHostPromptCache.ts`（已有 `modelId` + `cacheExpiresAt`） |
| 遥测 | `node/otel/`、`agentHostSessionOpenTelemetry.ts` |
| 行为可编程 | `.github/agents/*.agent.md` + `hookSchema.ts` + `SKILL.md`（**直接复用，不必另造**） |

---

## 6. 里程碑（粗粒度，用于判断是否该升级投入）

| 阶段 | 目标 | 产出 | 决策点 |
|---|---|---|---|
| **P0 验证**（周级） | 回答 §8 的开放问题与 §9 的待验证项 | 一份"什么可行"的结论 | 是否继续 |
| **P1 增强件**（周级） | D3 检索工具 + D7 分层系统化 + D4 成本闸 | 三家现有 agent 体感可测的提升 | 提升是否显著 |
| **P2 上下文**（月级） | D2：先看能否在代理层改写请求；不能则确认需自研 loop | 上下文画像 + 实测 token 节省 | **是否启动路线 I** |
| **P3 自研 Loop**（月级，条件触发） | `EvaAgent` provider 达成与 Codex 同级能力 | 第四个 agent 可选 | 是否替换默认 |
| **P4 领域化** | D6 规约包 + 项目记忆 | 可复制的企业方案 | — |

**P1/P2 的验收指标建议**（先定，免得事后自欺）：
1. 同一批任务的**平均 token 消耗**下降幅度（P2）
2. 同一批任务的**工具调用轮次**下降幅度（P1/P2）
3. 任务完成率的**人工介入次数**（P3）
4. 从"提问"到"首个正确编辑"的**延迟**（P1）

---

## 7. 唱反调：为什么也许根本不该自研 Loop

头脑风暴必须有反面，否则就是自我说服。

1. **模型才是瓶颈的概率不低**。如果 EVA 侧模型在长程工具使用上的能力弱于 Claude/Codex 所用模型，那么换 loop 换不出体验——钱花了，问题还在。**先做 P1/P2，用数据把这件事问清楚，而不是先赌。**
2. **维护成本是长期的，兴奋是短期的**。`codex/` 一个目录 912 个文件。自研 loop 意味着永久承担这块的上游跟进、bug 修复、协议演进。
3. **fork 的 diff 面积直接决定我们还能不能跟上上游 VS Code**。自研 loop 是 diff 面积最大的一种改法。
4. **"我们有自己的 loop"对用户的价值，远小于"任务真的做对了"**。用户不会为架构自主性付费，只会为结果付费。
5. **"不依赖 loop 就能交付的增强件"可能已经吃掉了 80% 的收益**。D3/D4/D7 不换 loop 也能做——那么剩下 20% 值不值那个成本，需要 P2 的数据来回答。
6. **评估体系缺席**。没有 benchmark 就没有"变好了"的证据，会陷入主观争论。**建议 P0 就建一个小的任务集**（几十个真实改动任务），否则后续所有判断都是拍脑袋。

---

## 8. 待你拍板的问题

| # | 问题 | 影响 |
|---|---|---|
| Q1 | 目标是"自有可控的智能体"，还是"用起来最好的智能体"？ | 决定路线 I 是否必须 |
| Q2 | 是否接受 fork diff 面积显著扩大（影响跟上游）？ | 路线 I 的前提 |
| Q3 | 商业侧最看重什么：成本 / 数据不出内网 / 领域定制 / 品牌自主？ | 决定 D4/D6 的优先级 |
| Q4 | EVA 模型在长程工具使用上的能力，是否已达到可承载自研 loop 的水平？ | **最关键的前置事实** |
| Q5 | 是否要求私有化/内网部署场景可用？ | 决定架构是否允许外挂 runtime |
| Q6 | 有没有可用的真实任务集做 benchmark？ | 决定所有"变好了"的说法能否成立 |
| Q7 | 是否保留 Copilot / Claude / Codex 三家并存？ | 影响 UI 与默认策略（**注意：Copilot 商标按既有决策保留不动**） |

---

## 9. 待验证清单（动手前必须查清）

| # | 待验证 | 为什么关键 | 怎么查 |
|---|---|---|---|
| V1 | **SDK 是否允许自定义 prompt 组装** | 决定 D2 能否在现有三家上落地，还是必须自研 loop | 查 Copilot/Claude/Codex SDK 是否暴露 prompt 组装钩子；否则看 BYOK 代理层能否改写请求体 |
| V2 | `ILanguageModelToolsService` 能否被 node 侧（agent host）直接调用 | 决定自研 loop 能否复用现有工具生态 | 查 `common/tools/languageModelToolsService.ts` 的可见性与已有桥接 |
| V3 | 注册第四个 provider 的最小实现面 | 路线 I 的真实工作量 | 以 `codex/` 与 `copilot/` 为参照，列出必需文件清单 |
| V4 | EVA 网关是否支持 `imageInput` / 多模态 | 决定"截图改 UI"这条线能否做 | 查 `/api/ai/models/square` 返回的 capability（`evaModels.ts` 现有读取逻辑） |
| V5 | EVA 模型的长程工具使用能力基线 | Q4 的答案 | 用 P0 任务集实测；对比现有三家 |
| V6 | `missionControl/` 的成熟度与 `MISSION_CONTROL_PRODUCTION_GAPS.md` 列了哪些缺口 | 决定能否复用为外部控制面 | 读那篇 MD |
| V7 | Hook 机制能否覆盖"工具执行前/后" | 决定 D4 的审批与审计能否用现成机制实现 | 读 `hookTypes.ts` 的 event 枚举 |
| V8 | 现有 trace 数据（`eva-ai.trace`）能否支撑上下文画像 | D2 的输入 | 开一次 trace，看字段是否够用 |

---

## 10. 附录：代码索引

**Agent Host 平台**
- `src/vs/platform/agentHost/node/agentHostMain.ts:155/171/186` — provider 注册（Copilot/Claude/Codex）
- `src/vs/platform/agentHost/common/agentService.ts:872` — `IAgentService`
- `src/vs/platform/agentHost/node/agentHostStateManager.ts`、`sessionDatabase.ts`、`sessionDataService.ts` — 会话状态与持久化
- `src/vs/platform/agentHost/node/agentHostChangesetService.ts`、`agentHostCheckpointService.ts` — 变更集与检查点
- `src/vs/platform/agentHost/node/sessionPermissions.ts`、`sessionSandbox.ts`、`commandAutoApprover.ts` — 权限/沙箱/自动批准
- `src/vs/platform/agentHost/node/agentHostPromptCache.ts:18-58` — prompt 缓存状态
- `src/vs/platform/agentHost/node/automationCron.ts`、`agentHostAutomationService.ts` — 定时/后台
- `src/vs/platform/agentHost/node/agentHostToolCallTracker.ts` — 工具调用追踪
- `src/vs/platform/agentHost/node/agentPluginManager.ts` — agent 插件
- `src/vs/platform/agentHost/node/missionControl/` — 外部控制面（含 `MISSION_CONTROL_PRODUCTION_GAPS.md`）
- `src/vs/platform/agentHost/node/chatContributions/` — 32 个 chat 贡献（含 `turnDelegation/`、`checkpointAndChangeset/`、`persistedFailedTurns/`）
- `src/vs/platform/agentHost/LOCAL_ENDPOINT.md` + `common/agentHostEndpointRegistry.ts` — 外部进程接入协议
- `src/vs/platform/agentHost/OTEL.md`、`PERFORMANCE.md` — 可观测性与性能基线

**BYOK / 模型通路**
- `src/vs/platform/agentHost/common/agentHostByokLm.ts` — 线协议
- `src/vs/platform/agentHost/node/byokLmBridgeRegistry.ts` — 模型快照与窗口选择
- `src/vs/platform/agentHost/node/copilot/byokLmProxyService.ts`、`byokResponsesTranslation.ts` — 代理与协议转换
- `extensions/eva-ai/src/extension.ts:283-370`（模型目录）、`:455-464`（token 校准）
- `extensions/eva-ai/src/evaChat.ts`（流式客户端，文件头记录了网关两个坑）
- `extensions/eva-ai/src/evaProxy.ts`、`evaCliConfig.ts`（`CLI_TIER_MODELS`）、`evaTrace.ts`

**智能体行为可编程面**
- `src/vs/workbench/contrib/chat/common/promptSyntax/hookSchema.ts:1`、`hookTypes.ts` — Hook 定义与 schema
- `src/vs/workbench/contrib/chat/browser/promptSyntax/hookUtils.ts`、`hookActions.ts` — Hook 执行
- `src/vs/workbench/contrib/chat/common/promptSyntax/hookClaudeCompat.ts`、`hookCopilotCliCompat.ts` — 兼容层
- `src/vs/workbench/contrib/chat/browser/tools/languageModelToolsService.ts`、`common/tools/languageModelToolsService.ts` — 工具注册表
- `.github/agents/*.agent.md`、`.github/skills/*/SKILL.md` — 自定义 agent 与技能
- `src/vs/workbench/contrib/preferences/browser/settingsLayout.ts:258` — `chat.agentFilesLocations`

**相关文档**
- `.docs/01_evacode大模型升级改造任务清单.md`
- `.docs/02_evacode界面升级改造任务清单.md`
- `.docs/03_evacode大模型转接方案.md`
- 仓库记忆：《用真值，不要估算》《遇到疑点就修，不要留到后面》《EVA 取代 GitHub 成为唯一账号》《Evacode rebrand: keep Copilot & plugin trademarks》
