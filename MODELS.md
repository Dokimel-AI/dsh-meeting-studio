# 模型与识别能力（develop 分支设计稿）

本文件是 **develop 分支**的施工图：**语音识别增强**、**发言人识别增强**、
**云端模型接口**、**允许安装更强的本地模型**。
实现按文末批次推进，每批都带验收（扩展 `smoke.mjs` 与 `TESTING.md`）。

**进度**：

| 批次 | 状态 |
| --- | --- |
| **M1 模型注册表 + 本地模型安装** | **已完成**（`host-models.js`、`/models*` 路由、管理页「模型」页签、说话人与手写按注册表取模型、会议记录写下 `speakerModel`） |
| **M2 云端 provider 与隐私开关** | **已完成**（`host-providers.js`、`/cloud` 与 `/cloud/test`、`/chunk` 接入云端识别、设置页开关与"音频将发往哪个域名"、密钥脱敏、连续失败自动回退；测试断言"未同意时零请求""消息里搜不到密钥""工程包里搜不到密钥"） |
| **M3 全量重聚类与跨会议声纹库** | **已完成**（说话人设置进 `$DSH_HOME/meeting-room/webhooks.json`：阈值三档预设 + 手动值、全量重判开关与上限；停录后的补标改为**默认全量**（旧的 60 条上限可开关回去）；`host-voices.js` 声纹库——只存质心向量、只在人命名时写入、建议姓名需人确认；`/speaker/settings` 与 `/voices*` 路由；设置页「发言人识别」与发言人页的建议行） |
| **M4 数字日期规整 + 切句参数可调** | **已完成**（`host-text.js` 纯本地规整：日期/时间/百分比/金额/数量，规则可逐条开关，结果与被识别的原文并存；`host-transcript.js` 把规整规则与切句参数（最短/最长/停顿判定/静音阈值）放进设置，并**真正接进浏览器半边的采集循环**） |
| **M4 的其余条目** | **部分受限**：见下方说明（热词注入、流式中间结果、双通道） |
| **R1–R5（fork）模型中心 / 云端协商 / speaker / 工具** | **已完成**（见 §4.1 字段表与 §10；UI 在「会议管理 → 模型中心」，能力缓存落 `webhooks.json` 的 `cloud.asr.capability`，工具 `meeting_cloud`） |

M3 里的**重叠语音（一条 cue 记两个说话人）标记为「受限」**：本地说话人 worker 的协议是
"一段音频 → 一个标签"，要支持它得换模型或加分离器，属于下一阶段的前提条件 —— 本轮不假装支持。

M4 里**没有落地**的三项，以及原因（都不假装支持）：

- **热词注入**：本机识别走 DSH 的语音能力，它**不接受热词参数**（`resolve()` 只收 audio），
  所以"把术语表当热词喂给引擎"这条路本机走不通。已落地的等价能力是**识别后按术语表替换**
  （`correctText`，早前就有）；术语表也确实作为热词发给了**云端**（M2 的 `prompt` 字段）。
- **流式中间结果**：DSH 的语音能力是请求/响应式，没有 partial hypothesis 可取；
  能做的是**把等待时间缩短** —— 这正是把切句参数暴露出来的原因。
- **双通道（麦克风 + 系统声）**：浏览器侧要额外申请系统声采集（第二条 MediaStream），
  涉及权限与设备差异，属于独立一批；本轮不做 `channel` 字段，避免"半个功能"。
- **重叠语音**（M3 遗留）：本地 worker 协议是一段音频一个标签，需换模型或加分离器。

**「工程包可选带上声纹」这一项没有实现**（§6 表格里的 embedding 存储）：已落地的行为是
默认**不导出**、也**不落盘**任何向量，这正是隐私上想要的一侧；"可选导出"是一个额外开关，
等真有跨机搬声纹的需求再做，现在不假装有。

M3 落地后的实际行为：改阈值会在保存时**主动重启识别进程**（阈值是启动参数，不重启不生效），
界面明说这一点；补标默认覆盖整场实录；给声音命名时把它学进声纹库；之后同一场或别的会议再出现，
面板给出「听起来像 X（相似度）」+「采用」——**建议永不自动写入**（有测试断言）；
会议记录与工程包里**不含任何向量**（embedding 与质心都在落盘前剥离）。

