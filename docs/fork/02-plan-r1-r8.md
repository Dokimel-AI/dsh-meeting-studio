# 02 · R1–R8 任务拆解、验收命令与工时

> 目标（一期唯一硬指标）：**用户在 UI 里配完本地 ASR / 声纹 / 手写 / 云端 ASR / 纪要 LLM 五类模型，不改配置、不敲命令，从干净安装到跑通一次真实转写全程鼠标完成。**
> 基线：`017` 见 `00-baseline.md`（smoke 217/220，代码地图见 `01-code-map.md`）。
> 分支：`feat/model-center`（自 master）。所有行号指基线 commit `01838da`。

## 0. 四个架构决定（先说清，免得后面返工）

1. **能力包放在 `cloud.asr` / `cloud.speaker` 内部**，不新增顶层设置块。
   理由：`readSettings()` (`host-tools.js:1510-1567`) 只透传 `cloud/speaker/transcript` 三个子对象，新增顶层键会在下一次任意设置写入时被静默丢弃（债-14）。
2. **自检结果单独落 `$DSH_HOME/meeting-room/capabilities.json`**，原子写（临时文件+rename），不进 `webhooks.json`。
   理由：同上；且自检每会话可重跑，不该和 apiKey 抢同一个文件的写窗口。
3. **校验/探测抽成新文件 `host-cloud-actions.js`（纯函数 + 一个网络探测）**，被 `host-providers.js`（写路径）、`host-routes.js`（UI）、`host-tools.js`（`meeting_cloud` 工具）三处 import。
   理由：client 是独立 bundle，不能 import host 代码；「UI 与工具共用一份校验」只能靠同一个服务端函数（`client.js:6678/6787/6803` 只走 HTTP）。
4. **模型中心用「左栏页新增页签」接缝 A**（`client.js:2194` + `:7310` 后插分支 + zh/en 键）。
   理由：纯新增、零注册改动、root 作用域；备选（第二个 `main` 页 / 右栏 tab）的代价见代码地图 §8。

## 1. 总览与工时

| 阶段 | 内容 | 估时 | 状态 |
|---|---|---|---|
| R6 | 能力自检（4 灯 + 修复指引 + 落盘） | 1.5 d | ✅ 完成（含启动时机假红修复） |
| R1 | 模型中心页签骨架（四块卡片） | 2.5 d | ✅ 完成（真实浏览器实拍） |
| R2 | 云端 ASR 卡片（预设/字段/同意/测试连接） | 2.5 d | ✅ 完成（界面里用本机桩跑通） |
| R3 | 能力协商与自动降级 | 1.5 d | ✅ 完成（smoke 断言 c/d） |
| R4 | 云端 speaker 保留 + 前缀清洗 | 1.0 d | ✅ 完成（smoke 断言 e + 真实 `/chunk`） |
| R5 | `meeting_cloud` 工具（get/set/test/clear） | 1.0 d | ✅ 完成（与 UI 同一句错误） |
| R7 | 安装/卸载自检脚本与说明 | 1.0 d | ✅ 完成（13 项 PASS / dry-run + --apply 实测） |
| R8 | 冒烟断言 + README/MODELS/NOTICES | 2.0 d | ✅ 完成（266/266） |
| — | 联调与演示（干净 profile 全流程） | 2.0 d | ✅ 完成（`studio-demo` + 真实转写） |

> 实际交付见 `04-integration-findings.md`；工时口径 = 1 名熟悉本仓的工程师。

**提交拆分（按依赖顺序，实际执行以右侧「状态」为准）**

```
c1 docs(fork): 基线、代码地图与 R1–R8 计划            ← 已完成
c2 feat(capabilities): 能力自检 + 品牌改名 dsh-meeting-studio   ← 已完成（两者合并提交：
        品牌字符串就在本次要改的 /version 断言与路由兜底里，拆开会出现一个必红的中间提交）
c3 feat(model-center): 左栏「模型中心」页签骨架（四块卡片，只读）
c4 feat(cloud-ui): 云端 ASR/LLM/声纹三张卡片 + 供应商预设 + 测试连接
c5 feat(cloud-negotiation): 能力探测、400 降级重试、capability 缓存
c6 feat(cloud-speaker): segments.speaker 保留、S1/S2 归一化、前缀清洗开关
c7 feat(tool): meeting_cloud（get/set/test/clear，与 UI 同一份校验）
c8 test+docs: smoke 新增断言、README/MODELS/THIRD-PARTY-NOTICES、安装卸载脚本
```

