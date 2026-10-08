# evacode 升级改造任务清单：界面深度改造（品牌化 / 商业定制）

> 目标：对 evacode（VS Code fork，当前 `product.json` 仍为 `Code - OSS`）做深度界面改造，
> 以匹配商业产品的品牌形象、首启体验、信息架构与分发策略。
>
> 状态：**方案梳理完成，待商业确认后执行**　|　梳理日期：2026-10-08　|　代码基线：`c623f099`（branch `main`）

---

## 0. 结论摘要（TL;DR）

| 结论 | 影响 |
|---|---|
| **品牌信息高度集中在 `product.json` + `src/vs/base/common/product.ts`** | 改名/改链接/改市场大多改这两处即可，无需散点改代码 |
| **图标资源分散在 `resources/` 与原生标题栏 SVG** | 需替换 4 套平台图标 + `code-icon.svg`，否则窗口/任务栏仍是 VS Code 图标 |
| **首启引导现在是「两套并存」** | 新版 `welcomeOnboarding`（OnboardingVariationA）与旧版 `welcomeGettingStarted`/`welcomeWalkthrough` 都要评估 |
| **Help 菜单是第三方链接（文档/反馈/YouTube/Ask @vscode）重灾区** | 移除/改写集中在 `helpActions.ts` 与 `issue/*` |
| **遥测/更新/市场开关各自独立** | 分别由 `telemetry.telemetryLevel`、`update.mode`、`extensionsGallery` 控制 |
| **商标合规是前置硬约束** | 必须彻底移除 `Microsoft`/`Visual Studio`/`VS Code` 字样与图标，避免商标侵权 |

**推荐执行顺序**：阶段 0（确认商业输入）→ 阶段 1（品牌基础）→ 阶段 2（首启体验）→ 阶段 3（布局/主题）→ 阶段 4（菜单/链接清洗）→ 阶段 5（遥测/更新/市场）→ 阶段 6（打包/分发）→ 阶段 7（验收）。

---

## 1. ⚠️ 待商业确认的输入（开工前必填）

> 以下项未定前，各阶段只能做到「占位/可配置」，无法落地最终效果。

