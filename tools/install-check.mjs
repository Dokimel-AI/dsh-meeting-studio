/**
 * 装完自检：确认 dsh-meeting-studio 真的被 profile 加载、宿主代码齐全、原生依赖可解析。
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉　邮箱：yangdaoquan@qq.com
 * Copyright (c) 博尔塔拉融媒体中心媒体传播与认知重点实验室
 *
 * Forked from dsh-meeting-room 0.1.0-preview.7 (MIT, © 博尔塔拉融媒体中心 · 杨道泉);
 * this file © dsh-meeting-studio contributors, MIT.
 *
 * 为什么需要它：装插件其实是两件事（`dsh.profile.bundles` 决定加载，`dependencies` 只是解析），
 * 而 pnpm 在 profile 里还会因为缺少 `allowBuilds` 而让 `add` 以 exit 1 结束、却仍打出一行
 * `+ dsh-meeting-studio`。只看安装日志无法判断到底成没成，这个脚本把四件事分开看。
 *
 * 用法（Node ≥ 20，零第三方依赖）：
 *   node tools/install-check.mjs                       # 默认 profile：desktop
 *   node tools/install-check.mjs --profile studio-x    # profile 名（在 $DSH_HOME/profiles 下）
 *   node tools/install-check.mjs --profile D:\path\to\profile
 *   node tools/install-check.mjs --help
 *
 * 退出码：0 = 没有阻断项（提醒不算）；1 = 有 FAIL，按每条的「修法」处理。
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-meeting-studio'
/** pnpm 11 在 profile 的 pnpm-workspace.yaml 里读 allowBuilds；不预置它，add 会 exit 1。 */
const BUILD_DEPENDENCY = 'onnxruntime-node'
/** 插件运行必须能解析的两个依赖。 */
const REQUIRED_MODULES = ['onnxruntime-node', 'pinyin-pro']
/** 可选依赖：缺了只有声纹受影响，能力自检会报红，不阻断安装。 */
const OPTIONAL_MODULES = ['sherpa-onnx-node']

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(here)

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    '用法：node tools/install-check.mjs [--profile <名字|路径>]',
    '',
    '  --profile <名字>   profile 名，等同 $DSH_HOME/profiles/<名字>（默认 desktop）',
    '  --profile <路径>   profile 目录本身（可写相对路径）',
    '  --help            显示这段说明',
    '',
    '环境变量（一般不需要）：',
    '  DSH_HOME             DSH 主目录（默认 ~/.dsh）',
    '  DSH_APP_ASAR         指定 DSH 的 app.asar；用于便携版/自定义安装位置',
    '  DSH_CLIENT_PACKAGES  逗号分隔的客户端包白名单，覆盖自动探测',
  ].join('\n'))
  process.exit(0)
}
let profileArgument = 'desktop'
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--profile') {
    profileArgument = argv[index + 1] ?? ''
    index += 1
  } else if (argv[index].startsWith('--profile=')) {
    profileArgument = argv[index].slice('--profile='.length)
  } else {
    console.error(`不认识的参数：${argv[index]}`)
    process.exit(2)
  }
}

/** The DSH home this installation uses; `$DSH_HOME` wins, exactly like the plugin's own code. */
const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')

/**
 * Resolve `--profile` to a directory. A value that looks like a path is taken as one; anything
 * else is a profile name under `$DSH_HOME/profiles`.
 * @param value - profile name or path from the command line.
 * @returns the absolute profile directory.
 */
function resolveProfile(value) {
  if (value === '') return join(dshHome, 'profiles', 'desktop')
  const looksLikePath = value.includes('/') || value.includes('\\') || value === '.' || value === '..'
  return looksLikePath ? resolve(value) : join(dshHome, 'profiles', value)
}

const profilePath = resolveProfile(profileArgument)

// ---------------------------------------------------------------------------
// 结果收集
// ---------------------------------------------------------------------------
const rows = []
const pass = (title, detail = '') => rows.push({ level: 'PASS', title, detail, fix: '' })
const fail = (title, fix, detail = '') => rows.push({ level: 'FAIL', title, detail, fix })
const warn = (title, detail = '', fix = '') => rows.push({ level: 'WARN', title, detail, fix })

