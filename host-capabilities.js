/**
 * Capability self-check — one honest answer to "what works on this machine right now".
 *
 * Why this module exists: every capability this plugin uses can be absent for a reason the
 * person cannot see. The speech service is provided by another bundle, the speaker and
 * handwriting models are optional downloads, the Python renderers depend on an interpreter
 * that may be missing packages — or may be there and still unable to write into the folder
 * it is handed. Each of those used to fail silently or as a traceback. This module turns
 * them into five rows with a state, a plain-language reason and one fix.
 *
 * The report is data, not a gate: nothing here prevents the plugin from loading. It is
 * written to `$DSH_HOME/meeting-room/capabilities.json` so a support conversation can start
 * from what the machine said, and it is served over HTTP for the "model center" panel.
 *
 * Forked from dsh-meeting-room 0.1.0-preview.7 (MIT, © 博尔塔拉融媒体中心 · 杨道泉);
 * this file © dsh-meeting-studio contributors, MIT.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readSpeechState, prepareSpeech } from './host-tools.js'
import { speakerState, prepareSpeakers } from './host-speaker.js'
import { handwritingState, prepareHandwriting } from './host-handwriting.js'
import { readRegistry, activeOf, verifyModel } from './host-models.js'
import { cloudSummary } from './host-providers.js'
import { pythonExecutable } from './host-helpers.js'

/** Version of the report this module writes; a reader may ignore unknown fields. */
export const REPORT_VERSION = 1

/** The rows every report carries, in the order the panel shows them. */
export const CHECK_IDS = ['asr', 'speaker', 'handwriting', 'cloud', 'python']

/** How long a probe may take before it is reported as unknown instead of hanging the page. */
const PROBE_TIMEOUT_MS = 8_000

/** Where the last report is kept, next to the other per-installation state. */
export function capabilitiesPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'meeting-room', 'capabilities.json')
}

/**
 * The directory a probe may write into: the same exports folder the renderers use, so the
 * probe proves the path the real feature will use rather than a different one.
 */
function probeDirectory() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'meeting-room', 'exports')
}

/**
 * Run one command with a deadline, collecting stdout and stderr.
 * @param command - executable to start.
 * @param args - its arguments.
 * @param timeoutMs - deadline in milliseconds.
 * @returns `{ code, stdout, stderr, timedOut }`; `code` is null when it never started.
 */
function runWithDeadline(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (failure) {
      finish({ code: null, stdout: '', stderr: failure instanceof Error ? failure.message : String(failure), timedOut: false })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      finish({ code: null, stdout, stderr, timedOut: true })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (failure) => {
      clearTimeout(timer)
      finish({ code: null, stdout, stderr: `${stderr}${failure instanceof Error ? failure.message : String(failure)}`, timedOut: false })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      finish({ code, stdout, stderr, timedOut: false })
    })
  })
}

/**
 * Whether a native module this plugin needs can be resolved at all.
 * @param specifier - module name, such as `sherpa-onnx-node`.
 * @returns `{ ok, path, reason }`.
 */
export function resolveModule(specifier) {
  try {
    return { ok: true, path: createRequire(import.meta.url).resolve(specifier), reason: '' }
  } catch (failure) {
    return { ok: false, path: '', reason: failure instanceof Error ? failure.message : String(failure) }
  }
}

/**
 * The state of one capability's active model, without downloading anything.
 * @param kind - asr / speaker / handwriting.
 * @returns `{ modelId, name, installed, verified }`.
 */
async function activeModelState(kind) {
  const registry = await readRegistry()
  const id = activeOf(registry)[kind] ?? ''
  const model = registry.models.find((entry) => entry.id === id)
  if (model === undefined) return { modelId: id, name: '', installed: false, verified: false }
  // A host-owned model (the DSH speech provider) has no files here: its readiness is the
  // speech service's own answer, which the asr probe reads separately.
  if (model.runtime === 'host') return { modelId: id, name: model.name, installed: true, verified: true }
  const state = await verifyModel(model)
  return { modelId: id, name: model.name, installed: state.installed, verified: state.verified }
}

