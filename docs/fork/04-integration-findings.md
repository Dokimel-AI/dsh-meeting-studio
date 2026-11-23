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

## 6. 未在真实界面验证的部分（诚实清单）

- 云端卡片的「测试连接」按钮没有在浏览器里真点（需要真实供应商 key；HTTP 层与工具体已用本地桩验证 36/36 + 47/47）。
- 手写板的识别没有跑（模型 73 MB 未下载；能力自检如实报「未就绪」）。
- 桌面端（`desktop` profile）没有安装本插件；上面的验证都发生在 `studio-web` 临时 profile，避免动用户正在用的桌面配置。
