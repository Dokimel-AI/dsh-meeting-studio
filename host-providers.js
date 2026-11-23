/**
 * Cloud model providers — the only code in this plugin that talks to anything outside the
 * machine, and it does nothing until a person says so.
 *
 * The contract is deliberately plain: an OpenAI-compatible transcription endpoint for speech,
 * a documented JSON contract for speaker vectors, and chat completions for the minutes model.
 * Every call passes the same gate — consent given, provider configured, not in fallback — and
 * every message that leaves this module has been through `redact`, so a key can never reach a
 * log, an error or the interface.
 */
import { readSettings, writeSettings } from './host-tools.js'
import {
  PROVIDER_PRESETS,
  normalizeCloudPatch,
  probeCloudAsr,
  probeCloudLlm,
  transcriptionForm,
  looksLikeFormatRejection,
  readCloudSegments,
} from './host-cloud-actions.js'

/** Provider names this module understands. */
export const CLOUD_PROVIDERS = ['off', 'openai-compatible', 'custom']

/**
 * How recognition chooses between the on-machine model and the cloud one.
 *
 * `local` never calls out, `prefer-cloud` tries the cloud and silently keeps the local result
 * after repeated failures, and `cloud-only` is the strict mode: failures are reported instead
 * of being absorbed by the local model.
 */
export const CLOUD_MODES = ['local', 'prefer-cloud', 'cloud-only']

/** Order of magnitude guard rails: a runaway loop must not become a bill. */
export const MAX_REQUESTS_PER_MINUTE = 60
/** One cloud attempt may not hang a meeting. */
export const REQUEST_TIMEOUT_MS = 20_000
/** After this many failures in a row, the plugin stops trying and says so. */
export const FAILURES_BEFORE_FALLBACK = 3

/** What this process knows about the cloud right now. */
export const cloudState = {
  /** Timestamps of recent requests, for the per-minute limit. */
  recent: [],
  consecutiveFailures: 0,
  fallback: false,
  message: '',
  lastModel: '',
  lastAt: 0,
  /** The stored mode, cached so a request path can tell whether falling back is allowed. */
  mode: 'local',
}

/**
 * Remove anything secret from a message before it is shown or logged.
 * @param value - any value about to be logged, returned or displayed.
 * @returns the same text with keys and authorization headers masked.
 */
