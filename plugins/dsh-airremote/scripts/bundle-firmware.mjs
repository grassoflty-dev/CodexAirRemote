#!/usr/bin/env node
/** 开发机打包工具。合并镜像只作分段烧录的数据容器，禁止从 0x0 整片写入。 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(process.env.AIRREMOTE_REPO_ROOT?.trim() || resolve(pluginRoot, '..', '..'))
const buildDir = join(repoRoot, 'firmware', 'build')
const targetDir = join(pluginRoot, 'firmware')
const imagePath = join(targetDir, 'codex_air_remote-merged.bin')
const manifestPath = join(targetDir, 'manifest.json')
const chip = 'esp32c6'
const plugin = 'dsh-airremote'
const layout = [
  { offset: 0, file: 'bootloader/bootloader.bin', limit: 0x8000 },
  { offset: 0x8000, file: 'partition_table/partition-table.bin', limit: 0x9000 },
  { offset: 0x10d000, file: 'ota_data_initial.bin', limit: 0x10f000 },
  { offset: 0x200000, file: 'codex_air_remote.bin', limit: 0xa00000 }
]
const nameOf = (file) => basename(file, '.bin')
const hex = (number) => `0x${number.toString(16)}`
const sha256 = (image) => createHash('sha256').update(image).digest('hex')
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim()

function requireThat(condition, message) {
  if (!condition) throw new Error(message)
}

function firmwareVersion(value) {
  requireThat(typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value),
    '请显式指定固件版本（--version X.Y.Z 或 AIRREMOTE_FIRMWARE_VERSION），不使用插件版本兜底')
  return value
}

function checkRegions(regions, imageSize) {
  requireThat(Array.isArray(regions) && regions.length === layout.length, '镜像必须恰好包含四个烧录段')
  for (const [i, { offset, file, limit }] of layout.entries()) {
    const region = regions[i]
    requireThat(region?.offset === offset && region.name === nameOf(file), `缺少预期镜像段 ${hex(offset)} ${file}`)
    requireThat(Number.isSafeInteger(region.size) && region.size > 0 &&
      offset + Math.ceil(region.size / 4096) * 4096 <= limit, `${file} 超出允许的擦除范围，拒绝打包`)
    requireThat(offset + region.size <= imageSize, `${file} 超出镜像大小`)
  }
}

function verifyApp(image, commit) {
  // ESP image header (24 B) + segment header (8 B) + esp_app_desc_t。
  requireThat(image.length >= 112 && image[0] === 0xe9 && image.readUInt16LE(12) === 13 &&
    image.readUInt32LE(32) === 0xabcd5432, '没有找到 ESP32-C6 应用描述符')
  const field = (offset) => image.toString('ascii', offset, offset + 32).split('\0')[0]
  const builtVersion = field(48)
  requireThat(field(80) === 'codex_air_remote', '应用镜像不是 codex_air_remote')
  requireThat(/^[a-z0-9_.-]+$/i.test(builtVersion) && !builtVersion.endsWith('-dirty'),
    `应用镜像来自未提交源码或版本无效（${builtVersion}）；请从干净提交重新构建`)
  // ESP-IDF 默认写入 git describe：裸短 SHA、精确 tag 或 tag-N-gSHA。
  const versionRef = /-\d+-g([a-f0-9]{7,40})$/i.exec(builtVersion)?.[1] ?? builtVersion
  requireThat(git('rev-parse', '--verify', `${versionRef}^{commit}`) === commit,
    `应用镜像来自 ${builtVersion}，与预期源码 ${commit.slice(0, 12)} 不符；请重新构建`)
  return builtVersion
}

function verifyBundle(manifest, image) {
  requireThat(manifest.plugin === plugin && manifest.chip === chip && manifest.flashOffset === 0, '固件清单目标不匹配')
  firmwareVersion(manifest.version)
  requireThat(image.length === manifest.size && sha256(image) === manifest.sha256, '合并镜像大小或 SHA-256 与清单不一致')
  checkRegions(manifest.regions, image.length)
  requireThat(/^[a-f0-9]{7,40}$/.test(manifest.commit), '清单缺少有效源码提交')
  const commit = git('rev-parse', '--verify', `${manifest.commit}^{commit}`)
  const app = manifest.regions.at(-1)
  return verifyApp(image.subarray(app.offset, app.offset + app.size), commit)
}

function merge(parts, output, flags) {
  // 下划线拼写同时兼容 ESP-IDF 5.5.5 环境中的 esptool 4.x 与 5.x。
  const args = ['-m', 'esptool', '--chip', chip, 'merge_bin', '-o', output, ...flags,
    ...parts.flatMap(({ offset, file }) => [hex(offset), file])]
  const options = { cwd: buildDir, stdio: 'inherit', timeout: 120_000 }
  if (process.platform === 'win32' && !process.env.IDF_PYTHON_ENV_PATH) {
    const activate = join(repoRoot, 'env', 'activate.ps1')
    requireThat(existsSync(activate), '请先激活 ESP-IDF 5.5.5（此处没有 env/activate.ps1）')
    const quote = (s) => `'${s.replaceAll("'", "''")}'`
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `. ${quote(activate)} | Out-Null; & python ${args.map(quote).join(' ')}; exit $LASTEXITCODE`], options)
  } else {
    const python = process.env.IDF_PYTHON_ENV_PATH
      ? join(process.env.IDF_PYTHON_ENV_PATH, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
      : 'python3'
    execFileSync(python, args, options)
  }
}

function main(args) {
  if (args.length === 1 && args[0] === '--check') {
    const manifest = json(manifestPath)
    const version = verifyBundle(manifest, readFileSync(imagePath))
    console.log(`[bundle-firmware] 校验通过：${manifest.version} / ${version} / ${manifest.size} B / ${manifest.sha256} / 4 段`)
    return
  }

  const print = args.includes('--print-version')
  const input = args.filter((arg) => arg !== '--print-version')
  requireThat(input.length === 0 || (input.length === 2 && input[0] === '--version'),
    '用法：bundle-firmware.mjs --version X.Y.Z [--print-version]，或 bundle-firmware.mjs --check')
  const version = firmwareVersion(input[1] ?? process.env.AIRREMOTE_FIRMWARE_VERSION?.trim())
  if (print) { console.log(version); return }

  requireThat(!git('status', '--porcelain', '--untracked-files=normal', '--', 'firmware'),
    'firmware/ 有未提交改动，拒绝打包，请先归档诊断补丁或提交正式源码')
  const commit = git('rev-parse', 'HEAD')
  const { flash_files: files, flash_settings: settings, extra_esptool_args: extra } = json(join(buildDir, 'flasher_args.json'))
  requireThat(extra?.chip === chip && settings?.flash_size === '16MB' &&
    Object.keys(files ?? {}).length === layout.length && layout.every(({ offset, file }) => files[hex(offset)] === file),
    'flasher_args 与 ESP32-C6 的固定四段布局不一致；检查构建目录，不会改动插件镜像')
  const parts = layout.map(({ offset, file }) => ({ offset, file, data: readFileSync(join(buildDir, file)) }))
  const regions = parts.map(({ offset, file, data }) => ({ offset, size: data.length, name: nameOf(file) }))
  const size = regions.at(-1).offset + regions.at(-1).size
  checkRegions(regions, size)
  verifyApp(parts.at(-1).data, commit)

  const tempDir = mkdtempSync(join(tmpdir(), 'airremote-firmware-'))
  try {
    const output = join(tempDir, basename(imagePath))
    merge(parts, output, ['--flash_mode', settings.flash_mode, '--flash_freq', settings.flash_freq, '--flash_size', settings.flash_size])
    const image = readFileSync(output)
    requireThat(image.length === size, '合并结果大小与分段不一致')
    // esptool 可以调整 bootloader header；其他段必须逐字节等于本次输入。
    for (const { offset, file, data } of parts.slice(1)) {
      requireThat(image.subarray(offset, offset + data.length).equals(data), `合并结果的 ${file} 与输入不一致`)
    }
    const manifest = { plugin, chip, version, commit, flashOffset: 0, size, sha256: sha256(image), builtAt: new Date().toISOString(), regions }
    verifyBundle(manifest, image)
    // 直到所有检查通过才更新插件产物；不搜索或复用旧的 merged*.bin。
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(imagePath, image)
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(JSON.stringify(manifest, null, 2))
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

try {
  main(process.argv.slice(2))
} catch (error) {
  console.error(`[bundle-firmware] ${error.message}`)
  process.exitCode = 1
}
