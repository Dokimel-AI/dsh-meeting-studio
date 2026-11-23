# 00 · 基线（clone 与冒烟）

> 记录时间：2026-11-23 21:05（Asia/Shanghai）
> 本机：Windows 10.0.26300 x64 · DSH Runtime 0.2.2-rc.5（Electron 桌面端，profile=desktop）
> Node v24.12.0 · pnpm 11.22.0 · Python 3.14.2（C:\Python314）

## 1. 上游与克隆

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/kekydream/dsh-meeting-room |
| 本地目录 | `D:\MyProject\研究学习\DSH插件\dsh-meeting-studio` |
| 默认分支 | **`master`**（上游没有 `main`，任务书里的 "main" 按 master 处理） |
| 当前锁定 commit | **`01838da67121b0bfa1fb3c18f7632890c73b28ce`** |
| `git describe` | `v0.1.0-preview.7-2-g01838da`（比 tag 多 2 个仅文档提交） |
| `package.json` version | `0.1.0-preview.7` |
| LICENSE | MIT（文件保留原版权：博尔塔拉融媒体中心 · 杨道泉） |
| 文件数 / 体积 | 40 个文件 / 1.10 MB（含 `.git` 之外的工作树） |
| 远端分支 | master, develop, release/preview.3, release/preview.7 |

命令与输出（原样）：

```
$ git rev-parse HEAD
01838da67121b0bfa1fb3c18f7632890c73b28ce

$ git describe --tags --always
v0.1.0-preview.7-2-g01838da
```

已建分支：`feat/model-center`（自 master 建，尚未提交任何改动前的基线状态干净）。

## 2. 冒烟基线（改动前）

```
$ node smoke.mjs
...
217/220 passed
failed: Excel 导出是真正的 xlsx | xlsx 文件以 PK 开头 | 生成 Word 纪要
[exit code: 1]
```

**基线 = 217/220**，与 `fork-debt.md` 债-04 记录一致（数字一致，但根因不同，见 §4）。

## 3. 环境侧事实（决定第二期/演示路径）

| 事实 | 证据 | 影响 |
|---|---|---|
| desktop profile 现有 35 个 bundle，**不含** meeting-room | `~/.dsh/profiles/desktop/package.json` → `dsh.profile.bundles` | 干净安装演示可行 |
| profile 内 **没有** `sherpa-onnx-node` / `onnxruntime-node` / `pinyin-pro` | `Test-Path profiles/desktop/node_modules/...` 全 False | 债-02 复现前提成立：装完插件声纹会静默失效 |
| profile 内 `@deepseek-ai/*` 仅 7 个（cosmokit/dsh-brand/dsh-sdk-protocol/dsh-subagent-claude-code/dsh-subagent-codex/dsh-tool-subagent/schemastery） | 目录列举 | 与「共享宿主包遮蔽」历史坑一致，安装前后需 diff |
| profile **没有**任何提供 `speechToText` 的 bundle | bundles 列表无 speech-to-text；npm 上 `@deepseek-ai/dsh-experimental-speech-to-text@0.1.7-alpha.1` 存在 | 债-11 成立：本机当前**本地转写完全不可用**，R6 自检必须如实亮红 |
| 系统 Python 3.14.2 已装 python-docx + openpyxl | `python -c "import docx, openpyxl"` → OK | Word/Excel 导出在系统解释器下可用 |
| 捆绑运行时 Python 3.12.14 已装同两个包 | `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe -c "import docx, openpyxl"` → OK | 但**写入受限**，见 §4 |

## 4. 债-04 根因更正：不是「找不到 python」，而是「捆绑运行时写不进目标目录」

三项失败的检查都在 `smoke.mjs:280-287`（xlsx 两项）与 `:346`（docx），都走 `pythonExecutable()`（`host-helpers.js:198-219`）+ `spawn(python, [script, target])`。

`smoke.mjs:23-26` 会主动把 `DSH_PYTHON` 指向 `%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`（存在则设）。本机该文件**存在**，于是：

```
$ $env:DSH_PYTHON='C:\Python314\python.exe'; node smoke.mjs
220/220 passed          # 用系统 python：全绿
```

用捆绑运行时直接渲染同一个 xlsx，真实报错是**写权限**，不是缺包：

```
$env:DSH_HOME=<Temp>; $env:DSH_PYTHON=<bundled python>
WARN: meeting-room: xlsx renderer failed: %s |
Traceback (most recent call last):
  File "...\scores-xlsx.py", line 71, in main
    book.save(target)
  ...
PermissionError: [Errno 13] Permission denied:
  'C:\Users\81521\AppData\Local\Temp\mr-probe2-...\meeting-room\exports\probe.xlsx'
```

最小对照（同一目录、同一秒，只换解释器）：

```
$ <bundled python>      -c "open(sys.argv[1],'w').write('x')"  <Temp>\a.txt  → PermissionError
$ C:\Python314\python.exe -c "open(sys.argv[1],'w').write('x')" <Temp>\b.txt  → ok
```

结论（已实测，可复现）：

1. 本机 `~/.dsh/dsh-runtimes/` 下的捆绑 python 运行在受限令牌（AppContainer 形态）里，**无法写入 `%TEMP%`**；`C:\Python314` 不受限。
2. `smoke.mjs` 优先选捆绑运行时 → 三项 python 检查在「临时 DSH_HOME」里失败；换成系统 python 即 220/220。
3. 所以 **基线 217/220 是测试装置问题，不是产品缺陷**；但它暴露了一个真实的产品风险：**导出 Word/Excel 在受限目录下会失败，而 UI 只会拿到一行 traceback**。→ 记入 `fork-debt.md` 债-19，并在 R6 自检里改成「写探测」而非「路径探测」。

## 5. 基线结论

| 项 | 基线值 | 之后每次改动都要对齐 |
|---|---|---|
| smoke | `217/220`（无 `DSH_PYTHON`）；`220/220`（`DSH_PYTHON=C:\Python314\python.exe`） | 不得低于基线；R8 会把这 3 项改成「能自动解释」的形态 |
| 工具数 | 8 个 `meeting_*` | 只增不减（R5 增第 9 个） |
| HTTP 路由 | 见 `01-code-map.md` §2 | 只增不改语义 |
| 设置文件 | `$DSH_HOME/meeting-room/webhooks.json` | 不迁移、不改名 |
