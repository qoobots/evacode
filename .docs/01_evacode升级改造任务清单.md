# evacode 升级改造任务清单：接入国内大模型服务商（CC Switch / 百炼）

> 目标：让 evacode 中的国外 AI 智能体（Copilot / Codex / Claude）使用国内服务商（如阿里云百炼）的模型，
> 并评估把 `D:\05workspaces\evaswitch`（CC Switch）集成进 evacode 的可行性。
>
> 状态：**方案已定，待执行**　|　调研日期：2026-10-07　|　代码基线：`3e955824`

---

## 0. 结论摘要（TL;DR）

| 结论 | 影响 |
|---|---|
| **CC Switch 无法直接接管 evacode** | 它的 10 个宿主工具里没有编辑器，不写 `settings.json` / `chatLanguageModels.json` |
| **evacode 无需安装任何插件** | Copilot、Codex、Claude 三套 AI 集成**全部内置**，装 marketplace 扩展是冗余的 |
| **最快可用路径：内置 Copilot + BYOK `customendpoint`** | 零源码改造，写一个 JSON 即可直连百炼；**未登录 GitHub 反而被允许**（见 §1.6） |
| **内置 Codex / Claude 的端点被"刻意锁死"** | 宿主用 `-c` / `settings.env` 强制覆写 base_url 与凭据，CC Switch 写的值会被覆盖 |
| **百炼同时兼容 OpenAI 与 Anthropic 协议** | 两条路线都能对接，优先选 OpenAI 兼容（生态最兼容） |

**推荐执行顺序**：路线 A（当天可用）→ 路线 C-1（打通 Codex，消除 CC Switch 依赖）→ 路线 C-2（可选，Claude）。

---

## 1. 现状分析

### 1.1 evacode 侧：三个 AI 集成入口的能力矩阵

evacode 的 agent host 只注册三个 provider（`src/vs/platform/agentHost/node/agentHostMain.ts:171/186`）：
`copilotcli`、`claude`、`codex`。

| 能力 | **Copilot**（内置扩展） | **Codex**（内置 agent host） | **Claude**（内置 agent host） |
|---|---|---|---|
| 实现方式 | 进程内 `@github/copilot-sdk` | spawn `codex.exe app-server`（`@openai/codex`） | in-process 加载 `@anthropic-ai/claude-agent-sdk` |
| 关键实现 | `extensions/copilot/.../copilotCli.ts:604`、`copilotAgent.ts:2705` | `codexAgent.ts:2504/2547`<br>`codexLaunchConfig.ts:116-151` | `claudeAgentSdkService.ts:274-307`<br>`claudeSdkOptions.ts:177-178` |
| 自定义 base_url | **支持**（`customendpoint` provider） | **不支持**（硬编码 `vscode-proxy`） | **不支持**（proxy 模式强制回环） |
| 读取 CLI dotfile | 不需要 | `~/.codex/config.toml`（provider 段被覆盖） | `~/.claude/settings.json`（`env` 段被覆盖） |
| 凭据来源 | Secret Storage / GitHub token | 本地回环代理 nonce（`codexLaunchConfig.ts:128`） | 本地回环代理 nonce（`claudeSdkOptions.ts:136-139`） |
| 模型列表来源 | CAPI 动态 + BYOK 动态 | CAPI 动态，仅保留 `/responses` 模型（`codexAgent.ts:267`） | 本地代理 `/v1/models` + SDK 静态表（`claudeAgent.ts:946/997`） |
| 启用开关 | 随内置扩展 | `chat.agentHost.codexAgent.enabled`<br>（默认 `quality !== 'stable'`） | `chat.agentHost.claudeAgent.enabled`（默认 `true`） |

### 1.2 evacode 已内置的 BYOK 通路（唯一开放的扩展点）

这是本次调研**最重要的发现**：evacode 已经内置了一条完整的「自定义端点 → Copilot CLI」通路，无需改 Copilot CLI 本身。

