# 第三方组件与模型声明

本插件（`dsh-meeting-studio`）以 **MIT** 协议发布，见 [LICENSE](LICENSE)。
下面是它运行时用到、但不属于本插件的组件与模型。**这些资产各自适用其作者/发布方的条款**，
本插件只是调用或下载它们；本声明用于说明来源，便于部署方核对合规。

核对日期：**2026-11-23**。每条结论都注明来源（npm 包元数据 / 上游仓库 LICENSE 路径 / 模型卡 URL），
换版本或模型卡改条款时请按同一路径复核。

## 一、随插件安装的运行时依赖

| 组件 | 版本 | 协议 | 来源（核对依据） | 用途 |
| --- | --- | --- | --- | --- |
| `onnxruntime-node` | 1.20.1 | **MIT** | npm 元数据 `license: MIT`：`https://registry.npmjs.org/onnxruntime-node/1.20.1`；上游 `github.com/microsoft/onnxruntime` | 在本机执行声纹与会话识别模型（子进程 `speaker-worker.js` / `handwriting-worker.js`） |
| `pinyin-pro` | `^3.27.0`（当前解析 3.29.5） | **MIT** | npm 元数据 `license: MIT`：`https://registry.npmjs.org/pinyin-pro/latest`；上游 `github.com/zh-lx/pinyin-pro` | 中文同音订正（术语表里的同音替换） |

## 二、由运行环境提供、本插件不打包

| 组件 | 协议 | 来源（核对依据） | 说明 |
| --- | --- | --- | --- |
| `sherpa-onnx-node`（peer，可选） | **Apache-2.0** | npm 元数据 `license: Apache-2.0`：`https://registry.npmjs.org/sherpa-onnx-node/1.13.8`；上游 LICENSE（Apache License 2.0）：`github.com/k2-fsa/sherpa-onnx/blob/master/LICENSE` | 语音识别 / 声纹后端；由运行环境提供，缺失时插件给出自检提示而不是安装它 |
| React / ReactDOM | MIT | 随 DeepSeek Harness 分发 | 面板与浏览器半边的界面运行时，由 DSH 客户端提供 |
| `@deepseek-ai/dsh-client-*` 系列 | 随 DeepSeek Harness 分发 | 见 DeepSeek Harness 自带的许可证与第三方声明 | 客户端槽位、侧栏、设置等平台模块，由宿主在运行时提供 |

## 三、运行时下载的模型（不属于本插件，也不随包分发）

插件只做"下载 + 校验（大小与 sha256）+ 在本机使用"，**不再分发**这些模型；
它们的版权与使用条款归各自发布方。

| 模型 | 上游 / 模型卡 | 许可证（模型卡声明） | 下载来源 | 校验（插件内置） | 用途 |
| --- | --- | --- | --- | --- | --- |
| `3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`（3D-Speaker CAM++，中英，16 kHz） | 阿里通义 DAMO / 3D-Speaker：`https://www.modelscope.cn/models/iic/speech_campplus_sv_zh-cn_16k-common` | **Apache License 2.0**（模型卡 `License` 字段）；训练/推理代码仓库 LICENSE 同为 Apache-2.0：`github.com/alibaba-damo-academy/3D-Speaker/blob/main/LICENSE` | k2-fsa/sherpa-onnx GitHub Release（tag `speaker-recongition-models`） | 28,281,138 字节；sha256 `f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11` | 发言人分离（声纹向量与聚类） |
| `handwriting-damo.onnx` + `vocab.txt`（DAMO 手写行识别，ConvNeXt-Tiny） | 阿里通义 DAMO / ModelScope 读光：`https://www.modelscope.cn/models/iic/cv_convnextTiny_ocr-recognition-handwritten_damo` | **Apache License 2.0**（模型卡 `License` 字段） | ModelScope 仓库接口 `https://www.modelscope.cn/api/v1/models/iic/cv_convnextTiny_ocr-recognition-handwritten_damo/repo`（`model.onnx` / `vocab.txt`） | `model.onnx` 76,859,029 字节、sha256 `a98dddb2b4ee1bd0b358bd087ecebc242767eae6657682569fb5e87ce96ea82e`；`vocab.txt` 30,333 字节 | 手写笔记的本地离线识别 |
| 语音识别模型（SenseVoice 等） | **由 DeepSeek Harness 的语音能力提供**，本插件不下载也不管理 | 随 DeepSeek Harness 分发 | — | — | 录音转写 |

模型落盘位置：`$DSH_HOME/speech-to-text/speakers/`（声纹）与 `$DSH_HOME/handwriting/`（手写）。

## 四、商用前必须逐个确认（两个模型）

两个模型的许可证结论**只代表 2026-11-23 当天模型卡上的声明**，部署方在对外服务、收费或再分发前
需**逐个模型**重新确认，不能把本文件的结论当作一次性豁免：

1. 打开上表对应的模型卡 URL，核对 `License` 字段是否仍为 Apache License 2.0、是否新增附加条款；
2. 核对模型卡的训练数据说明与用途限制（声纹模型涉及真实说话人数据，是否允许商用/对外服务以模型卡为准）；
3. 需要再分发模型文件时，按 Apache-2.0 第 4 条随附许可证与变更声明，并保留上游版权与归属信息；
4. 模型卡或上游仓库改条款、下线、换权重文件（sha256 变化）时，以当时的上游条款为准，本插件只负责校验下载完整性。

## 五、说明

- 插件**不上传**音频、实录或任何会议内容；模型下载与识别都在本机完成（见 README「数据位置」）。
- 推送到钉钉/企业微信时，只有你确认过的工作安排会按你在「会议管理 → 设置」里配置的方式发出。
- 若你是部署方，需要更细的清单（含传递依赖），可用 `npm ls --all` 结合各包自带的 LICENSE 生成。
- 本声明如与实际安装的版本不一致，以**实际版本附带的 LICENSE** 为准；发现遗漏欢迎发邮件指出
  （见 README「反馈」）。
