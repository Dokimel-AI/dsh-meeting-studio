# 01 · 代码地图（设置 / 模型 / 云端 / 工具）

> 基线 commit `01838da`（0.1.0-preview.7）。行号均为本仓库当前文件，未核实处标「未确认」。
> 规模：`client.js` 8263 行 · `host-tools.js` 2183 · `host-routes.js` 1761 · `index.js` 497 · `host-models.js` 562 · `host-providers.js` 371。

## 0. 先纠正任务书里的三个前提

| 任务书假设 | 仓库实际 | 证据 |
|---|---|---|
| 设置文件是 `$DSH_HOME/meeting-room/settings.json` | 实际是 **`webhooks.json`**（`settings.json` 只在文档里，代码零命中） | `host-tools.js:1499-1502`；`README.md:441` |
| 脱敏函数在 `host-tools.js` | 在 **`host-providers.js:49-55`**（`redact`），host-tools.js 全文零 `redact` | 全仓 16 处引用，见 §6 |
| 有统一的 `dshHome()` | 只有 `host-models.js:95-98` 一处；另有 8 处各自内联 `process.env.DSH_HOME ?? join(homedir(),'.dsh')` | `index.js:54`、`host-helpers.js:155/166/201`、`host-persistence.js:19`、`host-speaker.js:68`、`host-handwriting.js:43`、`host-tools.js:1500`、`host-voices.js:46` |

## 1. 宿主模块职责

| 文件 | 职责 | 本期是否改 |
|---|---|---|
| `index.js` | 插件入口：`inject=['webServer','tools']` (:82)；挂路由 (:107-110)、注册 8 工具 (:128-372)、注册 skill (:171-182)、会话生命周期 (:375-434)、worker dispose (:437-438)、5s flush (:441-451)、恢复 (:459-494) | **改**（+1 工具、+1 自检调用） |
| `host-routes.js` | 全部 `/meeting-room/*` 路由，单函数 `createHandler(ctx)` (:195) 里顺序 if 链 | **改**（+3 路由、cloud/relabel 小切口） |
| `host-tools.js` | 业务实现 + 设置读写 + 8 个工具实现（`// Tool Implementations` :1860 起） | **改**（+`meeting_cloud` 实现） |
| `host-providers.js` | 云端唯一出网点：consent/mode/asr/speaker、`cloudTranscribe` (:276)、`cloudEmbed` (:323)、`testCloud` (:346)、`redact` (:49) | **改**（能力协商、speaker 保留、探测） |
| `host-models.js` | 模型注册表：`BUILTIN_MODELS` (:33)、`models.json`、下载+sha256 (:361)、导入 (:452)、启用 (:505)、删除 (:530) | 基本不改（复用） |
| `host-speaker.js` | 3D-Speaker CAM++：`speakerState` (:114)、`ensureSpeakerModel` (:142)、`labelCue` (:314)、`relabelFromRecording` (:412) | 只读（自检读状态） |
| `host-handwriting.js` | DAMO 手写：`handwritingState` (:48)、`resolveOnnxRuntime` (:135)、`prepareHandwriting` (:229) | 只读（自检读状态） |
| `host-voices.js` / `host-transcript.js` | 声纹库/阈值；实录切句与数字规整 | 只读 |
| `host-constants.js` | `PREFIX='/meeting-room'` (:12)、阈值三档 (:59-63)、`speakerState` 类型引用等 | 只读（或 +1 常量） |
| `client.js` | Web 端单文件 React（`createElement`，无 JSX），左栏「会议管理」+ 右栏面板 | **改**（+1 页签、+卡片） |

## 2. HTTP 路由（与本期相关的部分）

全部挂在 `/meeting-room` 前缀下（`host-routes.js:208` 剥前缀）。

**云端**（`host-routes.js:1119-1137`）
| 路由 | 方法 | 现状 |
|---|---|---|
| `/cloud` | GET | `cloudSummary()`：consent/mode/asr{provider,baseUrl,host,model,language,keySet,keepRemote}/speaker{...}/state/limits，**从不回密钥** |
| `/cloud` | POST | `writeCloudSettings(body)` → 回 summary |
| `/cloud/test` | POST | `testCloud()`：只回 `{asr:{ok,message},speaker:{ok,message}}`，**无状态码/耗时/能力结论** |

