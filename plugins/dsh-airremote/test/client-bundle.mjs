/**
 * Load the built DSH client bundle exactly as `dsh-client-modules` does:
 * evaluate the script, take the registered `{id, factory}`, and run the factory
 * with a CJS `require`. Verifies the wrapper, exports and a browserless `apply`.
 *
 * The plugin contributes three slots: the status line in the conversation dock,
 * one merged settings section ("Air remote": board time + firmware flashing) and
 * its rail icon. Anything else is treated as an unexpected contribution.
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
  'airremote',
  'settings.airremote',
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
assert.deepEqual([...exports.inject].sort(), ['locale', 'slots'])

/* Every contribution the plugin is allowed to make: `${slot}:${id}` -> slot. */
const expectations = new Map([
  ['conversation.input.dock:dsh-airremote-status', 'conversation.input.dock'],
  ['settings.section:airremote', 'settings.section'],
  ['settings.section.icon:airremote', 'settings.section.icon']
])
const allowedSlots = new Set(expectations.values())
const registered = []
const locales = new Map()

let effectRegistered = false
const disposers = []
const ctx = {
  effect(body) {
    effectRegistered = true
    const disposer = body()
    assert.equal(typeof disposer, 'function')
    disposers.push(disposer)
  },
  locale: {
    register(namespace, dictionaries) {
      locales.set(namespace, dictionaries)
      return () => locales.delete(namespace)
    },
    bind(namespace) {
      return (key) => {
        const dictionaries = locales.get(namespace)
        assert.ok(dictionaries, `unknown locale namespace ${namespace}`)
        return dictionaries.en?.[key] ?? key
      }
    }
  },
  slots: {
    inject(name, callback) {
      assert.ok(allowedSlots.has(name), `unexpected slot injected: ${name}`)
      callback()
    },
    register(options) {
      const key = `${options.name}:${options.id}`
      assert.ok(expectations.has(key), `unexpected slot registration: ${key}`)
      if (options.name === 'settings.section') {
        assert.equal(typeof options.label, 'function', 'settings section label must be a locale function')
        assert.equal(options.label(), 'Air remote (ESP32-C6)')
        assert.equal(options.locale, 'settings.airremote')
      }
      registered.push(key)
      return () => undefined
    }
  }
}
await exports.apply(ctx)
assert.equal(effectRegistered, true)
assert.deepEqual(registered.sort(), [...expectations.keys()].sort())
for (const dispose of disposers) dispose()
console.log(
  'ok  built client bundle registers and applies (id=dsh-airremote, dock status + one Air remote settings section + icon)'
)
