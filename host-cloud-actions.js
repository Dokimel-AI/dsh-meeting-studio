/**
 * Cloud actions shared by the HTTP routes and the tools: the provider catalogue, the single
 * whitelist that validates a cloud settings write, and the probes behind "test connection".
 *
 * Why one module: the settings contract (`docs/fork/03-contract.md` §1) is the only place a
 * cloud field may be introduced, and both the route and the future `meeting_cloud` tool must
 * reject the same unknown keys with the same words. The probes live here too because the
 * recognition path must never spend a request to learn something one answer already told it —
 * probing is an explicit action, never a side effect of recording.
 *
 * Forked from dsh-meeting-room 0.1.0-preview.7 (MIT, © 博尔塔拉融媒体中心 · 杨道泉);
 * this file © dsh-meeting-studio contributors, MIT.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { minutesText } from './host-tools.js'
import {
  CLOUD_MODES,
  CLOUD_PROVIDERS,
  readCloudSettings,
  guardedFetch,
  redact,
  wavOf,
  saveAsrCapability,
} from './host-providers.js'

/**
 * The providers a person can start from. Metadata only: choosing one fills the address and
 * suggests model names, nothing here performs a request or changes a setting.
 */
export const PROVIDER_PRESETS = [
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    // Verified against GET /v1/models on 2026-11-23: every id below exists. The diarizing
    // model is listed because it is the only one that returns `speaker` per segment, and the
    // plug-in keeps that field (R4); the two after it differ in whether they accept
    // response_format=verbose_json, which is exactly what the capability probe measures.
    models: [
      'XingChenAGI/XingChenASR-Diarize-V3.0',
      'XingChenAGI/XingChenASR-V3.2-Ultra',
      'Qwen/Qwen3-ASR-1.7B',
      'FunAudioLLM/SenseVoiceSmall',
    ],
    llmModels: ['Qwen/Qwen3-8B', 'deepseek-ai/DeepSeek-V3.2'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['whisper-1', 'gpt-4o-transcribe'],
    llmModels: ['gpt-4o-mini'],
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['whisper-large-v3'],
    llmModels: ['llama-3.3-70b-versatile'],
  },
  {
    id: 'custom',
    name: '自定义',
    baseUrl: '',
    models: [],
    llmModels: [],
  },
]

/** How much silence the ASR probe uploads: long enough to be a real cue, short enough to be free. */
export const PROBE_AUDIO_SECONDS = 1

/**
 * The patch whitelist, one entry per field a client may write.
 *
 * `fallback` is what a JSON `null` resets the field to: the panel keeps a saved key out of the
 * form, so clearing must still be expressible. `apiKey` is special-cased ("empty" = keep).
 */
const FIELD_SPECS = {
  asr: {
    provider: { kind: 'provider', fallback: 'off' },
    baseUrl: { kind: 'string', fallback: '' },
    model: { kind: 'string', fallback: '' },
    language: { kind: 'string', fallback: '' },
    apiKey: { kind: 'secret' },
    keepRemote: { kind: 'boolean', fallback: false },
    stripSpeakerPrefix: { kind: 'boolean', fallback: true },
  },
  speaker: {
    provider: { kind: 'provider', fallback: 'off' },
    baseUrl: { kind: 'string', fallback: '' },
    model: { kind: 'string', fallback: '' },
    apiKey: { kind: 'secret' },
  },
  llm: {
    provider: { kind: 'provider', fallback: 'off' },
    baseUrl: { kind: 'string', fallback: '' },
    model: { kind: 'string', fallback: '' },
    apiKey: { kind: 'secret' },
    temperature: { kind: 'temperature', fallback: 0.2 },
  },
}

/** Top-level shape of a settings patch. */
const TOP_SPECS = {
  consent: { kind: 'boolean', fallback: false },
  mode: { kind: 'mode' },
  asr: { section: FIELD_SPECS.asr },
  speaker: { section: FIELD_SPECS.speaker },
  llm: { section: FIELD_SPECS.llm },
}