**已定**：包名/品牌 = `dsh-meeting-studio`（2026-11-23 李刚确认）；版本从 `0.1.0-preview.7` 起为 `0.1.0-fork.1`。
**待办（不影响开工）**：品牌图标（`icon.svg` 目前仍是上游图标，发布前必须换；MIT 不授商标）、`repository`/`homepage` 待我们自己的远端仓库建好后替换。

## 2. R6 · 能力自检（修 债-02 / 债-11 / 债-19）

**做什么**
- 新建 `host-capabilities.js`：`runSelfChecks(ctx)` 返回
  ```
  { checkedAt, version, checks: {
      asr:{ok,phase,message}, speaker:{ok,phase,message}, handwriting:{ok,phase,message},
      python:{ok,executable,message}, cloud:{ok,mode,fallback,message} } }
  ```
  探针来源全部复用既有状态：`readSpeechState(ctx)`（`host-tools.js:640`）、`speakerState`（`host-speaker.js:114`）、`handwritingState`（`host-handwriting.js:48`）、`cloudSummary()`（`host-providers.js:147`）。
- **python 探针改成「写探测」**：不只 `stat` 解释器，而是真跑 `python -c "import docx,openpyxl;open(<capabilities 同目录>,'w').write('1')"`（3s 超时）。理由见 `00-baseline.md` §4：本机捆绑运行时**能 import 但写不进 %TEMP%**，只查路径会误报绿。
- 原子写 `capabilities.json`（临时文件 + rename），失败只 `bootLog`，**不阻塞启动**。
- `index.js:451` 后（flush 定时器之后、恢复链之前）加 `void runSelfChecks(ctx).then(..., err => bootLog('capabilities-failed', err))`。
- 新路由 `GET /capabilities`（返回报告 + 每项的修复指引文本）、`POST /capabilities/repair {item}`（只做安全动作：`/speech/prepare`、`/speaker/prepare`、重跑探测；**不碰云配置**）。
- UI：模型中心顶部「能力自检」卡片，四盏灯 + 一行「为什么红 / 点这里修」。

**怎么验证**
```
$ node smoke.mjs | tail -3                       # 不得低于 217/220
$ node -e "..."（临时 DSH_HOME 里 import host-capabilities 并打印 runSelfChecks）   # 五项各有一句中文结论
$ curl -s localhost:<port>/meeting-room/capabilities   # 真实桌面端里点「重新自检」
```
**还差什么**：本机当前没有任何 `speechToText` 提供者，asr 灯**应当红**——这正是要演示的「显式失败」。演示前要么装官方 `@deepseek-ai/dsh-experimental-speech-to-text`，要么走云端。

## 3. R1 · 模型中心页签（四块）

**做什么**
1. 本地语音识别模型：列表 + 下载（sha256 + 百分比）+ 本地文件导入 + 启用 + 删除。数据全来自既有 `GET /models`（`host-models.js:289`），UI 复用 `ModelRow` 的展示逻辑（`client.js:5700-5754`，但**迁到新页签，不复制两份**）。
2. 声纹模型：状态/下载/启用 + 阈值三档（松 0.7 / 中 0.6 / 紧 0.5，来自 `host-constants.js:59-63`）+ 全量重聚类开关（`speaker.fullRelabel`）。路由沿用 `/speaker/settings`。
3. 手写模型：同上（`/models` 的 handwriting 分组 + `/prepare`）。
4. 云端服务：ASR / 纪要 LLM /（可选）声纹 embedding 三张卡片 → R2 落地。
- 旧「模型」页（`client.js:7185-7310`）保留一个跳转提示「已迁移到模型中心」，避免用户路径断裂；**旧卡片里的云端卡片一并迁走**（否则两处可改同一份配置）。

**怎么验证**
```
# 桌面端：左栏「会议管理」→ 新页签「模型中心」
# 1) 点声纹模型「下载」→ 进度百分比前进 → 完成显示「已校验（sha256）」
# 2) 点「启用」→ 刷新后仍是该模型（读 models.json）
# 3) 点「删除」→ 内置模型无删除按钮（只有「切换」）
$ node smoke.mjs | tail -2
```
**还差什么**：模型下载源可用性依赖外网；国内源已在 `host-constants.js:43-45` 有镜像，演示前预下语音+声纹模型可省 3~5 分钟。

