#!/usr/bin/env node
/**
 * 开发期手动脚本：把 `firmware/build/` 里的分段镜像合成一个「从 0x0 整体烧写」的 bin，
 * 拷进插件包 `firmware/`，并重写 `firmware/manifest.json`。
 *
 * 只在开发机上跑一次；插件运行时**绝不**调用本脚本、也绝不调用 idf.py / esptool / python
 * （host 只把 `firmware/` 当静态文件流式下发，浏览器端用 Web Serial 自己烧）。
 *
 * 用法（仓库根或任意目录均可）：
 *   node plugins/dsh-airremote/scripts/bundle-firmware.mjs
 *   node plugins/dsh-airremote/scripts/bundle-firmware.mjs --version 0.3.0
 *
 * 环境变量：
 *   AIRREMOTE_REPO_ROOT         仓库根（默认由脚本位置推出）
 *   AIRREMOTE_FIRMWARE_VERSION  固件语义版本（默认 0.3.0）
 *
 * 合并来源与偏移以 `firmware/build/flash_args` 为准（当前：bootloader 0x0、
 * partition-table 0x8000、ota_data 0x10d000、app 0x200000）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_VERSION = '0.3.0'
const DEFAULT_CHIP = 'esp32c6'
const MERGED_NAME = 'codex_air_remote-merged.bin'
const MANIFEST_NAME = 'manifest.json'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(scriptDir, '..')
const repoRoot = process.env.AIRREMOTE_REPO_ROOT?.trim() || resolve(pluginRoot, '..', '..')
const firmwareProject = join(repoRoot, 'firmware')
const buildDir = join(firmwareProject, 'build')
const flashArgsPath = join(buildDir, 'flash_args')
const targetDir = join(pluginRoot, 'firmware')
const targetPath = join(targetDir, MERGED_NAME)
const manifestPath = join(targetDir, MANIFEST_NAME)
const activateScript = join(repoRoot, 'env', 'activate.ps1')

function fail(message) {
  console.error(`[bundle-firmware] 失败：${message}`)
  process.exit(1)
}

function info(message) {
  console.log(`[bundle-firmware] ${message}`)
}

/** 命令行参数：`--version <semver>`。 */
function readVersionArg() {
  const index = process.argv.indexOf('--version')
  const fromArg = index >= 0 ? (process.argv[index + 1] ?? '').trim() : ''
  const fromEnv = (process.env.AIRREMOTE_FIRMWARE_VERSION ?? '').trim()
  return fromArg !== '' ? fromArg : fromEnv !== '' ? fromEnv : DEFAULT_VERSION
}

/** 跑一条 PowerShell，返回 stdout（`idf` 是 activate.ps1 里的函数，只能在那个会话里用）。 */
function runPowerShell(script, options = {}) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
  return execFileSync(
    shell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      cwd: options.cwd ?? repoRoot,
      encoding: 'utf8',
      stdio: options.inherit === true ? 'inherit' : 'pipe',
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeoutMs ?? 15 * 60 * 1000
    }
  )
}

/** `@flash_args` 里声明的偏移与文件，用来汇报「合并了哪些偏移」。 */
function readFlashArgs() {
  if (!existsSync(flashArgsPath)) return { flags: [], parts: [] }
  const tokens = readFileSync(flashArgsPath, 'utf8').split(/\s+/).filter((token) => token !== '')
  const parts = []
  const flags = []
  let offset = ''
  for (const token of tokens) {
    if (/^0x[0-9a-f]+$/i.test(token)) {
      offset = token
      continue
    }
    if (offset !== '') {
      parts.push({ offset, file: token })
      offset = ''
      continue
    }
    flags.push(token)
  }
  return { flags, parts }
}

function newestMergedCandidate() {
  const candidates = readdirSync(buildDir)
    .filter((name) => /merged.*\.bin$/i.test(name))
    .map((name) => {
      const full = join(buildDir, name)
      return { name, full, mtimeMs: statSync(full).mtimeMs, size: statSync(full).size }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0]
}

function main() {
  const version = readVersionArg()
  const appBin = join(buildDir, 'codex_air_remote.bin')

  if (!existsSync(firmwareProject)) fail(`找不到固件工程：${firmwareProject}`)
  if (!existsSync(buildDir)) fail(`找不到 firmware/build，请先构建固件：${buildDir}`)
  if (!existsSync(appBin)) fail(`找不到 app 镜像：${appBin}（先跑一次 idf -C firmware build）`)

  const flashArgs = readFlashArgs()
  const appSize = statSync(appBin).size
  info(`固件工程：${firmwareProject}`)
  info(`flash_args 偏移：${flashArgs.parts.map((part) => `${part.offset} ${part.file}`).join(', ') || '（未找到 flash_args）'}`)

  /* 1) 优先用 IDF 自己的 merge-bin；失败再退回 esptool merge_bin ------------------ */
  let merged
  if (existsSync(activateScript)) {
    info('执行 idf -C firmware merge-bin（激活 env/activate.ps1）...')
    try {
      runPowerShell(
        `. '${activateScript}' | Out-Null; idf -C '${firmwareProject}' merge-bin; ` +
          'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 0 }',
        { inherit: true }
      )
    } catch (error) {
      info(`idf merge-bin 失败（${error instanceof Error ? error.message : String(error)}），退回 esptool merge_bin`)
    }
    merged = newestMergedCandidate()
  }

  if (merged === undefined) {
    if (flashArgs.parts.length === 0) fail('既没有合并产物，也没有 flash_args，无法合并')
    info('执行 python -m esptool merge_bin（全局地址，@flash_args）...')
    runPowerShell(
      `. '${activateScript}' | Out-Null; ` +
        `python -m esptool --chip ${DEFAULT_CHIP} merge_bin -o '${join(buildDir, MERGED_NAME)}' -f raw @flash_args; ` +
        'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 0 }',
      { cwd: buildDir, inherit: true }
    )
    merged = newestMergedCandidate()
    if (merged === undefined) fail(`esptool 没有产出合并镜像，检查 ${buildDir}`)
  }

  info(`IDF 产出：${merged.full}（${merged.size} 字节）`)

  /* 2) 断言 merged > app，然后拷进插件包 ---------------------------------------- */
  if (merged.size <= appSize) {
    fail(`合并镜像 ${merged.size} 字节不大于 app 镜像 ${appSize} 字节，合并结果不对`)
  }
  mkdirSync(targetDir, { recursive: true })
  copyFileSync(merged.full, targetPath)
  const copiedSize = statSync(targetPath).size
  if (copiedSize !== merged.size) fail(`拷贝后大小不一致：${copiedSize} != ${merged.size}`)

  /* 3) 写 manifest.json --------------------------------------------------------- */
  const sha256 = createHash('sha256').update(readFileSync(targetPath)).digest('hex')
  let commit = ''
  try {
    commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    info('取不到 git 短 hash，manifest.commit 留空')
  }

  const manifest = {
    plugin: 'dsh-airremote',
    chip: DEFAULT_CHIP,
    version,
    commit,
    flashOffset: 0,
    size: copiedSize,
    sha256,
    builtAt: new Date().toISOString()
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  info(`已写入：${targetPath}`)
  info(`已写入：${manifestPath}`)
  console.log(JSON.stringify(manifest, null, 2))
  info(`合并偏移：${flashArgs.parts.map((part) => `${part.offset} <- ${part.file}`).join(' | ')}`)
}

main()
