/**
 * Load the built DSH client bundle exactly as `dsh-client-modules` does:
 * evaluate the script, take the registered `{id, factory}`, and run the factory
 * with a CJS `require`. Verifies the wrapper, exports and a browserless `apply`.
 *
 * The plugin contributes three slots: the status line in the conversation dock
 * plus two settings sections (board time and firmware flashing). Anything else is
 * treated as an unexpected contribution and fails the test.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/* The bundle must still ship these contracts, not just the slot registrations. */
for (const needle of [
  'settings.section',
  'airremote-time',
  'airremote-firmware',
  '/airremote/sync-time',
  '/airremote/firmware/manifest'
]) {
  assert.ok(source.includes(needle), `client bundle mentions ${needle}`)
}

let registration
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(value) {
        registration = value
      }
    }
  },
  Symbol,
  Object,
  console
}
vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })

assert.ok(registration, 'client bundle registered a module')
assert.equal(registration.id, 'dsh-airremote')
assert.equal(typeof registration.factory, 'function')

const exports = registration.factory((name) => require(name))
assert.equal(typeof exports.apply, 'function')
assert.equal(exports.inject.length, 1)
assert.equal(exports.inject[0], 'slots')

/* Every contribution the plugin is allowed to make: `${slot}:${id}` -> slot. */
const expectations = new Map([
  ['conversation.input.dock:dsh-airremote-status', 'conversation.input.dock'],
  ['settings.section:airremote-time', 'settings.section'],
  ['settings.section:airremote-firmware', 'settings.section']
])
const allowedSlots = new Set(expectations.values())
const registered = []

let effectRegistered = false
const ctx = {
  effect(body) {
    effectRegistered = true
    const disposer = body()
    assert.equal(typeof disposer, 'function')
    disposer()
  },
  slots: {
    inject(name, callback) {
      assert.ok(allowedSlots.has(name), `unexpected slot injected: ${name}`)
      callback()
    },
    register(options) {
      const key = `${options.name}:${options.id}`
      assert.ok(expectations.has(key), `unexpected slot registration: ${key}`)
      registered.push(key)
      return () => undefined
    }
  }
}
await exports.apply(ctx)
assert.equal(effectRegistered, true)
assert.deepEqual(registered.sort(), [...expectations.keys()].sort())
console.log(
  'ok  built client bundle registers and applies (id=dsh-airremote, dock status + board time + firmware flash)'
)