/**
 * Whether one npm `files` pattern matches one flat file name. Same subset as smoke.mjs: `*`
 * inside a single path segment, everything else literal.
 * @param pattern - the pattern from package.json.
 * @param name - one file name.
 * @returns true when the pattern covers the name.
 */
function patternMatches(pattern, name) {
  const expression = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&').replace(/\*/gu, '[^/]*')
  return new RegExp(`^${expression}$`, 'u').test(name)
}

/** The files this package would ship, derived from its own manifest so the list cannot drift. */
function expectedShippedFiles() {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const expected = new Set(['package.json', 'index.js'])
  for (const name of readdirSync(packageRoot)) {
    if (!statSync(join(packageRoot, name)).isFile()) continue
    const covered = (manifest.files ?? []).some((pattern) => !pattern.includes('/') && patternMatches(pattern, name))
    if (covered) expected.add(name)
  }
  for (const pattern of manifest.files ?? []) {
    if (!pattern.includes('/')) continue
    const slash = pattern.indexOf('/')
    const directory = pattern.slice(0, slash)
    const inner = pattern.slice(slash + 1)
    if (!inner.includes('*')) {
      expected.add(pattern)
      continue
    }
    let entries = []
    try {
      entries = readdirSync(join(packageRoot, directory), { withFileTypes: true }).filter((entry) => entry.isFile())
    } catch {
      // A declared directory that is not here would already be a packaging problem; report the
      // missing file below rather than crashing the check.
      continue
    }
    for (const entry of entries) {
      if (patternMatches(inner, entry.name)) expected.add(`${directory}/${entry.name}`)
    }
  }
  return [...expected].sort()
}

/**
 * Parse the `allowBuilds:` mapping out of a pnpm-workspace.yaml without a YAML dependency.
 * Only the exact shape pnpm writes is needed: `allowBuilds:` followed by indented `pkg: true`.
 * @param text - the file contents.
 * @returns the mapping that was found (may be empty).
 */
