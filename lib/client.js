/**
 * sage-reminder（时间提醒）— 浏览器半。
 *
 * 手写 ModuleLoader bundle（与 dsh-timeclock / sage-livingroom 同格式）：
 *   window.__ModuleLoader__.load({ id, factory })
 *   factory(require) 返回 { apply, inject }
 *
 * 形制要点：
 *   - 纯 client：时间是浏览器本地时间，提醒/倒计时存 localStorage，
 *     到点提示 = 本模块边框呼吸灯 + 界面浮条。host 半没有任何参与。
 *   - 定位是**会话内的短期时间提醒**（2026-09-19 用户定）：
 *     「提醒」= 一天内的一个钟点，长期留在列表、跑完回初始状态；
 *     「倒计时」= 一次性时长（天/时/分/秒），跑完自动清理。
 *     不做重复规则、不做系统通知、不做跨重启持久化 —— 那就不止是个 DSH 插件了。
 *   - 入口挂在 conversation.session.header.actions（order 30，坐在「客厅」31 左边）。
 *     槽位 standardProps 直接给 sessionId，用它去问 sessions 服务要事件流。
 *   - 面板不另开 overlay：整个「模块 + 下拉」包在同一个 .ck-wrap 里，
 *     面板绝对定位到它（right:0）→ 跟着模块走，且不会顶出窗口右侧。
 *
 * 「距你上次发消息」是尽力而为：DSH 的会话事件类型没有随包发出来，
 * 所以这里不硬编码事件名，而是运行时宽松探测（见 extractLastUserMs）。
 * 探不到就隐藏那一行，不留假数据。
 */