/**
 * Validate and normalize one field. A `null` resets it to `fallback`; anything unusable is an
 * error rather than a guess, because a silently dropped value is a setting that never applies.
 * @param path - field path for messages, such as `asr.baseUrl`.
 * @param spec - the field spec from FIELD_SPECS.
 * @param raw - the value the client sent.
 * @returns `{ value }`, `{ skip: true }` (leave the stored value), or `{ error }`.
 */
function normalizeField(path, spec, raw) {
  if (spec.kind === 'secret') {
    if (raw === null) return { value: '' }
    if (typeof raw !== 'string') return { error: `${path} 必须是字符串或 null` }
    const key = raw.trim()
    // An empty key field means "keep the saved key": the panel renders a saved key as blank.
    return key === '' ? { skip: true } : { value: key }
  }
  if (raw === null) {
    if (spec.kind === 'mode') return { error: 'mode 不能为空' }
    return { value: spec.fallback }
  }
  if (spec.kind === 'string') {
    if (typeof raw !== 'string') return { error: `${path} 必须是字符串` }
    return { value: raw.trim() }
  }
  if (spec.kind === 'boolean') {
    if (typeof raw !== 'boolean') return { error: `${path} 必须是 true 或 false` }
    return { value: raw }
  }
  if (spec.kind === 'provider') {
    if (!CLOUD_PROVIDERS.includes(raw)) return { error: `${path} 只能是 ${CLOUD_PROVIDERS.join(' / ')}` }
    return { value: raw }
  }
  if (spec.kind === 'mode') {
    if (!CLOUD_MODES.includes(raw)) return { error: `${path} 只能是 ${CLOUD_MODES.join(' / ')}` }
    return { value: raw }
  }
  if (spec.kind === 'temperature') {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 2) {
      return { error: `${path} 需是 0 到 2 之间的数字` }
    }
    return { value: raw }
  }
  return { error: `${path} 的类型未知` }
}

/**
 * The only place a cloud settings patch is validated. Unknown keys reject the WHOLE patch:
 * half-saving a body whose intent was not understood is how a key ends up in the wrong field.
 *
 * `asr.capability` is deliberately ignored when a client sends it — a cached probe result may
 * only be written by this process after a real request, never claimed by a request body.
 *
 * @param patch - `{ consent?, mode?, asr?, speaker?, llm? }` from JSON or a tool call.
 * @returns `{ ok, value, error, rejected }`; `value` holds only the supplied fields.
 */
export function normalizeCloudPatch(patch) {
  const rejected = []
  const fail = (error) => ({ ok: false, value: null, error, rejected })
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return fail('请求体必须是一个 JSON 对象')
  }
  const unknownTop = Object.keys(patch).filter((key) => !Object.hasOwn(TOP_SPECS, key))
  if (unknownTop.length > 0) {
    rejected.push(...unknownTop)
    return fail(`不认识的字段：${unknownTop.join('、')}（整份配置未写入）`)
  }
  const value = {}
  for (const [key, spec] of Object.entries(TOP_SPECS)) {
    if (!Object.hasOwn(patch, key)) continue
    const raw = patch[key]
    if (spec.section === undefined) {
      const normalized = normalizeField(key, spec, raw)
      if (normalized.error !== undefined) return fail(normalized.error)
      value[key] = normalized.value
      continue
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return fail(`${key} 必须是一个对象`)
    }
    const section = {}
    const unknown = []
    for (const name of Object.keys(raw)) {
      // Server-written only: ignore rather than reject, so an echoed summary round-trips.
      if (name === 'capability') continue
      if (!Object.hasOwn(spec.section, name)) {
        unknown.push(`${key}.${name}`)
        continue
      }
      const normalized = normalizeField(`${key}.${name}`, spec.section[name], raw[name])
      if (normalized.error !== undefined) return fail(normalized.error)
      if (normalized.skip !== true) section[name] = normalized.value
    }
    if (unknown.length > 0) {
      rejected.push(...unknown)
      return { ok: false, value: null, error: `不认识的字段：${unknown.join('、')}（整份配置未写入）`, rejected }
    }
    value[key] = section
  }
  return { ok: true, value, error: '', rejected }
}

/**
 * The host a person sees when asked "where will the audio go?".
 * @param url - configured base URL.
 * @returns the host name, the raw value when it does not parse, or '' when unset.
 */