M1 落地后的实际行为：内置目录就是一直以来的两个固定模型（同样的文件、大小、sha256、目录，
所以老装机不受影响）；`$DSH_HOME/meeting-room/models.json` 可以添加自己的模型条目；
「模型」页签能下载并校验、**从本地文件导入**、启用、删除；启用后
`prepareSpeakers` / `prepareHandwriting` 就用那个模型（未装好不允许启用）。

## 0. 不变量（任何改动都不得违反）

1. **默认不出本机**：不配置云端时不发起任何外部请求；音频、实录、笔记、评分均不上传。
2. **开关必须显式**：启用任何云端能力都要人明确操作，并在界面上写清"上传什么、传到哪、留多久"。
3. **人工确认权威**：模型只产草稿；任务与评分仍要人确认（这条与模型强弱无关）。
4. **可回退**：云端失败、超时、限额用尽时，退回本地模型继续工作，且**如实告知发生了回退**。
5. **可核对**：任何下载的模型都带**大小与 sha256**，导入的工程包若引用本机没有的模型要**明确提示**。
6. **密钥不进日志、不进导出包**：`$DSH_HOME/meeting-room/webhooks.json` 里的密钥不写进 boot.log，也不进会议工程包。

## 1. 现状（0.1.0-preview.1）

| 环节 | 现在怎么做 | 位置 |
| --- | --- | --- |
| 语音识别 | 用 DSH 自带的语音能力（SenseVoice 等），请求/响应式，说话人停顿后成段 | 宿主 `/speech` 路由，模型由 DSH 管理 |
| 发言人分离 | 固定 3D-Speaker CAM++（16 kHz，中英），在线聚类 + 结束时按录音补标（上限 60 条） | `speaker-worker.js`；`$DSH_HOME/speech-to-text/speakers/` |
| 手写识别 | 固定 DAMO 行模型（ConvNeXt-Tiny） | `handwriting-worker.js`；`$DSH_HOME/handwriting/` |
| 要点/纪要/评分 | 走 Agent（对话里说一句），本插件不直接调 LLM | `meeting_*` 工具 |

现状的局限：模型**写死在常量里**、只能换实现不能换模型；识别**只在本地**、长会议补标有上限；
没有任何"更强的模型"入口，也无法在算力好的机器上用大模型、在会议室小主机上用轻量模型。

## 2. 模型注册表（M1 的核心）

把"模型"从常量抽成**数据**，落盘 `$DSH_HOME/meeting-room/models.json`（用户可手改，插件只做校验）：

```jsonc
{
  "version": 1,
  "models": [
    {
      "id": "speaker.campplus.zh-en.16k",      // 稳定标识，写进会议记录
      "kind": "speaker",                        // asr | speaker | handwriting | llm
      "name": "3D-Speaker CAM++（中英，16k）",
      "runtime": "onnx",                        // onnx | http
      "source": { "url": "https://…", "mirrors": ["https://…"] },
      "files": [{ "name": "model.onnx", "bytes": 28281139, "sha256": "e6af4d4c444f3dab01d991bb9b7d5af98eb979e329f6c8880a19d5553561ed25" }],
      "languages": ["zh", "en"],
      "quality": { "sizeClass": "small", "note": "通用场景够用；嘈杂环境建议换 large" },
      "licence": "见上游模型卡",
      "builtin": true
    }
  ],
  "active": { "speaker": "speaker.campplus.zh-en.16k", "handwriting": "handwriting.damo.line" }
}
```

- **解析顺序**：`active` 指定 → 该 kind 唯一的可用模型 → 内置默认；找不到就**明确报错**，不静默降级。
- 每个 kind **默认只启用一个**；`asr` 允许按语言/场景配多个（见 §5）。
- 会议记录写入 `asrModel` / `speakerModel`（id + 名称快照），保证**旧会议永远读得回来**。

## 3. 允许安装更强的本地模型

界面：**会议管理 → 模型**（新页签），只做四件事——列出、安装、启用、删除。

