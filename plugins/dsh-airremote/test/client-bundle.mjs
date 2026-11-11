/**
 * Load the built DSH client bundle exactly as `dsh-client-modules` does:
 * evaluate the script, take the registered `{id, factory}`, and run the factory
 * with a CJS `require`. Verifies the wrapper, exports and a browserless `apply`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

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

let effectRegistered = false
let dockRegistered = false
const ctx = {
  effect(body) {
    effectRegistered = true
    const disposer = body()
    assert.equal(typeof disposer, 'function')
    disposer()
  },
  slots: {
    inject(name, callback) {
      assert.equal(name, 'conversation.input.dock')
      callback()
    },
    register(options) {
      assert.equal(options.name, 'conversation.input.dock')
      assert.equal(options.id, 'dsh-airremote-status')
      dockRegistered = true
      return () => undefined
    }
  }
}
await exports.apply(ctx)
assert.equal(effectRegistered, true)
assert.equal(dockRegistered, true)
console.log('ok  built client bundle registers and applies (id=dsh-airremote, dock status)')