export function cloudHostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return url === '' ? '' : redact(url)
  }
}

/**
 * Boot canary, same file `index.js` writes, so a capability write that failed on a read-only
 * home is still diagnosable. Never throws.
 * @param parts - values joined into one line.
 */
function noteBoot(...parts) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const directory = join(home, 'meeting-room')
    mkdirSync(directory, { recursive: true })
    const line = `${new Date().toISOString()} ${parts.map((part) => (
      typeof part === 'string' ? part
        : part instanceof Error ? (part.stack ?? part.message)
          : JSON.stringify(part)
    )).join(' ')}\n`
    appendFileSync(join(directory, 'boot.log'), line, 'utf8')
  } catch {
    // Silent: logging must not add a failure mode to a probe.
  }
}

/**
 * One second of 16 kHz mono PCM16 silence in a WAV container.
 * @param seconds - duration in seconds.
 * @returns the WAV bytes.
 */
export function silentWav(seconds = PROBE_AUDIO_SECONDS) {
  return wavOf(Buffer.alloc(Math.round(seconds * 16_000) * 2), 16_000)
}

/**
 * Whether a failed attempt failed BECAUSE of `response_format`, which is worth one retry
 * without the field. Only 400/422 count: a 401 or a timeout will not change on a retry.
 * @param status - HTTP status of the failed attempt (0 when it never answered).
 * @param detail - raw response body, or the redacted error message.
 * @returns true when removing `response_format` may help.
 */
export function looksLikeFormatRejection(status, detail) {
  if (status !== 400 && status !== 422) return false
  const text = String(detail ?? '')
  // SiliconFlow's Qwen3-ASR answers a rejected `response_format` with a 400 and an EMPTY
  // body (measured 2026-11-23), so a keyword test alone would never retry it. On the
  // transcription endpoint the only optional field this plugin adds is `response_format`,
  // so a 400/422 with nothing to read is treated as a format rejection as well: the retry
  // costs one request and, when the guess was wrong, the second failure is reported as is.
  if (text.trim() === '') return true
  return /response_format|verbose_json|format|invalid|unsupported|parameter|字段|参数/iu.test(text)
}

/**
 * Whether a request may leave the machine at all, and what to say when it may not.
 *
 * Configuration problems are reported before the privacy gate: "not configured" is the useful
 * answer for a test button, and both cases make zero requests either way.
 * @param cloud - result of readCloudSettings().
 * @param kind - asr / llm.
 * @returns `{ verdict, reason }`, both '' when a request may be made.
 */
function gateCloud(cloud, kind) {
  const part = cloud[kind]
  if (part.provider === 'off') return { verdict: '未配置', reason: '没有选择云端服务' }
  if (part.baseUrl === '') return { verdict: '未配置', reason: '还没有填写服务地址' }
  if (kind === 'llm' && part.model === '') return { verdict: '未配置', reason: '还没有填写模型名称' }
  if (part.provider === 'openai-compatible' && part.apiKey === '') return { verdict: '未配置', reason: '还没有填写密钥' }
  // The privacy promise: no consent or local mode means no request, whatever is configured.
  if (cloud.mode === 'local' || cloud.consent !== true) {
    return { verdict: '未启用', reason: '还没有同意上传（未发起任何请求）' }
  }
  return { verdict: '', reason: '' }
}

/**
 * Build the multipart body of one transcription request, with or without `response_format`.
 * @param part - the asr settings.
 * @param wav - WAV bytes.
 * @param includeVerbose - whether to ask for `verbose_json`.
 * @param extras - `{ language?, prompt? }` recognition hints.
 * @returns the FormData body.
 */
export function transcriptionForm(part, wav, includeVerbose, extras = {}) {
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'cue.wav')
  form.append('model', part.model === '' ? 'whisper-1' : part.model)
  if (includeVerbose) form.append('response_format', 'verbose_json')
  const language = typeof extras.language === 'string' ? extras.language : ''
  if (language !== '') form.append('language', language)
  if (typeof extras.prompt === 'string' && extras.prompt !== '') form.append('prompt', extras.prompt.slice(0, 800))
  // Declaring that the audio may not be retained is part of asking for consent honestly.
  if (part.keepRemote !== true) form.append('retention', 'none')
  return form
}