/**
 * The speech-recognition row: is a provider present, and is its model usable.
 * @param ctx - Host context.
 * @returns a check row.
 */
function checkAsr(ctx) {
  const speech = readSpeechState(ctx)
  if (speech.phase === 'unavailable') {
    return {
      ok: false,
      state: 'missing',
      message: '没有找到语音识别服务：本机无法离线转写',
      fix: '安装并启用语音输入 bundle（@deepseek-ai/dsh-experimental-voice-input-bundle），或改用云端识别',
      action: 'install-voice-bundle',
      detail: { phase: speech.phase, providerId: speech.providerId },
    }
  }
  if (speech.ready === true) {
    return { ok: true, state: 'ready', message: `本机识别就绪（${speech.providerId || '默认'}）`, fix: '', action: '', detail: { phase: speech.phase } }
  }
  const progress = speech.totalBytes > 0 ? `（${Math.floor((100 * speech.completedBytes) / speech.totalBytes)}%）` : ''
  return {
    ok: false,
    state: speech.phase === 'failed' ? 'failed' : 'preparing',
    message: speech.message !== '' ? speech.message : `识别模型尚未就绪${progress}`,
    fix: speech.phase === 'failed' ? '检查网络与磁盘空间后重试下载' : '点「准备模型」下载识别模型',
    action: 'prepare-asr',
    detail: { phase: speech.phase, completedBytes: speech.completedBytes, totalBytes: speech.totalBytes },
  }
}

/**
 * The speaker row: native addon resolvable, and the active speaker model verified on disk.
 * @param ctx - Host context.
 * @returns a check row.
 */
async function checkSpeaker() {
  const module = resolveModule('sherpa-onnx-node')
  const model = await activeModelState('speaker')
  const detail = { modulePath: module.path, modelId: model.modelId, installed: model.installed, verified: model.verified, workerPhase: speakerState.phase }
  if (!module.ok) {
    return {
      ok: false,
      state: 'missing',
      message: '声纹不可用：缺少 sherpa-onnx-node（依赖未安装，识别会静默跳过）',
      fix: '在本 profile 安装依赖 sherpa-onnx-node@1.13.8，然后重启 Harness',
      action: 'install-speaker-dependency',
      detail: { ...detail, reason: module.reason },
    }
  }
  if (!model.verified) {
    return {
      ok: false,
      state: model.installed ? 'corrupt' : 'not-downloaded',
      message: `声纹模型未就绪：${model.name || '未选择模型'}`,
      fix: '在模型中心下载 3D-Speaker CAM++（约 28 MB），或从本地文件导入',
      action: 'prepare-speaker',
      detail,
    }
  }
  return { ok: true, state: 'ready', message: `声纹就绪：${model.name}`, fix: '', action: '', detail }
}

/**
 * The handwriting row: runtime resolvable, and the DAMO model verified on disk.
 * @returns a check row.
 */
async function checkHandwriting() {
  const runtime = resolveModule('onnxruntime-node')
  const model = await activeModelState('handwriting')
  const detail = { modulePath: runtime.path, modelId: model.modelId, installed: model.installed, verified: model.verified, workerPhase: handwritingState.phase }
  if (!runtime.ok) {
    return {
      ok: false,
      state: 'missing',
      message: '手写识别不可用：缺少 onnxruntime-node',
      fix: '重新安装本插件（onnxruntime-node 是它的依赖），然后重启 Harness',
      action: 'reinstall-plugin',
      detail: { ...detail, reason: runtime.reason },
    }
  }
  if (!model.verified) {
    return {
      ok: false,
      state: model.installed ? 'corrupt' : 'not-downloaded',
      message: `手写模型未就绪：${model.name || '未选择模型'}`,
      fix: '在模型中心下载 DAMO 手写模型（约 43 MB），或从本地文件导入',
      action: 'prepare-handwriting',
      detail,
    }
  }
  return { ok: true, state: 'ready', message: `手写识别就绪：${model.name}`, fix: '', action: '', detail }
}

/**
 * The cloud row: configured and reachable is not the same thing, so this row reports what
 * the settings say and leaves the actual reachability to the "test connection" button.
 * @returns a check row.
 */