| 操作 | 路由 | 说明 |
| --- | --- | --- |
| 列出可选与已装 | `GET /models` | 内置目录 + 本机已装（含大小、是否校验通过、是否为当前启用） |
| 下载并校验 | `POST /models/install` `{ id }` | 依次尝试 `url` 与镜像；**边下边校验 sha256**；失败不留半个文件 |
| **从本地文件导入** | `POST /models/import`（原始字节 + 头带 id/文件名） | 离线机房、内网、自训模型：不联网也能装；同样校验 sha256（可放宽为"仅校验大小并要人确认"） |
| 启用 | `POST /models/activate` `{ kind, id }` | 只改 `active`，不重启进程；说话人模型下次准备时生效 |
| 删除 | `POST /models/remove` `{ id }` | 内置模型只能"停用"，不能删；删前提示哪些会议用过它 |

- 大模型目录（可选、后续）：如中文更强的 ASR、多人分离更好的说话人模型、更高精度手写模型；
  目录以**独立 JSON** 提供（`models-catalog.json`），便于不发版也能更新；
- 每个模型必须声明**磁盘占用与内存量级**，界面显示"装它要多少空间、跑起来大概吃多少内存"；
- 支持**机器档位预设**：轻量（会议室小主机）/ 均衡 / 高精度（有独显的工作站），一键切换 `active` 组合。

## 4. 云端模型接口

统一的 provider 契约（宿主侧模块 `host-providers.js`）：

```js
/** 一次"把音频变成带时间戳与说话人的文字"。 */
provider.transcribe({ pcm, sampleRate, language, hotwords, signal }) -> {
  segments: [{ start, end, text, speaker? }],
  model: 'cloud.xxx', usage: { audioSeconds }, warnings: []
}

/** 一次"把一段音频变成声纹向量"。 */
provider.embed({ pcm, sampleRate }) -> { vector: Float32Array, model: 'cloud.xxx' }
```

- **配置**：`$DSH_HOME/meeting-room/webhooks.json` 的 `cloud` 段（字段表见 §4.1）；
- **协议**：优先 **OpenAI 兼容**（`/v1/audio/transcriptions` 风格）+ 自定义 `baseUrl`，这样大多数
  自建网关（vLLM、FastWhisper 服务、各家云）都能直接接；接不了的部分用"自定义适配器"登记；
- **隐私开关**：`cloud.consent` 记录人已阅读并同意上传；界面明确列出
  - 上传**什么**（仅当前录音片段 vs 整场录音）；
  - 传到**哪个域名**（显示完整 host，不只显示"云端"）；
  - 是否**保留**（请求头声明不留存；插件侧不缓存返回的音频）；
- **密钥**：只存 `$DSH_HOME/meeting-room/webhooks.json`，日志与工程包一律脱敏（`sk-***`）；
- **限额与超时**：每次请求 20 s 超时（沿用现有风格）、5xx 重试 1 次、
  单位时间请求上限（如 60 次/分钟）；
- **回退**：云端连续失败 N 次 → 自动切回本地并提示"已回退到本地识别（原因）"，不再反复重试。

### 4.1 设置字段（`webhooks.json` 的 `cloud` 段）

`$DSH_HOME/meeting-room/webhooks.json` 是唯一的设置文件（早期文档写作 `settings.json`，已统一改名）。
`cloud` 是**透传**子对象：只能在它内部加字段——`readSettings()` 只透传 cloud / speaker / transcript，
新增顶层键会在下一次任意设置写入时被静默丢弃。

```jsonc
"cloud": {
  "consent": false,                              // 明确同意上传；false 时一个请求都不发
  "mode": "local",                               // local | prefer-cloud | cloud-only
  "asr": {
    "provider": "off",                           // off | openai-compatible | custom
    "baseUrl": "", "model": "", "language": "", "apiKey": "",
    "keepRemote": false,                         // false → 请求带 retention=none
    "stripSpeakerPrefix": true,                  // 写入实录前去掉「1: 」等说话人前缀
    "capability": null                           // 服务端写的能力缓存，见下表
  },
  "speaker": { "provider": "off", "baseUrl": "", "model": "", "apiKey": "" },
  "llm": { "provider": "off", "baseUrl": "", "model": "", "apiKey": "", "temperature": 0.2 }
}
```

