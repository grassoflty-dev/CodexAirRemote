/**
 * Build both halves of the DSH plugin:
 *
 *  - `lib/index.js`  ESM host entry (Node, external node builtins)
 *  - `lib/client.js` browser bundle in the DSH module-loader factory format
 *  - `lib/host-test.js` internal exports used by the local integration tests
 *  - `lib/virtual-mic.test.js` standalone shim for the headless-browser test
 *
 * The browser wrapper is the contract `@deepseek-ai/dsh-client-modules`
 * documents: the script registers `{id, factory}`; the factory is a lazy CJS
 * module body and returns its exports.
 */

import { mkdirSync, rmSync } from 'node:fs'
import { build } from 'rolldown'

rmSync('lib', { recursive: true, force: true })
rmSync('test/dist', { recursive: true, force: true })
mkdirSync('lib', { recursive: true })
mkdirSync('test/dist', { recursive: true })

const clientBanner = `window.__ModuleLoader__.load({
	id: "dsh-airremote",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
`
const clientFooter = `
		return module.exports;
	}
});
`

const clientExternals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots'
]

await build({
  input: 'src/index.ts',
  platform: 'node',
  external: [/^node:/, '@deepseek-ai/cordis'],
  output: {
    file: 'lib/index.js',
    format: 'esm',
    sourcemap: false
  }
})

await build({
  input: 'src/client/index.ts',
  platform: 'browser',
  external: clientExternals,
  output: {
    file: 'lib/client.js',
    format: 'cjs',
    exports: 'named',
    sourcemap: false,
    codeSplitting: false,
    banner: clientBanner,
    footer: clientFooter
  }
})

await build({
  input: 'src/host/test-entry.ts',
  platform: 'node',
  external: [/^node:/],
  output: {
    file: 'test/dist/host-test.js',
    format: 'esm',
    sourcemap: false
  }
})

await build({
  input: 'src/client/virtual-mic.ts',
  platform: 'browser',
  output: {
    file: 'test/dist/virtual-mic.test.js',
    format: 'iife',
    name: 'AirRemoteVirtualMic',
    sourcemap: false
  }
})

console.log('built lib/index.js, lib/client.js, test/dist/host-test.js, test/dist/virtual-mic.test.js')