async function checkCloud() {
  const cloud = await cloudSummary()
  const detail = { mode: cloud.mode, consent: cloud.consent, provider: cloud.asr.provider, host: cloud.asr.host, keySet: cloud.asr.keySet, fallback: cloud.state.fallback }
  if (cloud.mode === 'local') {
    return { ok: true, state: 'off', message: '云端识别未启用（只用本机），这不影响其他功能', fix: '', action: '', detail }
  }
  if (cloud.consent !== true) {
    return { ok: false, state: 'needs-consent', message: '已选云端模式，但还没有同意上传：所有请求都不会发出', fix: '在云端卡片勾选同意，或把识别方式改回「只用本机」', action: 'cloud-consent', detail }
  }
  if (cloud.asr.provider === 'off' || cloud.asr.baseUrl === '') {
    return { ok: false, state: 'incomplete', message: '云端识别缺少服务地址或服务类型', fix: '在模型中心填写服务地址（baseUrl）并选择服务类型', action: 'cloud-config', detail }
  }
  if (cloud.asr.provider === 'openai-compatible' && cloud.asr.keySet !== true) {
    return { ok: false, state: 'incomplete', message: '云端识别缺少密钥', fix: '在模型中心填写 apiKey', action: 'cloud-config', detail }
  }
  if (cloud.state.fallback === true) {
    return { ok: false, state: 'fallback', message: `云端连续失败，已回退本机：${cloud.state.message}`, fix: '先点「测试连接」定位原因，再决定是否继续使用云端', action: 'cloud-test', detail }
  }
  return { ok: true, state: 'configured', message: `云端已配置（${cloud.asr.host}），用「测试连接」确认可用`, fix: '', action: 'cloud-test', detail }
}

/**
 * The python row, probed by DOING rather than by looking.
 *
 * A path that exists proves nothing: on Windows a bundled interpreter can import every
 * package and still be refused when it writes into the target folder (see 债-19). So the
 * probe imports what the renderers need AND writes a scratch file where the renderers write.
 * @returns a check row.
 */
async function checkPython() {
  const executable = await pythonExecutable()
  const directory = probeDirectory()
  await mkdir(directory, { recursive: true }).catch(() => undefined)
  const scratch = join(directory, `.capability-probe-${process.pid}.txt`)
  const script = [
    'import sys',
    'import docx, openpyxl',
    "open(sys.argv[1], 'w', encoding='utf-8').write('ok')",
    'print("probe-ok")',
  ].join('\n')
  const result = await runWithDeadline(executable, ['-c', script, scratch], PROBE_TIMEOUT_MS)
  const wrote = await readFile(scratch, 'utf8').then((text) => text.trim() === 'ok').catch(() => false)
  await rm(scratch, { force: true }).catch(() => undefined)
  const detail = { executable, stdout: result.stdout.trim().slice(0, 200), stderr: result.stderr.trim().slice(0, 400), wrote }
  if (result.timedOut) {
    return { ok: false, state: 'timeout', message: `Python 探测超时（${PROBE_TIMEOUT_MS / 1000} 秒）：${executable}`, fix: '检查该解释器是否可用，或用 DSH_PYTHON 指定一个正常的 python', action: 'python', detail }
  }
  if (result.code !== 0 || !wrote) {
    const reason = result.stderr.trim() === '' ? `退出码 ${String(result.code)}` : result.stderr.trim().split('\n').slice(-1)[0]
    const writeProblem = result.code === 0 && !wrote
    return {
      ok: false,
      state: writeProblem ? 'cannot-write' : 'failed',
      message: writeProblem
        ? `Python 能运行但写不进导出目录：${executable}`
        : `Python 不可用：${reason}`,
      fix: writeProblem
        ? '换一个能写入该目录的解释器（设置环境变量 DSH_PYTHON），否则 Word/Excel 导出会失败'
        : '安装 python-docx 与 openpyxl，或用 DSH_PYTHON 指定已装好它们的 python',
      action: 'python',
      detail: { ...detail, reason },
    }
  }
  return { ok: true, state: 'ready', message: `Word/Excel 导出可用（${executable}）`, fix: '', action: '', detail }
}