| 字段 | 取值 | 谁写 | 说明 |
| --- | --- | --- | --- |
| `consent` | boolean，默认 false | 人 | 隐私总开关。**agent 用 `meeting_cloud` 改它之前必须先问用户** |
| `mode` | `local` / `prefer-cloud` / `cloud-only`，默认 local | 人 | `local` 即使已同意也不发；`prefer-cloud` 连续失败 3 次回退本地；`cloud-only` 失败报错、不回退 |
| `asr.provider` | `off` / `openai-compatible` / `custom` | 人 | 预设只填地址与候选模型名，不含行为 |
| `asr.baseUrl` / `asr.model` | string | 人 | 请求 `POST {baseUrl}/audio/transcriptions`，插件自己补后半段；地址一般以 `/v1` 结尾 |
| `asr.language` | string，空=自动 | 人 | 作为 multipart 的 `language` 字段发送 |
| `asr.apiKey` | string | 人 | 只存本机；界面/日志/工程包一律脱敏 `sk-***`。提交空串=保持已保存的值，`null`=清空 |
| `asr.keepRemote` | boolean，默认 false | 人 | false 时请求带 `retention=none`（声明不保留） |
| `asr.stripSpeakerPrefix` | boolean，**默认 true** | 人 | 云端文字前的「1: 」「SPEAKER_00: 」是否在写进 `cue.text` 前去掉；原文保留在 `cue.cloudText` |
| `asr.capability` | object 或 null | **只有服务端** | 最近一次真实探测/降级的结果；客户端提交时整段忽略（不接受"自称"的能力） |
| `speaker.*` | provider/baseUrl/model/apiKey | 人 | 可选的云端声纹：`POST {baseUrl}/speaker/embedding` 返回 `{vector}` |
| `llm.*` | provider/baseUrl/model/apiKey/temperature（0–2，默认 0.2） | 人 | 纪要改写：`POST {baseUrl}/chat/completions`；不配置时行为不变，仍由当前会话的模型生成 |

**`cloud.asr.capability` 的字段与写入时机**

| 字段 | 含义 |
| --- | --- |
| `supportsVerboseJson` | 对方接不接受 `response_format=verbose_json`。true → 每段带它（有分段/时间）；false → 首请求就不带 |
| `returnsSegments` | 探测那次回答里有没有 `segments` |
| `returnsSpeaker` | `segments[].speaker` 有没有值；有则归一成 S1/S2 记进 `cue.cloudSpeaker` |
| `model` | 探测/降级那次回答里的模型名（面板回显用） |
| `probedAt` | epoch ms |
| `evidence` | 一行证据（HTTP 状态、形态、段数、有无 speaker），≤200 字、已脱敏 |

写入时机只有两处：①「测试连接」探测成功后；②识别时遇到 400/422 且响应体提到
`response_format` / `verbose_json` / `format` → 去掉该字段**重试一次**成功后（`degraded:true`）。
缓存的意义是让下一次识别的**第一个请求就按对的形态发**，不必每段先撞一次 400；换地址或模型后
由下一次探测覆盖。写盘失败只记 `boot_log`，不会把已经成功的识别变成失败。降级重试是固定行为，
没有开关。

**同一份校验**：界面的 `POST /cloud` 和工具 `meeting_cloud {action:"set"}` 都走
`host-cloud-actions.js` 的 `normalizeCloudPatch()`——未知字段**整份拒绝**并列出，越界值夹紧或拒绝，
`capability` 只允许服务端写。因此两边对同一个非法 patch 返回同一句话（有冒烟断言盯着）。

## 5. 语音识别增强

