/**
 * sage-clockwork（座钟）— 浏览器半。
 *
 * 手写 ModuleLoader bundle（与 dsh-timeclock / sage-livingroom 同格式）：
 *   window.__ModuleLoader__.load({ id, factory })
 *   factory(require) 返回 { apply, inject }
 *
 * 形制要点：
 *   - 纯 client：时间是浏览器本地时间，闹钟/倒计时存 localStorage，
 *     到点提示 = 本模块边框呼吸灯 + 界面浮条。host 半没有任何参与。
 *   - 入口挂在 conversation.session.header.actions（order 30，坐在「客厅」31 左边）。
 *     槽位 standardProps 直接给 sessionId，用它去问 sessions 服务要事件流。
 *   - 面板不另开 overlay：整个「模块 + 下拉」包在同一个 .ck-wrap 里，
 *     面板绝对定位到它 → 与模块左对齐，且天然跟着模块走。
 *
 * 「距你上次发消息」是尽力而为：DSH 的会话事件类型没有随包发出来，
 * 所以这里不硬编码事件名，而是运行时宽松探测（见 extractLastUserMs）。
 * 探不到就隐藏那一行，不留假数据。
 */

window.__ModuleLoader__.load({
	id: "sage-clockwork",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const h = react.createElement;

		/* ══════════════════════════════════════════════════════════
		   0 · 开关与常量
		   ══════════════════════════════════════════════════════════ */
		const STORE_KEY = "sage-clockwork/v1";
		const WEEK_LABEL = ["日", "一", "二", "三", "四", "五", "六"]; // 下标 = Date.getDay()
		const WEEK_FULL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
		const GOLD = "#e8b84b";
		const WARN_MS = 10 * 60 * 1000; // 10 分钟内转金色

		function pad2(n) { return (n < 10 ? "0" : "") + n; }

		/** 本地时区的 YYYY-MM-DD。
		   ⚠️ 别用 toISOString().slice(0,10) —— 那是 UTC，本地凌晨 0-8 点会算成「昨天」，
		   设出来的「只一次」闹钟日期直接错一天（2026-09-19 修）。 */
		function localDate(d) {
			return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
		}

		/** 「只一次」落在哪一天：今天这个点还没到就是今天，已经过了就顺延到明天
		   —— 否则会设出一个永远不响的闹钟（下一次响铃查询返回 null）。 */
		function onceDateFor(hh, mm) {
			const n = new Date();
			const todayAt = new Date(n.getFullYear(), n.getMonth(), n.getDate(), hh, mm, 0, 0).getTime();
			if (todayAt > n.getTime()) return localDate(n);
			return localDate(new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1));
		}

		/** 日期说人话：今天 / 明天 / 9月21日。 */
		function dayWord(dateStr) {
			if (dateStr === localDate(new Date())) return "今天";
			if (dateStr === localDate(new Date(Date.now() + 86400000))) return "明天";
			const p = String(dateStr || "").split("-").map(Number);
			return p.length === 3 && p.every((x) => !isNaN(x)) ? (p[1] + "月" + p[2] + "日") : String(dateStr || "");
		}

		function uid() {
			return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
		}

		/* ══════════════════════════════════════════════════════════
		   1 · 存储（浏览器本地；清缓存会丢 —— 这是当面确认过的取舍）
		   ══════════════════════════════════════════════════════════ */
		function readStore() {
			try {
				const raw = window.localStorage.getItem(STORE_KEY);
				if (!raw) return { alarms: [], timers: [], lastFired: null };
				const d = JSON.parse(raw);
				return {
					alarms: Array.isArray(d && d.alarms) ? d.alarms : [],
					timers: Array.isArray(d && d.timers) ? d.timers : [],
					lastFired: (d && d.lastFired) || null,
				};
			} catch (e) {
				return { alarms: [], timers: [], lastFired: null };
			}
		}

		function writeStore(s) {
			try {
				window.localStorage.setItem(STORE_KEY, JSON.stringify({
					alarms: s.alarms || [],
					timers: s.timers || [],
					lastFired: s.lastFired || null,
				}));
			} catch (e) {
				/* 隐私模式 / 配额满：静默降级为内存态，不炸界面 */
			}
		}

		/* ══════════════════════════════════════════════════════════
		   2 · 闹钟引擎
		   alarm = { id, name, hh, mm, repeat:'once'|'daily'|'weekly',
		             days:[0..6], date:'YYYY-MM-DD', enabled:bool }
		   ══════════════════════════════════════════════════════════ */

		/** 下一次响铃的绝对时间（ms）；不会再响返回 null。 */
		function nextFire(alarm, from) {
			if (!alarm || !alarm.enabled) return null;
			const base = new Date(from);
			const at = (y, m, d) => new Date(y, m, d, alarm.hh, alarm.mm, 0, 0).getTime();

			if (alarm.repeat === "once") {
				if (!alarm.date) return null;
				const p = String(alarm.date).split("-").map(Number);
				if (p.length !== 3 || p.some(isNaN)) return null;
				const t = at(p[0], p[1] - 1, p[2]);
				return t > from ? t : null;
			}
			if (alarm.repeat === "weekly" && Array.isArray(alarm.days) && alarm.days.length) {
				for (let i = 0; i < 8; i++) {
					const cand = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
					if (alarm.days.indexOf(cand.getDay()) < 0) continue;
					const t = at(cand.getFullYear(), cand.getMonth(), cand.getDate());
					if (t > from) return t;
				}
				return null;
			}
			// daily（默认）
			let t = at(base.getFullYear(), base.getMonth(), base.getDate());
			if (t <= from) {
				const tm = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
				t = at(tm.getFullYear(), tm.getMonth(), tm.getDate());
			}
			return t;
		}

		/** 重复规则的中文摘要，如「每天 21:40」「每周 二/四/五 21:40」。 */
		function repeatText(alarm) {
			const hm = pad2(alarm.hh) + ":" + pad2(alarm.mm);
			if (alarm.repeat === "once") return (alarm.date || "某天") + " " + hm;
			if (alarm.repeat === "weekly" && Array.isArray(alarm.days) && alarm.days.length) {
				const ds = alarm.days.slice().sort((a, b) => a - b)
					.map((d) => WEEK_LABEL[d]).join(" / ");
				return "每周 " + ds + " " + hm;
			}
			return "每天 " + hm;
		}

		/** 「还有 N 分钟」这类剩余描述。 */
		function fmtRemain(ms) {
			if (ms <= 0) return "到点了";
			const s = Math.floor(ms / 1000);
			const d = Math.floor(s / 86400);
			const hh = Math.floor((s % 86400) / 3600);
			const mm = Math.floor((s % 3600) / 60);
			if (d > 0) return "还有 " + d + " 天 " + hh + " 小时";
			if (hh > 0) return "还有 " + hh + " 小时 " + mm + " 分钟";
			if (mm > 0) return "还有 " + mm + " 分钟";
			return "还有 " + (s % 60) + " 秒";
		}

		/** 倒计时读秒：mm:ss（超 1 小时给 h:mm:ss）。 */
		function fmtClock(ms) {
			const s = Math.max(0, Math.floor(ms / 1000));
			const hh = Math.floor(s / 3600);
			const mm = Math.floor((s % 3600) / 60);
			const ss = s % 60;
			return hh > 0 ? hh + ":" + pad2(mm) + ":" + pad2(ss) : pad2(mm) + ":" + pad2(ss);
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
			".ck-seg{display:flex;gap:4px}",
			".ck-seg button{flex:1;height:26px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));",
			"  color:var(--dsw-alias-label-secondary,rgba(255,255,255,.6));font-size:11.5px;cursor:pointer;background:none;font-family:inherit}",
			".ck-seg button.on{background:rgba(232,184,75,.14);border-color:rgba(232,184,75,.45);color:#e8b84b}",
			".ck-days{display:flex;gap:4px;margin-top:8px}",
			".ck-days button{flex:1;height:26px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));",
			"  color:var(--dsw-alias-label-secondary,rgba(255,255,255,.6));font-size:11.5px;padding:0;cursor:pointer;background:none;font-family:inherit}",
			".ck-days button.on{background:rgba(232,184,75,.14);border-color:rgba(232,184,75,.45);color:#e8b84b}",
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
			   （旧版这里被上一行孤儿声明吃掉了一整条规则，滚轮会退回成上下两坨 —— 见 2026-09-19 记录） */
			".ck-picker{display:flex;align-items:center;justify-content:center;gap:6px;height:72px}",
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
			".ck-unit{font-size:10.5px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.45));opacity:.75}",
			".ck-colon{font-size:14px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.45));opacity:.75;padding:0 2px}",

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
			const tagId = "sage-clockwork/panel.css";
			if (typeof document === "undefined") return;
			if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "sage-clockwork";
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

		/** 并排的两个滚轮（时:分 / 分:秒），共用一个高亮条，两侧标单位。 */
		function TimeWheels(props) {
			return h("div", { className: "ck-picker" },
				h("span", { className: "ck-unit" }, props.unitA),
				h("div", { className: "ck-slot" },
					h(Picker, { value: props.a, max: props.maxA, label: props.unitA, onChange: props.onA }),
					h("span", { className: "ck-colon" }, ":"),
					h(Picker, { value: props.b, max: props.maxB, label: props.unitB, onChange: props.onB })),
				h("span", { className: "ck-unit" }, props.unitB));
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
						const nm = a.name || "闹钟";
						setStore((s) => ({
							...s,
							alarms: a.repeat === "once"
								? s.alarms.map((x) => x.id === a.id ? { ...x, enabled: false } : x)
								: s.alarms,
							lastFired: { name: nm, at: Date.now() },
						}));
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
			function toggleAlarm(id) {
				setStore((s) => ({ ...s, alarms: s.alarms.map((x) => x.id === id ? { ...x, enabled: !x.enabled } : x) }));
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

			/* ── 收起态模块 ── */
			const modCls = "ck-mod" + (open ? " open" : "") + (firing ? " alarm" : "");
			const moduleEl = h("button", {
				type: "button",
				className: modCls,
				"aria-expanded": open ? "true" : "false",
				title: "座钟 — 现在时间 / 闹钟 / 倒计时",
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

			/* 闹钟段 */
			const alarmKids = [];
			if (store.alarms.length === 0) {
				alarmKids.push(h("div", { className: "ck-empty", key: "e" }, "还没有闹钟"));
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
							h("span", { className: "ck-meta" }, repeatText(a))),
						h("span", {
							className: "ck-left" + (a.enabled && ms !== null && ms <= WARN_MS ? " warn" : ""),
						}, a.enabled ? (t ? fmtRemain(ms) : "已过期") : "已关闭"),
						h("span", { className: "ck-acts" },
							h("button", { className: "ck-mini", title: a.enabled ? "关掉" : "启用", onClick: () => toggleAlarm(a.id) }, a.enabled ? "⏸" : "▶"),
							h("button", { className: "ck-mini", title: "编辑", onClick: () => { setEditing(a); setView("alarm"); } }, "⋯"))));
				});
			listKids.push(h("div", { className: "ck-sec", key: "alarms" },
				h("div", { className: "ck-sechead" },
					h("span", { className: "ck-secname" }, "闹钟"),
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

			/* ── 到点浮条 ── */
			const toastEl = firing ? h("div", { className: "ck-toast" },
				h("span", null, "⏰"),
				h("span", null, h("b", null, firing.name), " 到点了"),
				h("button", { onClick: () => setStore((s) => ({ ...s, lastFired: null })) }, "知道了")) : null;

			return h("span", { className: "ck-wrap", ref: wrapRef }, moduleEl, panelEl, toastEl);
		}

		/* ══════════════════════════════════════════════════════════
		   7 · 闹钟编辑器（新建 / 修改 / 删除）
		   ══════════════════════════════════════════════════════════ */
		function AlarmEditor(props) {
			const a = props.alarm;
			const isNew = !a;

			const [name, setName] = react.useState(a ? (a.name || "") : "");
			const [hh, setHh] = react.useState(a ? a.hh : 21);
			const [mm, setMm] = react.useState(a ? a.mm : 40);
			const [repeat, setRepeat] = react.useState(a ? (a.repeat || "daily") : "daily");
			const [days, setDays] = react.useState(a && Array.isArray(a.days) ? a.days : []);

			function toggleDay(d) {
				setDays((cur) => cur.indexOf(d) >= 0 ? cur.filter((x) => x !== d) : cur.concat([d]).sort());
			}

			/* 预览：按当前表单算下一次响铃。「只一次」的日期 = 今天这个点过了就明天
			   （编辑已有的那次时，只要原日期还没过去就保留它）。 */
			const keepDate = a && a.repeat === "once" && a.date && a.date >= localDate(new Date()) ? a.date : null;
			const onceDate = keepDate || onceDateFor(hh, mm);
			const hmText = pad2(hh) + ":" + pad2(mm);
			const draft = {
				hh: hh, mm: mm, enabled: true,
				repeat: repeat,
				days: repeat === "weekly" ? (days.length ? days : [new Date().getDay()]) : days,
				date: repeat === "once" ? onceDate : null,
			};
			const nextT = nextFire(draft, Date.now());
			const hintText = repeat === "once"
				? dayWord(onceDate) + " " + hmText + " 响一次"
				: hmText + " · " + (nextT
					? "距下次响铃 " + fmtRemain(nextT - Date.now()).replace("还有 ", "")
					: "这个时间已经过去了");

			function submit() {
				const next = {
					id: a ? a.id : uid(),
					name: name.trim() || "闹钟",
					hh: hh, mm: mm,
					repeat: repeat,
					days: repeat === "weekly" ? (days.length ? days : [new Date().getDay()]) : [],
					date: repeat === "once" ? onceDate : null,
					enabled: true,
				};
				props.onSave(next);
			}

			return h("div", { className: "ck-edit" },
				h("div", { className: "ck-ehead" },
					h("button", { className: "ck-back", onClick: props.onCancel }, "←"),
					h("span", { className: "ck-etitle" }, isNew ? "新建闹钟" : "编辑闹钟")),

				h("div", { className: "ck-field" },
					h("span", { className: "ck-flabel" }, "名称"),
					h("input", {
						className: "ck-input",
						value: name,
						placeholder: "给这个闹钟起个名字",
						onChange: (e) => setName(e.target.value),
					})),

				h("div", { className: "ck-field" },
					h("span", { className: "ck-flabel" }, "时间"),
					h("div", { className: "ck-hint" }, hintText),
					h(TimeWheels, {
						a: hh, maxA: 24, unitA: "时", onA: setHh,
						b: mm, maxB: 60, unitB: "分", onB: setMm,
					})),

				h("div", { className: "ck-field" },
					h("span", { className: "ck-flabel" }, "重复"),
					h("div", { className: "ck-seg" },
						h("button", { className: repeat === "once" ? "on" : "", onClick: () => setRepeat("once") }, "只一次"),
						h("button", { className: repeat === "daily" ? "on" : "", onClick: () => setRepeat("daily") }, "每天"),
						h("button", { className: repeat === "weekly" ? "on" : "", onClick: () => setRepeat("weekly") }, "每周")),
					repeat === "weekly" ? h("div", { className: "ck-days" },
						[1, 2, 3, 4, 5, 6, 0].map((d) => h("button", {
							key: d,
							className: days.indexOf(d) >= 0 ? "on" : "",
							onClick: () => toggleDay(d),
						}, WEEK_LABEL[d]))) : null),

				h("div", { className: "ck-foot" },
					isNew ? null : h("button", { className: "ck-btn danger", onClick: () => props.onDelete(a.id) }, "删除"),
					h("span", { className: "ck-spacer" }),
					h("button", { className: "ck-btn", onClick: props.onCancel }, "取消"),
					h("button", { className: "ck-btn primary", onClick: submit }, "保存")));
		}

		/* ══════════════════════════════════════════════════════════
		   8 · 倒计时新建（常用时长快捷键，够用且快）
		   ══════════════════════════════════════════════════════════ */
		/* 倒计时新建：时长用与闹钟同一套滚轮（分 / 秒）。
		   不用文字输入 —— 避免有人敲进非时间字符；也不再放一排快捷按钮，
		   保持两处「选时间」的交互一致。 */
		function TimerEditor(props) {
			const [name, setName] = react.useState("");
			const [mm, setMm] = react.useState(10);
			const [ss, setSs] = react.useState(0);
			const totalMs = (mm * 60 + ss) * 1000;
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
					h("div", { className: "ck-hint" }, totalMs > 0 ? "计时 " + fmtClock(totalMs) : "先选一个时长"),
					h(TimeWheels, {
						a: mm, maxA: 100, unitA: "分", onA: setMm,
						b: ss, maxB: 60, unitB: "秒", onB: setSs,
					})),
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
		let appCtx = null;
		const inject = ["slots"];

		async function apply(ctx) {
			appCtx = ctx;
			injectCss();
			ctx.slots.inject("conversation.session.header.actions", () => {
				ctx.slots.register(
					{
						name: "conversation.session.header.actions",
						id: "sage-clockwork",
						order: 30,
						label: "座钟",
					},
					// 把槽位标准 props（含 sessionId）透传给组件
					(props) => h(ClockModule, props || {}),
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
