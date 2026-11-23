/**
 * 卸载 dsh-meeting-studio：默认 dry-run，只列将删项；--apply 才真的交给 DSH 的卸载入口。
 *
 * 本插件由博尔塔拉融媒体中心媒体传播与认知重点实验室制作。
 * 制作人：杨道泉　邮箱：yangdaoquan@qq.com
 * Copyright (c) 博尔塔拉融媒体中心媒体传播与认知重点实验室
 *
 * Forked from dsh-meeting-room 0.1.0-preview.7 (MIT, © 博尔塔拉融媒体中心 · 杨道泉);
 * this file © dsh-meeting-studio contributors, MIT.
 *
 * 卸载要清两处（装的时候也是两处）：`dsh.profile.bundles`（决定加载）与 `dependencies`
 * （决定解析）。只删一处会留下「列表里有、代码不在」或「代码在、不加载」的残局，所以先
 * 打印清单让人看清，再交给 `dsh plugin remove`；命令不可用或失败时给出手工步骤。
 *
 * 不碰用户数据：会议记录、录音、设置、模型、声纹库都在 $DSH_HOME 下，卸载插件不等于删数据。
 *
 * 用法（Node ≥ 20，零第三方依赖）：
 *   node tools/uninstall.mjs                          # dry-run，默认 profile：desktop
 *   node tools/uninstall.mjs --profile studio-x       # dry-run
 *   node tools/uninstall.mjs --profile studio-x --apply
 *   node tools/uninstall.mjs --help
 *
 * 退出码：dry-run 恒为 0；--apply 时两个清单项都清掉才算 0。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const PACKAGE = 'dsh-meeting-studio'
/** The build allowlist entry installing this plugin adds; only removed with explicit consent. */
const BUILD_DEPENDENCY = 'onnxruntime-node'

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    '用法：node tools/uninstall.mjs [--profile <名字|路径>] [--apply]',
    '',
    '  --profile <名字>   profile 名，等同 $DSH_HOME/profiles/<名字>（默认 desktop）',
    '  --profile <路径>   profile 目录本身（可写相对路径）',
    '  --apply            真的执行卸载（默认只 dry-run，列出将删项）',
    '  --dry-run          显式要求只列清单（默认行为）',
    '  --help             显示这段说明',
  ].join('\n'))
  process.exit(0)
}
let profileArgument = 'desktop'
let apply = false
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index]
  if (argument === '--profile') {
    profileArgument = argv[index + 1] ?? ''
    index += 1
  } else if (argument.startsWith('--profile=')) {
    profileArgument = argument.slice('--profile='.length)
  } else if (argument === '--apply') {
    apply = true
  } else if (argument === '--dry-run') {
    apply = false
  } else {
    console.error(`不认识的参数：${argument}`)
    process.exit(2)
  }
}

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
const profilesDirectory = join(dshHome, 'profiles')
/** The name `dsh plugin --profile` takes; only derivable when the profile lives where DSH keeps them. */
const profileName = dirname(profilePath) === profilesDirectory ? basename(profilePath) : ''

/**
 * Parse the `allowBuilds:` mapping out of pnpm-workspace.yaml (no YAML dependency needed).
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

/** Run one command line through the platform shell; a string keeps quoting in one place. */
function runShell(commandLine) {
  const windows = process.platform === 'win32'
  const shell = windows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh'
  const shellArgs = windows ? ['/d', '/s', '/c', commandLine] : ['-c', commandLine]
  return spawnSync(shell, shellArgs, { cwd: profilePath, encoding: 'utf8', windowsHide: true, timeout: 180_000 })
}

console.log(`${PACKAGE} 卸载（${apply ? '--apply：将真的执行' : 'dry-run：不会改动任何文件'}）`)
console.log(`profile：${profilePath}`)
console.log('')

const manifestPath = join(profilePath, 'package.json')
if (!existsSync(profilePath) || !statSync(profilePath).isDirectory() || !existsSync(manifestPath)) {
  console.error(`profile 不完整：找不到 ${manifestPath}`)
  console.error('先确认 --profile 指向正确的 profile 目录，再重跑本脚本。')
  process.exit(2)
}

let manifest = {}
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (failure) {
  console.error(`profile 的 package.json 不是合法 JSON：${failure instanceof Error ? failure.message : String(failure)}`)
  console.error('先修好这个文件（或从备份恢复），否则卸载会写到坏文件上。')
  process.exit(2)
}

const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
const dependencySpec = typeof manifest?.dependencies?.[PACKAGE] === 'string' ? manifest.dependencies[PACKAGE] : ''
const workspacePath = join(profilePath, 'pnpm-workspace.yaml')
const workspaceText = existsSync(workspacePath) ? readFileSync(workspacePath, 'utf8') : ''
const allowBuilds = allowBuildsOf(workspaceText)
const installedDir = join(profilePath, 'node_modules', PACKAGE)

// ---------------------------------------------------------------------------
// 将删项
// ---------------------------------------------------------------------------
const removals = []
if (bundles.includes(PACKAGE)) removals.push(`package.json → dsh.profile.bundles 里的 "${PACKAGE}"（这一项决定它被加载）`)
if (dependencySpec !== '') removals.push(`package.json → dependencies 里的 "${PACKAGE}" = ${dependencySpec}`)
// The build allowlist entry is reported, never edited: another plugin in the same profile may
// still need onnxruntime-node to be built.
const manualItems = []
if (allowBuilds.get(BUILD_DEPENDENCY) === true) {
  manualItems.push(`pnpm-workspace.yaml → allowBuilds.${BUILD_DEPENDENCY}（确认没有别的插件需要它构建后才删；脚本不动它）`)
}