/**
 * Run every probe and return the report. Probes never throw: one broken capability must not
 * hide the state of the other four.
 * @param ctx - Host context.
 * @returns the report including per-row `fix` guidance.
 */
export async function runSelfChecks(ctx) {
  const rows = {}
  const guarded = async (id, work) => {
    try {
      rows[id] = await work()
    } catch (failure) {
      rows[id] = {
        ok: false,
        state: 'error',
        message: `探测本身失败：${failure instanceof Error ? failure.message : String(failure)}`,
        fix: '这是插件的缺陷，请把这句话连同 boot.log 一起反馈',
        action: '',
        detail: {},
      }
    }
  }
  await guarded('asr', async () => checkAsr(ctx))
  await guarded('speaker', async () => checkSpeaker())
  await guarded('handwriting', async () => checkHandwriting())
  await guarded('cloud', async () => checkCloud())
  await guarded('python', async () => checkPython())
  const ready = CHECK_IDS.filter((id) => rows[id]?.ok === true)
  const report = {
    version: REPORT_VERSION,
    plugin: 'dsh-meeting-studio',
    checkedAt: Date.now(),
    checks: rows,
    summary: {
      ready: ready.length,
      total: CHECK_IDS.length,
      // Only the on-machine capabilities block recording-related work; cloud is optional
      // and python only affects document export, so they are reported but not "blocking".
      blocking: CHECK_IDS.filter((id) => (id === 'asr' || id === 'speaker') && rows[id]?.ok !== true),
    },
  }
  return report
}

/**
 * Write the report atomically, so a reader never sees half a file.
 * @param report - result of runSelfChecks().
 * @returns the path written.
 */
export async function saveReport(report) {
  const path = capabilitiesPath()
  await mkdir(join(path, '..'), { recursive: true })
  const partial = `${path}.part`
  await writeFile(partial, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await rename(partial, path)
  return path
}

/**
 * The last saved report, or null when this installation has never run the checks.
 * @returns `{ report, path }` where report may be null.
 */
export async function readReport() {
  const path = capabilitiesPath()
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.checkedAt !== 'number') return { report: null, path }
    return { report: parsed, path }
  } catch {
    return { report: null, path }
  }
}

/**
 * Run the checks and save them, tolerating a read-only home: the report is still returned.
 * @param ctx - Host context.
 * @returns `{ report, saved, error }`.
 */
export async function refreshReport(ctx) {
  const report = await runSelfChecks(ctx)
  try {
    await saveReport(report)
    return { report, saved: true, error: '' }
  } catch (failure) {
    return { report, saved: false, error: failure instanceof Error ? failure.message : String(failure) }
  }
}

/** What a repair request may ask for. */
export const REPAIR_ACTIONS = ['prepare-asr', 'prepare-speaker', 'prepare-handwriting']

/**
 * Start the download/preparation behind one check row.
 *
 * Only the three actions that mean "fetch what is missing" are executed; everything else is
 * guidance, because a missing dependency or a broken interpreter cannot be fixed by clicking
 * and pretending otherwise.
 * @param ctx - Host context.
 * @param action - one of REPAIR_ACTIONS.
 * @returns `{ started, message }`.
 */
export async function repairCapability(ctx, action) {
  if (action === 'prepare-asr') {
    void prepareSpeech(ctx).catch(() => undefined)
    return { started: true, message: '已请求准备本机识别模型，进度看「能力自检」的 asr 行' }
  }
  if (action === 'prepare-speaker') {
    void prepareSpeakers(ctx).catch(() => undefined)
    return { started: true, message: '已开始下载声纹模型，完成后自检会转绿' }
  }
  if (action === 'prepare-handwriting') {
    void prepareHandwriting(ctx).catch(() => undefined)
    return { started: true, message: '已开始下载手写模型，完成后自检会转绿' }
  }
  return {
    started: false,
    message: '这一项不能一键修：缺少原生依赖或解释器需要人工处理，按提示操作后再跑一次自检',
  }
}