## 4. R2 · 云端 ASR 卡片 + 测试连接

**做什么**
- 预设供应商（只填元数据，不写死行为）：硅基流动 `https://api.siliconflow.cn/v1`（候选 `FunAudioLLM/SenseVoiceSmall`、`Qwen/Qwen3-ASR-1.7B`、`XingChenASR-V3.2-Ultra`）、OpenAI `https://api.openai.com/v1`（`whisper-1`、`gpt-4o-transcribe`）、Groq `https://api.groq.com/openai/v1`（`whisper-large-v3`）、自定义。预设集中在新文件 `host-cloud-actions.js` 的 `PROVIDER_PRESETS`，UI 与工具同一份。
- 字段：`baseUrl`、`model`（可手填 + 预设候选下拉）、`language`、`apiKey`、`keepRemote`（补上 UI 缺失，`host-providers.js:166` 已支持）。`keepRemote=false` 时请求带 `retention=none`（既有行为，`host-providers.js:290`）。
- apiKey：`type=password` + 占位「已保存，留空不变」+ 永不回显（沿用 `cloudSummary.keySet`）。**新增断言**：日志、`/cloud` 响应、`meeting_cloud` 回执、导出包、错误消息五处都不出现 key。
- **「测试连接」复用 `probeCloudAsr()`**：用 1s 静音 WAV 真发一次请求，返回
  ```
  { ok:boolean, http:{status,ms}, capability:{supportsVerboseJson,returnsSegments,returnsSpeaker},
    verdict:'可用'|'需要降级'|'不可用', reason, wouldSendTo:{host,duration} , degraded:boolean }
  ```
- 卡片明写三句：音频发往哪个域名、远端是否留存（`keepRemote` 的直白翻译）、失败会回退本地还是报错（由 `mode` 决定）。
- 未勾选同意时**零请求**（`cloudStatus` 已保证，`host-providers.js:135`），UI 把「测试连接」按钮置灰并说明原因。

**怎么验证**
```
# 桌面端：模型中心 → 云端 ASR → 选预设「硅基流动」→ 填 key → 勾同意 → 测试连接
#   期望：HTTP 200 / 耗时 ms / 能力行「verbose_json: 支持；segments: 有；speaker: 无」/ 结论「可用」
#   换 Qwen3-ASR：http 400 → 结论「需要降级」→ 点「应用降级」后重测可用
# 未勾同意直接点测试 → UI 明示「还没有同意上传，未发起任何请求」
$ node smoke.mjs | tail -2      # 新增断言 (a)(b) 全绿
```

## 5. R3 · 能力协商与降级（修 债-08 / 09）

**做什么**
- 设置结构（**放在 `cloud` 内，透传安全**）：
  ```
  cloud.asr.capability   = { supportsVerboseJson, returnsSegments, returnsSpeaker, model, probedAt, evidence }
  cloud.asr.degradeRetry = true（默认）
  cloud.asr.stripSpeakerPrefix = true/false（R4 的开关，默认开）
  ```
- `cloudTranscribe` 顺序：读能力 → 按能力发（不支持 verbose_json 就不带）→ 若 400/422 且 body 暗示 `response_format` → 去掉该字段**重试一次** → 仍失败按 `mode` 决定：`prefer-cloud` 回退本地并回 `{degraded:true, reason}`；`cloud-only` 报错不降级（既有语义，`host-providers.js:236-239` 保留）。
- 能力探测结果写回 settings（best-effort，失败只记 `bootLog`），下次直接走正确形态（断言 (d) 缓存生效）。
- 预设内置三条已知行为：XingChen 系支持 verbose_json；Qwen3-ASR 不支持；OpenAI 支持。

**怎么验证**
```
$ node smoke.mjs | tail -2       # 新增断言 (c)(d)：400 后自动降级重试一次；第二次不再带 verbose_json
# 桌面端：Qwen3-ASR 首测 400 → 卡片出现「已按能力降级并缓存」→ 再测一次 HTTP 200
```

## 6. R4 · 保留云端 speaker（修 债-10）