**模型**（`host-routes.js:1139-1179`）
| 路由 | 方法 | 行为 |
|---|---|---|
| `/models` | GET | `modelState()`：catalog + 每模型 installed/verified/files + active + 下载进度 |
| `/models/install` | POST | `installModel(id)`（下载→sha256→rename） |
| `/models/import?id&name` | POST（raw body） | `importModel(id,name,bytes)`，上限 512MB (:76) |
| `/models/activate` | POST | `activateModel(kind,id)`；未校验通过拒绝 |
| `/models/remove` | POST | `removeModel(id)`；内置/在用拒绝 |

**语音/声纹/手写**（供自检复用）
| 路由 | 行 | 用途 |
|---|---|---|
| `/speech` | :1713-1718 | `readSpeechState(ctx)`：本机 ASR 就绪 + 下载进度 |
| `/speech/prepare` | :1747-1757 | `prepareSpeech(ctx)` |
| `/prepare` | :1729-1735 | 一次性准备声纹+手写模型 |
| `/speaker` | :1674 | 声纹模型状态/准备 |
| `/speaker/settings` | :812 / :825 | 阈值三档 + 重聚类 |
| `/version` | :1181-1195 | 读 package.json 的 name/version/author |

**已知瑕疵**：`GET /transcript` 注册两次，`:794-804` 先命中，`:1269-1280` 那段**不可达**。

## 3. 设置与持久化（本期最关键的约束）

`$DSH_HOME/meeting-room/` 下：`webhooks.json`（设置）、`models.json`（模型）、`voices.json`（声纹库）、`meetings/*.json`、`exports/`、`boot.log`。

`readSettings()` (`host-tools.js:1510-1567`) 的字段树：

```
dingtalk wecom appKey appSecret agentId mode people[] departments[]
scoreWeights{quality,completion,learn} templates{briefing,review,weekly,monthly}
cloud      ← 原样透传 (:1540)   真实默认在 host-providers.js:58-67
speaker    ← 原样透传 (:1542)   真实默认在 host-voices.js:29-42
transcript ← 原样透传 (:1543)   真实默认在 host-transcript.js:34-45
```

**三条硬约束（改动前必须知道）**

1. **未知顶层键会被静默丢弃**：`readSettings` 按白名单重建对象，任何新顶层字段在一次「读—改—写」后就从磁盘消失。
   → 所以 R3 的能力包、R4 的清洗开关一律塞进 **已有的 `cloud` 子对象**（透传，安全）；R6 的自检结果**另落 `capabilities.json`**。
2. **写入非原子**：`writeSettings` = `mkdir + writeFile` 整份覆盖 (`host-tools.js:1574-1578`)，无临时文件+rename、无锁；另有第二处直写绕开它（`host-routes.js:978-980`，POST `/webhooks`）。
   → 含 apiKey 的文件被截断就整份丢；R2 期间顺手加「临时文件 + rename」（≤10 行，小切口）。
3. **无版本号、无迁移**：设置文件没有 `version` 字段；只有 `voices.json`(1)、`models.json`(1)、工程包(1) 有版本。

**密钥现状**：apiKey/appSecret 明文落盘，无 `chmod`（全仓零命中；`MODELS.md:133` 声称 0600，**未实现**）。
**脱敏现状**：`redact` 覆盖 host-providers 全部出站消息 + `/cloud/test`；**未覆盖**：钉钉 `dingtalkToken`/`postRobot` 的 `error.message` (`host-tools.js:1649,1718`，URL 里带 appsecret/access_token)、`/meeting-room` 全局 catch (`host-routes.js:1753-1756`)、`boot.log`。
**云摘要**：GET `/cloud` 只回 `keySet:boolean` 与 `host`，不回密钥（`host-providers.js:147-185`）——UI 侧已经安全，本期不得回退。

## 4. 客户端结构（`client.js`）