```
Copilot SDK runtime
  ← 注入 type:'openai', wireApi:'responses', baseUrl=http://127.0.0.1:<port>/v/<vendor>
  ← byokLmProxyService.ts:114-127（本地 OpenAI 兼容 HTTP 代理）
  ← ILanguageModelsService
  ← 扩展 BYOK provider（customendpoint：任意 OpenAI/Anthropic 兼容端点）
  → 百炼
```

关键代码：

| 位置 | 作用 |
|---|---|
| `extensions/copilot/src/extension/byok/vscode-node/byokContribution.ts:58-71` | provider 清单，含 `CustomEndpointBYOKModelProvider('customendpoint')` |
| `extensions/copilot/src/extension/byok/vscode-node/customEndpointProvider.ts:23` | `apiType: 'chat-completions' \| 'responses' \| 'messages'` |
| 同文件 `:25-46`、`:58-60` | 自动补 `/v1/chat/completions`；识别 `/responses`、`/messages` |
| 同文件 `:286-308` | messages 协议发 `x-api-key` + `anthropic-version: 2023-06-01`，否则 `Authorization: Bearer` |
| 同文件 `:327-335` | `requestHeaders` 里字面量 `${apiKey}` 会被替换为真实 key |
| `src/vs/platform/agentHost/node/copilot/copilotSessionLauncher.ts:566-620` | 构造注入给 runtime 的 provider 列表 |
| `src/vs/platform/agentHost/common/agentHostByokLm.ts:112-192` | 线协议，模型 id 格式 `${vendor}/${id}` |
| `extensions/copilot/package.json:2006-2179` | `customendpoint` 的完整 JSON Schema |

**配置文件位置**：`<userDataDir>/User/chatLanguageModels.json`
（默认 profile 下 `location` 即 `User` 子目录，**不是** userDataDir 根目录；`src/vs/platform/userDataProfile/common/userDataProfile.ts:204`；结构见 `src/vs/workbench/contrib/chat/common/languageModelsConfiguration.ts:41-47`）

**API key 不落盘**：存 VS Code Secret Storage，key 名 `copilot-byok-<provider>[-<model>]-api-key`
（`extensions/copilot/src/extension/byok/vscode-node/byokStorageService.ts:68/76/96`）。

### 1.3 为什么 CC Switch（evaswitch）不能直接接管

| 事实 | 证据 |
|---|---|
| 它的宿主枚举里没有编辑器 | `src-tauri/src/app_config.rs:400-418`（`Claude/ClaudeDesktop/Codex/Gemini/GrokBuild/OpenCode/OpenClaw/Hermes/Pi/Mcode`） |
| 全仓库无任何 VS Code 路径引用 | `settings.json`、`chatLanguageModels.json`、VS Code 扩展 ID 均零命中 |
| 它写的是 CLI dotfile | `~/.claude/settings.json`（`config.rs:297-310`）、`~/.codex/config.toml`（`codex_config.rs:834-837`） |
| Provider 存储在 SQLite | `~/.cc-switch/cc-switch.db`（`config.rs:313-361`、`database/schema.rs:26-31`） |
| **它本身支持任意自定义 baseUrl** | `src/components/providers/forms/ProviderForm.tsx:398`（完整 URL 模式） |
| **它已内置百炼预设** | `src/config/codexProviderPresets.ts:1753-1758`（`https://dashscope.aliyuncs.com/compatible-mode/v1`） |
| 它有本地代理模式 | `app_config.rs:448-453`，仅 Claude/Codex/Gemini/GrokBuild |
| 写入是字段级补丁 + 合并，不整体覆写 | `src-tauri/src/services/provider/claude_direct.rs:1-5`（文件头注释）、`live/project/claude.rs:89` |

> `src/lib/api/vscode.ts` 是**文件名误导**，实为通用 API 模块，与 Visual Studio Code 无关。

### 1.4 为什么内置 Codex / Claude 会被 CC Switch 覆盖

这是 evacode 的**刻意设计**，不是疏漏：**CLI 只做执行引擎，认证与路由由 VS Code 自己的回环代理 + CAPI 统一管控**，防止 token 外泄。