**做什么**
- `cloudTranscribe` 的 segments 映射加 `speaker`（`host-providers.js:299-308`）。
- 录制链（`host-routes.js:405-433`）：云端返回后
  - `cue.cloudSpeaker = 'S1'|'S2'|…`（按出现顺序归一化，与本地标签前缀一致）；
  - **本地 CAM++ 结果为准**（`cue.speaker` 不动），云端结果只存 `cue.cloudSpeaker` 供对比；
  - `splitCueIntoSentences` 会把 `...cue` 铺到每一句（`host-tools.js:1341-1349`），所以切句后对比信息自动保留。
- `text` 里 `1:` / `Speaker 1:` 前缀清洗：`host-cloud-actions.cleanSpeakerPrefix(text)`，开关位 `cloud.asr.stripSpeakerPrefix`；清洗后文本进 `cue.text`，原文进 `cue.cloudText` 便于追溯。
- SRT/纯文本/纪要**不加**新字段（避免污染导出），仅在实录行显示一个「云端认为 S3」的次级标签。

**怎么验证**
```
# 用 XingChenASR-Diarize 或自建伪造端点（返回带 speaker 的 segments）
$ node smoke.mjs | tail -2       # 新增断言 (e)：speaker 保留 + 「1: 」前缀清洗 + 本地优先
# 桌面端：导入一段双人录音 → 实录里每人一行、无「1: 」污染；开启/关闭清洗开关各测一次
```

## 7. R5 · `meeting_cloud` 工具（修 债-06）

**做什么**
- `action: get | set | test | clear`；`set` 只接受白名单字段（`consent/mode/asr.*/speaker.*/capability?`），未知字段**拒绝并列出**（不静默丢）。
- 校验/归一化走 `host-cloud-actions.normalizeCloudPatch()`，与 `POST /cloud` **同一函数**；`test` 与 UI 的「测试连接」**同一函数** `probeCloudAsr()`。
- 返回给模型的是字符串，全部过 `redact`；`get` 只回 `keySet` 不回 key。
- 注册：`index.js:372` 后加一次 `registerTool`（label `meeting-room: meeting_cloud tool`）。

**怎么验证**
```
# 会话里让 agent 执行：meeting_cloud {action:"get"} → 看到已配置摘要（无 key）
                             {action:"set", asr:{model:"Qwen/Qwen3-ASR-1.7B"}} → 回执含「已保存，下次识别按能力协商」
                             {action:"test"} → 与 UI 同一段能力结论
                             {action:"set", foo:1} → 明确拒绝，列出允许字段
$ node smoke.mjs | tail -2       # 新增断言 (f)：工具与 UI 共享校验（同一个非法 patch 两边同样报错）
```

## 8. R7 · 安装与卸载自检

**做什么**
- `tools/install-check.mjs`：装完校验 `dsh.profile.bundles` 是否含本包，缺失则打印**补齐步骤**（不自动改 profile）；同时校验 `host-*.js` 齐全、`sherpa-onnx-node` 可解析。
- `tools/uninstall.mjs`：双清（插件管理器 + 依赖清单），先 dry-run 列将删项。
- `package.json`：`pnpm.onlyBuiltDependencies: ["onnxruntime-node"]`（治 债-01 的 exit 1）；`sherpa-onnx-node` 从 peer 改 `optionalDependencies`（治 债-02；仍保留可选语义，缺了由自检红灯兜底）。
- README「安装」章节改写：exit 1 但出现 `+ 包名` 时不要慌 + 跑 `install-check`。

**怎么验证**
```
$ pnpm dlx dsh plugin --profile <临时profile> add <本仓库>   # 期望 exit 0
$ node tools/install-check.mjs                             # 输出 bundles 包含/依赖可解析/自检命令
$ node tools/uninstall.mjs --dry-run                       # 列清将删项，不做修改
```

## 9. R8 · 测试与文档

**smoke.mjs 新增断言（≥12 条）**