window.__ModuleLoader__.load({
	id: "sage-reminder",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;

		/* ══════════════════════════════════════════════════════════
		   0 · 开关与常量
		   ══════════════════════════════════════════════════════════ */
		const STORE_KEY = "sage-reminder/v1";
		const WEEK_FULL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
		const WARN_MS = 10 * 60 * 1000; // 10 分钟内转金色

		function pad2(n) { return (n < 10 ? "0" : "") + n; }

		function uid() {
			return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
		}

		/* ══════════════════════════════════════════════════════════
		   1 · 存储（浏览器本地；清缓存会丢 —— 这是当面确认过的取舍）
		   ══════════════════════════════════════════════════════════ */
		function readStore() {
			try {
				const raw = window.localStorage.getItem(STORE_KEY);
				if (!raw) return { alarms: [], timers: [], lastFired: null, wakeOnFire: false, lastWake: null };
				const d = JSON.parse(raw);
				return {
					alarms: Array.isArray(d && d.alarms) ? d.alarms : [],
					timers: Array.isArray(d && d.timers) ? d.timers : [],
					lastFired: (d && d.lastFired) || null,
					wakeOnFire: !!(d && d.wakeOnFire),
					lastWake: (d && d.lastWake) || null,
				};
			} catch (e) {
				return { alarms: [], timers: [], lastFired: null, wakeOnFire: false, lastWake: null };
			}
		}

		function writeStore(s) {
			try {
				window.localStorage.setItem(STORE_KEY, JSON.stringify({
					alarms: s.alarms || [],
					timers: s.timers || [],
					lastFired: s.lastFired || null,
					wakeOnFire: !!s.wakeOnFire,
					lastWake: s.lastWake || null,
				}));
			} catch (e) {
				/* 隐私模式 / 配额满：静默降级为内存态，不炸界面 */
			}
		}

		/* ══════════════════════════════════════════════════════════
		   2 · 提醒引擎
		   reminder = { id, name, hh, mm, enabled:bool }
		   ——「提醒」= 一天内的一个钟点（用户 2026-09-19 定：闹钟本就一个时、单天内的设定）。
		   没有重复规则（只一次 / 每天 / 每周全部取消）：它长期留在列表里，
		   响过之后回到初始状态继续等下一个钟点，由 ▶ / ⏸ 显式开关。
		   旧数据里的 repeat / days / date 字段一律忽略。
		   ══════════════════════════════════════════════════════════ */

		/** 下一次响铃的绝对时间（ms）：今天这个点还没到就是今天，过了就是明天。 */
		function nextFire(alarm, from) {
			if (!alarm || !alarm.enabled) return null;
			const base = new Date(from);
			const at = (y, m, d) => new Date(y, m, d, alarm.hh, alarm.mm, 0, 0).getTime();
			let t = at(base.getFullYear(), base.getMonth(), base.getDate());
			if (t <= from) {
				const tm = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
				t = at(tm.getFullYear(), tm.getMonth(), tm.getDate());
			}
			return t;
		}

		/** 提醒的副标题：钟点（`21:40`）。 */
		function alarmMeta(alarm) {
			return pad2(alarm.hh) + ":" + pad2(alarm.mm);
		}

		/** 「还有 N 分钟」这类剩余描述。有更大的单位时把「分钟」缩成「分」——
		    列表行右边就这点地方，全写会挤掉名字（2026-09-19 实测）。 */
		function fmtRemain(ms) {
			if (ms <= 0) return "到点了";
			const s = Math.floor(ms / 1000);
			const d = Math.floor(s / 86400);
			const hh = Math.floor((s % 86400) / 3600);
			const mm = Math.floor((s % 3600) / 60);
			if (d > 0) return "还有 " + d + " 天 " + hh + " 小时";
			if (hh > 0) return "还有 " + hh + " 小时 " + mm + " 分";
			if (mm > 0) return "还有 " + mm + " 分钟";
			return "还有 " + (s % 60) + " 秒";
		}

		/** 倒计时读秒：mm:ss（超 1 小时给 h:mm:ss，超 1 天给 N天 h:mm:ss）。 */
		function fmtClock(ms) {
			const s = Math.max(0, Math.floor(ms / 1000));
			const d = Math.floor(s / 86400);
			const hh = Math.floor((s % 86400) / 3600);
			const mm = Math.floor((s % 3600) / 60);
			const ss = s % 60;
			if (d > 0) return d + "天 " + pad2(hh) + ":" + pad2(mm) + ":" + pad2(ss);
			return hh > 0 ? hh + ":" + pad2(mm) + ":" + pad2(ss) : pad2(mm) + ":" + pad2(ss);
		}

		/** 时长说人话（选择器下方的提示行）：`1 天 02 时 30 分 00 秒` / `10 分 00 秒`。
		   高位为 0 就省掉，看着不啰嗦。 */
		function fmtDur(ms) {
			const s = Math.max(0, Math.floor(ms / 1000));
			const d = Math.floor(s / 86400);
			const hh = Math.floor((s % 86400) / 3600);
			const mm = Math.floor((s % 3600) / 60);
			const ss = s % 60;
			const out = [];
			if (d > 0) out.push(d + " 天");
			if (d > 0 || hh > 0) out.push((d > 0 ? pad2(hh) : hh) + " 时");
			out.push((d > 0 || hh > 0 ? pad2(mm) : mm) + " 分");
			out.push(pad2(ss) + " 秒");
			return out.join(" ");
		}

		/* ══════════════════════════════════════════════════════════
		   3 · 「距你上次发消息」——宽松探测
		   DSH 的会话事件类型没随包发布，事件名无从查证，所以不猜名字，
		   而是按形状找：type 里带 user/prompt/input 且不带 assistant/tool，
		   并从常见字段名里取时间戳。找不到就返回 null（UI 隐藏该行）。
		   ══════════════════════════════════════════════════════════ */
		const TIME_FIELDS = ["time", "timestamp", "ts", "at", "createdAt", "occurredAt"];

		function pickTime(obj, depth) {
			if (!obj || typeof obj !== "object" || depth > 3) return null;
			for (let i = 0; i < TIME_FIELDS.length; i++) {
				const v = obj[TIME_FIELDS[i]];
				if (typeof v === "number" && v > 1000000000000) return v; // 毫秒级时间戳
			}
			// 往下找一层（事件多半把载荷放在 data / payload 里）
			const subs = [obj.data, obj.payload, obj.body];
			for (let i = 0; i < subs.length; i++) {
				const t = pickTime(subs[i], depth + 1);
				if (t) return t;
			}
			return null;
		}

		function looksLikeUserMessage(type) {
			const t = String(type || "").toLowerCase();
			if (!t) return false;
			if (/assistant|tool|system|compaction|checkpoint/.test(t)) return false;
			return /user|prompt|human|input/.test(t);
		}

		/** 从事件窗口里倒着找最近一条「用户消息」的时间戳。 */
		function extractLastUserMs(entries) {
			if (!Array.isArray(entries)) return null;
			for (let i = entries.length - 1; i >= 0; i--) {
				const wrap = entries[i];
				const ev = wrap && wrap.event ? wrap.event : wrap;
				if (!ev) continue;
				if (!looksLikeUserMessage(ev.type)) continue;
				const t = pickTime(ev, 0);
				if (t) return t;
			}
			return null;
		}

		/* ══════════════════════════════════════════════════════════
		   4 · 样式（data-plugin-css 幂等注入；类名统一 ck- 前缀）
		   ══════════════════════════════════════════════════════════ */
		const CSS = [
			/* — 模块（收起态）— */
			".ck-wrap{position:relative;display:inline-flex}",
			".ck-mod{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 9px 0 10px;",
			"  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:9px;",
			"  background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;cursor:pointer;",
			"  font-family:inherit;white-space:nowrap;transition:border-color .15s,background .15s,box-shadow .3s}",
			".ck-mod:hover{border-color:var(--dsw-alias-border-l2,rgba(255,255,255,.16));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04))}",
			".ck-mod.open{border-color:rgba(232,184,75,.5)}",
			/* 到点提醒：边框呼吸灯（替代系统通知） */
			".ck-mod.alarm{border-color:rgba(232,184,75,.75);animation:ck-breath 1.7s ease-in-out infinite}",
			"@keyframes ck-breath{",
			"  0%,100%{box-shadow:0 0 0 1px rgba(232,184,75,.22),0 0 8px rgba(232,184,75,.16)}",
			"  50%{box-shadow:0 0 0 1px rgba(232,184,75,.6),0 0 20px rgba(232,184,75,.45)}}",
			".ck-mod.alarm .ck-date,.ck-mod.alarm .ck-time{color:#f0d08a}",
			".ck-lines{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;line-height:1.25}",
			".ck-date{font-size:9.5px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.45));font-variant-numeric:tabular-nums}",
			".ck-time{font-size:11.5px;font-weight:500;letter-spacing:.01em;color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:tabular-nums}",
			".ck-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;",
			"  background:rgba(232,184,75,.12);border:1px solid rgba(232,184,75,.32);color:#e8b84b;",
			"  font-size:10.5px;font-variant-numeric:tabular-nums}",
			".ck-caret{color:var(--dsw-alias-label-secondary,rgba(255,255,255,.45));font-size:8px;transition:transform .18s}",
			".ck-mod.open .ck-caret{transform:rotate(180deg)}",

			/* — 下拉面板 — */
			/* right:0 —— 会话头部在窗口右侧，面板往左展开才不会顶出窗口（左对齐会溢出） */
			".ck-panel{position:absolute;top:calc(100% + 6px);right:0;width:288px;max-width:calc(100vw - 20px);z-index:60;",
			"  background:var(--dsw-alias-bg-layer-2,#222);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));",
			"  border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.55);overflow:hidden;",
			"  opacity:0;transform:translateY(-6px);pointer-events:none;",
			"  transition:opacity .16s ease-out,transform .18s cubic-bezier(.2,.9,.3,1.1)}",
			".ck-panel.open{opacity:1;transform:none;pointer-events:auto}",
			/* 列表限高：闹钟/倒计时再多，面板也不会长成一根柱子 */
			".ck-list{max-height:min(62vh,440px);overflow-y:auto;overscroll-behavior:contain;",
			"  scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2,rgba(255,255,255,.16)) transparent}",
			".ck-list::-webkit-scrollbar{width:8px}",
			".ck-list::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2,rgba(255,255,255,.16));border-radius:4px}",
			".ck-list::-webkit-scrollbar-track{background:transparent}",
			".ck-sec{padding:11px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}",
			".ck-sec:last-child{border-bottom:none}",
			".ck-sechead{display:flex;align-items:center;gap:6px;margin-bottom:8px}",
			".ck-secname{font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.45))}",
			".ck-seccount{font-size:10px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.45));opacity:.6}",
			".ck-add{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.6));",
			"  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:6px;padding:1px 7px;cursor:pointer;background:none;font-family:inherit}",
			".ck-add:hover{color:var(--dsw-alias-label-primary,inherit)}",

			".ck-now{font-size:19px;font-weight:500;letter-spacing:.02em;font-variant-numeric:tabular-nums;line-height:1.2}",
			".ck-nowsub{font-size:11.5px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.6));margin-top:3px}",
			".ck-since{margin-top:9px;display:flex;align-items:baseline;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.45))}",
			".ck-since b{font-weight:500;color:var(--dsw-alias-label-primary,inherit);font-variant-numeric:tabular-nums}",

			".ck-item{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:8px}",
			".ck-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}",
			".ck-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-secondary,rgba(255,255,255,.3))}",
			".ck-item.on .ck-dot{background:#e8b84b;box-shadow:0 0 0 3px rgba(232,184,75,.16)}",
			".ck-item.off{opacity:.45}",
			".ck-main{min-width:0;flex:1}",
			".ck-name{font-size:12.5px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".ck-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.45));font-variant-numeric:tabular-nums;display:block;margin-top:1px;opacity:.72;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".ck-left{font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap}",
			".ck-left.warn{color:#e8b84b}",
			".ck-acts{display:flex;gap:2px;opacity:0;transition:opacity .12s}",
			".ck-item:hover .ck-acts{opacity:1}",
			".ck-mini{width:20px;height:20px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));",
			"  color:var(--dsw-alias-label-secondary,rgba(255,255,255,.6));font-size:11px;display:inline-flex;",
			"  align-items:center;justify-content:center;cursor:pointer;background:none;font-family:inherit}",
			".ck-mini:hover{color:var(--dsw-alias-label-primary,inherit)}",
			/* ▶ / ⏸ 成对出现：当前生效的那个亮，另一个变暗（都还能点） */
			".ck-mini.dim{opacity:.32}",
			/* 开关（到点唤醒会话）：胶囊按钮，开=金色 */
			".ck-toggle{margin-left:auto;height:22px;padding:0 10px;border-radius:999px;background:none;font-family:inherit;",
			"  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,rgba(255,255,255,.6));",
			"  font-size:11px;cursor:pointer}",
			".ck-toggle.on{background:rgba(232,184,75,.14);border-color:rgba(232,184,75,.45);color:#e8b84b}",
			".ck-note{font-size:10.5px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.45));opacity:.78;margin-top:7px;line-height:1.5}",
			".ck-wake-last{color:#e8b84b;opacity:.92}",
			".ck-empty{font-size:11.5px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.45));padding:4px 8px 2px}",

			".ck-cd{padding:8px 8px 9px;display:block}",
			".ck-cdtop{display:flex;align-items:baseline;gap:8px}",
			".ck-cdname{font-size:12.5px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".ck-cdleft{font-size:14px;font-variant-numeric:tabular-nums;color:#e8b84b;letter-spacing:.02em}",
			".ck-bar{height:3px;border-radius:2px;background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.12));margin-top:7px;overflow:hidden}",
			".ck-bar > i{display:block;height:100%;background:#e8b84b;border-radius:2px;transition:width .9s linear}",

			/* — 编辑视图 — */
			".ck-edit{display:none}",
			".ck-panel.editing .ck-list{display:none}",
			".ck-panel.editing .ck-edit{display:block}",
			".ck-ehead{display:flex;align-items:center;gap:8px;padding:11px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}",
			".ck-back{width:22px;height:22px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));",
			"  color:var(--dsw-alias-label-secondary,rgba(255,255,255,.6));font-size:12px;display:inline-flex;",
			"  align-items:center;justify-content:center;cursor:pointer;background:none;font-family:inherit}",
			".ck-etitle{font-size:12.5px;font-weight:600}",
			".ck-field{padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}",
			".ck-flabel{display:block;font-size:10.5px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.45));opacity:.75;margin-bottom:6px}",
			".ck-input{width:100%;height:30px;padding:0 9px;border-radius:8px;",
			"  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.2));",
			"  color:var(--dsw-alias-label-primary,inherit);font-size:12.5px;font-family:inherit;box-sizing:border-box}",
			".ck-input:focus{outline:none;border-color:rgba(232,184,75,.5)}",
			".ck-hint{font-size:10.5px;color:#e8b84b;opacity:.85;margin:-1px 0 8px}",
			".ck-hint b{font-weight:500}",
			".ck-foot{display:flex;align-items:center;gap:6px;padding:10px 12px}",
			".ck-spacer{flex:1}",
			".ck-btn{height:28px;padding:0 11px;border-radius:8px;font-size:11.5px;cursor:pointer;font-family:inherit;",
			"  border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,rgba(255,255,255,.6));background:none}",
			".ck-btn.primary{background:#e8b84b;border-color:transparent;color:#1a1408;font-weight:600}",
			".ck-btn.danger{color:#e57373;border-color:rgba(229,115,115,.35)}",

			/* — 时间滚轮（并排 · 缩小）—
			   对齐原理：列高 = 可见行数 × 行高，中间那行正好落在列的正中，
			   高亮条也画在列的正中 → 两者天然重合，不靠 margin 去凑。
			   （旧版这里被上一行孤儿声明吃掉了一整条规则，滚轮会退回成上下两坨 —— 见 2026-09-19 记录）
			   单位（时/分、天/时/分/秒）标在每列正上方：列数可变（提醒 2 列、倒计时 4 列），
			   每列等宽 34px，所以单位行与滚轮列天然对齐。 */
			".ck-picker{display:flex;flex-direction:column;align-items:center;gap:3px}",
			".ck-units{display:flex;padding:0 6px}",
			".ck-unit{width:34px;text-align:center;font-size:10.5px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.45));opacity:.75}",
			".ck-slot{position:relative;display:flex;align-items:center;justify-content:center;height:72px;padding:0 6px;",
			"  -webkit-mask-image:linear-gradient(180deg,rgba(0,0,0,.3) 0,#000 33.5%,#000 66.5%,rgba(0,0,0,.3) 100%);",
			"  mask-image:linear-gradient(180deg,rgba(0,0,0,.3) 0,#000 33.5%,#000 66.5%,rgba(0,0,0,.3) 100%)}",
			".ck-slot::before{content:'';position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);height:24px;",
			"  border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.22));",
			"  border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));",
			"  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08))}",
			".ck-pcol{position:relative;display:flex;flex-direction:column;align-items:center;width:34px;outline:none;cursor:pointer}",
			".ck-pcol:focus-visible .ck-pk.on{text-decoration:underline;text-underline-offset:4px}",
			".ck-pk{height:24px;line-height:24px;font-size:13px;font-variant-numeric:tabular-nums;cursor:pointer;",
			"  color:var(--dsw-alias-label-secondary,rgba(255,255,255,.6));opacity:.34;user-select:none}",
			".ck-pk.near{opacity:.6}",
			".ck-pk.on{font-size:18px;font-weight:600;color:#e8b84b;opacity:1}",

			/* — 到点浮条（固定定位，贴头部下方居中）— */
			".ck-toast{position:fixed;left:50%;transform:translateX(-50%);top:70px;z-index:900;",
			"  display:inline-flex;align-items:center;gap:10px;padding:9px 14px;border-radius:10px;",
			"  background:linear-gradient(180deg,rgba(232,184,75,.18),rgba(232,184,75,.07));",
			"  border:1px solid rgba(232,184,75,.42);color:#f0d08a;font-size:12.5px;",
			"  box-shadow:0 12px 32px rgba(0,0,0,.45);animation:ck-fadein .2s ease-out}",
			"@keyframes ck-fadein{from{opacity:0;transform:translateX(-50%) translateY(-6px)}to{opacity:1;transform:translateX(-50%)}}",
			".ck-toast button{font-size:11.5px;color:#e8b84b;text-decoration:underline;text-underline-offset:2px;",
			"  cursor:pointer;background:none;border:none;font-family:inherit}",
		].join("\n");

		function injectCss() {
			const tagId = "sage-reminder/panel.css";
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "sage-reminder";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/* ══════════════════════════════════════════════════════════
		   5 · 小组件
		   ══════════════════════════════════════════════════════════ */

		/* ── 时间滚轮 ──
		   可见行数 × 行高 = 列高，中间行就在列的正中（高亮条画在同一个位置），
		   所以「选中项」与「高亮条」永远对齐 —— 别再给首行加 margin 去挪它。 */
		const PICK_ROWS = 3;
		const PICK_ROW_H = 24;

		/** 单列滚轮：中间那行是当前值。点上下行、滚轮、↑↓ 键都能转。 */
		function Picker(props) {
			const value = props.value;
			const max = props.max;
			const onChange = props.onChange;
			const colRef = react.useRef(null);
			const half = (PICK_ROWS - 1) / 2;
			const items = [];
			for (let i = -half; i <= half; i++) {
				items.push({ off: i, v: ((value + i) % max + max) % max });
			}
			const step = (d) => onChange(((value + d) % max + max) % max);

			/* React 17+ 把 wheel 以 passive 挂在根容器上，onWheel 里 preventDefault 是空操作
			   —— 调时间时页面会跟着滚。所以这里用原生非 passive 监听。 */
			react.useEffect(() => {
				const el = colRef.current;
				if (!el) return undefined;
				const onWheel = (e) => {
					e.preventDefault();
					step(e.deltaY > 0 ? 1 : -1);
				};
				el.addEventListener("wheel", onWheel, { passive: false });
				return () => el.removeEventListener("wheel", onWheel);
			}, [value, max]);

			return h("div", {
				className: "ck-pcol",
				ref: colRef,
				tabIndex: 0,
				role: "spinbutton",
				"aria-label": props.label || "",
				"aria-valuenow": value,
				"aria-valuemin": 0,
				"aria-valuemax": max - 1,
				"aria-valuetext": pad2(value) + (props.label || ""),
				onKeyDown: (e) => {
					if (e.key === "ArrowUp") { e.preventDefault(); step(1); }
					else if (e.key === "ArrowDown") { e.preventDefault(); step(-1); }
					else if (e.key === "PageUp") { e.preventDefault(); step(10); }
					else if (e.key === "PageDown") { e.preventDefault(); step(-10); }
				},
			}, items.map((it) => h("span", {
				key: it.off,
				className: "ck-pk" + (it.off === 0 ? " on" : (Math.abs(it.off) === 1 ? " near" : "")),
				onClick: () => onChange(((value + it.off) % max + max) % max),
			}, pad2(it.v))));
		}

		/** 并排的时间滚轮，列数可变：提醒 = 时/分（2 列），倒计时 = 天/时/分/秒（4 列）。
		   单位标在每列正上方（与列同宽 34px，天然对齐），所有列共用一条高亮条。 */
		function TimeWheels(props) {
			const cols = props.cols;
			return h("div", { className: "ck-picker" },
				h("div", { className: "ck-units" },
					cols.map((c, i) => h("span", { key: i, className: "ck-unit" }, c.unit))),
				h("div", { className: "ck-slot" },
					cols.map((c, i) => h(Picker, {
						key: i, value: c.value, max: c.max, label: c.unit, onChange: c.onChange,
					}))));
		}

		/* ══════════════════════════════════════════════════════════
		   6 · 主组件
		   ══════════════════════════════════════════════════════════ */
		function ClockModule(props) {
			const sessionId = props && props.sessionId;
			const wrapRef = react.useRef(null);

			const [now, setNow] = react.useState(() => Date.now());
			const [open, setOpen] = react.useState(false);
			const [store, setStore] = react.useState(readStore);
			const [view, setView] = react.useState("list");     // list | alarm | timer
			const [editing, setEditing] = react.useState(null); // 正在编辑的闹钟
			const [lastUserMs, setLastUserMs] = react.useState(null);

			/* — 每秒心跳 — */
			react.useEffect(() => {
				const t = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(t);
			}, []);

			/* — 读「距上次发消息」（尽力而为） —
			   实测：binding().eventSource.getSnapshot() 通道是通的，但**首次快照 entries 为空**
			   （事件窗口按需填充）。所以这里订阅它，窗口填进来之后再取。 */
			react.useEffect(() => {
				if (!sessionId) return undefined;
				let es = null;
				try {
					const sessions = appCtx && appCtx.get ? appCtx.get("sessions") : null;
					const binding = sessions && typeof sessions.binding === "function"
						? sessions.binding(sessionId) : null;
					es = binding && binding.eventSource;
				} catch (e) { es = null; }
				if (!es || typeof es.getSnapshot !== "function") return undefined;
				const read = () => {
					let snap = null;
					try { snap = es.getSnapshot(); } catch (e) { snap = null; }
					const t = extractLastUserMs(snap && snap.entries);
					if (t) setLastUserMs(t);
				};
				read();
				let un = null;
				try { un = typeof es.subscribe === "function" ? es.subscribe(read) : null; } catch (e) { un = null; }
				return () => { if (typeof un === "function") un(); };
			}, [sessionId]);

			/* — 持久化 — */
			react.useEffect(() => { writeStore(store); }, [store]);

			/* — 到点检测（闹钟 / 倒计时）——
			   触发记录写进 store.lastFired，**不用组件 state**：实测组件会被重新挂载，
			   用 useState 记「正在响」会丢（timer 已被消费、提示却不见了，2026-09-18 实测）。 */
			react.useEffect(() => {
				const quiet = store.lastFired && (now - store.lastFired.at) < 60000;
				if (quiet) return;
				for (let i = 0; i < store.alarms.length; i++) {
					const a = store.alarms[i];
					if (!a.enabled) continue;
					const fire = nextFire(a, now - 1000);
					if (fire && fire <= now) {
						/* 用户 2026-09-19 定：提醒「跑完恢复初始状态」——
						   不做消费，照旧留在列表里、保持启动状态，等下一个钟点。 */
						setStore((s) => ({ ...s, lastFired: { name: a.name || "提醒", at: Date.now() } }));
						/* 到点唤醒会话：**总开关 + 这一条的开关都开着**才注入（两个默认都关）。
						   60 秒静默期天然挡住连发。 */
						if (store.wakeOnFire && a.wake) wakeSession(a.name || "提醒");
						return;
					}
				}
				for (let i = 0; i < store.timers.length; i++) {
					const t = store.timers[i];
					if (t.paused) continue;
					if (t.endsAt && t.endsAt <= now) {
						const nm = t.name || "倒计时";
						setStore((s) => ({
							...s,
							timers: s.timers.filter((x) => x.id !== t.id),
							lastFired: { name: nm, at: Date.now() },
						}));
						return;
					}
				}
			}, [now, store]);

			/* — 收起面板的副作用（Esc / 点外面） — */
			react.useEffect(() => {
				if (!open) return undefined;
				const close = () => { setOpen(false); setView("list"); };
				const onKey = (e) => { if (e.key === "Escape") close(); };
				const onDown = (e) => {
					const el = wrapRef.current;
					if (el && e.target && !el.contains(e.target)) close();
				};
				document.addEventListener("keydown", onKey);
				document.addEventListener("mousedown", onDown, true);
				return () => {
					document.removeEventListener("keydown", onKey);
					document.removeEventListener("mousedown", onDown, true);
				};
			}, [open]);

			/* 「正在响」由 lastFired 的时间推导，不占组件 state —— 重挂载也不丢。
			   响后 60 秒内持续提示；静默期同时防止 daily/weekly 闹钟在同一分钟内反复触发。 */
			const firing = (store.lastFired && (now - store.lastFired.at) < 60000) ? store.lastFired : null;

			const d = new Date(now);
			const dateStr = d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日";
			const week = WEEK_FULL[d.getDay()];
			const hm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());

			/* 收起态右侧徽标：最近一个要响的东西 */
			let badge = null;
			let badgeMs = null;
			store.alarms.forEach((a) => {
				if (!a.enabled) return;
				const t = nextFire(a, now);
				if (t && (badgeMs === null || t - now < badgeMs)) badgeMs = t - now;
			});
			store.timers.forEach((t) => {
				const ms = t.paused ? (t.remainingMs || 0) : Math.max(0, (t.endsAt || 0) - now);
				if (badgeMs === null || ms < badgeMs) badgeMs = ms;
			});
			if (badgeMs !== null) badge = fmtClock(badgeMs);

			/* ── 数据操作 ── */
			function saveAlarm(a) {
				setStore((s) => {
					const exists = s.alarms.some((x) => x.id === a.id);
					return { ...s, alarms: exists ? s.alarms.map((x) => x.id === a.id ? a : x) : s.alarms.concat([a]) };
				});
				setView("list");
				setEditing(null);
			}
			function deleteAlarm(id) {
				setStore((s) => ({ ...s, alarms: s.alarms.filter((x) => x.id !== id) }));
				setView("list");
				setEditing(null);
			}
			/** ▶ / ⏸：显式启动 / 关闭一个提醒（不是"切换"，两个动作各自明确）。 */
			function setAlarmEnabled(id, on) {
				setStore((s) => ({ ...s, alarms: s.alarms.map((x) => x.id === id ? { ...x, enabled: on } : x) }));
			}
			function addTimer(name, totalMs) {
				const timer = { id: uid(), name: name, totalMs: totalMs, endsAt: Date.now() + totalMs, paused: false, remainingMs: 0 };
				setStore((s) => ({ ...s, timers: s.timers.concat([timer]) }));
				setView("list");
			}
			function pauseTimer(id) {
				setStore((s) => ({
					...s,
					timers: s.timers.map((t) => {
						if (t.id !== id) return t;
						if (t.paused) return { ...t, paused: false, endsAt: Date.now() + (t.remainingMs || 0), remainingMs: 0 };
						return { ...t, paused: true, remainingMs: Math.max(0, (t.endsAt || 0) - Date.now()) };
					}),
				}));
			}
			function removeTimer(id) {
				setStore((s) => ({ ...s, timers: s.timers.filter((t) => t.id !== id) }));
			}

			/* ── 到点唤醒会话（2026-09-19 第一步：**先验证"注入能不能真把人叫醒"**）──
			   走 sessions 服务的正规接口 `session.prompt()` —— 就是官方 composer 的
			   `send()` 那条路（dsh-client-ui-conversation:2938），等价于"亲手发了一条消息"，
			   会真的开一轮 agent 回合。不碰 DOM、不伪造事件。

			   三条自我约束：
			     ① **署名** —— 注入文本明说是插件发的，绝不冒充用户的话（他自己定的规矩）；
			     ② **只在会话空闲时注入** —— snapshot.running 为真就跳过，别打断正在跑的回合；
			     ③ 失败只 console 一行，不弹窗、不改界面状态（这是"叫醒"不是"报错"）。 */
			function wakeSession(name) {
				/* 每一步的结果都写进 store.lastWake —— 面板上会显示，
				   这样"到底叫醒了没有"不用开控制台就能看出来（2026-09-19 验证期需要）。 */
				const done = (result) => {
					console.log("[sage-reminder] 唤醒：", result);
					setStore((s) => ({ ...s, lastWake: { at: Date.now(), name: name, result: result } }));
				};
				let sess = null;
				try {
					const sessions = appCtx && appCtx.get ? appCtx.get("sessions") : null;
					const binding = sessions && typeof sessions.binding === "function"
						? sessions.binding(sessionId) : null;
					sess = binding && binding.session;
				} catch (e) { sess = null; }
				if (!sess || typeof sess.prompt !== "function") {
					done("跳过：拿不到会话");
					return;
				}
				let running = false;
				try {
					const snap = typeof sess.getSnapshot === "function" ? sess.getSnapshot() : null;
					running = !!(snap && snap.running);
				} catch (e) { running = false; }
				if (running) {
					done("跳过：会话正在跑");
					return;
				}
				const text = "【时间提醒】" + name + " 到点了。\n"
					+ "（本条由 sage-reminder 插件自动注入）";
				try {
					const p = sess.prompt([{ type: "text", text: text }], "queue");
					if (p && typeof p.then === "function") {
						p.then((r) => done(r && r.ok ? "已投递" : ("被拒：" + JSON.stringify(r && r.error))))
							.catch((e) => done("异常：" + String((e && e.message) || e)));
					} else {
						done("已调用（没拿到 Promise，无法确认）");
					}
				} catch (e) {
					done("抛错：" + String((e && e.message) || e));
				}
			}

			/* ── 收起态模块 ── */
			const modCls = "ck-mod" + (open ? " open" : "") + (firing ? " alarm" : "");
			const moduleEl = h("button", {
				type: "button",
				className: modCls,
				"aria-expanded": open ? "true" : "false",
				title: "时间提醒 — 现在时间 / 提醒 / 倒计时",
				onClick: () => { setOpen(!open); if (open) setView("list"); },
			},
				h("span", { className: "ck-lines" },
					h("span", { className: "ck-date" }, dateStr),
					h("span", { className: "ck-time" }, week + " " + hm)),
				badge ? h("span", { className: "ck-badge" }, badge) : null,
				h("span", { className: "ck-caret" }, "▼"));

			/* ── 面板：列表视图 ── */
			const listKids = [];
			listKids.push(h("div", { className: "ck-sec", key: "now" },
				h("div", { className: "ck-now" }, hm + ":" + pad2(d.getSeconds())),
				h("div", { className: "ck-nowsub" }, dateStr + " " + week),
				lastUserMs !== null
					? h("div", { className: "ck-since" }, "距你上次发消息 ",
						h("b", null, fmtRemain(now - lastUserMs).replace("还有 ", "")))
					: null));

			/* 提醒段（原「闹钟」）——用户 2026-09-19 定：这一段改名「提醒」，
			   语义仍是「一天内的一个钟点」，长期保留、跑完回初始状态。 */
			const alarmKids = [];
			if (store.alarms.length === 0) {
				alarmKids.push(h("div", { className: "ck-empty", key: "e" }, "还没有提醒"));
			}
			store.alarms.slice().sort((a, b) => (nextFire(a, now) || Infinity) - (nextFire(b, now) || Infinity))
				.forEach((a) => {
					const t = nextFire(a, now);
					const ms = t ? t - now : null;
					const cls = "ck-item" + (a.enabled ? " on" : " off");
					alarmKids.push(h("div", { className: cls, key: a.id },
						h("span", { className: "ck-dot" }),
						h("span", { className: "ck-main" },
							h("span", { className: "ck-name" }, a.name || "（未命名）"),
							h("span", { className: "ck-meta", title: a.wake ? "到点会唤醒会话（还要总开关开着）" : "" },
								alarmMeta(a) + (a.wake ? " · ⚡" : ""))),
						h("span", {
							className: "ck-left" + (a.enabled && ms !== null && ms <= WARN_MS ? " warn" : ""),
						}, a.enabled
							? (t ? fmtRemain(ms).replace("还有 ", "") : "已过期")
							: "已关闭"),
						h("span", { className: "ck-acts" },
							h("button", {
								className: "ck-mini" + (a.enabled ? " dim" : ""),
								title: "启动", onClick: () => setAlarmEnabled(a.id, true),
							}, "▶"),
							h("button", {
								className: "ck-mini" + (a.enabled ? "" : " dim"),
								title: "关闭", onClick: () => setAlarmEnabled(a.id, false),
							}, "⏸"),
							h("button", { className: "ck-mini", title: "编辑", onClick: () => { setEditing(a); setView("alarm"); } }, "⋯"))));
				});
			listKids.push(h("div", { className: "ck-sec", key: "alarms" },
				h("div", { className: "ck-sechead" },
					h("span", { className: "ck-secname" }, "提醒"),
					h("span", { className: "ck-seccount" }, store.alarms.length + " 个"),
					h("button", { className: "ck-add", onClick: () => { setEditing(null); setView("alarm"); } }, "+ 新建")),
				alarmKids));

			/* 倒计时段 */
			const timerKids = [];
			if (store.timers.length === 0) {
				timerKids.push(h("div", { className: "ck-empty", key: "e" }, "还没有倒计时"));
			}
			store.timers.forEach((t) => {
				const ms = t.paused ? (t.remainingMs || 0) : Math.max(0, (t.endsAt || 0) - now);
				const pct = t.totalMs ? Math.max(0, Math.min(100, (1 - ms / t.totalMs) * 100)) : 0;
				timerKids.push(h("div", { className: "ck-item ck-cd on", key: t.id },
					h("div", { className: "ck-cdtop" },
						h("span", { className: "ck-cdname" }, t.name || "倒计时"),
						h("span", { className: "ck-cdleft" }, fmtClock(ms)),
						h("span", { className: "ck-acts" },
							h("button", { className: "ck-mini", title: t.paused ? "继续" : "暂停", onClick: () => pauseTimer(t.id) }, t.paused ? "▶" : "⏸"),
							h("button", { className: "ck-mini", title: "删除", onClick: () => removeTimer(t.id) }, "×"))),
					h("div", { className: "ck-bar" }, h("i", { style: { width: pct + "%" } }))));
			});
			listKids.push(h("div", { className: "ck-sec", key: "timers" },
				h("div", { className: "ck-sechead" },
					h("span", { className: "ck-secname" }, "倒计时"),
					h("span", { className: "ck-seccount" }, store.timers.length + " 个"),
					h("button", { className: "ck-add", onClick: () => setView("timer") }, "+ 新建")),
				timerKids));

			/* 到点唤醒会话（总开关）—— 2026-09-19 第一步，先验证"注入能不能真把人叫醒" */
			listKids.push(h("div", { className: "ck-sec", key: "wake" },
				h("div", { className: "ck-sechead" },
					h("span", { className: "ck-secname" }, "到点唤醒会话"),
					h("button", {
						className: "ck-toggle" + (store.wakeOnFire ? " on" : ""),
						title: "提醒到点时，往当前会话发一条署名消息，把空闲的会话叫醒",
						onClick: () => setStore((s) => ({ ...s, wakeOnFire: !s.wakeOnFire })),
					}, store.wakeOnFire ? "开" : "关")),
				h("div", { className: "ck-note" }, store.wakeOnFire
					? "提醒到点时，会往当前会话发一条署名消息（等价于我替你发了一句），把空闲的会话叫醒。会话正在跑时不发；倒计时不唤醒。"
					: "关着时到点只有呼吸灯 + 浮条。打开后，勾了「唤醒」的提醒到点会发一条署名消息试试能不能把会话叫醒。"),
				store.lastWake
					? h("div", { className: "ck-note ck-wake-last" },
						"上次唤醒（" + fmtClock(Date.now() - store.lastWake.at) + " 前）：" + store.lastWake.result)
					: null));

			/* ── 面板：闹钟编辑 ── */
			const editEl = h(AlarmEditor, {
				key: "edit",
				alarm: editing,
				onSave: saveAlarm,
				onDelete: deleteAlarm,
				onCancel: () => { setView("list"); setEditing(null); },
			});

			/* ── 面板：倒计时新建 ── */
			const timerEl = h(TimerEditor, {
				key: "tedit",
				onStart: addTimer,
				onCancel: () => setView("list"),
			});

			const panelCls = "ck-panel" + (open ? " open" : "") + (view !== "list" ? " editing" : "");
			const panelEl = h("div", { className: panelCls },
				h("div", { className: "ck-list" }, listKids),
				view === "alarm" ? editEl : null,
				view === "timer" ? timerEl : null);

			/* ── 到点浮条 ──
			   用户 2026-09-19 定：**只显示设定的内容**（名字），不加「到点了」这类旁白。 */
			const toastEl = firing ? h("div", { className: "ck-toast" },
				h("span", null, "⏰"),
				h("span", null, h("b", null, firing.name)),
				h("button", { onClick: () => setStore((s) => ({ ...s, lastFired: null })) }, "知道了")) : null;

			return h("span", { className: "ck-wrap", ref: wrapRef }, moduleEl, panelEl, toastEl);
		}

		/* ══════════════════════════════════════════════════════════
		   7 · 提醒编辑器（新建 / 修改 / 删除）
		   只有「名字 + 一天内的钟点」，没有重复规则（用户 2026-09-19 定：不做重复规则）。
		   ══════════════════════════════════════════════════════════ */
		function AlarmEditor(props) {
			const a = props.alarm;
			const isNew = !a;

			const [name, setName] = react.useState(a ? (a.name || "") : "");
			const [hh, setHh] = react.useState(a ? a.hh : 21);
			const [mm, setMm] = react.useState(a ? a.mm : 40);
			/* 「到点唤醒会话」逐条开关：默认 eligible（真正生效还要面板底部的总开关也开着） */
			const [wake, setWake] = react.useState(a ? a.wake !== false : true);

			/* 预览：按当前表单算下一次响铃（今天这个点已经过了就算明天） */
			const nextT = nextFire({ hh: hh, mm: mm, enabled: true }, Date.now());
			const hintText = pad2(hh) + ":" + pad2(mm) + " · 距下次响铃 "
				+ fmtRemain(nextT - Date.now()).replace("还有 ", "");

			function submit() {
				props.onSave({
					id: a ? a.id : uid(),
					name: name.trim() || "提醒",
					hh: hh, mm: mm,
					wake: wake,
					/* 编辑已有那条时保持它原来的开关状态 —— 别因为改个名字就把它悄悄打开 */
					enabled: a ? a.enabled !== false : true,
				});
			}

			return h("div", { className: "ck-edit" },
				h("div", { className: "ck-ehead" },
					h("button", { className: "ck-back", onClick: props.onCancel }, "←"),
					h("span", { className: "ck-etitle" }, isNew ? "新建提醒" : "编辑提醒")),

				h("div", { className: "ck-field" },
					h("span", { className: "ck-flabel" }, "名称"),
					h("input", {
						className: "ck-input",
						value: name,
						placeholder: "给这个提醒起个名字",
						onChange: (e) => setName(e.target.value),
					})),

				h("div", { className: "ck-field" },
					h("span", { className: "ck-flabel" }, "时间"),
					h("div", { className: "ck-hint" }, hintText),
					h(TimeWheels, { cols: [
						{ value: hh, max: 24, unit: "时", onChange: setHh },
						{ value: mm, max: 60, unit: "分", onChange: setMm },
					] })),

				h("div", { className: "ck-field" },
					h("div", { className: "ck-sechead" },
						h("span", { className: "ck-secname" }, "到点唤醒会话"),
						h("button", {
							className: "ck-toggle" + (wake ? " on" : ""),
							onClick: () => setWake(!wake),
						}, wake ? "开" : "关")),
					h("div", { className: "ck-note" }, "面板底部的总开关关着时，这里开着也不会发。")),

				h("div", { className: "ck-foot" },
					isNew ? null : h("button", { className: "ck-btn danger", onClick: () => props.onDelete(a.id) }, "删除"),
					h("span", { className: "ck-spacer" }),
					h("button", { className: "ck-btn", onClick: props.onCancel }, "取消"),
					h("button", { className: "ck-btn primary", onClick: submit }, "保存")));
		}

		/* ══════════════════════════════════════════════════════════
		   8 · 倒计时新建（时长：天 / 时 / 分 / 秒）
		   天 0-99、时 0-23、分 0-59、秒 0-59 —— 24 / 60 进制（用户 2026-09-19 定）。
		   列之间不做进位：要 90 分钟就写「1 时 30 分」，不写「90 分」。
		   倒计时是一次性的：跑完自动从列表清理（提醒相反，长期保留）。
		   ══════════════════════════════════════════════════════════ */
		function TimerEditor(props) {
			const [name, setName] = react.useState("");
			const [dd, setDd] = react.useState(0);
			const [hh, setHh] = react.useState(0);
			const [mm, setMm] = react.useState(10);
			const [ss, setSs] = react.useState(0);
			const totalMs = (((dd * 24 + hh) * 60 + mm) * 60 + ss) * 1000;
			return h("div", { className: "ck-edit" },
				h("div", { className: "ck-ehead" },
					h("button", { className: "ck-back", onClick: props.onCancel }, "←"),
					h("span", { className: "ck-etitle" }, "新建倒计时")),
				h("div", { className: "ck-field" },
					h("span", { className: "ck-flabel" }, "名称"),
					h("input", {
						className: "ck-input", value: name,
						placeholder: "例如：泡面、午休、专注",
						onChange: (e) => setName(e.target.value),
					})),
				h("div", { className: "ck-field" },
					h("span", { className: "ck-flabel" }, "时长"),
					h("div", { className: "ck-hint" }, totalMs > 0 ? "计时 " + fmtDur(totalMs) : "先选一个时长"),
					h(TimeWheels, { cols: [
						{ value: dd, max: 100, unit: "天", onChange: setDd },
						{ value: hh, max: 24, unit: "时", onChange: setHh },
						{ value: mm, max: 60, unit: "分", onChange: setMm },
						{ value: ss, max: 60, unit: "秒", onChange: setSs },
					] })),
				h("div", { className: "ck-foot" },
					h("span", { className: "ck-spacer" }),
					h("button", { className: "ck-btn", onClick: props.onCancel }, "取消"),
					h("button", {
						className: "ck-btn primary",
						onClick: () => {
							if (totalMs <= 0) return;
							props.onStart(name.trim() || ("倒计时 " + fmtClock(totalMs)), totalMs);
						},
					}, "开始")));
		}

		/* ══════════════════════════════════════════════════════════
		   9 · apply
		   ══════════════════════════════════════════════════════════ */
		/**
		 * 挂一个槽位，失败必须在日志里响一声。
		 *
		 * DSH 0.1.7 的发布说明明写「客户端 Session 支持多实例共存，相关 API 及 slot
		 * 有变化」——这一层动过。槽位名或 slots API 一旦对不上，老写法是**彻底无声**的：
		 * 按钮不出现、控制台一个字没有，只表现为「这插件好像没装」。
		 * 这里把「API 没了」和「注入抛异常」两种情况变成可见的警告；槽位名本身若被改掉，
		 * 依然要靠 0.1.7 上的实测去发现（inject 对未知槽位不一定抛）。
		 */
		function mountSlot(ctx, spec, render) {
			const slots = ctx && ctx.slots;
			if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
				console.warn(`[${spec.id}] ctx.slots 不可用，界面未挂载 —— DSH 的 slots API 可能变了`);
				return false;
			}
			try {
				slots.inject(spec.name, () => slots.register(spec, render));
				return true;
			} catch (e) {
				console.warn(`[${spec.id}] 挂载到槽位 ${spec.name} 失败：`, e);
				return false;
			}
		}

		let appCtx = null;
		const inject = ["slots"];

		async function apply(ctx) {
			appCtx = ctx;
			injectCss();
			mountSlot(
				ctx,
				{
					name: "conversation.session.header.actions",
					id: "sage-reminder",
					order: 30,
					label: "时间提醒",
				},
				// 把槽位标准 props（含 sessionId）透传给组件
				(props) => h(ClockModule, props || {}),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
