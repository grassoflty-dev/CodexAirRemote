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
 *   node plugins/dsh-airremote/scripts/bundle-firmware.mjs --version 0.4.0
 *   node plugins/dsh-airremote/scripts/bundle-firmware.mjs --print-version   # 只打印解析结果，不生成镜像
 *
 * 环境变量：
 *   AIRREMOTE_REPO_ROOT         仓库根（默认由脚本位置推出）
 *   AIRREMOTE_FIRMWARE_VERSION  固件语义版本（覆盖 package.json 的 version）
 *
 * 版本号单一来源，优先级：--version > AIRREMOTE_FIRMWARE_VERSION >
 * plugins/dsh-airremote/package.json 的 `version`。三者都没有就报错退出。
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

const DEFAULT_CHIP = 'esp32c6'
const MERGED_NAME = 'codex_air_remote-merged.bin'
const MANIFEST_NAME = 'manifest.json'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(scriptDir, '..')
const packageJsonPath = join(pluginRoot, 'package.json')
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

/** 兜底来源：插件自身 package.json 的 `version`（脚本按自身位置推路径，不写死绝对路径）。 */
function versionFromPackageJson() {
  if (!existsSync(packageJsonPath)) {
    fail(`找不到插件 package.json：${packageJsonPath}；请用 --version <semver> 或环境变量 AIRREMOTE_FIRMWARE_VERSION 指定固件版本`)
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  } catch (error) {
    fail(
      `解析 package.json 失败：${packageJsonPath}（${error instanceof Error ? error.message : String(error)}）；` +
        '请用 --version <semver> 或环境变量 AIRREMOTE_FIRMWARE_VERSION 指定固件版本'
    )
  }
  const version = typeof parsed?.version === 'string' ? parsed.version.trim() : ''
  if (version === '') {
    fail(
      `package.json 里没有 version 字段：${packageJsonPath}；` +
        '请补上 version，或用 --version <semver> / 环境变量 AIRREMOTE_FIRMWARE_VERSION 指定固件版本'
    )
  }
  return version
}

/** 版本号单一来源：`--version <semver>` > `AIRREMOTE_FIRMWARE_VERSION` > package.json 的 version。 */
function readVersionArg() {
  const index = process.argv.indexOf('--version')
  if (index >= 0) {
    const fromArg = (process.argv[index + 1] ?? '').trim()
    if (fromArg === '') fail('--version 后面缺少版本号，例如：--version 0.4.0')
    return fromArg
  }
  const fromEnv = (process.env.AIRREMOTE_FIRMWARE_VERSION ?? '').trim()
  return fromEnv !== '' ? fromEnv : versionFromPackageJson()
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
  /* 只验证版本解析，不碰 build/ 与插件包里的镜像，便于本地单测这条逻辑。 */
  if (process.argv.includes('--print-version')) {
    console.log(version)
    return
  }
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
    /* esptool v5 no longer expands `@flash_args` (it only fits `write_flash`) and
     * renamed `-f` to `--format`. Rebuild the argument list explicitly: the
     * global flash flags plus one `offset file` pair per part. */
    const flashFlags = flashArgs.flags.length > 0
      ? flashArgs.flags
      : ['--flash_mode', 'dio', '--flash_freq', '80m', '--flash_size', '16MB']
    const partArgs = flashArgs.parts.map((part) => `${part.offset} ${part.file}`).join(' ')
    info('执行 python -m esptool merge_bin（显式参数，esptool v5 兼容）...')
    runPowerShell(
      `. '${activateScript}' | Out-Null; ` +
        `python -m esptool --chip ${DEFAULT_CHIP} merge_bin -o '${join(buildDir, MERGED_NAME)}' ` +
        `${flashFlags.join(' ')} ${partArgs}; ` +
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

  /* 分段烧写表：插件运行时按段写 bootloader / 分区表 / ota_data / app，
   * 不写 NVS（0x9000..0x107000），所以烧固件不会清掉配对/配网/时区。 */
  const regions = flashArgs.parts
    .map((part) => ({
      offset: Number.parseInt(part.offset, 16),
      size: statSync(join(buildDir, part.file)).size,
      name: part.file.split('/').pop().replace(/\.bin$/u, '')
    }))
    .sort((left, right) => left.offset - right.offset)
  for (const region of regions) {
    if (region.offset < 0x107000 && region.offset + region.size > 0x9000) {
      fail(`段 ${region.name} 覆盖 NVS 分区（0x9000..0x107000），拒绝打包`)
    }
  }

  const manifest = {
    plugin: 'dsh-airremote',
    chip: DEFAULT_CHIP,
    version,
    commit,
    flashOffset: 0,
    size: copiedSize,
    sha256,
    builtAt: new Date().toISOString(),
    regions
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  info(`已写入：${targetPath}`)
  info(`已写入：${manifestPath}`)
  console.log(JSON.stringify(manifest, null, 2))
  info(`合并偏移：${flashArgs.parts.map((part) => `${part.offset} <- ${part.file}`).join(' | ')}`)
}

main()