| 目标 | CC Switch 写入的内容 | evacode 的应对 | 结果 |
|---|---|---|---|
| Codex 换供应商 | `[model_providers.x] base_url` | `codexLaunchConfig.ts:130-143` 用 `-c` 硬编码 `model_providers.vscode-proxy.base_url` 指向本地回环；`:128` 把 `OPENAI_API_KEY` 锁成 nonce | ❌ 被完全绕过，provider 由 `codexAgent.ts:268/270` 硬编码 |
| Codex 防篡改 | — | `codexProviderConfiguration.ts:88-94` 明确把 `base_url`/`env_key`/`experimental_bearer_token`/`http_headers` 列为 `vscode-proxy` 的**非法字段**；宿主还会主动写入该段（`:64-72`） | 🚫 主动防御 |
| Claude 换供应商 | `env.ANTHROPIC_BASE_URL` | proxy 模式下 `claudeSdkOptions.ts:136-139` 通过 `settings.env` 注入**同名**变量，在 settings.json 之后应用 | ⚠️ 被压过 |
| Claude 换 key | `env.ANTHROPIC_API_KEY` | proxy 模式 `claudeSdkOptions.ts:395` 显式置 `undefined` | ❌ 被剥离 |

补充：`claudeTransportMode.ts:54-60` 明确写 *"There is deliberately no host-global setting to prefer a transport"* —— 没有任何全局开关能改传输模式。

### 1.5 百炼的协议支持（2026-09 官方文档核实）

| 协议 | 端点形态 | 备注 |
|---|---|---|
| OpenAI 兼容 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 推荐；新版按 workspace 专属域 `https://{WorkspaceId}...` |
| Anthropic 兼容 | 支持（官方专文说明 Claude Code 接入） | `apiType: "messages"` |
| Token Plan | 独立域名 `token-plan.cn-beijing.maas.aliyuncs.com`，密钥前缀 `sk-sp-` | 与普通 `sk-` 密钥**不能混用** |

官方明确支持"兼容 openai / anthropic api 协议且支持自定义服务端点的第三方编程工具"。

---

## 2. 可行性判定矩阵

| 组合 | 可行性 | 理由 |
|---|---|---|
| CC Switch → 内置 Copilot | ❌ | CC Switch 不写 `chatLanguageModels.json` |
| CC Switch → 内置 Codex | ❌ | `-c` 覆写 + nonce 锁 + 主动防御 |
| CC Switch → 内置 Claude（proxy 模式） | ❌ | 同名 env 注入压过 + API key 被剥离 |
| CC Switch → 内置 Claude（native 模式） | ⚠️ 条件苛刻 | 需同时满足：flag `allowSignedOutWhenUsable` + **未登录 GitHub** + `accountInfo()` 有凭据（`claudeTransportMode.ts:62-74`） |
| 直接配 BYOK `customendpoint` → 百炼 | ✅ | 内置能力，零改造 |
| 源码改造放开 Codex provider | ✅ | 有明确的拦截点，改动范围可控 |
| 装 marketplace 扩展（`openai.chatgpt`/`anthropic.claude-code`） | ⚠️ 冗余 | evacode 已内置；且这两者读自己的扩展存储，同样不受 CC Switch 支配 |

---

## 3. 方案设计

### 路线 A：内置 Copilot + BYOK `customendpoint` 直连百炼（推荐，零改造）

**原理**：走 1.2 的现成通路，Copilot SDK runtime 通过本地回环代理把请求转发到百炼。

**前置条件**（缺一即"配了没反应"）：

- [x] **无需 GitHub 登录** —— `isClientBYOKAllowed`（`byokProvider.ts:226-234`）对 signed-out 用户返回 **`true`**，
      注释原文 *"Signed-out users are allowed"*。反之若登录了 GitHub 但拿不到 Copilot token，反而会被拒绝（`:230-232`）