export function redact(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text
    .replace(/sk-[A-Za-z0-9_-]{6,}/gu, 'sk-***')
    .replace(/(api[-_]?key["'\s:=]+)[A-Za-z0-9._-]{6,}/giu, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{6,}/giu, '$1***')
}

/** The defaults for the cloud section: everything off, nothing configured. */
function defaultCloud() {
  return {
    // Explicit consent, never implied: no call happens while this is false.
    consent: false,
    // Local by default: saving a cloud address is not the same as using it.
    mode: 'local',
    asr: {
      provider: 'off',
      baseUrl: '',
      model: '',
      language: '',
      apiKey: '',
      keepRemote: false,
      // R4: some services prepend "1: " / "SPEAKER_00: " to the text; the panel may clean it.
      stripSpeakerPrefix: true,
      // R3: what the last probe learned, or null when nothing has been probed yet.
      capability: null,
    },
    speaker: { provider: 'off', baseUrl: '', model: '', apiKey: '' },
    // R2: the minutes model, written through the same gate as the recognisers.
    llm: { provider: 'off', baseUrl: '', model: '', apiKey: '', temperature: 0.2 },
  }
}

/**
 * Read a stored ASR capability cache, or null when it is absent or unusable.
 *
 * An unusable cache is dropped rather than patched with guesses: a wrong `supportsVerboseJson`
 * would make every recognition spend a request the provider is known to refuse.
 * @param stored - the persisted `cloud.asr.capability` value.
 * @returns the capability, or null.
 */
function readAsrCapability(stored) {
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return null
  if (typeof stored.supportsVerboseJson !== 'boolean') return null
  return {
    supportsVerboseJson: stored.supportsVerboseJson,
    // `null` here means "the probe could not tell" (it uploads silence), which is a different
    // statement from "the provider does not segment"; the interface renders it as 未知.
    returnsSegments: stored.returnsSegments === true ? true : stored.returnsSegments === false ? false : null,
    returnsSpeaker: stored.returnsSpeaker === true ? true : stored.returnsSpeaker === false ? false : null,
    model: typeof stored.model === 'string' ? stored.model : '',
    probedAt: Number.isFinite(stored.probedAt) ? Number(stored.probedAt) : 0,
    evidence: typeof stored.evidence === 'string' ? redact(stored.evidence).slice(0, 200) : '',
  }
}

/**
 * Read the cloud section of the shared settings, filling in defaults.
 * @returns the cloud settings.
 */
export async function readCloudSettings() {
  const settings = await readSettings()
  const stored = settings.cloud
  const cloud = defaultCloud()
  if (stored !== null && typeof stored === 'object') {
    cloud.consent = stored.consent === true
    if (CLOUD_MODES.includes(stored.mode)) cloud.mode = stored.mode
    for (const kind of ['asr', 'speaker']) {
      const part = stored[kind]
      if (part === null || typeof part !== 'object') continue
      if (CLOUD_PROVIDERS.includes(part.provider)) cloud[kind].provider = part.provider
      for (const key of ['baseUrl', 'model', 'language', 'apiKey']) {
        if (typeof part[key] === 'string') cloud[kind][key] = part[key].trim()
      }
      if (kind === 'asr') {
        cloud.asr.keepRemote = part.keepRemote === true
        // R4: on by default; only an explicit false turns the cleanup off.
        cloud.asr.stripSpeakerPrefix = part.stripSpeakerPrefix !== false
        cloud.asr.capability = readAsrCapability(part.capability)
      }
    }
    // R2: the minutes model is read the same way, but it has no language and no keepRemote.
    const llm = stored.llm
    if (llm !== null && typeof llm === 'object') {
      if (CLOUD_PROVIDERS.includes(llm.provider)) cloud.llm.provider = llm.provider
      for (const key of ['baseUrl', 'model', 'apiKey']) {
        if (typeof llm[key] === 'string') cloud.llm[key] = llm[key].trim()
      }
      if (Number.isFinite(llm.temperature)) {
        cloud.llm.temperature = Math.min(2, Math.max(0, llm.temperature))
      }
    }
  }
  // A request path that only has the module state still needs the current mode: `cloud-only`
  // must not quietly turn on the process-wide fallback.
  cloudState.mode = cloud.mode
  return cloud
}

/**
 * Write the cloud section back, merging the patches that `normalizeCloudPatch` accepted.
 *
 * Validation lives in `host-cloud-actions.js` so the route and the tool refuse the same input;
 * this function only merges and persists. A patch with an unknown field is rejected whole.
 * @param patch - `{ consent?, mode?, asr?, speaker?, llm? }`; an empty apiKey keeps the saved one.
 * @returns `{ ok, cloud, error, rejected }`; `cloud` is null when nothing was written.
 */
export async function writeCloudSettings(patch) {
  const normalized = normalizeCloudPatch(patch)
  if (normalized.ok !== true) {
    return { ok: false, cloud: null, error: normalized.error, rejected: normalized.rejected }
  }
  const settings = await readSettings()
  const current = await readCloudSettings()
  const next = {
    consent: current.consent,
    mode: current.mode,
    asr: { ...current.asr },
    speaker: { ...current.speaker },
    llm: { ...current.llm },
  }
  const value = normalized.value
  if (value.consent !== undefined) next.consent = value.consent
  if (value.mode !== undefined) next.mode = value.mode
  for (const kind of ['asr', 'speaker', 'llm']) {
    if (value[kind] === undefined) continue
    Object.assign(next[kind], value[kind])
  }
  // The capability cache is server-written only: always carry the stored one through.
  next.asr.capability = current.asr.capability
  settings.cloud = next
  await writeSettings({ ...settings, cloud: next })
  // A request path that only has the module state needs the new mode immediately: `cloud-only`
  // must not silently keep the previous fallback behaviour.
  cloudState.mode = next.mode
  return { ok: true, cloud: next, error: '', rejected: [] }
}

/**
 * Persist one ASR capability cache entry, best effort at the call site.
 *
 * Only a real request may write here: the cache exists so a later recognition spends one
 * request instead of two, so a value invented by a client would cost money.
 * @param capability - result of a probe or of a successful degradation retry.
 * @returns the stored capability.
 */
export async function saveAsrCapability(capability) {
  const settings = await readSettings()
  const current = await readCloudSettings()
  const next = { ...current, asr: { ...current.asr, capability: capability ?? null } }
  settings.cloud = next
  await writeSettings({ ...settings, cloud: next })
  return next.asr.capability
}

/**
 * Whether one capability may call out at all, and why not when it may not.
 * @param kind - asr / speaker / llm.
 * @returns `{ ok, reason }`.
 */
export async function cloudStatus(kind) {
  const cloud = await readCloudSettings()
  const part = cloud[kind]
  // The mode is checked first: `local` means no request is made even when everything else
  // is configured, so switching back to local is an immediate, complete stop.
  if (cloud.mode === 'local') return { ok: false, reason: '当前选择本地识别', cloud }
  if (cloud.consent !== true) return { ok: false, reason: '还没有同意上传：云端识别默认关闭', cloud }
  if (part.provider === 'off') return { ok: false, reason: '没有选择云端服务', cloud }
  if (part.baseUrl === '') return { ok: false, reason: '还没有填写服务地址', cloud }
  if (part.provider === 'openai-compatible' && part.apiKey === '') return { ok: false, reason: '还没有填写密钥', cloud }
  if (cloudState.fallback) return { ok: false, reason: redact(cloudState.message), cloud }
  return { ok: true, reason: '', cloud }
}

/**
 * What the interface may know about the cloud: whether a key is set, never the key itself.
 * @returns a masked summary.
 */
export async function cloudSummary() {
  const cloud = await readCloudSettings()
  const host = (url) => {
    try {
      return new URL(url).host
    } catch {
      return url === '' ? '' : redact(url)
    }
  }
  return {
    consent: cloud.consent,
    mode: cloud.mode,
    asr: {
      provider: cloud.asr.provider,
      baseUrl: cloud.asr.baseUrl,
      host: host(cloud.asr.baseUrl),
      model: cloud.asr.model,
      language: cloud.asr.language,
      keySet: cloud.asr.apiKey !== '',
      keepRemote: cloud.asr.keepRemote,
      // R4: whether the panel offers "clean the speaker prefix in the text".
      stripSpeakerPrefix: cloud.asr.stripSpeakerPrefix,
      // R3: the last probe result, or null when nothing has been measured yet.
      capability: cloud.asr.capability,
    },
    speaker: {
      provider: cloud.speaker.provider,
      baseUrl: cloud.speaker.baseUrl,
      host: host(cloud.speaker.baseUrl),
      model: cloud.speaker.model,
      keySet: cloud.speaker.apiKey !== '',
    },
    // R2: the minutes model, same masked treatment as the recognisers.
    llm: {
      provider: cloud.llm.provider,
      baseUrl: cloud.llm.baseUrl,
      host: host(cloud.llm.baseUrl),
      model: cloud.llm.model,
      keySet: cloud.llm.apiKey !== '',
      temperature: cloud.llm.temperature,
    },
    // Starting points for the panel's "fill from provider" control; metadata only.
    presets: PROVIDER_PRESETS,
    state: {
      fallback: cloudState.fallback,
      strict: cloud.mode === 'cloud-only',
      message: redact(cloudState.message),
      lastModel: cloudState.lastModel,
      lastAt: cloudState.lastAt,
      failures: cloudState.consecutiveFailures,
    },
    limits: { perMinute: MAX_REQUESTS_PER_MINUTE, timeoutMs: REQUEST_TIMEOUT_MS, failuresBeforeFallback: FAILURES_BEFORE_FALLBACK },
  }
}

/**
 * Forget a fallback, so the next call is tried again (the "test connection" button does this).
 */
export function resetCloudFallback() {
  cloudState.fallback = false
  cloudState.consecutiveFailures = 0
  cloudState.message = ''
}

/**
 * One guarded request: rate limited, timed out, retried once after a transient failure, and
 * never leaking a key.
 *
 * A 4xx answer is final: it is retried only by an explicit degradation path (see
 * `looksLikeFormatRejection`), because paying for the same refusal twice helps nobody. The
 * thrown error carries `status` and `detail` so a caller can tell "the provider refused the
 * request format" from "the provider is down" without parsing the message.
 * @param url - target.
 * @param options - fetch options.
 * @param label - what to call this request in messages.
 * @param timeoutMs - per-attempt deadline. A cue needs seconds; writing a whole meeting's
 *   minutes with a small model measured 40 s against the real service (2026-11-23), so the
 *   caller decides instead of one constant deciding for every operation.
 * @returns the response.
 */
export async function guardedFetch(url, options, label, timeoutMs = REQUEST_TIMEOUT_MS) {
  const now = Date.now()
  cloudState.recent = cloudState.recent.filter((at) => now - at < 60_000)
  if (cloudState.recent.length >= MAX_REQUESTS_PER_MINUTE) {
    throw new Error(redact(`${label}：请求过于频繁（每分钟上限 ${MAX_REQUESTS_PER_MINUTE} 次），已暂停`))
  }
  cloudState.recent.push(now)
  let lastError = ''
  let lastStatus = 0
  let lastDetail = ''
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
      if (response.status >= 500 && attempt === 0) {
        lastStatus = response.status
        lastError = `HTTP ${response.status}`
        continue
      }
      if (!response.ok) {
        // The body may explain itself; it is still redacted before anyone sees it.
        const detail = await response.text().catch(() => '')
        lastStatus = response.status
        lastDetail = detail
        const error = new Error(redact(`${label}：HTTP ${response.status}${detail === '' ? '' : ` ${detail.slice(0, 200)}`}`))
        error.status = response.status
        error.detail = detail.slice(0, 2000)
        // A deterministic refusal will say the same thing again; do not spend a second request.
        error.final = true
        throw error
      }
      cloudState.consecutiveFailures = 0
      cloudState.fallback = false
      cloudState.message = ''
      return response
    } catch (failure) {
      lastError = failure instanceof Error ? failure.message : String(failure)
      if (failure?.name === 'TimeoutError' || /aborted|timeout/iu.test(lastError)) lastError = `${label}：超时（${timeoutMs / 1000} 秒）`
      if (failure?.final === true || attempt === 1) break
    }
  }
  cloudState.consecutiveFailures += 1
  // Strict mode reports every failure instead of going quiet: a person who picked
  // "cloud only" asked for cloud text, not for the local model's text without being told.
  if (cloudState.mode !== 'cloud-only' && cloudState.consecutiveFailures >= FAILURES_BEFORE_FALLBACK) {
    cloudState.fallback = true
    cloudState.message = redact(`云端连续 ${cloudState.consecutiveFailures} 次失败，已回退到本机识别：${lastError}`)
  }
  const error = new Error(redact(lastError))
  if (lastStatus !== 0) error.status = lastStatus
  if (lastDetail !== '') {
    error.detail = lastDetail.slice(0, 2000)
    error.final = true
  }
  throw error
}

/**
 * Wrap raw PCM16 in a WAV container, which is what every transcription endpoint expects.
 * @param pcm - mono PCM16 little-endian bytes.
 * @param sampleRate - samples per second.
 * @returns the WAV bytes.
 */
export function wavOf(pcm, sampleRate) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * Transcribe one cue through the configured cloud service.
 *
 * Returns `{ skipped: true, reason }` when the gate is closed — and performs NO request in that
 * case, which is the promise the privacy switch makes.
 *
 * R3: the first request follows the cached capability (`verbose_json` only when the provider is
 * known to accept it, or when nothing has been measured yet). A provider that refuses the
 * field gets ONE retry without it — a failure-only path, so the successful request count stays
 * at one. The learned capability is written back so the next cue asks correctly the first time.
 *
 * R4: `segments[].speaker` is preserved verbatim; mapping it to S1/S2 belongs to the recording
 * chain, which owns the per-meeting numbering.
 *
 * @param input - `{ pcm, sampleRate, language, hotwords }`.
 * @returns `{ skipped }` or `{ text, segments, model, usage, degraded, capability }`.
 */
export async function cloudTranscribe(input) {
  const status = await cloudStatus('asr')
  if (!status.ok) return { skipped: true, reason: status.reason }
  const part = status.cloud.asr
  const wav = wavOf(input.pcm, input.sampleRate)
  const url = `${part.baseUrl.replace(/\/$/u, '')}/audio/transcriptions`
  const headers = part.apiKey === '' ? {} : { Authorization: `Bearer ${part.apiKey}` }
  const language = input.language !== undefined && input.language !== '' ? input.language : part.language
  const extras = {
    language,
    // A prompt carries the meeting's own vocabulary, which is how names survive transcription.
    prompt: typeof input.hotwords === 'string' ? input.hotwords : '',
  }
  let includeVerbose = part.capability === null || part.capability.supportsVerboseJson !== false
  let degraded = false
  let response
  try {
    response = await guardedFetch(url, {
      method: 'POST',
      headers,
      body: transcriptionForm(part, wav, includeVerbose, extras),
    }, '云端识别')
  } catch (failure) {
    if (!includeVerbose || !looksLikeFormatRejection(Number(failure?.status ?? 0), failure?.detail ?? failure?.message)) {
      throw failure
    }
    includeVerbose = false
    degraded = true
    response = await guardedFetch(url, {
      method: 'POST',
      headers,
      body: transcriptionForm(part, wav, false, extras),
    }, '云端识别')
  }
  const value = await response.json().catch(() => ({}))
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  if (text === '') throw new Error('云端识别返回了空文本')
  const segments = readCloudSegments(value)
  cloudState.lastModel = typeof value.model === 'string' ? value.model : part.model
  cloudState.lastAt = Date.now()
  let capability = part.capability
  if (degraded) {
    capability = {
      supportsVerboseJson: false,
      returnsSegments: part.capability?.returnsSegments === true,
      returnsSpeaker: part.capability?.returnsSpeaker === true,
      model: cloudState.lastModel,
      probedAt: Date.now(),
      evidence: redact('降级重试成功：服务端拒绝了 response_format=verbose_json').slice(0, 200),
    }
    // Best effort: a read-only home must not turn a successful recognition into a failure.
    await saveAsrCapability(capability).catch(() => undefined)
  }
  return {
    skipped: false,
    text,
    segments,
    model: cloudState.lastModel,
    usage: value.duration === undefined ? {} : { audioSeconds: Number(value.duration) },
    degraded,
    capability,
  }
}

/**
 * Ask the configured service for one speaker vector.
 *
 * The contract is documented rather than guessed: POST the WAV, answer
 * `{ vector: number[], model?: string }`.
 *
 * @param input - `{ pcm, sampleRate }`.
 * @returns `{ skipped }` or `{ vector, model }`.
 */
export async function cloudEmbed(input) {
  const status = await cloudStatus('speaker')
  if (!status.ok) return { skipped: true, reason: status.reason }
  const part = status.cloud.speaker
  const wav = wavOf(input.pcm, input.sampleRate)
  const response = await guardedFetch(`${part.baseUrl.replace(/\/$/u, '')}/speaker/embedding`, {
    method: 'POST',
    headers: {
      'Content-Type': 'audio/wav',
      ...(part.apiKey === '' ? {} : { Authorization: `Bearer ${part.apiKey}` }),
    },
    body: wav,
  }, '云端声纹')
  const value = await response.json().catch(() => ({}))
  const vector = Array.isArray(value.vector) ? value.vector.map(Number).filter((item) => Number.isFinite(item)) : []
  if (vector.length === 0) throw new Error('云端声纹返回了空向量')
  return { skipped: false, vector, model: typeof value.model === 'string' ? value.model : part.model }
}

/**
 * Generate Markdown minutes with the configured cloud LLM (OpenAI-compatible chat completions).
 *
 * Failures are returned, not thrown: the caller keeps the on-machine minutes and shows the
 * reason beside them, so a broken LLM never costs the document a person asked for.
 * @param chatMessages - `[{ role, content }]` messages.
 * @returns `{ ok, skipped, text, model, reason }`.
 */
export async function cloudLlmComplete(chatMessages, options = {}) {
  const status = await cloudStatus('llm')
  if (!status.ok) return { ok: false, skipped: true, text: '', model: '', reason: status.reason }
  const part = status.cloud.llm
  const url = `${part.baseUrl.replace(/\/$/u, '')}/chat/completions`
  const headers = {
    'Content-Type': 'application/json',
    ...(part.apiKey === '' ? {} : { Authorization: `Bearer ${part.apiKey}` }),
  }
  // Writing minutes is a long generation, not a cue: one real request against
  // SiliconFlow/Qwen3-8B took 40 s end to end, which the cue-sized 20 s deadline would
  // always cut off. The caller passes how long it is willing to wait.
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 120_000
  try {
    const response = await guardedFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: part.model, messages: chatMessages, temperature: part.temperature, max_tokens: 2048 }),
    }, '云端纪要', timeoutMs)
    const value = await response.json().catch(() => ({}))
    const content = typeof value?.choices?.[0]?.message?.content === 'string' ? value.choices[0].message.content.trim() : ''
    if (content === '') throw new Error('云端纪要返回了空文本')
    cloudState.lastModel = typeof value.model === 'string' ? value.model : part.model
    cloudState.lastAt = Date.now()
    return { ok: true, skipped: false, text: content, model: cloudState.lastModel, reason: '' }
  } catch (failure) {
    return {
      ok: false,
      skipped: false,
      text: '',
      model: part.model,
      reason: redact(failure instanceof Error ? failure.message : String(failure)),
    }
  }
}