| 能力 | 做法 | 备注 |
| --- | --- | --- |
| **热词/术语注入** | 现有会议术语表（每行一条、`错词=正确词`）直接作为 ASR 的 hotword 参数；本地引擎无热词能力时退化为**识别后替换**（已有） | 术语表已是现成资产 |
| **流式中间结果** | provider 支持流式时，面板显示"正在说的话"（灰字，定稿后替换）；本地请求/响应式保持现状 | 需 provider 声明 `streaming: true` |
| **标点与数字规整** | 识别后统一数字、单位、日期写法（`二零二六年` → `2026 年`），规则表可配 | 纯本地，无隐私问题 |
| **语言/方言** | provider 声明 `languages` 与 `dialects`；会议可设"这场会议的语言"，默认跟随系统 | 影响分段与标点模型 |
| **双通道** | 麦克风（现场）+ 系统声（线上参会）分别识别，实录里标注来源 | 采集层已能区分，需在 cue 上加 `channel` |
| **VAD 可调** | 静音阈值、最短段长、最长段长（现为最长 5 s）暴露为设置 | 长句被截断的抱怨多来自这里 |
| **分片与重叠** | 长会议按 N 分钟切片，相邻片重叠 2 s 并对重叠区去重 | 避免句首被切掉 |

## 6. 发言人识别增强

| 能力 | 做法 | 备注 |
| --- | --- | --- |
| **阈值可调** | 现有聚类阈值（`SPEAKER_THRESHOLD`）进设置，界面给出"人多/人少"两档 + 手动值 | 现场人数已知时可显著改善 |
| **全量重聚类** | 结束时的重判从"最后 60 条"改为**全量**（可配上限），并做全局一致性合并 | 直接改善长会议标签断裂 |
| **跨会议声纹库** | `$DSH_HOME/meeting-room/voices.json`：每人一条质心向量 + 已知姓名；新会议识别后**建议**姓名（"听起来像张三"），需人确认才写入 | 建议必须可忽略；库里只存向量不存音频 |
| **重叠语音** | 一条 cue 跨两人时，除主导说话人外记录**次要说话人**（若 provider 能给），实录显示"S1 / S2" | 现在只取主导的一位 |
| **embedding 存储** | 会议记录里默认**不存**向量；工程包提供选项"连同声纹一起导出"（默认关） | 隐私优先 |

## 7. 兼容、路由与工具

新增/变化的路由：

| 路由 | 作用 |
| --- | --- |
| `GET /models` | 模型目录 + 本机状态 + 当前启用 |
| `POST /models/install` / `/models/import` / `/models/activate` / `/models/remove` | 见 §3 |
| `GET /providers` / `POST /providers` | 云端 provider 的读写与连通性测试（"测试连接"按钮） |
| `POST /speech`（扩展） | 增加 `language`、`hotwords`、`channel` 参数 |
| `POST /speaker/prepare`（扩展） | 增加 `threshold`、`fullRelabel` 参数 |

工具侧（模型可见的接口）：

- `meeting_read` 增加"本场用了哪个模型"一行（便于排查识别质量）；
- 新增工具 `meeting_models`（列出可用与已装模型、当前启用），供 Agent 回答"能不能换个更强的模型"。

会议工程包（`host-package.js`）：

- `manifest.json` 增加 `models: { asr, speaker, handwriting }`（id + 名称，**不含**模型文件本身）；
- 导入时若本机缺少对应模型：提示"这场会议用了 X，本机未安装（可继续查看文字）"，**不阻断导入**。

## 8. 分批落地与验收

| 批次 | 内容 | 验收（在现有 77 项冒烟上扩展） |
| --- | --- | --- |
| **M1** | 模型注册表 + `models.json` + 会议管理「模型」页签 + 安装/导入/启用/删除 | 注册表解析（缺文件/坏 sha256/未知 kind 均明确报错）；导入本地模型成功与"校验不符"被拒；启用切换后 `speakerState` 反映新模型；旧会议仍可读 |
| **M2** | 云端 provider（ASR + 声纹）+ 隐私开关 + 密钥脱敏 + 回退 | 未同意上传时**不发起请求**（用本地假 provider 断言零调用）；超时/失败回退并提示；日志与工程包里搜不到密钥 |
| **M3** | 全量重聚类 + 阈值可调 + 跨会议声纹库（建议姓名） | 60 条上限被替换后，长会议标签一致性提升（用固定样本断言标签数）；建议姓名不写入除非确认 |
| **M4** | 热词注入、流式中间结果、双通道、分片重叠 | 热词命中率对比（固定音频 + 术语表）；双通道实录带来源标注；切片重叠区不重复 |