- [x] `chat.agentHost.byokModels.enabled` 为 `true` —— 实测本机 `agent-host-config.json` 已是 `byokModelsEnabled: true`

**实施步骤**：

1. 确认 `chatLanguageModels.json` 路径（默认 profile 下为 `<userDataDir>/User/chatLanguageModels.json`；实测本机即此，非根目录）
2. 写入 provider 组（示例见 §4.1）
3. 在 UI 中填入 API key（走 Secret Storage，勿明文写文件）
4. 重启窗口，在模型选择器中确认出现 `customendpoint/...` 条目

**风险**：低。局限在于需要 GitHub 登录态 —— 若目标环境无法访问 GitHub，此路线不可用，此时转路线 C。

### 路线 B：CC Switch 本地代理 + evacode 指向回环（中等改造）

**原理**：CC Switch 起本地代理（`app_config.rs:448-453`）转发到百炼，evacode 侧只需把 base_url 指向 `http://127.0.0.1:<port>`。

**为什么不能直接用**：Codex/Claude 的 base_url 被宿强制覆写（§1.4），必须先做路线 C-1/C-2 的改造才能让它们指向 CC Switch 的代理。

**实施步骤**：

1. 完成路线 C-1（Codex 放开 provider 可配置）
2. 在 CC Switch 中添加百炼 provider（`codexProviderPresets.ts:1753-1758` 已有预设），切到本地代理模式
3. 记录 CC Switch 监听端口，在 evacode 中把 `chat.agentHost.codexAgent.*` 指向该端口

**风险**：中。引入一层本地代理转发，增加故障点和排障复杂度。仅在必须保留 CC Switch 统一管理时才选。

### 路线 C：源码改造（工程化，彻底解决）

#### C-1：放开 Codex 自定义 provider（消除 CC Switch 依赖）

**目标**：让 `~/.codex/config.toml` 里 CC Switch 写的 `[model_providers.x]` 真正生效。

| 拦截点 | 现状 | 改造方向 |
|---|---|---|
| `codexLaunchConfig.ts:130-143` | 硬编码 `-c model_providers.vscode-proxy.*` | 新增设置 `chat.agentHost.codexAgent.externalProvider`，为真时**不注入** `-c` 覆写 |
| `codexLaunchConfig.ts:128` | `env.OPENAI_API_KEY = proxy.nonce` | 外部 provider 模式下改为不覆盖，让 CLI 读 config.toml |
| `codexAgent.ts:268` | `CODEX_COPILOT_MODEL_PROVIDER = 'vscode-proxy'` 硬编码 | 改为可配置 |
| `codexProviderConfiguration.ts:88-94` | 主动判 `vscode-proxy` 字段非法 | 外部模式下降级为警告，不阻断 |
| 模型列表 `codexAgent.ts:267` | 只保留暴露 `/responses` 的模型 | 百炼需确认其 `/responses` 兼容性；不兼容时需放宽过滤 |

**新增设置键**（建议命名，沿用 `chat.agentHost.codexAgent.*` 命名空间）：

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `chat.agentHost.codexAgent.externalProvider.enabled` | boolean | `false` | 关闭 vscode-proxy 注入，转由 config.toml 决定 |
| `chat.agentHost.codexAgent.externalProvider.name` | string | `''` | config.toml 中的 provider 名 |

**验收**：`~/.codex/config.toml` 配 `[model_providers.bailian] base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"` 后，
Codex agent 的模型请求实际到达百炼（可用百炼侧 token 用量日志佐证），且请求头不含 VS Code nonce。

#### C-2：放开 Claude 外部 provider（可选）

**目标**：让 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` 生效（等价于让 CC Switch 接管 Claude）。

| 拦截点 | 改造方向 |
|---|---|
| `claudeTransportMode.ts:62-74` | 新增设置允许强制 `native` 传输，跳过 flag/登录态判定 |
| `claudeSdkOptions.ts:136-139` | 外部模式下不注入 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` |
| `claudeSdkOptions.ts:395` | 外部模式下不剥离 `ANTHROPIC_API_KEY` |
| `claudeAgent.ts:946` | 模型列表来源从本地代理改为 CLI 侧发现 |