if (removals.length === 0 && manualItems.length === 0) {
  console.log(`没有要删的项：这个 profile 里没有 ${PACKAGE}（可能已经卸过）。`)
  console.log('')
  console.log('用户数据仍然保留在 $DSH_HOME 下；需要清理请按 README「数据位置」一节手工处理。')
  process.exit(0)
}

if (removals.length > 0) {
  console.log('将删除：')
  for (const line of removals) console.log(`  - ${line}`)
  console.log('')
}
if (manualItems.length > 0) {
  console.log('需要你自己确认（脚本不会改它们）：')
  for (const line of manualItems) console.log(`  - ${line}`)
  console.log('')
}
if (removals.length === 0) {
  console.log('profile 清单里已经没有本插件，不需要执行卸载；上面那一项按你的判断手工处理即可。')
  process.exit(0)
}
console.log('将保留（这是用户数据，脚本不会碰）：')
const dataDirectories = [
  '$DSH_HOME/meeting-room/            会议记录、设置（含 webhooks.json 的云端配置）、能力自检报告、声纹库',
  '$DSH_HOME/meetings/                录音 WAV 与导出的 SRT / Markdown / Word',
  '$DSH_HOME/speech-to-text/speakers/ 发言人模型',
  '$DSH_HOME/handwriting/             手写识别模型',
  '插件目录本身                        卸载不会删除源码或安装副本目录里的用户改动',
]
for (const line of dataDirectories) console.log(`  - ${line}`)
console.log('')

if (!apply) {
  console.log('这是 dry-run，没有改动任何文件。要真的卸载：')
  console.log(`  node tools/uninstall.mjs --profile "${profileArgument}" --apply`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------
if (profileName === '') {
  console.error(`无法用 DSH 的卸载入口处理这个目录（不在 ${profilesDirectory} 下）。`)
  printManualSteps()
  process.exit(1)
}
// The DSH entry point locates a profile BY NAME. A name that needs shell quoting cannot be
// passed safely through the platform shell, so fall back to the manual steps instead of
// silently uninstalling the wrong profile.
if (!/^[A-Za-z0-9._-]+$/u.test(profileName)) {
  console.error(`profile 名 "${profileName}" 含空格或特殊字符，无法安全地按名字交给 DSH 的卸载入口。`)
  printManualSteps()
  process.exit(1)
}

const commandLine = `dsh plugin --profile ${profileName} remove ${PACKAGE}`
console.log(`执行：${commandLine}`)
const run = runShell(commandLine)
if (run.stdout !== '') console.log(run.stdout.trimEnd())
if (run.stderr !== '') console.error(run.stderr.trimEnd())
if (run.error !== undefined) {
  console.error(`命令没能启动：${run.error.message}`)
  printManualSteps()
  process.exit(1)
}

// Re-read instead of trusting the log: pnpm prints `+ package` even when the build step failed,
// and a removal that only half-applied is exactly the state this script exists to catch.
let after = {}
try {
  after = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (failure) {
  console.error(`卸载后 package.json 读不出来了：${failure instanceof Error ? failure.message : String(failure)}`)
  printManualSteps()
  process.exit(1)
}
const bundlesLeft = Array.isArray(after?.dsh?.profile?.bundles) && after.dsh.profile.bundles.includes(PACKAGE)
const dependencyLeft = typeof after?.dependencies?.[PACKAGE] === 'string'
const copyLeft = existsSync(installedDir)

console.log('')
if (!bundlesLeft && !dependencyLeft) {
  console.log(`结果：已卸载 ${PACKAGE}（bundles 与 dependencies 都不再有它）。`)
  if (copyLeft) console.log(`提醒：${installedDir} 还在，可手工删掉，不影响加载。`)
  if (allowBuilds.get(BUILD_DEPENDENCY) === true) {
    console.log(`提醒：pnpm-workspace.yaml 的 allowBuilds.${BUILD_DEPENDENCY} 保留着。确认没有别的插件需要它构建后可手工删那一行。`)
  }
  console.log('')
  console.log('重启 DeepSeek Harness 后生效（宿主半边每个进程只加载一次）。用户数据未删除。')
  process.exit(0)
}

console.log(`结果：还有没清掉的项（bundles=${bundlesLeft ? '仍在' : '已清'}，dependencies=${dependencyLeft ? '仍在' : '已清'}）。`)
printManualSteps()
process.exit(1)

/**
 * What to do when the DSH entry point cannot finish the job. Both lists matter: one decides
 * loading, the other decides whether the name resolves at all.
 */
function printManualSteps() {
  const steps = [
    `编辑 ${manifestPath}`,
    `    · 从 dsh.profile.bundles 里删掉 "${PACKAGE}"`,
    `    · 从 dependencies 里删掉 "${PACKAGE}"`,
    `在 profile 目录执行：cd "${profilePath}" && pnpm install`,
  ]
  if (allowBuilds.get(BUILD_DEPENDENCY) === true) {
    steps.push(`确认没有别的插件需要 ${BUILD_DEPENDENCY} 构建后，从 ${workspacePath} 的 allowBuilds 里删掉那一行`)
  }
  steps.push('重启 DeepSeek Harness 后生效；用户数据（会议记录、录音、设置、模型）不在删除范围内')
  console.log('')
  console.log('手工步骤（前两步都要做，缺一步会留下半装的残局）：')
  steps.forEach((step, index) => console.log(`  ${index + 1}) ${step}`))
}