| 编号 | 待确认项 | 用途 | 影响阶段 |
|---|---|---|---|
| B-1 | 产品中文名 / 英文名（短名 + 长名） | `nameShort`/`nameLong` | 1,3,4 | **已确认：Evacode / evacode（已在 product.json 落地）** |
| B-2 | 应用进程名（`applicationName`，如 `evacode`） | 命令行、数据目录、协议 | 1 | **已确认：evacode（已落地）** |
| B-3 | 数据目录名（`dataFolderName`、`.vscode-oss` → `.<brand>`） | 用户配置隔离 | 1 |
| B-4 | 主色 / 强调色 / 深色&浅色默认主题 | 标题栏、活动栏、强调色 | 3 | **已确认：默认仅深色 + 浅色两套，用户可经插件自行扩展主题；品牌强调色待提供** |
| B-5 | Logo 源文件（SVG 矢量 + 各平台 ico/icns/png） | 窗口/安装包/任务栏 | 1,6 | **已生成：品牌色 `#4F46E5 → #7C3AED`，全套图标已产出（code.ico / code.icns / code.png / server/* / 标题栏 SVG）** |
| B-6 | 首启引导要呈现的内容（产品介绍/快捷入口/注册登录） | 首启页 | 2 |
| B-7 | 是否需要内置账号登录/激活（影响首启与 Help 菜单） | 首启页、命令面板 | 2,4 |
| B-8 | 扩展市场来源（自建 Open VSX / 私有市场 URL） | `extensionsGallery` | 5 |
| B-9 | 问题反馈/帮助入口指向（自建工单/社区/客服 URL） | `reportIssueUrl`、Help 菜单 | 4,5 |
| B-10 | 是否保留遥测（产品用量统计）还是完全关闭 | `telemetry.telemetryLevel` | 5 |
| B-11 | 是否启用自动更新（自托管更新服务 or 关闭） | `update.mode`/`update.channel` | 5,6 |
| B-12 | 需隐藏/移除的功能入口清单（如某些视图、命令、菜单项） | 菜单清洗 | 4 |

---

## 2. 现状分析（界面定制面清单）

基于 `c623f099` 的源码检索，evacode 的界面定制面共 14 个，关键入口如下（完整索引见 §7）：

| # | 定制面 | 核心入口 | 改动难度 |
|---|---|---|---|
| 1 | 产品名/应用名/品牌串 | `product.json:2-37`、`src/vs/base/common/product.ts`、`src/vs/platform/product/common/product.ts` | 低 |
| 2 | 应用/窗口/标题栏图标 | `resources/win32/code.ico`、`darwin/code.icns`、`linux/code.png`、`src/vs/workbench/browser/media/code-icon.svg` | 中 |
| 3 | 首启/Getting Started | `welcomeOnboarding/*`、`welcomeGettingStarted/*`、`welcomeWalkthrough/*` | 中 |
| 4 | About 对话框 | `platform/dialogs/electron-browser/dialog.ts:17-49`、`browser/actions/windowActions.ts:395-476` | 低 |
| 5 | 标题栏/活动栏/状态栏布局 | `browser/parts/titlebar/`、`activitybar/`、`statusbar/`、`sidebar/` 及各自 `media/*.css` | 中 |
| 6 | 全局主题/颜色/CSS | `platform/theme/common/colors/*.ts`、`colorRegistry.ts` | 中 |
| 7 | 默认设置覆盖 | `platform/configuration/common/configurationRegistry.ts` | 低 |
| 8 | 遥测/更新禁用 | `platform/telemetry/*`、`platform/update/*` | 中 |
| 9 | 菜单/命令面板/上下文菜单 | `browser/actions/helpActions.ts`、`platform/actions/common/actions.ts`、`MenuRegistry` | 中 |
| 10 | 启动闪屏 | `contrib/splash/*`、`code/electron-browser/workbench/partsSplash.ts` | 中 |
| 11 | 报告问题/反馈/帮助链接 | `contrib/issue/*`、`product.json:34` | 低 |
| 12 | 扩展市场 URL | `product.json:40-47`、`extensionGalleryManifestService.ts:97` | 低 |
| 13 | 默认键位/引导键位 | `product.json:178-252`、`onboardingVariationA.ts:870-1012` | 低 |
| 14 | 标题栏产品图标/侧栏 Logo | `code-icon.svg`、`titlebarPart.ts:475-478`、`sidebarPart.ts` | 中 |

---

## 3. 任务清单

### 阶段 0：商业输入与品牌规范（前置）

- [ ] 0.1 收集 §1 的 B-1 ~ B-12，形成《品牌与产品规范》单文档
- [ ] 0.2 交付 Logo 矢量稿（SVG）与三平台位图（ico/icns/png，含多尺寸：16/32/48/64/128/256/512）
- [ ] 0.3 确定主色板（深色 + 浅色各一套），输出为 `colorRegistry` 可注册的色值
- [ ] 0.4 商标合规自查：确认不使用 `Microsoft`/`Visual Studio`/`VS Code`/`Copilot` 商标（Copilot 为 GitHub 商标，见 §7 风险）
- [ ] 0.5 拟定需要隐藏/移除的功能入口清单（对应 B-12）

### 阶段 1：品牌基础（改名 + 图标资源）

- [ ] 1.1 修改 `product.json` 品牌字段：`nameShort`/`nameLong`/`applicationName`/`dataFolderName`/`sharedDataFolderName`/`urlProtocol`/`win32*`/`darwin*`/`linux*`（`product.json:2-37`）
- [ ] 1.2 校验 `src/vs/platform/product/common/product.ts:44-50` 的 Dev 后缀逻辑（改名后 Dev 显示为 `<<BRAND>> Dev` 是否符合预期）
- [x] 1.3 替换平台图标：`resources/win32/code.ico`、`resources/darwin/code.icns`、`resources/linux/code.png`、`resources/server/*`（用 PIL 生成，品牌色 `#4F46E5→#7C3AED`）
- [x] 1.4 替换 `src/vs/workbench/browser/media/code-icon.svg`（标题栏 app icon 本体，已同步品牌渐变）
- [ ] 1.5 全文检索残留 `Code - OSS` / `Visual Studio Code` / `Microsoft Corporation` 字面量并替换（约 9500+ 处命中，重点在非依赖的源码/资源，依赖与第三方版权注释保留）
- [ ] 1.6 更新 `package.json:2` 的 `name`（当前 `code-oss-dev`）与版本号策略

### 阶段 2：首启体验（Welcome / Onboarding）

- [ ] 2.1 评估并二选一：定制新版 `welcomeOnboarding`（OnboardingVariationA）或旧版 `welcomeGettingStarted`（`welcomeOnboarding/browser/welcomeOnboarding.contribution.ts:15-33`、`onboardingVariationA.ts:96`）
- [ ] 2.2 改写首启页品牌内容（产品介绍、快捷入口、主题/键位选择），替换默认 VS Code 文案与截图
- [ ] 2.3 如 B-7 需要账号登录/激活，在首启页注入登录卡片（对接自有鉴权）
- [ ] 2.4 校准 `product.json:178-252` 的 `onboardingKeymaps`/`onboardingThemes`，保留或替换为自有主题与键位扩展
- [ ] 2.5 清理首启遥测埋点（如不需要）`onboardingVariationA.ts:1257`

### 阶段 3：布局与主题（标题栏 / 活动栏 / 状态栏 / 配色）

- [ ] 3.1 标题栏改造：`titlebarPart.ts:470-504` 左/中/右布局、`titlebarpart.css` 样式、appIcon 徽标色 `:857-858`
- [ ] 3.2 活动栏/状态栏/侧边栏结构调整：`activitybar/`、`statusbar/`、`sidebar/` 三处 `*.ts` + `media/*.css`
- [ ] 3.3 注入品牌主色：在 `platform/theme/common/colors/*.ts` 覆盖 `activityBar.background`/`titleBar.activeBackground`/`statusBar.background` 等默认值
- [ ] 3.4 新增（或替换）内置主题：提供深色 + 浅色品牌主题（参考 `product.json:215-252` `onboardingThemes`）
- [ ] 3.5 侧边栏 Logo（可选）：在 `sidebarPart.ts` 新增品牌 Logo 元素（默认无注入点，需自建）
- [ ] 3.6 闪屏配色同步：`code/electron-browser/workbench/partsSplash.ts:8-29` 取色与品牌主题一致

### 阶段 4：菜单 / 命令 / 帮助链接清洗

- [ ] 4.1 重写 Help 菜单：`browser/actions/helpActions.ts`（行 42/75/107/139/194/226/258/296/325/358 的文档/视频/技巧/订阅/YouTube/Ask @vscode 等入口）
- [ ] 4.2 移除或重定向 `Report Issue...`：`contrib/issue/common/issue.contribution.ts:115-130` 与 `electron-browser/issue.contribution.ts:83-92`，指向 B-9 自有入口
- [ ] 4.3 按 B-12 移除/隐藏命令与菜单项：全局检索 `MenuRegistry.appendMenuItem` / `registerCommand`，对不需要的项加条件门控
- [ ] 4.4 About 对话框品牌化：`platform/dialogs/electron-browser/dialog.ts:17-49` 标题用 `nameLong`，补充版权/商标归属行；`menubar.ts:409` "About {nameLong}"
- [ ] 4.5 命令面板（Quick Access）入口清洗：`quickaccess` 相关 MenuRegistry、隐藏内部调试命令

### 阶段 5：遥测 / 更新 / 市场（商业合规与分发控制）

- [ ] 5.1 遥测策略：按 B-10 设定 `telemetry.telemetryLevel` 默认值（`platform/telemetry/common/telemetryService.ts:277-373`）；关闭则同步断开 `telemetry.feedback.enabled` 闸门（`issue/*`、`surveys/nps.contribution.ts`）
- [ ] 5.2 更新策略：按 B-11 设定 `update.mode`/`update.channel`（`platform/update/common/update.config.contribution.ts:13-90`）；自托管则改 `updateService.*.ts` 的更新源
- [ ] 5.3 隐藏/改写 Help 菜单 "Check for Updates"：`contrib/update/browser/update.contribution.ts:59`
- [ ] 5.4 扩展市场重定向：按 B-8 改 `product.json:40-47` `extensionsGallery`（serviceUrl/itemUrl/resourceUrlTemplate 等），核对 `extensionGalleryManifestService.ts:97` 读取点
- [ ] 5.5 默认设置覆盖：通过 `configurationRegistry.ts` 的 `registerDefaultConfigurations()`（`platform/configuration/common/configurationRegistry.ts:104,512`）固化商业默认项（如默认主题、关闭遥测、隐藏某视图）

### 阶段 6：打包与分发（图标落进安装包）

- [ ] 6.1 Windows 安装包图标：`build/win32/code.iss:16,25,112-115`（SetupIconFile、快捷方式、文件关联）
- [ ] 6.2 macOS/AppImage 图标与 BundleId：`darwinBundleIdentifier`/`linuxDesktopName` 已随 1.1 改，确认打包脚本引用新资源
- [ ] 6.3 自托管更新通道：若 5.2 启用了自动更新，部署更新服务器并填入 URL
- [ ] 6.4 安装包品牌名/协议/卸载项文本校对（InnoSetup、DMG、deb/rpm 模板）

### 阶段 7：验收与回归

- [ ] 7.1 构建：`scripts/build-local.ps1 compile` + `npm run typecheck-client`（参考 doc 01 §5 阶段 2.7）
- [ ] 7.2 三平台实机验收：窗口/任务栏/安装包图标均为新 Logo，无 VS Code 残留
- [ ] 7.3 首启页品牌内容与 B-6 一致；不触发外部（GitHub/Microsoft）网络请求
- [ ] 7.4 菜单/命令/Help/About 均不含第三方商标与链接
- [ ] 7.5 遥测/更新/市场行为符合 B-10/B-11/B-8
- [ ] 7.6 运行 `git status`，确认本次改动清单与提交一致（遵循仓库提交规范：逐文件 `git add`，不用 `-A`/`.`）

---

## 4. 风险与前置条件

| 风险 | 等级 | 缓解 |
|---|---|---|
| **商标侵权**：残留 `Microsoft`/`Visual Studio`/`VS Code` 字样或图标 | 高 | 阶段 1.5 全文替换 + 阶段 7.2 三平台验收；`Copilot` 为 GitHub 商标，界面文案需规避 |
| 9500+ 处字面量误伤依赖/第三方版权头 | 中 | 仅替换自有源码与资源文案，保留第三方 `LICENSE`/`Copyright` 注释与 `node_modules` |
| 首启两套引导并存导致改漏 | 中 | 阶段 2.1 明确只保留一套并关闭另一套贡献 |
| 颜色覆盖被用户主题覆盖 | 低 | 内置品牌主题设为默认并锁定 `colorCustomizations` 优先级 |
| `extensionsGallery` 自建市场不可用 | 中 | 阶段 5.4 先用 `curl` 验证市场 API 可达 |
| 自动更新改源后回滚困难 | 中 | 阶段 5.2 先在 `update.mode=none` 验证，再切自托管 |
| 安装包图标缓存未刷新 | 低 | 阶段 6 清理构建缓存后重新打包 |

---

## 5. 明确不做

- ❌ 改动 VS Code 核心编辑器/语言服务逻辑（本次仅界面层）
- ❌ 引入需联网才能启动的强制登录（除非 B-7 明确需要，且提供离线降级）
- ❌ 删除 `node_modules` / 依赖中的版权声明
- ❌ 修改 CC Switch（evaswitch）相关工程（见 doc 01《明确不做》）

---

## 6. 附录：代码引用索引

**品牌 / 名称**
- `product.json:2-37` — 全部品牌字段（nameShort/nameLong/applicationName/dataFolderName/win32*/darwin*/linux*/urlProtocol）
- `product.json:34` — `reportIssueUrl`
- `product.json:40-47` — `extensionsGallery`
- `product.json:178-252` — `onboardingKeymaps` / `onboardingThemes`
- `src/vs/base/common/product.ts:99-295` — `IProductConfiguration` 接口
- `src/vs/platform/product/common/product.ts:25-109` — 运行时读取 + Dev 后缀
- `package.json:2-3` — `name` / `version`