**风险**：高。绕过代理意味着放弃 evacode 的凭据保护，**必须确保 Secret Storage 与日志脱敏仍然生效**。

#### C-3：CC Switch 侧增加 evacode 适配（若坚持"统一管理"）

**目标**：让 CC Switch 像管理 Claude Code CLI 一样管理 evacode。

**实施**：在 `src-tauri/src/app_config.rs:400-418` 的 `AppType` 增加 `Evacode`，实现两件事：

1. 写 `<userDataDir>/User/chatLanguageModels.json`（默认 profile 位于 `User` 子目录，**非根目录**；provider 组走 §4.1 schema）
2. 沿用已有 `live/project/claude.rs:89` 的 `direct_patch` 字段级补丁策略，**不要整体覆写**（该文件里可能有用户手工加的模型）

**风险**：中。需在两个仓库间同步 schema；copilot 扩展升级可能改 schema。

---

## 4. 配置样例

### 4.1 百炼接入 `chatLanguageModels.json`

> ⚠️ `apiKey` 不要明文写入此文件 —— 用 `${input:xxx}` 占位，真实值走 Secret Storage
> （`byokStorageService.ts:96`，key 名 `copilot-byok-customendpoint-api-key`）。
> 直接明文写 `apiKey` 字段虽然可用，但会落盘。

```jsonc
// 注意：顶层是数组，不是 { "providerGroups": [...] }
// 依据 languageModelsConfigurationService.ts:218/232（JSON.stringify(groups, undefined, '\t')）
[
	{
		"name": "阿里云百炼",
		"vendor": "customendpoint",
		"settings": {
			"apiKey": "${input:chat.lm.secret.bailian}",   // 引用 Secret Storage
			"apiType": "chat-completions",                  // 百炼走 OpenAI 兼容
			"models": [
				{
					"id": "qwen3.8-max",
					"name": "Qwen3.8 Max",
					"url": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
					"toolCalling": "true",                  // Agent 场景必须为 true
					"vision": "false",
					"maxInputTokens": "262144",
					"maxOutputTokens": "65536"
				},
				{
					"id": "qwen3.7-plus",
					"name": "Qwen3.7 Plus",
					"url": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
					"toolCalling": "true",
					"vision": "false",
					"maxInputTokens": "262144",
					"maxOutputTokens": "32768"
				}
			]
		}
	}
]
```

> 模型 ID 取自百炼官方模型大全（2026-09 更新）。若用 Token Plan 套餐，密钥前缀为 `sk-sp-`，
> 且需改用独立域名 `token-plan.cn-beijing.maas.aliyuncs.com`；普通按量付费用 `sk-` + 通用域名。

**若改用 Anthropic 兼容端点**：`apiType` 改为 `"messages"`，`url` 填到 `/v1/messages`，
客户端会自动改用 `x-api-key` + `anthropic-version: 2023-06-01`（`customEndpointProvider.ts:291-296`）。

**Token Plan 注意**：必须用独立域名 + `sk-sp-` 前缀密钥，与普通百炼密钥不通用。

### 4.2 CC Switch 侧的百炼 provider（供路线 B/C 使用）

CC Switch 已内置百炼预设（`codexProviderPresets.ts:1753-1758`），也可手工添加：

```toml
# ~/.codex/config.toml —— CC Switch 写入的内容
[model_providers.bailian]
name = "阿里云百炼"
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
wire_api = "chat"          # 注意：evacode 过滤逻辑只保留 `/responses`（codexAgent.ts:267）
requires_openai_auth = true
env_key = "DASHSCOPE_API_KEY"
```

> ⚠️ 此配置在**未完成路线 C-1 之前对 evacode 无效**（§1.4）。

---

## 5. 任务清单

### 阶段 0：环境准备与验证

