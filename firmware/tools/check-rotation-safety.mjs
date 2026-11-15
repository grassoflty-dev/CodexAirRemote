#!/usr/bin/env node
/**
 * 旋转安全静态检查：防止 2026-11-15 真机事故（设置页 overlay 打开时按 ROTATE →
 * LVGL 池只剩 ~1 KB → lv_draw_add_task Store access fault）的回退。
 *
 * 这里只做源码级断言（components 不在 npm 测试体系里）：
 *  1. settings_panel.c 必须“先隐藏 overlay”再发旋转请求，并在完成后恢复；
 *  2. BSP 必须在写 MADCTL 前检查 LVGL 内存（4096 / 2048 阈值）；
 *  3. BSP 必须有 flush 等待上限（200 ms）与“aborted”日志；
 *  4. BSP/面板必须成对恢复（restored / done 日志）；
 *  5. 旋转失败要有用户可见提示文案。
 *
 * 用法：node firmware/tools/check-rotation-safety.mjs
 * 退出码 0 = 通过；1 = 有回退或实现缺失（打印缺哪一条）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

const tests = []
const requireText = (label, text, needles) => {
  const missing = needles.filter((needle) => !text.includes(needle))
  tests.push({ label, ok: missing.length === 0, missing })
}

const panel = read('components/app_ui/settings_panel.c')
const bsp = read('components/bsp_board/lvgl_bsp.cpp')
const bspHeader = read('components/bsp_board/include/lvgl_bsp.h')

requireText('settings panel: hides overlay before requesting rotation', panel, [
  'panel_show(false)',
  'board_display_rotation_set(rotate_target)',
  'settings: rotation request %d (current %d), overlay hidden'
])
requireText('settings panel: restores overlay on success and failure', panel, [
  'settings_overlay_restore();',
  'settings: rotation: overlay restored',
  'settings: rotation skipped: lvgl memory too low',
  'settings: rotation aborted (no completion)'
])
requireText('settings panel: visible hints for skip/abort failures', panel, [
  '内存不足，请稍后重试',
  '显示忙，请重试',
  '旋转换向超时，请重试'
])
requireText('settings panel: drops overlay when LVGL pool is low', panel, [
  'settings_overlay_drop();',
  'settings: rotation: overlay dropped to reclaim lvgl'
])
requireText('bsp: LVGL memory gate before MADCTL', bsp, [
  'mon.free_size < 4096 || mon.free_biggest_size < 2048',
  'rotation skipped: lvgl memory too low free=%u biggest=%u'
])
requireText('bsp: flush wait bounded and abort logged', bsp, [
  '#define ROTATION_FLUSH_TIMEOUT_MS 200',
  'settings: rotation aborted (flush busy %u ms)'
])
requireText('bsp: MADCTL write failure rolls back to previous orientation', bsp, [
  'Set_Rotate((uint16_t)previous)',
  'rotation: MADCTL write failed, keeping %d deg'
])
requireText('bsp: one-shot rotation done callback exported', bspHeader, [
  'typedef void (*lvgl_rotation_done_cb_t)',
  'void Lvgl_SetRotationDoneCallback(lvgl_rotation_done_cb_t callback);'
])

let failed = 0
for (const test of tests) {
  if (test.ok) {
    console.log(`ok   ${test.label}`)
  } else {
    failed += 1
    console.log(`FAIL ${test.label}`)
    for (const missing of test.missing) console.log(`       missing: ${missing}`)
  }
}
if (failed > 0) {
  console.error(`\n${failed} rotation safety check(s) failed`)
  process.exit(1)
}
console.log('\nall rotation safety checks passed')