**图标资源**
- `resources/win32/code.ico`、`resources/darwin/code.icns`、`resources/linux/code.png`、`resources/server/*`
- `src/vs/workbench/browser/media/code-icon.svg` — 标题栏 app icon
- `src/vs/workbench/browser/parts/titlebar/media/titlebarpart.css:283-303` — `.window-appicon` 样式
- `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts:475-478` — 注入 app icon 元素
- `build/win32/code.iss:16,25,112-115` — 安装包图标

**首启 / 引导**
- `src/vs/workbench/contrib/welcomeOnboarding/browser/welcomeOnboarding.contribution.ts:15-33`
- `src/vs/workbench/contrib/welcomeOnboarding/browser/onboardingVariationA.ts:96,870-1012,1257`
- `src/vs/workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.ts:43-49,116-124,203-209`
- `src/vs/workbench/contrib/welcomeWalkthrough/browser/walkThrough.contribution.ts:42`

**布局 / 主题**
- `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts:470-504,857-858`
- `src/vs/workbench/browser/parts/titlebar/commandCenterControl.ts:10-12,245-269`
- `src/vs/workbench/browser/parts/{activitybar,statusbar,sidebar}/*` 及各自 `media/*.css`
- `src/vs/platform/theme/common/colorRegistry.ts:6-18`、`colorUtils.ts:144,252`
- `src/vs/platform/theme/common/colors/*.ts`
- `src/vs/workbench/services/themes/common/productIconThemeSchema.ts`、`browser/productIconThemeData.ts`

