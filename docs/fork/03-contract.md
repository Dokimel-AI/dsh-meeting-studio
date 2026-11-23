# 03 · 接口契约（并行开发唯一事实源）

> 本文件由 Lead 维护，任何实现与它冲突以它为准；变更必须先改这里并在团队里说一声。
> 基线 `01838da` + c2（改名、能力自检）。仓库根：`D:\MyProject\研究学习\DSH插件\dsh-meeting-studio`，分支 `feat/model-center`。

## 0. 全局约束

1. **写作用域**：每人只改自己名下的文件；跨文件需求写进任务留言，不要抢先改。`host-routes.js` 只允许 **定点 edit**，禁止整文件重写。
2. **不提交 git**：Lead 统一按阶段 `git add <paths> && commit`。谁都不跑 `git commit/add/stash`。
3. **smoke 必须绿**：改完跑 `$env:DSH_PYTHON='C:\Python314\python.exe'; node smoke.mjs`，当前基线 **231/231**。不许把别人的断言改宽。
4. **不猜配置、失败要显式**：任何降级/缺依赖/网络失败，UI 与工具回执都要说清「发生了什么、影响什么、怎么修」。
5. **脱敏**：任何出站字符串（HTTP 响应、工具回执、错误消息、boot.log）必须过 `redact()`（`host-providers.js:49`）。apiKey 永不回显。
6. **注释语言**：代码注释英文、用户可见文案中文（沿用上游风格）。新增文件顶部保留 fork 来源与 MIT 一行。

## 1. 设置结构（`$DSH_HOME/meeting-room/webhooks.json`）

只允许在 **已透传的 `cloud` 子对象** 里加字段（`readSettings` 只透传 cloud/speaker/transcript，新顶层键会被静默丢弃）。

```jsonc
"cloud": {
  "consent": false,
  "mode": "local",                       // local | prefer-cloud | cloud-only
  "asr": {
    "provider": "off",                   // off | openai-compatible | custom
    "baseUrl": "", "model": "", "language": "", "apiKey": "",
    "keepRemote": false,                 // 是否允许远端留存音频（false → 请求带 retention=none）
    "stripSpeakerPrefix": true,          // R4：清洗 text 里的「1: 」说话人前缀
    "capability": {                      // R3：探测结果缓存；无探测时为 null
      "supportsVerboseJson": true,
      "returnsSegments": true,
      "returnsSpeaker": false,
      "model": "Qwen/Qwen3-ASR-1.7B",
      "probedAt": 1763900000000,
      "evidence": "HTTP 200, segments=12, speaker=no"   // ≤200 字符、已脱敏
    }
  },
  "speaker": { "provider": "off", "baseUrl": "", "model": "", "apiKey": "" },
  "llm": {                               // 新增：纪要 LLM（OpenAI 兼容 chat completions）
    "provider": "off",                   // off | openai-compatible
    "baseUrl": "", "model": "", "apiKey": "",
    "temperature": 0.2
  }
}
```

校验/归一化只有一处：`host-cloud-actions.js` 的 `normalizeCloudPatch(patch)` → `{ok, value, error, rejected:[...]}`。
- 白名单字段：`consent, mode, asr.{provider,baseUrl,model,language,apiKey,keepRemote,stripSpeakerPrefix}, speaker.{provider,baseUrl,model,apiKey}, llm.{provider,baseUrl,model,apiKey,temperature}`
- `capability` 只允许服务端写入（探测/降级时），客户端提交时忽略。
- 未知字段 → `rejected` 列出并整体拒绝（不静默丢）。

## 2. HTTP 接口

前缀 `/meeting-room`。所有响应 JSON；4xx 带 `{error}`。

### 2.1 `GET /cloud`（扩展，向后兼容）

保留现有字段（`consent/mode/asr{speaker}/state/limits`），新增：

```jsonc
{
  "asr": { "...": "...", "capability": {…}|null, "stripSpeakerPrefix": true },
  "llm": { "provider": "off", "baseUrl": "", "host": "", "model": "", "keySet": false },
  "presets": [                       // 供应商预设（元数据，不含行为）
    { "id": "siliconflow", "name": "硅基流动", "baseUrl": "https://api.siliconflow.cn/v1",
      "models": ["FunAudioLLM/SenseVoiceSmall", "Qwen/Qwen3-ASR-1.7B", "XingChenASR-V3.2-Ultra"],
      "llmModels": ["Qwen/Qwen2.5-72B-Instruct"] },
    { "id": "openai", "name": "OpenAI", "baseUrl": "https://api.openai.com/v1",
      "models": ["whisper-1", "gpt-4o-transcribe"], "llmModels": ["gpt-4o-mini"] },
    { "id": "groq", "name": "Groq", "baseUrl": "https://api.groq.com/openai/v1",
      "models": ["whisper-large-v3"], "llmModels": ["llama-3.3-70b-versatile"] },
    { "id": "custom", "name": "自定义", "baseUrl": "", "models": [], "llmModels": [] }
  ]
}
```

### 2.2 `POST /cloud`

`body = {consent?, mode?, asr?, speaker?, llm?}` → 走 `normalizeCloudPatch`，非法返回 400 `{error, rejected}`；成功写盘后返回 **与 GET /cloud 同形**。apiKey 只在非空字符串时覆盖（空串 = 保持不变；清空用 `apiKey: null`）。

### 2.3 `POST /cloud/test`（R2 核心）

