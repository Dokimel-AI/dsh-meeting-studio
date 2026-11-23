# 04 · 集成实测（真实 Web 运行时 + 真实转写）

> 环境：DSH Runtime 0.2.2-rc.5 · 临时验证 profile `studio-web`（`dsh-base` + `dsh-web-app` + 本插件 + 官方语音输入 bundle）
> 证据：`docs/fork/evidence/model-center-live.png`（模型中心在浏览器里的实拍）

## 1. 「装上了但界面不出现」的两个真因（都已修）

| # | 现象 | 根因 | 证据 | 修法 |
|---|---|---|---|---|
| 1 | 插件页显示「会议记录」已启用、locale 文案正确，但左栏没有「会议管理」、会话头没有「会议记录」 | `package.json` 的 `dsh.client.inject` 声明了 `@deepseek-ai/dsh-client-ui-primitives` 与 `@deepseek-ai/dsh-client-ui-slots`，**当前 Web 壳里没有这两个包**（抓 `plugins/??…` 预加载清单 57 个客户端包，两者均不在），整包客户端被注入门禁跳过 | 预加载清单里无 `dsh-meeting-studio/client.js` | 删掉这两项 inject（其余 8 项都在壳里） |
| 2 | 修完 inject 后 bundle 进了预加载清单，界面仍然不出现 | `client.js` 的 `__ModuleLoader__.load({ id: 'dsh-meeting-room' })` 还是上游包名，**模块 id 必须等于包名**，壳按包身份加载 → 静默不执行（无报错、无界面） | 清单里有、页面无任何插件入口 | `id`、`TAB_ID`、`aboutName`、反馈邮件主题、`plugins.bundle.activation` 的 key 全部改成 `dsh-meeting-studio`；仅保留 localStorage 键 `dsh-meeting-room.terms` 以兼容旧数据 |

两个都修掉后，左栏出现「会议管理」（含取消固定按钮）、会话头出现「会议记录」、页面里出现「模型中心」页签。**这两条是 fork 改名的必踩坑，已写进 install-check 与 README。**

## 2. 模型中心实拍（图 `model-center-live.png`）