/**
 * Read one segment list, keeping the provider's own speaker token (R4). The token is stored
 * verbatim; normalizing it to S1/S2 is the recording chain's job, not the wire's.
 * @param value - parsed response body.
 * @returns the segments.
 */
export function readCloudSegments(value) {
  if (!Array.isArray(value?.segments)) return []
  return value.segments
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({
      start: Number(item.start ?? 0),
      end: Number(item.end ?? 0),
      text: typeof item.text === 'string' ? item.text.trim() : '',
      speaker: typeof item.speaker === 'string' ? item.speaker.trim() : '',
    }))
    .filter((item) => item.text !== '')
}

/**
 * Probe the configured ASR service with one second of silence and record what it can do.
 *
 * No request is made without consent and cloud mode — the returned `destination` still tells
 * the person where the audio would have gone. A provider that refuses `verbose_json` gets ONE
 * retry without the field; that is the documented degradation, and the result says so.
 *
 * Verdicts: `可用` / `需要降级` / `不可用` / `未配置` / `未启用`.
 * @returns the contract's `asr` block plus the backward-compatible `ok`/`message` pair.
 */
export async function probeCloudAsr() {
  const result = {
    ok: false,
    verdict: '未配置',
    http: null,
    capability: null,
    destination: null,
    degraded: false,
    attempts: [],
    reason: '',
    message: '',
    model: '',
  }
  const cloud = await readCloudSettings()
  const part = cloud.asr
  result.destination = {
    host: cloudHostOf(part.baseUrl),
    keepRemote: part.keepRemote === true,
    audioSeconds: PROBE_AUDIO_SECONDS,
  }
  const gate = gateCloud(cloud, 'asr')
  if (gate.verdict !== '') {
    result.verdict = gate.verdict
    result.reason = gate.reason
    result.message = gate.reason
    return result
  }
  const url = `${part.baseUrl.replace(/\/$/u, '')}/audio/transcriptions`
  const headers = part.apiKey === '' ? {} : { Authorization: `Bearer ${part.apiKey}` }
  const wav = silentWav()
  // Ask for the richest answer unless a cached probe already proved it would be refused.
  let includeVerbose = part.capability === null || part.capability.supportsVerboseJson !== false
  let degraded = false
  const attemptOnce = async (verbose) => {
    const started = Date.now()
    try {
      const response = await guardedFetch(url, {
        method: 'POST',
        headers,
        body: transcriptionForm(part, wav, verbose),
      }, '云端识别测试')
      // Parse explicitly: a 200 that is not JSON means the address points at the wrong
      // endpoint, and calling that "available" would send the person home with a broken setup.
      const raw = await response.text().catch(() => '')
      let value = {}
      let parsed = false
      try {
        value = raw === '' ? {} : JSON.parse(raw)
        parsed = value !== null && typeof value === 'object'
      } catch {
        parsed = false
      }
      return { ok: true, status: response.status, ms: Date.now() - started, value, parsed }
    } catch (failure) {
      return {
        ok: false,
        status: Number(failure?.status ?? 0),
        ms: Date.now() - started,
        detail: String(failure?.detail ?? ''),
        message: redact(failure instanceof Error ? failure.message : String(failure)),
      }
    }
  }
  let attempt = await attemptOnce(includeVerbose)
  result.attempts.push({ responseFormat: includeVerbose ? 'verbose_json' : 'none', status: attempt.status, ms: attempt.ms })
  if (!attempt.ok && includeVerbose && looksLikeFormatRejection(attempt.status, attempt.detail ?? attempt.message)) {
    includeVerbose = false
    degraded = true
    attempt = await attemptOnce(false)
    result.attempts.push({ responseFormat: 'none', status: attempt.status, ms: attempt.ms })
  }
  result.degraded = degraded
  if (!attempt.ok) {
    const reason = attempt.message.slice(0, 200)
    result.ok = false
    result.verdict = '不可用'
    // A refusal is still an answer: show its status so the panel can say "HTTP 401" plainly.
    if (attempt.status !== 0) result.http = { status: attempt.status, ms: attempt.ms }
    result.reason = reason === '' ? '请求没有成功，也没有返回可读的原因' : reason
    result.message = result.reason
    return result
  }
  if (attempt.parsed !== true) {
    result.ok = false
    result.verdict = '不可用'
    result.http = { status: attempt.status, ms: attempt.ms }
    result.reason = '服务端返回 2xx，但响应不是 JSON：地址可能指错了端点（应为 {baseUrl}/audio/transcriptions）'
    result.message = result.reason
    return result
  }
  const value = attempt.value ?? {}
  const segments = readCloudSegments(value)
  const returnsSpeaker = segments.some((segment) => segment.speaker !== '')
  // The probe uploads one second of silence, which a service may legitimately transcribe as
  // nothing at all — including one that does support segments. Reporting "no segments" then
  // would be a fact about the probe rather than about the provider, so that case stays
  // `null` (the interface renders it as 未知) unless an earlier probe knew better.
  const heardSomething = segments.length > 0 || (typeof value.text === 'string' && value.text.trim() !== '')
  const capability = {
    supportsVerboseJson: includeVerbose,
    // Without the verbose request there are no segments to look at, so a known good state is
    // carried over instead of being overwritten by "we did not ask".
    returnsSegments: !includeVerbose
      ? part.capability?.returnsSegments === true
      : heardSomething ? segments.length > 0 : null,
    returnsSpeaker: !includeVerbose
      ? part.capability?.returnsSpeaker === true
      : heardSomething ? returnsSpeaker : null,
    model: typeof value.model === 'string' && value.model !== '' ? value.model : part.model,
    probedAt: Date.now(),
    evidence: redact(`HTTP ${attempt.status}，${includeVerbose ? 'verbose_json' : '普通 JSON'}，segments=${segments.length}${heardSomething ? '' : '（探测音频是静音，无法判断分段）'}，speaker=${returnsSpeaker ? 'yes' : 'no'}`).slice(0, 200),
  }
  result.ok = true
  result.verdict = degraded ? '需要降级' : '可用'
  result.capability = capability
  result.model = capability.model
  result.http = { status: attempt.status, ms: attempt.ms }
  result.reason = degraded
    ? '服务端不接受 response_format=verbose_json，已自动改用普通格式：能拿到全文，但没有分段与说话人'
    : ''
  result.message = degraded
    ? redact(`已连通但需要降级（${capability.model} 不支持 verbose_json）`)
    : redact(`已连通（${capability.model}${segments.length > 0 ? `，${segments.length} 段` : ''}）`)
  // Best effort: the capability cache makes the NEXT recognition cheaper, but a read-only
  // home must not turn a successful probe into a failed one.
  try {
    await saveAsrCapability(capability)
  } catch (failure) {
    noteBoot('cloud-capability-save-failed', failure instanceof Error ? failure.message : String(failure))
  }
  return result
}