**菜单 / 命令 / 帮助**
- `src/vs/workbench/browser/actions/helpActions.ts:42,75,107,139,194,226,258,296,325,358`
- `src/vs/platform/actions/common/actions.ts:130` — `MenuId` 定义
- `src/vs/workbench/contrib/issue/common/issue.contribution.ts:115-130`
- `src/vs/workbench/contrib/issue/electron-browser/issue.contribution.ts:83-92`
- `src/vs/platform/menubar/electron-main/menubar.ts:409` — "About {nameLong}"

**About / 闪屏**
- `src/vs/platform/dialogs/electron-browser/dialog.ts:17-49`
- `src/vs/workbench/browser/actions/windowActions.ts:395-476`
- `src/vs/workbench/contrib/splash/browser/{splash.ts,partsSplash.ts,splash.contribution.ts}`
- `src/vs/code/electron-browser/workbench/partsSplash.ts:8-29`

**遥测 / 更新 / 设置**
- `src/vs/platform/telemetry/common/telemetry.ts:99`（`telemetry.telemetryLevel`）
- `src/vs/platform/telemetry/common/telemetryService.ts:277-373`
- `src/vs/platform/update/common/update.config.contribution.ts:13-90`
- `src/vs/platform/update/electron-main/updateService.*.ts`
- `src/vs/platform/configuration/common/configurationRegistry.ts:104,512`
- `src/vs/workbench/services/configuration/browser/configuration.ts:37-119`

**扩展市场**
- `src/vs/workbench/services/extensionManagement/electron-browser/extensionGalleryManifestService.ts:97`

**相关文档**
- `01_evacode大模型升级改造任务清单.md` — 同期大模型接入方案
- 仓库记忆《Windows 构建环境陷阱》《打包流程与耗时》— 构建/打包前置必读