/**
 * Probe the configured speaker service, keeping the existing vector contract: POST the WAV and
 * expect `{ vector }`.
 * @returns `{ ok, verdict, reason, message }`.
 */
async function probeSpeaker() {
  const cloud = await readCloudSettings()
  const part = cloud.speaker
  if (part.provider === 'off' || part.baseUrl === '') {
    return { ok: false, verdict: '未配置', reason: '没有配置', message: '没有配置' }
  }
  if (cloud.mode === 'local' || cloud.consent !== true) {
    const reason = '还没有同意上传（未发起任何请求）'
    return { ok: false, verdict: '未启用', reason, message: reason }
  }
  try {
    // A twentieth of a second of silence is enough to prove the path works, and sends no speech.
    const answer = await cloudEmbed({ pcm: Buffer.alloc(1600), sampleRate: 16_000 })
    if (answer.skipped === true) {
      return { ok: false, verdict: '未启用', reason: answer.reason, message: answer.reason }
    }
    return { ok: true, verdict: '可用', reason: '', message: redact(`已连通（${answer.model === '' ? '声纹接口' : answer.model}）`) }
  } catch (failure) {
    const reason = redact(failure instanceof Error ? failure.message : String(failure)).slice(0, 200)
    return { ok: false, verdict: '不可用', reason, message: reason }
  }
}

/**
 * Try the configured services once, for the "test connection" button.
 *
 * This is the ONLY place a request is made just to learn something: the recognition path never
 * probes. Each capability is probed from a clean fallback state so one broken service does not
 * hide the state of the next.
 * @returns `{ asr, llm, speaker }` in the contract's per-kind shape (each also carries the old
 *   `ok`/`message` pair the current panel reads).
 */
export async function testCloud() {
  const results = {}
  resetCloudFallback()
  results.asr = await probeCloudAsr()
  resetCloudFallback()
  results.llm = await probeCloudLlm()
  resetCloudFallback()
  results.speaker = await probeSpeaker()
  resetCloudFallback()
  return results
}