- 外壳：`window.__ModuleLoader__.load({id:'dsh-meeting-room', factory(require){…}})` (:19-21)，返回 `{inject, apply}` (:7848-8261)；只 `require('react')`（:22）与可选的 `dsh-client-ui-primitives`（:30-35，失败降级）。
- 样式：内联 `styles` 对象 (:1010-1298) + `CONTROL_CSS` 模板串 (:1312-1397)，一次性注入 `<style id="mr-control-style">` (:1398-1403)；颜色全走 `var(--dsw-alias-*)`。
- i18n：扁平键表 `zh` (:150-578) / `en` (:580-1008)，**键必须成对新增**；注册 `ctx.locale.register(NS,{zh,en})` (:7851)。
- 组件：纯 `React.createElement`（别名 `h`）；宿主原语优先/原生回退四件套 `Btn/Field/Picker/Dialog` (:1605-1739)；浮层走 `createPortal` (:1491-1503)。
- 7 个挂载点：右栏 tab 定义 (:8050)、右栏面板 `MeetingPanel` (:8065→:2323)、面板标题 (:8118)、开始页引导卡 (:8123)、会话头按钮 (:8176)、**左栏「会议管理」整页 `MeetingHubPage` (:8185→:6422)**、左栏行图标 (:8250)、安装引导 (:8253)。
- 请求封装：`post(route,body)` (:2077)、`get(route)` (:2097)，前缀 `/meeting-room`；大块传输直拼 `PREFIX`。

**左栏页签（`MeetingHubPage`）**：`HUB_TAB_VALUES` (:2194-2195) = `records | models | terms | settings | people`，渲染是并列三元 (:7184-7779)：
| 页签 | 行 |
|---|---|
| 记录 records | :7670-7754（预览 :7755-7777） |
| **模型 models** | :7185-7310（本地模型列表 :7199-7214；**云端卡片 :7216-7297**） |
| 术语 terms | :7311-7322 |
| **设置 settings** | :7323-7580（子页签 `SETTINGS_TABS` :2176-2182：推送/权重/模板/**发言人识别 :7448-7510**/实录切句） |
| 人员 people | :7581-7669 |

## 5. 云端现状（R2/R3/R4 的靶子）

宿主字段（`host-providers.js:58-67`）：
```
consent:false  mode:'local'|'prefer-cloud'|'cloud-only'
asr:     { provider:'off'|'openai-compatible'|'custom', baseUrl, model, language, apiKey, keepRemote:false }
speaker: { provider, baseUrl, model, apiKey }
```

`cloudTranscribe` (:276-312) 的问题（逐条对应债）：
- `:284` **无条件** `form.append('response_format','verbose_json')` → Qwen3-ASR 之类直接 400（债-08）；
- `:299-308` segments 只映射 `start/end/text`，**`speaker` 被丢弃**（债-10）；
- `:298` 空文本即抛错，不看 HTTP 层能力信息；
- 无「供应商能力包」，无降级重试；
- `cloudStatus` (:129-141) 的门是 consent/mode/provider/baseUrl/apiKey/fallback，语义正确，**保留**。

UI 现状（`client.js`）：
| 项 | 行 | 说明 |
|---|---|---|
| mode/consent/provider/baseUrl/model/language | :7222-7275 | 三档 Picker + 勾选 + 3 值 Picker + 3 个 Field |
| apiKey | :7276-7284 | `type='password'`，draft 恒空，非空才提交；占位符「已保存，留空不变」 |
| **keepRemote** | — | **未渲染**（全文件无该标识符） |
| **云端 speaker** | — | **未渲染** |
| 测试连接 | :7295 → `runCloudTest` :6798-6812 → POST `/cloud/test` | 结果只写一行 `span` 文本（:7296） |
| 音频去向提示 | :7287-7289 | 取 `/cloud`.asr.host |

`testCloud` (:346-371) 用 1600 字节静音（0.1s/16k）发一次真请求，但只回 ok/message，**不探测能力**。

## 6. 工具与注册（R5 的接缝）

8 个工具定义在 `index.js`，实现都在 `host-tools.js` 的 `// Tool Implementations` 段：

| 工具 | definition | 实现 |
|---|---|---|
| meeting_read | :128-145 | `readTranscript` :1870 |
| meeting_session | :147-167 | `meetingSession` :1901 |
| meeting_query | :184-210 | `queryMeetings` :227 |
| meeting_distill | :212-228 | `distillForSession` :562 |
| meeting_write | :230-300 | `writeAnalysis` :1969 |
| meeting_note_write | :302-320 | `writeNote` :2165 |
| meeting_revise | :322-351 | `reviseTranscript` :2101 |
| meeting_save_document | :353-372 | `saveDocument` :2134 |