/**
 * Probe the configured LLM with one tiny chat completion.
 * @returns the contract's `llm` block plus the backward-compatible `ok`/`message` pair.
 */
export async function probeCloudLlm() {
  const result = { ok: false, verdict: '未配置', http: null, model: '', reason: '', message: '' }
  const cloud = await readCloudSettings()
  const part = cloud.llm
  result.model = part.model
  const gate = gateCloud(cloud, 'llm')
  if (gate.verdict !== '') {
    result.verdict = gate.verdict
    result.reason = gate.reason
    result.message = gate.reason
    return result
  }
  const url = `${part.baseUrl.replace(/\/$/u, '')}/chat/completions`
  const headers = {
    'Content-Type': 'application/json',
    ...(part.apiKey === '' ? {} : { Authorization: `Bearer ${part.apiKey}` }),
  }
  const started = Date.now()
  try {
    const response = await guardedFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: part.model,
        messages: [{ role: 'user', content: '回复 ok 两个字' }],
        max_tokens: 8,
      }),
    }, '云端纪要测试', 45_000)
    const ms = Date.now() - started
    const value = await response.json().catch(() => ({}))
    result.http = { status: response.status, ms }
    if (!Array.isArray(value?.choices) || value.choices.length === 0) {
      result.verdict = '不可用'
      result.reason = '服务端返回 2xx，但响应里没有 choices（不是 OpenAI 兼容的 chat completions？）'
      result.message = result.reason
      return result
    }
    result.ok = true
    result.verdict = '可用'
    result.model = typeof value.model === 'string' && value.model !== '' ? value.model : part.model
    result.message = redact(`已连通（${result.model}）`)
  } catch (failure) {
    const reason = redact(failure instanceof Error ? failure.message : String(failure)).slice(0, 200)
    const status = Number(failure?.status ?? 0)
    if (status !== 0) result.http = { status, ms: Date.now() - started }
    result.verdict = '不可用'
    result.reason = reason
    result.message = reason
  }
  return result
}