页面里可读到（无障碍树原文）：`能力自检`（3/5 + 重新自检）、五行状态（语音识别「识别模型尚未就绪」+「准备模型」按钮、声纹「就绪：3D-Speaker CAM++」、手写「未就绪」+「下载并安装」、云端「未启用」、Python「导出可用（C:\Users\…\python.exe）」）、本地模型三组、云端 ASR 卡片（预设/地址/model/language/API Key/keepRemote/stripSpeakerPrefix/同意勾选/**音频将发往·远端留存·失败时回退**三行）、云端纪要 LLM 卡片、`保存云端设置`/`测试连接`（未勾同意时禁用并写明原因）。

## 3. 真实转写端到端（本地 SenseVoice + CAM++，无云端）

做法：Windows SAPI 合成两个音色（Kangkang 男 / Huihui 女）的六句话，16 kHz 单声道 PCM16，按「一句话一个 cue」喂给真实路由 `POST /meeting-room/chunk`（与浏览器端采集后的行为一致）。

```
$ node feed.mjs
meeting: meeting-mwtbwp25-7310fb5f sampleRate: 16000
line1: text="各位好，今天我们把三季度的交付情况过一遍，先看数据中心的机柜扩容。" speaker=S1
line2: text="扩容这部分我们上周已经完成了两个机柜，剩下的要等采购到货…"            speaker=S2
line3: text="我需要提前通知业务方。"                                              speaker=S1
line4: text="窗口定在周五凌晨2点到4点，方案已经评审过，回滚预案也准备好了。"          speaker=S2
line5: text="可以风险点击一下，各街当天必须有两个人值班，另外把监控告警提前调好。"     speaker=S1
line6: text="明白，我今天下班前把值班表和告警清单发给您。"                          speaker=S2

labels: ["S1","S2"]     # 两个音色被正确分成两个人
```

- 识别模型：官方 `@deepseek-ai/dsh-experimental-voice-input-bundle`（SenseVoice），首次准备下载 239 MB，就绪后 `phase=ready`。
- 声纹：`3D-Speaker CAM++` 28 MB，S1/S2 与两个 TTS 音色一一对应。
- 纪要：`POST /minutes` 返回 Markdown（标题/编号/时长/段落数/实录逐条），**不再出现 `undefined` 发言人**。

## 4. 过程中修掉的两个真缺陷

1. **声纹模型钉定值失效**：旧钉定 `28,281,138 / f682b514…` 与 GitHub 当前资产（`28,281,139 / e6af4d4c…`）不一致 → 大小守卫先拒（"收到 28281139，应为 28281138"），镜像又 403，下载路径 100% 失败。已重钉并实测 `phase=ready`。
2. **无发言人时纪要渲染出 `undefined`**：`displaySpeaker()` 把 `undefined` 原样交给模板。已改为返回空串，实测纪要正常。

## 5. 安装路径实测（R7 的事实基础）

| 场景 | 结果 |
|---|---|
| `dsh plugin add <仓库目录>`（link） | exit 0、bundles 注册成功，但**传递依赖一个都没装**（onnxruntime/pinyin/sherpa 全缺）→「装上了但手写/声纹全废」的假成功。记 债-20 |
| `add <tgz>` 且 profile 未放行构建脚本 | **复现上游 债-01**：`ERR_PNPM_IGNORED_BUILDS: onnxruntime-node`，exit 1，deps 写入但 **bundles 不注册** |
| 先写 `pnpm-workspace.yaml` 的 `allowBuilds: {onnxruntime-node: true}` 再 `add <tgz>` | **exit 0 + postinstall 已跑 + bundles 含本包**（`studio-final` 实测） |
| 先 add 再 `pnpm approve-builds` 再 add | 第二次只输出 "Already up to date"，**bundles 仍不注册** |
| pnpm 11 读 `package.json` 的 `pnpm.onlyBuiltDependencies` | 不读（报 WARN）；Web profile 还要一并放行 `koffi`（dsh-web-app 的依赖） |

所以正确的干净安装顺序是：**建 profile → 写 allowBuilds（含 onnxruntime-node，做 Web 验证再加 koffi）→ `npm pack` 出 tgz → `dsh plugin add <tgz>` → install-check**。

## 6. 「测试连接」在真实界面里跑通（本地桩，不花真钱）

在 `studio-demo` 的浏览器里：选预设「OpenAI」→ 把 baseUrl 改成本机桩 `http://127.0.0.1:3411/v1` → 填测试 key → 勾同意 → 识别方式切「云端优先」→ 保存 → 测试连接。界面原文：

```
结论：可用
HTTP / 耗时：200 · 5ms
verbose_json：支持   segments：支持   speaker：支持
发往：127.0.0.1:3411 · 不保留 · 探测音频 1s
尝试：verbose_json 200 5ms
原因：已连通（stub-asr，1 段）
```

桩的请求日志（`GET /hits`）：`POST /v1/audio/transcriptions  verbose=true  Bearer sk-test-…`，说明能力探测真的带上了 `response_format`、密钥只作为 Bearer 头发送；随后 `GET /cloud` 的 `asr.capability` 变成
`{supportsVerboseJson:true, returnsSegments:true, returnsSpeaker:true, model:'stub-asr', evidence:'HTTP 200，verbose_json，segments=1，speaker=yes'}`。

再走一次真实 `/chunk`（云端优先、桩返回 `'1: 这是桩返回的一句话。'`）：

```json
{"text":"这是桩返回的一句话。","localText":"各位好，今天我们把三季度的交付情况过一遍…",
 "cloudText":"1: 这是桩返回的一句话。","cloudSpeaker":"S1","asrModel":"stub-asr","degraded":false}
```

→ **R4 的四条语义同时成立**：前缀被清洗、原文留在 cloudText、云端 speaker 归一成 S1、本地文字留在 localText。
测完已把云端配置复位（`mode=local`、`consent=false`、key 清空），`webhooks.json` 里没有测试密钥。

## 7. 干净安装 + 最终自检（`studio-demo`，全新 profile）

```
$ dsh plugin --profile studio-demo add <tgz>            → exit 0，bundles 含本插件
$ node tools/install-check.mjs --profile studio-demo    → 结果：通过（13 项 PASS，0 项提醒）
$ GET /meeting-room/capabilities
asr: ok=True  ready   本机识别就绪（sensevoice-local）
speaker: ok=True  ready   声纹就绪：3D-Speaker CAM++
handwriting: ok=False  not-downloaded   手写模型未就绪（73 MB 未下载，如实报）
cloud: ok=True  off     云端识别未启用
python: ok=True  ready  Word/Excel 导出可用
summary: 4/5
```

界面同步显示「可用 4/5」（截图 `evidence/model-center-final-4of5.png`）。

**顺带修掉的一个假红**：启动自检最初在激活后 ~2s 就跑，而语音服务先注册、再校验模型，于是健康机器被报成「识别模型尚未就绪」。现在自检延后 10s（`setTimeout` + `ctx.effect` 清理），且把 provider 的「正在启动/校验」单独措辞，不再冒充故障。

**再修一个静默失效**：干净 profile 里 `speakerState.phase` 一直是 `unprepared`，而 `labelCue()` 只认 `ready`/`failed`，于是「agent 建会 + 直接喂音频」这条路**永远不出发言人标签**（面板开录会先 prepare，所以只在无面板路径暴露）。现在 `labelCue` 在 `unprepared` 时**懒启动一次** `prepareSpeakers()`（`speakerWarmup` 去重），当前 cue 返回空标签、后续 cue 正常标注。实测同一场：line1/line2 无标签 → line3 `S1` → line4 `S2` → 之后 S1/S2 交替正确。自检的声纹行也补了「首次发言时启动识别器，前一两句可能未标注」。

## 8. 真实供应商实测（硅基流动，2026-11-23，模型按用户指定）

配置：`baseUrl=https://api.siliconflow.cn/v1`、ASR 模型 `XingChenAGI/XingChenASR-V3.2-Ultra`、
纪要模型 `Qwen/Qwen3-8B`、consent 开、`mode=prefer-cloud`、`keepRemote=false`。

| 路径 | 结果 | 证据 |
|---|---|---|
| ASR 探活（Ultra） | 200 / 477ms，`verbose_json` 支持 | 能力缓存写入，静音探测下 segments 记为 **null（未知）**，证据串注明「静音，无法判断分段」 |
| 云端转写（Ultra，经 `/chunk` 真路由） | `cloud.used=true`、`degraded=false`、`model=…Ultra`；文本带标点、`localText` 保留、本地 CAM++ 给 S1 | 见 §7 的转写输出 |
| 降级（Qwen3-ASR-1.7B） | 第一次 400 **且 body 为空** → 去掉 `response_format` 重试 → 200；`verdict=需要降级`、`attempts` 两条、`supportsVerboseJson:false` 入缓存 | 修复前不会重试：`looksLikeFormatRejection` 只看 body 关键词 |
| 分轨模型（Diarize-V3.0） | segments 带 `speaker:"1"`，`text` 带 `「1: 」` 前缀 | 正好是 R4 要清洗的形态；逐段请求无法跨 cue 认人，本地 CAM++ 仍为准 |
| LLM 探活（Qwen3-8B） | 200 / 16.9s | 20s 的 cue 超时会误杀，故 LLM 探活给 45s |
| 云端纪要（`/minutes useCloudLlm`） | 200 / **25.7s**，`llm.ok=true`，输出结构化纪要（含工作安排） | 首次失败是 20s 超时；已改为 120s 并实测通过 |

因此本轮还改了：`guardedFetch` 增加 per-request `timeoutMs`、`cloudLlmComplete` 默认 120s、
`/minutes` 显式 120s、LLM 探活 45s、超时提示按实际秒数打印；`looksLikeFormatRejection` 把
「400/422 + 空 body」也算疑似格式拒绝；能力探测的 segments/speaker 用 `null` 表示「测不出」。

## 9. 桌面端（`desktop` profile）安装结果

```
$ dsh plugin --profile desktop add dsh-meeting-studio-0.1.0-fork.1.tgz   → exit 0
  node_modules/onnxruntime-node postinstall$ node ./script/install → Done
$ node tools/install-check.mjs --profile desktop
  13 项 PASS / 0 提醒（bundles 36 项、发布清单 42 文件、inject 8 项、三个依赖全部可解析）
```

- 安装前已备份 `package.json` 与 `pnpm-workspace.yaml`（`*.bak-20261123-223158`），并先把
  `allowBuilds: onnxruntime-node / sherpa-onnx-node` 写进 profile，否则会复现 债-01。
- 与备份对比：bundles 只多 `dsh-meeting-studio`，dependencies 只多一行；其他 35 个 bundle 未变。
- **宿主半边已在本进程内热加载生效**：第 9 个工具 `meeting_cloud` 可直接调用，`get` 读到真实配置、
  `test` 对硅基流动返回 ASR 200/580ms、LLM 200/5.2s。
- 客户端半边要**刷新页面**（或重启 Harness）才会出现在左侧栏——页面加载时才会拉新的客户端包清单。

## 10. 仍未验证（诚实清单）

- **手写识别**没有真跑：模型 73 MB 未下载（自检如实报「未就绪」）；上传/落库路径由 smoke 覆盖。
- **真实供应商**（硅基流动/OpenAI/Groq）没有用真 key 调过；只用本机桩验证了协议、能力探测、降级分支与脱敏。
- **桌面端 `desktop` profile 没有安装本插件**：全部验证发生在临时 profile（`studio-demo`），没有动用户正在用的桌面配置；要装进桌面端需重启 Harness（安装步骤见 README）。
- 录音链路（麦克风采集）没有用真实麦克风跑；`/chunk` 用合成 PCM 走的是同一条服务端路径。