| 组 | 断言 | 手法 |
|---|---|---|
| (a) 零请求 | 未同意时 `cloudTranscribe` / `probeCloudAsr` 不发 fetch | 全局桩 `globalThis.fetch` 计数器 |
| (b) 密钥不外泄 | 把 key 写进设置后：`/cloud` 响应、`/cloud/test` 消息、`meeting_cloud get/set/test` 回执、`boot.log`、工程包 bytes 均不含 key 原文 | 字符串包含检查 + 桩 fetch 故意回显 key（`{"error":"bad sk-xxx"}`）验证 `redact` 生效 |
| (c) 降级重试 | 桩回 400 → 一次重试不带 `verbose_json` → 成功；断言 fetch 次数=2 且第二次 body 无该字段 | 桩 fetch 抓 FormData |
| (d) 能力缓存 | 探测成功后 settings 含 `capability.supportsVerboseJson`，下一次首请求即不带该字段（fetch 次数=1） | 读 `webhooks.json` |
| (e) speaker 保留 | 桩回 `segments[].speaker='1'` + `text='1: 你好'` → `cue.cloudSpeaker==='S1'`、`cue.text==='你好'`、`cue.speaker` 仍为本地标签 | 直接调录制链函数 |
| (f) 共享校验 | 同一个非法 patch 经 `POST /cloud` 与 `meeting_cloud set` 得到同一句错误 | 两路调用对比 |
| (g) 自检 | `runSelfChecks` 五项齐全、`capabilities.json` 可读、python 探针为「写探测」 | 临时 DSH_HOME |
| (h) 回归 | 原有 8 工具与 220 项全部保持 | 跑全量 |

**文档**：README 新增「模型中心」「供应商预设表」「常见错误码」（401/403/404/413/429/400-verbose_json/422/5xx）；MODELS.md 更新字段树与 `webhooks.json` 命名（治 债-18）；THIRD_PARTY-NOTICES 补 sherpa-onnx(Apache-2.0)、onnxruntime(MIT)、pinyin-pro(MIT) 与两个模型的许可证说明。

**怎么验证**
```
$ $env:DSH_PYTHON='C:\Python314\python.exe'; node smoke.mjs
232/232 passed        # 220 + 新增 12
$ node smoke.mjs
…（不带 DSH_PYTHON 时 3 项 python 检查应显示 SKIP 或 PASS，而不是 FAIL——见 R8 附带修 smoke.mjs:23-27）
```

## 10. 最终演示脚本（干净 profile，全程鼠标）

1. 临时 profile 安装本包 → `install-check` 通过。
2. 打开左栏「会议管理 → 模型中心」，能力自检：本地 ASR 红（未装语音 bundle）/ 声纹黄（模型未下）/ 手写黄 / 云端灰（未配置）。
3. 点声纹「下载」→ 完成；点手写「下载」→ 完成；两灯转绿。
4. 云端 ASR 卡片：选「硅基流动」预设 → 填 key → 勾同意 → 测试连接（显示 HTTP/耗时/能力三行/结论）。
5. 选模型：云端 ASR 用 XingChen 系（支持 verboseJSON + diarize）或本地 SenseVoice（若已装语音 bundle）。
6. 导入一段真实双人会议录音（`/chunk` 走真实音频）→ 实录里两个发言人、无「1: 」污染。
7. 让 agent 生成纪要 → 导出 Word / SRT（带 S1/S2 前缀）。

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 上游 0.3.x 迭代 → 合并冲突 | 只新增文件 + 小切口；每个阶段先 `git log upstream` 对齐；冲突超过 30 行就停下来重新评估 |
| 云端供应商行为再次不一致 | 一切按探测结果走，预设不含行为；降级路径有断言 (c)(d) |
| 本机没有本地 ASR 提供者，演示卡在「真实转写」 | 演示前装官方 `@deepseek-ai/dsh-experimental-speech-to-text`，或整场走云端 ASR；两条路自检都要如实显示 |
| 原生模块打包（onnxruntime/sherpa） | 本期不动构建脚本；只改依赖声明与安装校验 |
| 模型许可证（声纹 CAM++ / DAMO 手写） | 逐个核对并写进 THIRD-PARTY-NOTICES；商用前单独确认，不默认可商用 |

## 12. 决策记录

- **2026-11-23 包名/品牌**：`dsh-meeting-studio`（李刚拍板）。`package.json` name/版本、`cordis.patch.yml` name、`NOTICE`、`/version` 兜底名同步改；`LICENSE` 原版权逐字保留。
- 其余按默认推进：预设内置硅基流动/OpenAI/Groq/自定义；**默认不开启云端**（`mode: local` + `consent: false`）；`keepRemote` 默认 false。
- 仍未定（不阻塞）：品牌图标、我们自己的远端仓库地址。