/**
 * Build the chat messages that turn the on-machine minutes into a readable Markdown one.
 *
 * The local minutes are the source of truth: the model is asked to edit, never to invent. A
 * very long meeting is truncated from the transcript side by `minutesText`'s own shape, and
 * the request is capped again so one careless click cannot become an unbounded bill.
 * @param meeting - meeting record.
 * @returns chat messages for cloudLlmComplete().
 */
export function cloudMinutesMessages(meeting) {
  const source = minutesText(meeting)
  const capped = source.length > 24_000 ? `${source.slice(0, 24_000)}\n\n（后面内容因长度被截断）` : source
  return [
    {
      role: 'system',
      content: '你是中文会议纪要编辑。只输出 Markdown 正文，不要解释过程。只使用给定材料里的事实，不要编造。保留决议、工作安排、风险与待确认项。',
    },
    {
      role: 'user',
      content: `请把下面这份本机生成的会议纪要改写成更适合阅读的 Markdown 纪要（可调整顺序与措辞，但不要增删事实），保留「会议纪要」标题：\n\n${capped}`,
    },
  ]
}

/** A leading speaker token, as some OpenAI-compatible services prepend to the text. */
const SPEAKER_PREFIX = /^\s*(?:\[?(?:speaker[_\s-]*\d+|说话人\s*\d+|s\d+)\]?|\d{1,2})\s*[:：]/iu

/**
 * Strip a leading speaker token from transcribed text, when the person asked for that.
 *
 * Conservative on purpose: a numeric prefix is only removed when what follows does not start
 * with another digit, so a time such as `12:30` is not mistaken for a speaker label.
 * @param text - transcribed text.
 * @returns `{ text, cleaned }` where `cleaned` says whether anything was removed.
 */
export function cleanSpeakerPrefix(text) {
  const source = typeof text === 'string' ? text : ''
  const match = SPEAKER_PREFIX.exec(source)
  if (match === null) return { text: source, cleaned: false }
  const rest = source.slice(match[0].length)
  if (/^\d/u.test(rest)) return { text: source, cleaned: false }
  return { text: rest.replace(/^\s+/u, ''), cleaned: true }
}

/**
 * Turn the provider's own speaker tokens into the S1/S2 vocabulary the panel already uses.
 *
 * Numbering follows first appearance so two cues from the same voice keep the same label. When
 * a caller supplies `options.map`, the mapping is read from and written back to that object,
 * which is how the recording chain keeps one numbering for the whole meeting.
 * @param segments - cloud segments, each optionally carrying a `speaker` token.
 * @param options - `{ map? }` persistent token-to-label map.
 * @returns the label(s) of the speakers in this cue, in first-appearance order, or ''.
 */
export function normalizeSpeaker(segments, options = {}) {
  const list = Array.isArray(segments) ? segments : []
  const map = options !== null && typeof options === 'object' && options.map !== null && typeof options.map === 'object'
    ? options.map
    : {}
  const labels = []
  for (const segment of list) {
    if (segment === null || typeof segment !== 'object') continue
    const token = typeof segment.speaker === 'string' ? segment.speaker.trim() : ''
    if (token === '') continue
    // hasOwn, not `undefined`: a token named "constructor" must not read the prototype.
    if (!Object.hasOwn(map, token)) map[token] = `S${Object.keys(map).length + 1}`
    const label = map[token]
    if (!labels.includes(label)) labels.push(label)
  }
  return labels.join('/')
}