- [ ] 0.1 确认百炼 API key 与端点（含是否为 Token Plan 套餐）
- [ ] 0.2 确认 `chatLanguageModels.json` 的实际路径：`<userDataDir>` 随启动 profile 变化，需实测
- [ ] 0.3 确认 evacode 是否有 GitHub 登录态（**决定路线 A 是否可用**）
- [ ] 0.4 用 `curl` 直连百炼端点，验证 `chat/completions` 与 tool calling 可用
- [ ] 0.5 确认百炼是否支持 `/v1/responses`（决定 Codex 路线的可行性，`codexAgent.ts:267`）

### 阶段 1：路线 A 落地（不依赖任何改造）

- [ ] 1.1 按 §4.1 写入 `<userDataDir>/User/chatLanguageModels.json`（默认 profile 在 `User` 子目录，**非根目录**）
- [ ] 1.2 通过 UI 将 API key 写入 Secret Storage
- [ ] 1.3 重启窗口，确认模型选择器出现百炼模型
- [ ] 1.4 实测：发起一次带工具调用的对话，确认请求到达百炼（百炼侧 token 用量佐证）
- [ ] 1.5 验收：`git status` 无源码改动；重启后配置仍生效

### 阶段 2：路线 C-1（Codex 放开自定义 provider）

- [ ] 2.1 新增两个设置键 + 注册（`agentHostStarter.config.contribution.ts`，`tags: ['experimental','advanced']`）
- [ ] 2.2 改 `codexLaunchConfig.ts:123-143`：外部模式下不注入 `-c` 覆写、不锁 `OPENAI_API_KEY`
- [ ] 2.3 改 `codexAgent.ts:268`：provider 名可配置
- [ ] 2.4 改 `codexProviderConfiguration.ts:88-94`：外部模式下不判非法
- [ ] 2.5 依 0.5 结论决定是否放宽 `codexAgent.ts:267` 的模型过滤
- [ ] 2.6 补单测：参照 `test/node/codex/codexLaunchConfig.test.ts` 的断言风格
- [ ] 2.7 `npm run typecheck-client` + `scripts/build-local.ps1 compile`
- [ ] 2.8 验收：config.toml 配百炼 → Codex agent 请求到达百炼

### 阶段 3：CC Switch 集成（路线 B / C-3，可选）

- [ ] 3.1 评估是否需要：若阶段 1 已满足需求，本阶段可跳过
- [ ] 3.2 （C-3）在 `app_config.rs` 增加 `Evacode` 枚举 + `FromStr`/`as_str`
- [ ] 3.3 实现 `chatLanguageModels.json` 的字段级补丁写入（参考 `live/project/claude.rs:89`）
- [ ] 3.4 在 UI 增加 evacode 图标与 provider 表单
- [ ] 3.5 验收：从 CC Switch 切换供应商，evacode 重启后模型随之变化

### 阶段 4：可选增强

- [ ] 4.1 Claude 外部 provider（C-2），**风险高，需评估凭据保护影响**
- [ ] 4.2 模型能力覆写：`chat.agentHost.copilot.modelCapabilityOverrides`（`copilotCliConfig.ts:285-335`）为百炼模型补 `availableTools`
- [ ] 4.3 彻底替换 runtime：`chat.agentHost.copilot.runtimePath`（`copilotCliConfig.ts:195-200`）

### 明确不做

- ❌ 安装 `openai.chatgpt` / `anthropic.claude-code` marketplace 扩展 —— evacode 已内置，且它们读自己的扩展存储，同样不受 CC Switch 支配
- ❌ 修改 CC Switch 的插件文件或 IDE 环境变量 —— 源头不可改，见记忆文档《Windows 构建环境陷阱与固化入口》

---

## 6. 风险与前置条件