## 9. 风险与取舍

- **模型越大越慢**：界面必须显示"预期实时率（RTF）与内存"，否则用户会在大模型上踩坑；
- **云端带来的合规问题**：默认关闭、逐项同意、域名可见、可随时关闭，且**不因方便而默认打开**；
- **声纹库是最敏感的数据**：只存向量、可一键清空、默认本机、工程包默认不含；
- **不追新模型数量**：目录里宁可少而准（每个 kind 2–3 个），每个都实测过 RTF 与中文效果再收录；
- **一切可回退**：任何增强都保留"用回内置默认"的路径，避免升级后无法工作。

## 10. 安装、依赖与客户端注入（2026-11-23 实测）

三条都是真机上踩出来的，与模型配置直接相关，写在这里免得重犯。

### 10.1 pnpm 11 的构建放行键换成 `allowBuilds`

- pnpm 11 **忽略** `package.json` 里的 `pnpm.onlyBuiltDependencies`，改读 profile 的
  `pnpm-workspace.yaml`：`allowBuilds: { onnxruntime-node: true }`。
- **必须先写 `allowBuilds` 再 `add`**。先 add 失败、再 `pnpm approve-builds` 补批准，只会得到
  `Already up to date`，`dsh.profile.bundles` 仍然不注册（studio-ws 实测）。
- 做 **Web 端验证**的 profile 若依赖 `@deepseek-ai/dsh-web-app`，它的依赖 `koffi` 也带构建脚本，
  必须一起放行，否则 `add` 直接 exit 1：`allowBuilds: { koffi: true, onnxruntime-node: true }`。
- 未预置时的典型症状：日志出现 `+ dsh-meeting-studio` 但紧接着
  `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: onnxruntime-node@1.20.1` 并以 exit 1 结束，
  dependency 在、`bundles` 空、界面不出现。`tools/install-check.mjs` 的 `allowBuilds` 一项就是查这个。

### 10.2 依赖声明：`sherpa-onnx-node` 改为可选安装

- `sherpa-onnx-node` 从 `peerDependencies` 移到 **`optionalDependencies`**：装插件时自动带上，
  装不上也不阻塞安装；缺失只影响本地转写与声纹，由能力自检的 asr/声纹两行如实报红。
- `onnxruntime-node`（手写）与 `pinyin-pro`（同音订正）仍是 `dependencies`。
- 目录 `link:` 安装**不会装传递依赖**（债-20）：`onnxruntime-node` 等解析不到，只能用于开发；
  真实安装请打包 tgz 后 `add`，并用 `tools/install-check.mjs` 逐项核对。

### 10.3 `dsh.client.inject` 的门禁：一条对不上就整包客户端消失

- 客户端注入要求 `dsh.client.inject` 里**每一个**名字都在当前 Web 壳的客户端包里。
- 实测（DSH 0.2.2-rc.5）：壳里**没有** `@deepseek-ai/dsh-client-ui-primitives` 与
  `@deepseek-ai/dsh-client-ui-slots`。把这两个名字留在 inject 里，后果是**整包客户端被注入门禁
  跳过**：插件在「已安装插件」里显示已启用、名字描述都对，但左栏没有「会议管理」、会话头也没有
  「打开会议」，且没有任何报错。
- 现在 inject 只列壳里存在的 8 项：`dsh-client-locale`、`dsh-client-ui-renderer`、
  `dsh-client-ui-layout`、`dsh-client-ui-sidebar`、`dsh-client-ui-sidebar-right`、
  `dsh-client-ui-conversation`、`dsh-client-ui-workspace`、`dsh-client-ui-plugin-manager`。
- `tools/install-check.mjs` 会把 inject 每一项与安装副本里的客户端包清单（优先
  `@deepseek-ai/dsh-web-app` 的依赖；Electron 桌面版则读 `app.asar` 头里的文件清单）逐项比对，
  缺一个就 FAIL 并列出名字——这是"装上了但界面不出现"的唯一离线预防手段。