function allowBuildsOf(text) {
  const entries = new Map()
  let inside = false
  for (const line of text.split(/\r?\n/u)) {
    if (/^allowBuilds:\s*(?:#.*)?$/u.test(line)) {
      inside = true
      continue
    }
    if (!inside) continue
    if (/^\S/u.test(line)) {
      inside = false
      continue
    }
    const match = /^\s+(['"]?)([^\s:'"]+)\1\s*:\s*(true|false)\s*(?:#.*)?$/u.exec(line)
    if (match !== null) entries.set(match[2], match[3] === 'true')
  }
  return entries
}

// ---------------------------------------------------------------------------
// 1. profile 本身
// ---------------------------------------------------------------------------
console.log(`${PACKAGE} 安装自检`)
console.log(`profile：${profilePath}`)
console.log('')

if (!existsSync(profilePath) || !statSync(profilePath).isDirectory()) {
  fail(`profile 目录不存在：${profilePath}`,
    `先让 DSH 初始化这个 profile（例如打开一次该 profile，或跑 dsh plugin --profile ${profileArgument} add ${PACKAGE}），再重跑本脚本。`)
  printResults()
  process.exit(1)
}
pass('profile 目录存在')

const profileManifestPath = join(profilePath, 'package.json')
let profileManifest = null
try {
  profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
  pass('profile 的 package.json 可读', profileManifestPath)
} catch (failure) {
  fail('profile 的 package.json 读不到或不是合法 JSON',
    `确认 ${profileManifestPath} 存在且 JSON 完整；坏的 profile 会让插件无法加载。`,
    failure instanceof Error ? failure.message : String(failure))
}

const dependencies = profileManifest !== null && typeof profileManifest === 'object' ? (profileManifest.dependencies ?? {}) : {}
const bundles = Array.isArray(profileManifest?.dsh?.profile?.bundles) ? profileManifest.dsh.profile.bundles : []
const dependencySpec = typeof dependencies[PACKAGE] === 'string' ? dependencies[PACKAGE] : ''
// A directory link installs the source tree without its transitive dependencies (债-20): it is
// a developer setup, not an installation. `node_modules/<pkg>` is a symlink for every pnpm
// install, so the dependency spec — not the symlink — says which kind this is.
const directorySpec = dependencySpec.startsWith('link:')
  || (dependencySpec.startsWith('file:') && !/\.(?:tgz|tar\.gz)$/u.test(dependencySpec))

// ---------------------------------------------------------------------------
// 2. 两件事：bundles 决定加载，dependencies 决定解析
// ---------------------------------------------------------------------------
if (profileManifest !== null) {
  if (bundles.includes(PACKAGE)) {
    pass('dsh.profile.bundles 里有本插件（决定它会被加载）')
  } else {
    fail('dsh.profile.bundles 里没有本插件：装上了也不会加载',
      `用 DSH 的安装入口重装（它会同时写 bundles）：dsh plugin --profile ${profileArgument} add ${PACKAGE}\n     或手工把 "${PACKAGE}" 加进 ${profileManifestPath} 的 dsh.profile.bundles 后重启 Harness。`)
  }
  if (dependencySpec !== '') {
    pass('dependencies 里有本插件', `${PACKAGE} = ${dependencySpec}`)
  } else {
    fail('dependencies 里没有本插件：bundles 里的名字找不到对应代码',
      `在 profile 目录执行 pnpm add ${PACKAGE}（或重跑 dsh plugin --profile ${profileArgument} add ${PACKAGE}）。`)
  }
}

// ---------------------------------------------------------------------------
// 3. pnpm 的 allowBuilds（2026-11-23 实测出的关键项）
// ---------------------------------------------------------------------------
const workspacePath = join(profilePath, 'pnpm-workspace.yaml')
const workspaceText = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : ''
const allowBuilds = allowBuildsOf(workspaceText)
const onlyBuiltDependencies = Array.isArray(profileManifest?.pnpm?.onlyBuiltDependencies) ? profileManifest.pnpm.onlyBuiltDependencies : []
/** The exact two lines pnpm 11 needs, indented so they read as one block inside the fix line. */
const allowSnippet = `allowBuilds:\n         ${BUILD_DEPENDENCY}: true`
/** Why the allowlist matters here: a link install still needs the transitive dependencies built. */
const afterAllowStep = directorySpec
  ? `然后 cd ${profilePath} && pnpm install（目录 link 安装的传递依赖靠这一步装）`
  : `然后 dsh plugin --profile ${profileArgument} add ${PACKAGE}`
if (allowBuilds.get(BUILD_DEPENDENCY) === true) {
  pass('pnpm-workspace.yaml 的 allowBuilds 允许构建 onnxruntime-node')
} else if (onlyBuiltDependencies.includes(BUILD_DEPENDENCY)) {
  fail('只在 package.json 的 pnpm.onlyBuiltDependencies 里允许构建（pnpm 11 不会读它）',
    `把这段加进 ${workspacePath}（缺文件就新建）：\n       ${allowSnippet}\n       ${afterAllowStep}`)
} else {
  fail('pnpm-workspace.yaml 没有预置 allowBuilds：pnpm 11 下 add 会 exit 1 且 bundles 不注册',
    `先写这段再安装（缺文件就新建 ${workspacePath}）：\n       ${allowSnippet}\n       ${afterAllowStep}`)
}

// ---------------------------------------------------------------------------
// 4. 装进 profile 的宿主代码是否齐全
// ---------------------------------------------------------------------------
const installedDir = join(profilePath, 'node_modules', PACKAGE)
if (!existsSync(installedDir)) {
  fail(`node_modules 里没有 ${PACKAGE}`,
    `在该 profile 里装依赖：cd ${profilePath} && pnpm install；或 dsh plugin --profile ${profileArgument} add ${PACKAGE}`)
  printResults()
  process.exit(1)
}
pass('node_modules 里有本插件', installedDir)

let installedManifest = null
try {
  installedManifest = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
  if (installedManifest.name === PACKAGE) {
    pass('装的是本插件', `${PACKAGE}@${installedManifest.version}`)
  } else {
    fail('装的包名不对：这不是本插件',
      `删掉 ${installedDir} 后重装 ${PACKAGE}。`, String(installedManifest.name))
  }
} catch (failure) {
  fail('装进来的 package.json 读不到',
    `重装本插件（装的可能是半个包）：dsh plugin --profile ${profileArgument} add ${PACKAGE}`,
    failure instanceof Error ? failure.message : String(failure))
}

const expected = expectedShippedFiles()
const missingFiles = expected.filter((name) => !existsSync(join(installedDir, name)))
if (missingFiles.length === 0) {
  pass(`宿主代码齐全（按发布清单核对 ${expected.length} 个文件）`)
} else {
  fail(`安装副本缺 ${missingFiles.length} 个文件（发布清单里的这些没装进来）`,
    `删掉 ${installedDir} 后重装；缺 host-*.js 时插件在加载期就会失败。`,
    missingFiles.slice(0, 8).join('、'))
}

// The historical bug: `files` listed only a few host-*.js, so the package imported modules that
// were never shipped. Walking the real relative imports catches it even if the list is wrong.
const unresolvedImports = []
for (const entry of readdirSync(installedDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue
  const text = readFileSync(join(installedDir, entry.name), 'utf8')
  for (const match of text.matchAll(/from\s+'(\.\/[^']+)'/gu)) {
    const target = match[1].slice(2)
    if (!existsSync(join(installedDir, target))) unresolvedImports.push(`${entry.name} → ${match[1]}`)
  }
}
if (unresolvedImports.length === 0) {
  pass('安装副本里的相对 import 都能落到文件上')
} else {
  fail('安装副本里有 import 指向不存在的文件',
    '这份包装得不完整：删掉重装本插件。', unresolvedImports.slice(0, 8).join('、'))
}

// ---------------------------------------------------------------------------
// 5. dsh.client.inject：每个名字都必须真的在这套 DSH 的 Web 壳里
// ---------------------------------------------------------------------------
// A client plugin is injected only when EVERY `dsh.client.inject` name resolves to a client
// package the running shell knows. One stale name (removed upstream, never existed in this
// release) makes DSH skip the WHOLE client half silently: the plugin still appears as enabled
// in the installed list, its name and description look right, and no tab, button or panel ever
// appears. That failure has no log line a user would find, so it is checked here.

/**
 * Read an Electron app.asar without Electron: its header lists every packaged file, which is
 * enough both to enumerate client packages and to read one package.json.
 * @param asarPath - the archive path.
 * @returns `{ readFile, clientNames }`, or null when the archive cannot be read.
 */
function readAsar(asarPath) {
  let handle = null
  try {
    handle = openSync(asarPath, 'r')
    const head = Buffer.alloc(16)
    readSync(handle, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(12)
    if (headerSize <= 0 || headerSize > 64 * 1024 * 1024) return null
    const headerBytes = Buffer.alloc(headerSize)
    readSync(handle, headerBytes, 0, headerSize, 16)
    const root = JSON.parse(headerBytes.toString('utf8'))
    const dataStart = 8 + head.readUInt32LE(4)
    const readFile = (internalPath) => {
      let node = root
      for (const part of internalPath.split('/')) {
        if (node === null || typeof node !== 'object' || node.files === undefined) return null
        node = node.files[part]
      }
      if (node === undefined || typeof node.size !== 'number' || typeof node.offset !== 'string') return null
      const bytes = Buffer.alloc(node.size)
      readSync(handle, bytes, 0, node.size, dataStart + Number(node.offset))
      return bytes.toString('utf8')
    }
    const clientNames = new Set()
    const walk = (node, depth) => {
      if (node === null || typeof node !== 'object' || node.files === undefined || depth > 24) return
      for (const [name, child] of Object.entries(node.files)) {
        if (name.startsWith('dsh-client-') && child !== null && typeof child === 'object' && child.files !== undefined) {
          clientNames.add(`@deepseek-ai/${name}`)
        }
        walk(child, depth + 1)
      }
    }
    walk(root, 0)
    return { readFile, clientNames }
  } catch {
    return null
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle)
      } catch {
        // Read-only handle; nothing to recover.
      }
    }
  }
}

/**
 * Where the running DSH application keeps its archive. `$DSH_APP_ASAR` wins so a portable or
 * custom install can be pointed at explicitly.
 * @returns the candidate paths that exist.
 */
function appAsarCandidates() {
  const candidates = []
  if (typeof process.env.DSH_APP_ASAR === 'string' && process.env.DSH_APP_ASAR !== '') candidates.push(process.env.DSH_APP_ASAR)
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (base) candidates.push(join(base, 'DeepSeek Harness', 'resources', 'app.asar'))
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')
  } else {
    candidates.push('/opt/deepseek-harness/resources/app.asar', '/opt/DeepSeek Harness/resources/app.asar')
  }
  return candidates.filter((candidate) => candidate !== '' && existsSync(candidate))
}