注册器 `registerTool`（`index.js:118-126`）：`ctx.effect(() => ctx.tools.register(definition), label)`，每工具独立 try/catch（单个失败只丢自己）。**运行时无 schema 校验**，每个实现自己再校验（惯例见 `:1871-1874`、`:2107-2113`）。
工具返回给模型的永远是**字符串**（失败也是字符串）。

## 7. 我们准备动的文件（补丁面清单）

| 文件 | 性质 | 改动点 | 风险 |
|---|---|---|---|
| `host-capabilities.js` | **新增** | 5 项探针 + `capabilities.json` 原子写 + `runSelfChecks()` | 低（不动老代码） |
| `host-cloud-actions.js` | **新增** | `probeCloudAsr()`（能力探测，UI/工具共用）、`normalizeCloudPatch()`（白名单校验）、`cleanSpeakerPrefix()` | 低 |
| `client.js` | 改，小切口 | ① `HUB_TAB_VALUES` :2194 加 `'model-center'`；② :7310 后插一个 `hubTab === 'model-center'` 分支；③ zh/en 各加键（:397 起 / :826 起） | 中（444KB 但只加不改） |
| `host-routes.js` | 改，小切口 | ① 3 条新路由（`/capabilities`、`/capabilities/repair`、`/cloud/probe`）；② `/cloud/test` 改调新探测；③ 录制链 :405-433 保留 speaker | 中（录制链要小心） |
| `host-providers.js` | 改 | `cloudTranscribe` 能力协商 + 降级重试 + speaker 映射；`writeCloudSettings` 白名单 + 原子写 | 中 |
| `host-tools.js` | 改 | 追加 `meetingCloud()`（文件尾）；`writeSettings` 改原子写（≤10 行） | 低-中 |
| `index.js` | 改 | +1 `registerTool`（:372 后）；+:451 后 `void runSelfChecks(ctx)` | 低 |
| `smoke.mjs` | 改 | +6 组断言（见 R8）；修 `hasPython` 探测为「写探测」 | 低 |
| `package.json` | 改 | 品牌名/包名/版本/`pnpm.onlyBuiltDependencies`、`sherpa-onnx-node` 依赖声明 | 需拍板 |
| `README.md` / `MODELS.md` / `THIRD-PARTY-NOTICES.md` / `LICENSE` | 改 | 新增「模型中心」「供应商预设」「错误码」；品牌与许可 | 低 |

**明确不动**：`recorder`/`useRecorder` (:2284-2321)、`post/get` 封装 (:2077-2138)、布局接管 (:7859-7957)、`watchPendingStart` (:7971-7995)、采集/切句/停止链 (:3789-4262)、`Boundary` 与各 slot 的 key、`CONTROL_CSS`/`styles` 既有键、i18n 既有键。

## 8. 可用的三个 UI 接缝（R1 选型）

| 接缝 | 做法 | 代价 | 结论 |
|---|---|---|---|
| **A. 左栏页新增 `model-center` 页签** | 常量 + 一个并列三元 + 两语言键，纯新增 | 模型入口有两个（旧「模型」页仍在），需产品上决定是否把旧卡片迁走 | **选它**（零注册改动、root 作用域、样式全复用） |
| B. 第二个 `main` 页（左栏多一行） | 复制 :8185-8249 + `sidebar.panellist` + 新图标 | 多一级入口，shell 对同插件多 `main` key 未验证 | 备选 |
| C. 右栏第二个 tab | 复制 tab 三件套 | 会话作用域，无会话打不开，与「全局配置」语义冲突 | 不选 |

## 9. 新增的上游缺陷（已写入 `fork-debt.md` 债-13 ~ 债-19）

- 债-13 设置写入非原子 + 无并发保护 + 双写实现（`host-tools.js:1574` / `host-routes.js:978`）
- 债-14 未知顶层设置键被静默丢弃（`host-tools.js:1510-1567`）
- 债-15 `GET /transcript` 重复注册，第二处不可达（`:794` vs `:1269`）
- 债-16 钉钉/机器人错误消息未脱敏（`host-tools.js:1649,1718` → `/push` 响应）
- 债-17 UI 未渲染 `keepRemote` 与云端 `speaker`（宿主已支持）
- 债-18 文档把设置文件写作 `settings.json`（实际 `webhooks.json`）
- 债-19 捆绑运行时 python 在 `%TEMP%` 写入受限 → 导出报 traceback（详见 `00-baseline.md` §4）
