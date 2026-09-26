/**
 * dsh-reminder — client factory 冒烟测试（Node 侧模拟 ModuleLoader）。
 *
 * 与 sage-livingroom / dsh-timeclock 同款：抓顶层异常、校验 exports 形态
 * （apply / inject），再用最小 mock ctx 走一遍 apply，确认槽位注册发生。
 *
 * 用法：node scripts/smoke-client.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// 不写死本机路径：按脚本自身位置定位插件根（本脚本在 <root>/scripts/ 下）
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginRequire = createRequire(PLUGIN_DIR + '/lib/client.js')

const react = (() => { try { return pluginRequire('react') } catch { return null } })()
if (!react) {
	console.error('FAIL: react not resolvable from plugin dir (先在该目录 pnpm install)')
	process.exit(1)
}
console.log('react resolved:', typeof react.createElement)

let loaded = null
globalThis.window = {
	__ModuleLoader__: {
		load(def) {
			loaded = def.factory((name) => {
				if (name === 'react') return react
				throw new Error('unexpected require: ' + name)
			})
		},
	},
}

try {
	await import('file://' + PLUGIN_DIR + '/lib/client.js?smoke=' + Date.now())
} catch (e) {
	console.error('FACTORY THREW:', e.stack || e.message)
	process.exit(1)
}

if (!loaded) {
	console.error('FAIL: __ModuleLoader__.load was never called')
	process.exit(1)
}
console.log('factory OK | apply =', typeof loaded.apply, '| inject =', JSON.stringify(loaded.inject))

const calls = { registered: [] }
const fakeCtx = {
	get() { return undefined },
	slots: {
		inject(slotName, fn) {
			try { fn() } catch (e) {
				console.error('slots.inject callback THREW for', slotName, ':', e.stack || e.message)
				process.exitCode = 1
			}
		},
		register(def, comp) {
			calls.registered.push(def.name + '#' + (def.id || def.key))
			if (typeof comp !== 'function') { console.error('register comp not function'); process.exitCode = 1 }
		},
	},
}
try {
	await loaded.apply(fakeCtx)
	console.log('apply OK | registered =', JSON.stringify(calls.registered))
} catch (e) {
	console.error('APPLY THREW:', e.stack || e.message)
	process.exit(1)
}
console.log('SMOKE PASS')