/**
 * The `@deepseek-ai/dsh-web-app` manifest of the profile, hoisted or inside pnpm's store.
 * @returns the package.json path, or '' when this profile does not carry the web bundle.
 */
function webAppManifestPath() {
  const direct = join(profilePath, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json')
  if (existsSync(direct)) return direct
  const store = join(profilePath, 'node_modules', '.pnpm')
  if (!existsSync(store)) return ''
  try {
    for (const entry of readdirSync(store)) {
      if (!entry.startsWith('@deepseek-ai+dsh-web-app@')) continue
      const candidate = join(store, entry, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json')
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // Treat an unreadable store as "not available"; the caller reports the skip.
  }
  return ''
}

const injectNames = Array.isArray(installedManifest?.dsh?.client?.inject)
  ? installedManifest.dsh.client.inject.filter((name) => typeof name === 'string' && name !== '')
  : []
if (injectNames.length === 0) {
  pass('dsh.client.inject 为空（不依赖其它客户端包）')
} else {
  // What the running shell ships: the web bundle's own client dependencies. An explicit
  // `DSH_CLIENT_PACKAGES` override exists for CI and for unusual installations.
  const override = (process.env.DSH_CLIENT_PACKAGES ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '')
  const asar = process.env.DSH_APP_ASAR !== undefined
    ? readAsar(process.env.DSH_APP_ASAR)
    : appAsarCandidates().map((candidate) => readAsar(candidate)).find((value) => value !== null) ?? null
  const shellNames = new Set(override)
  let shellSource = override.length > 0 ? 'DSH_CLIENT_PACKAGES' : ''
  if (shellNames.size === 0) {
    const manifestPath = webAppManifestPath()
    if (manifestPath !== '') {
      try {
        const webApp = JSON.parse(readFileSync(manifestPath, 'utf8'))
        for (const name of Object.keys(webApp.dependencies ?? {})) {
          if (name.startsWith('@deepseek-ai/dsh-client-')) shellNames.add(name)
        }
        shellSource = manifestPath
      } catch {
        // Leave the set empty; reported as skipped below.
      }
    }
  }
  const installedClientNames = new Set(asar === null ? [] : asar.clientNames)
  if (shellNames.size === 0 && installedClientNames.size > 0) {
    // No web bundle to read, but the archive still lists what this release ships.
    for (const name of installedClientNames) shellNames.add(name)
    shellSource = 'DSH 安装目录里的客户端包清单（app.asar）'
  }
  if (shellNames.size === 0) {
    warn('无法定位这套 DSH 的客户端包清单，跳过 dsh.client.inject 校验',
      '既没有可读的 app.asar，profile 里也没有 @deepseek-ai/dsh-web-app',
      '在插件页确认「模型中心」页签是否出现；或用环境变量 DSH_APP_ASAR=<app.asar 路径> 指定安装位置后重跑。')
  } else {
    // A name that is present in the installation at all but absent from the web composition is
    // suspicious rather than fatal: another loaded bundle may provide it.
    const missing = injectNames.filter((name) => !shellNames.has(name))
    const fatal = missing.filter((name) => !installedClientNames.has(name))
    const suspicious = missing.filter((name) => installedClientNames.has(name))
    if (fatal.length === 0 && suspicious.length === 0) {
      pass(`dsh.client.inject 的 ${injectNames.length} 个客户端包都在壳里`, shellSource)
    }
    if (fatal.length > 0) {
      fail(`dsh.client.inject 里有 ${fatal.length} 个名字这套 DSH 根本没有：${fatal.join('、')}`,
        '从 package.json 的 dsh.client.inject 删掉这些名字（或换到声明了它们的 DSH 版本）后重新打包安装。'
        + '\n       后果：只要有一个名字对不上，整包客户端就会被注入门禁跳过——插件在「已安装插件」里显示已启用、'
        + '\n       名字描述都对，但左栏没有「会议管理」、会话头也没有「打开会议」，而且没有任何报错。',
        `清单来源：${shellSource}`)
    }
    if (suspicious.length > 0) {
      warn(`dsh.client.inject 里有 ${suspicious.length} 个名字不在 Web 壳的客户端组合里：${suspicious.join('、')}`,
        `这些包这套 DSH 里存在，但不在 ${shellSource} 的 Web 组合里；若插件页正常就无需处理`,
        '如果界面不出现，从 inject 里删掉这些名字后重新安装。')
    }
  }
}

// ---------------------------------------------------------------------------
// 6. 依赖是否可解析（从安装副本的 realpath 解析）
// ---------------------------------------------------------------------------
// Under pnpm's .pnpm layout the profile-level directory is a symlink; resolving dependencies
// from the symlink's own path finds nothing, which is why realpath comes first.
let requireFromInstalled = null
try {
  const realInstalled = realpathSync(installedDir)
  requireFromInstalled = createRequire(join(realInstalled, 'package.json'))
} catch (failure) {
  fail('无法从安装副本构造依赖解析器',
    '检查 node_modules 是否损坏，然后重装本插件。', failure instanceof Error ? failure.message : String(failure))
}

/**
 * Resolve one module the way the plugin does at runtime.
 * @param name - bare module specifier.
 * @returns `{ ok, path, reason }`.
 */
function resolveModule(name) {
  if (requireFromInstalled === null) return { ok: false, path: '', reason: '解析器不可用' }
  try {
    return { ok: true, path: requireFromInstalled.resolve(name), reason: '' }
  } catch (failure) {
    return { ok: false, path: '', reason: failure instanceof Error ? failure.message : String(failure) }
  }
}

for (const name of REQUIRED_MODULES) {
  const resolved = resolveModule(name)
  if (resolved.ok) {
    pass(`依赖可解析：${name}`, resolved.path)
  } else {
    fail(`依赖解析不到：${name}`,
      `在 profile 目录执行 pnpm install（缺原生包时先按上面 allowBuilds 那条修好再装）。`, resolved.reason.split(/\r?\n/u)[0])
  }
}
for (const name of OPTIONAL_MODULES) {
  const resolved = resolveModule(name)
  if (resolved.ok) {
    pass(`可选依赖可解析：${name}（声纹可用）`, resolved.path)
  } else {
    warn(`可选依赖没装上：${name}（只有声纹分离受影响，录音与转写不受影响）`,
      resolved.reason.split(/\r?\n/u)[0].slice(0, 160),
      `想在本地做声纹就装它：cd ${profilePath} && pnpm add ${name}@1.13.8；不装也能用，能力自检的「声纹」一行会如实报红。`)
  }
}

// The link-install notice belongs after the dependency verdicts: it explains why they failed.
if (directorySpec) {
  warn('这是目录 link 安装：开发用，不会装传递依赖（债-20）',
    dependencySpec === '' ? '' : `dependencies 里写的是 ${dependencySpec}`,
    '正式安装请打包后再装（见 README「安装」四步：预置 allowBuilds → pack tgz → add → install-check）。')
}

printResults()
process.exit(rows.some((row) => row.level === 'FAIL') ? 1 : 0)

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
/** Print every row, then the next steps; FAIL rows carry their own fix. */
function printResults() {
  console.log('')
  for (const row of rows) {
    console.log(`[${row.level}] ${row.title}`)
    if (row.detail !== '') console.log(`       ${row.detail}`)
    if (row.level === 'FAIL' && row.fix !== '') console.log(`       修法：${row.fix}`)
    if (row.level === 'WARN' && row.fix !== '') console.log(`       提醒：${row.fix}`)
  }
  const failures = rows.filter((row) => row.level === 'FAIL')
  const warnings = rows.filter((row) => row.level === 'WARN')
  console.log('')
  if (failures.length === 0) {
    console.log(`结果：通过（${rows.length - failures.length} 项 PASS，${warnings.length} 项提醒）`)
    console.log('')
    console.log('接下来：')
    console.log('  1) 重启 DeepSeek Harness —— 宿主半边每个进程只加载一次，不重启等于没装。')
    console.log('  2) 打开左侧「会议管理 → 模型中心」，先看顶部「能力自检」：红的按提示修，黄的按需。')
    console.log('  3) 想复查安装状态，随时重跑：')
    console.log(`     node "${join(installedDir, 'tools', 'install-check.mjs')}" --profile "${profilePath}"`)
    console.log('  4) 要卸载：node tools/uninstall.mjs（默认 dry-run，只列将删项）。')
  } else {
    console.log(`结果：${failures.length} 项未通过，${warnings.length} 项提醒`)
    console.log('')
    console.log('按上面每条的「修法」处理，然后重跑本脚本；没有修好的项不要重启 Harness 去试插件。')
  }
}