| 风险 | 等级 | 缓解 |
|---|---|---|
| 登录了 GitHub 但拿不到 Copilot token → BYOK provider 被注销 | 中 | 保持 signed-out 即可（`byokProvider.ts:227-232`）；若已登录则需修复 token 获取 |
| 百炼 `/responses` 兼容性未知 | 中 | 阶段 0.5 先验证；不兼容则 Codex 走 `wire_api = "chat"` 并放宽过滤 |
| C-2 绕过回环代理 → 凭据保护削弱 | 高 | 若实施，需先确认 Secret Storage 与日志脱敏仍生效 |
| copilot 扩展升级改动 BYOK schema | 中 | C-3 的写入需做 schema 版本容错 |
| `chatLanguageModels.json` 被用户手改冲突 | 低 | 沿用 CC Switch 的字段级补丁 + 首写备份策略 |
| 打包时 copilot SDK 版本校验失败 | 低 | `package.json` 的 `copilotRuntimeVersion` 必须与 `@github/copilot-sdk` 一致 |

---

## 7. 附录：代码引用索引

**evacode · BYOK / Copilot**
- `extensions/copilot/src/extension/byok/vscode-node/byokContribution.ts:58-107` — provider 清单与门控
- `extensions/copilot/src/extension/byok/vscode-node/customEndpointProvider.ts:23-60, 259-335` — 端点解析与鉴权头
- `extensions/copilot/src/extension/byok/vscode-node/byokStorageService.ts:65-101` — Secret Storage
- `extensions/copilot/package.json:2006-2179` — `customendpoint` JSON Schema
- `src/vs/platform/agentHost/node/copilot/byokLmProxyService.ts:114-127` — 本地回环代理
- `src/vs/platform/agentHost/node/copilot/copilotSessionLauncher.ts:566-620` — 注入 runtime 的 provider 构造
- `src/vs/platform/agentHost/common/agentHostByokLm.ts:112-192` — 代理线协议
- `src/vs/workbench/contrib/chat/common/languageModelsConfiguration.ts:23-47` — 配置结构与文件位置
- `src/vs/platform/userDataProfile/common/userDataProfile.ts:204` — `chatLanguageModels.json` 路径

**evacode · Codex**
- `src/vs/platform/agentHost/node/codex/codexAgent.ts:2504/2547/267/268/270` — spawn、模型过滤、provider 硬编码
- `src/vs/platform/agentHost/node/codex/codexLaunchConfig.ts:116-151` — env 与 `-c` 覆写
- `src/vs/platform/agentHost/node/codex/codexProviderConfiguration.ts:30-94` — config.toml UI 与防篡改
- `src/vs/platform/agentHost/common/agentService.ts:213/284/323/329/335` — 相关设置键

**evacode · Claude**
- `src/vs/platform/agentHost/node/claude/claudeAgentSdkService.ts:274-307` — SDK 加载
- `src/vs/platform/agentHost/node/claude/claudeSdkOptions.ts:136-141/177-178/199/386-412` — env 注入、settingSources
- `src/vs/platform/agentHost/node/claude/claudeTransportMode.ts:54-74` — transport 判定
- `src/vs/platform/agentHost/node/claude/claudeAgent.ts:946/974/997` — 模型列表
- `src/vs/platform/agentHost/node/claude/CONTEXT.md` — 157KB 详细设计文档

**evaswitch（CC Switch）**
- `src-tauri/src/app_config.rs:400-495` — `AppType` 枚举
- `src-tauri/src/config.rs:297-361/441-459` — 各工具路径与原子写
- `src-tauri/src/codex_config.rs:272-277/834-837` — Codex config.toml
- `src-tauri/src/services/provider/claude_direct.rs:1-5/73-89` — 字段级补丁写入
- `src-tauri/src/live/project/claude.rs:89` — `direct_patch` 算法
- `src-tauri/src/live/engine.rs:52-54/158-187` — 首写备份与写锁
- `src-tauri/src/database/schema.rs:26-31` — SQLite provider 表
- `src/config/codexProviderPresets.ts:1753-1758` — 百炼预设
- `src/components/providers/forms/ProviderForm.tsx:376-469/793-798` — 自定义 provider 表单

**外部文档**
- 阿里云百炼接入编程工具：<https://help.aliyun.com/zh/model-studio/more-tools>
