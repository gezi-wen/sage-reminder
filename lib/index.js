/**
 * sage-clockwork（座钟）— host 半
 *
 * 这一半**故意是空的**：座钟显示的是浏览器本地时间，闹钟与倒计时数据存在
 * 浏览器 localStorage，到点提示靠界面自身（模块边框呼吸灯 + 浮条）。
 * 没有任何需要 host 侧参与的东西 —— 不读文件、不起进程、不建数据通道。
 *
 * 对比：sage-livingroom 要 SSH 拉远程服务器文件，所以它有 TypertRemoteService；
 * 座钟没有这类需求，保持最小形状即可（与 dsh-timeclock 同款）。
 */

export const name = 'sage-clockwork'

/** 不依赖任何 host 服务。 */
export const inject = []

export function apply() {
  // 全部 UI 与逻辑都在浏览器半：lib/client.js
  //
  // 三级验证第③级的标记 —— 启动日志里出现这行，才证明 DSH 真加载了这份代码。
  // 必须用 console.log：ctx.logger 的输出不进 stdout，会白等一场。
  console.log('[sage-clockwork] host apply() called')
}