```jsonc
{
  "asr": {
    "ok": true,
    "verdict": "可用" | "需要降级" | "不可用",
    "http": { "status": 200, "ms": 1180 },          // 未发出时为 null
    "capability": { "supportsVerboseJson": true, "returnsSegments": true, "returnsSpeaker": false },
    "destination": { "host": "api.siliconflow.cn", "keepRemote": false, "audioSeconds": 1 },
    "degraded": false,
    "attempts": [ { "responseFormat": "verbose_json", "status": 200, "ms": 1180 } ],
    "reason": "",                                  // 人话，已脱敏
    "message": "…"                                 // 兼容旧 client 的一行摘要
  },
  "llm": { "ok": true, "verdict": "可用", "http": {…}, "model": "…", "reason": "", "message": "…" },
  "speaker": { "ok": false, "verdict": "未配置", "reason": "…", "message": "…" }   // 语义保持：POST WAV 期望 {vector}
}
```

行为要求（写进实现，不许偏离）：
1. **未同意或 mode=local 时零请求**：`destination` 照常返回，`ok:false`，`reason:"还没有同意上传（未发起任何请求）"`。
2. ASR 用 **1.000 秒 16kHz 静音 WAV**（不是 0.1s）真发一次 `POST {baseUrl}/audio/transcriptions`。
3. 400/422 且 body 文本提到 `response_format`/`verbose_json`/`format` → **去掉该字段重试一次**，`degraded:true`，`verdict:"需要降级"`（重试成功则 `ok:true`）。
4. 成功时解析 `text/segments/model/duration`，并把 `capability` 与 `probedAt` 写回 `cloud.asr.capability`（best-effort，写失败只记 bootLog）。
5. LLM 探测：`POST {baseUrl}/chat/completions`，`{model, messages:[{"role":"user","content":"回复 ok 两个字"}], max_tokens:8}`；2xx 且能取到 choices 即可用。4xx 报原文（脱敏后截断 200 字）。
6. 超时 20s/请求，沿用 `guardedFetch` 的限流与失败计数；测试前 `resetCloudFallback()`。

### 2.4 `GET /capabilities`（已实现，勿改）

`?refresh=1` 重探；返回 `{report, path, saved, error, stale}`。5 行：`asr/speaker/handwriting/cloud/python`。

### 2.5 `POST /capabilities/repair`（已实现，勿改）

`{action}` ∈ `prepare-asr | prepare-speaker | prepare-handwriting`，其余 400 并回 `allowed`。

### 2.6 `POST /minutes`（扩展，可选字段）

`body.useCloudLlm === true` 且 `cloud.llm` 配好时，先用 chat completions 生成 Markdown 纪要，再走既有落盘；失败**不覆盖**本地生成，响应带 `llm:{ok,reason}`。未配置时行为不变。

## 3. 转写链（R4）

`cloudTranscribe(input)` 返回 `{skipped} | {text, segments, model, usage, degraded, capability}`，其中 `segments[i] = {start, end, text, speaker}`，`speaker` 原样（如 `"1"`/`"SPEAKER_00"`）。
`host-routes.js` 录制链（约 :405-433）在云端作答后：
- `cue.text = cleanSpeakerPrefix(answer.text)`（仅当 `cloud.asr.stripSpeakerPrefix`);
- `cue.cloudText = answer.text`（原文，供追溯）；
- `cue.cloudSpeaker = normalizeSpeaker(answer.segments, cue)` → `S1/S2/…` 按出现顺序，先出现先编号；
- 本地 `cue.speaker` **不动**（本地为准）；冲突只记录，不改写。

## 4. 工具 `meeting_cloud`（R5）

```
meeting_cloud { action: "get" | "set" | "test" | "clear", ... }
- get   → 脱敏摘要（同 GET /cloud 的精简版，不含 presets）
- set   → 字段同 POST /cloud；未知字段拒绝并列出 rejected
- test  → 与 POST /cloud/test 同一函数，回一段人话 + 三行结构化结果
- clear → 清空 asr/speaker/llm 的 baseUrl/model/apiKey，保留 consent/mode（要显式传 mode 才改）
返回：给模型看的字符串；任何失败也要说「影响什么、怎么修」。
```

## 5. UI 契约（client.js，唯一写者）

- 左栏「会议管理」新增页签：`HUB_TAB_VALUES` 加 `'model-center'`，文案键 `hubTabModelCenter`；渲染分支插在 `models` 分支之后（`client.js:7310` 附近）。
- 新键统一前缀 `mc*`，zh/en **成对**新增。
- 四块卡片顺序：`能力自检` → `本地模型（asr/speaker/handwriting 三组）` → `云端语音识别 ASR` → `云端纪要 LLM`；声纹 embedding 作为 ASR 卡片里的「可选」折叠区。
- 只读旧页签不动；旧「模型」页的云端卡片保留但加一句「已迁移到模型中心」，避免双入口改同一配置。
- 所有网络错误必须落到可见的一行状态文字（不许只 console）。

## 6. 文件归属（写作用域）

| 文件 | 属主 |
|---|---|
| `host-cloud-actions.js`（新）、`host-providers.js`、`host-routes.js` | host-cloud |
| `client.js` | ui |
| `host-tools.js`、`index.js` | tool（等 host-cloud 交付后开工） |
| `icon.svg`、`locale/*.json`、`THIRD-PARTY-NOTICES.md` | brand |
| `smoke.mjs`、`README.md`、`MODELS.md`、`tools/*`、`docs/fork/0*.md`（除本文件） | qa-docs |
| 本契约、`docs/fork/00-02`、提交 | Lead |
