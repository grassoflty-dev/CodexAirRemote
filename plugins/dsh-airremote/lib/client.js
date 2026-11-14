window.__ModuleLoader__.load({
	id: "dsh-airremote",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// src/client/AirRemoteBar.tsx
		/** Dock hint under the composer: explains the Air Remote link while the official mic is active. */
		function AirRemoteBar({ voiceState }) {
			const [snapshot, setSnapshot] = (0, react.useState)(() => voiceState?.get() ?? {
				phase: "idle",
				detail: "",
				lastTranscript: ""
			});
			(0, react.useEffect)(() => {
				if (voiceState === void 0) return;
				return voiceState.subscribe(() => setSnapshot(voiceState.get()));
			}, [voiceState]);
			if (snapshot.phase === "idle") return null;
			const icon = snapshot.phase === "error" ? "⚠️" : snapshot.phase === "live" ? "🔴" : "🎙";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				role: "status",
				"aria-live": "polite",
				style: {
					display: "flex",
					gap: "8px",
					alignItems: "center",
					fontSize: "12px",
					opacity: .85,
					padding: "2px 4px"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": "true",
						children: icon
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "Air Remote" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: { opacity: .7 },
						children: snapshot.detail === "" ? snapshot.phase : snapshot.detail
					})
				]
			});
		}
		// src/time-zones.ts
		/** 没保存过时区、或保存值不认识时的默认项。 */
		const DEFAULT_TIMEZONE = "auto";
		/** 固件接受的分钟范围（东为正，UTC−12:00..UTC+14:00）。 */
		const MIN_TIMEZONE_MINUTES = -720;
		/** 设置页展示的顺序，固定项之外不要随便增删（已存进 `time.json` 的 id 要能继续识别）。 */
		const TIMEZONE_OPTIONS = [
			{
				id: "auto",
				label: "跟随系统"
			},
			{
				id: "utc-8",
				label: "UTC−8 洛杉矶",
				minutes: -480
			},
			{
				id: "utc-5",
				label: "UTC−5 纽约",
				minutes: -300
			},
			{
				id: "utc+0",
				label: "UTC+0 伦敦",
				minutes: 0
			},
			{
				id: "utc+1",
				label: "UTC+1 柏林",
				minutes: 60
			},
			{
				id: "utc+8",
				label: "UTC+8 北京",
				minutes: 480
			},
			{
				id: "utc+9",
				label: "UTC+9 东京",
				minutes: 540
			}
		];
		/** 当前环境的时区偏移（分钟、东为正），夹到固件接受的范围内。 */
		function systemOffsetMinutes(now = /* @__PURE__ */ new Date()) {
			const minutes = -now.getTimezoneOffset();
			if (minutes < -720) return MIN_TIMEZONE_MINUTES;
			if (minutes > 840) return 840;
			return minutes;
		}
		/**
		* 把设置里的时区 id 换成 `AR1Z` 需要的分钟偏移。
		* 固定项直接用表里的值；`auto`、未知 id 都跟随系统时钟（与设置页的回退行为一致）。
		*/
		function minutesForTimezone(id, now = /* @__PURE__ */ new Date()) {
			const option = TIMEZONE_OPTIONS.find((candidate) => candidate.id === id);
			if (option?.minutes !== void 0) return option.minutes;
			return systemOffsetMinutes(now);
		}
		// src/client/DevBoardTime.tsx
		/** Human reason for a failed sync; unknown codes fall back to the host message. */
		function syncFailureText(error, message) {
			switch (error) {
				case "no-board": return "未找到开发板（USB VID 303A）";
				case "open-failed": return "串口打不开（可能被占用）";
				case "timeout": return "板子没有响应";
				case "rejected": return "板子拒绝了命令";
				case "busy": return "上一次同步还没结束";
				default: return message ?? "同步失败";
			}
		}
		async function requestJson(path, init) {
			const response = await fetch(path, init);
			const data = await response.json().catch(() => ({}));
			return {
				status: response.status,
				data
			};
		}
		function formatLocalTime(unix) {
			const date = /* @__PURE__ */ new Date(unix * 1e3);
			const pad = (value) => String(value).padStart(2, "0");
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}
		/**
		* Settings section: the board keeps UTC in its RTC, the display offset lives in
		* NVS. Picking a zone only persists the choice. A serial round-trip happens on
		* the explicit button press, or automatically on host startup / board session
		* when 「自动对时」 is on (the default); this panel never polls.
		*/
		function DevBoardTime() {
			const selectId = (0, react.useId)();
			const autoSyncId = (0, react.useId)();
			const [timezone, setTimezone] = (0, react.useState)(DEFAULT_TIMEZONE);
			const [autoSync, setAutoSync] = (0, react.useState)(true);
			const [status, setStatus] = (0, react.useState)(null);
			const [saving, setSaving] = (0, react.useState)(false);
			const [savingAutoSync, setSavingAutoSync] = (0, react.useState)(false);
			const [syncing, setSyncing] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				let alive = true;
				(async () => {
					try {
						const { status: httpStatus, data } = await requestJson("/airremote/time");
						if (!alive) return;
						const known = TIMEZONE_OPTIONS.some((option) => option.id === data.timezone);
						if (httpStatus === 200 && data.ok !== false && known) setTimezone(data.timezone);
						else {
							setTimezone(DEFAULT_TIMEZONE);
							setStatus({
								tone: "info",
								text: "读取已保存的时区失败，已回退到「跟随系统」"
							});
						}
						setAutoSync(data.autoSync !== false);
					} catch {
						if (!alive) return;
						setTimezone(DEFAULT_TIMEZONE);
						setAutoSync(true);
						setStatus({
							tone: "info",
							text: "读取已保存的时区失败，已回退到「跟随系统」"
						});
					}
				})();
				return () => {
					alive = false;
				};
			}, []);
			const handleTimezoneChange = (0, react.useCallback)((next) => {
				setTimezone(next);
				setSaving(true);
				setStatus(null);
				(async () => {
					try {
						const { status: httpStatus, data } = await requestJson("/airremote/time", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ timezone: next })
						});
						if (httpStatus === 200 && data.ok !== false) setStatus({
							tone: "ok",
							text: "已保存"
						});
						else setStatus({
							tone: "error",
							text: data.message ?? "保存失败"
						});
					} catch {
						setStatus({
							tone: "error",
							text: "保存失败（无法连接本地服务）"
						});
					} finally {
						setSaving(false);
					}
				})();
			}, []);
			const handleAutoSyncChange = (0, react.useCallback)((next) => {
				setAutoSync(next);
				setSavingAutoSync(true);
				setStatus(null);
				(async () => {
					try {
						const { status: httpStatus, data } = await requestJson("/airremote/time", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ autoSync: next })
						});
						if (httpStatus === 200 && data.ok !== false) {
							setAutoSync(data.autoSync !== false);
							setStatus({
								tone: "ok",
								text: next ? "已开启自动对时" : "已关闭自动对时"
							});
						} else {
							setAutoSync(!next);
							setStatus({
								tone: "error",
								text: data.message ?? "保存失败"
							});
						}
					} catch {
						setAutoSync(!next);
						setStatus({
							tone: "error",
							text: "保存失败（无法连接本地服务）"
						});
					} finally {
						setSavingAutoSync(false);
					}
				})();
			}, []);
			const handleSync = (0, react.useCallback)(() => {
				if (syncing) return;
				setSyncing(true);
				setStatus(null);
				(async () => {
					const minutes = minutesForTimezone(timezone);
					try {
						const { status: httpStatus, data } = await requestJson("/airremote/sync-time", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ minutes })
						});
						if (httpStatus === 200 && data.ok === true) {
							const port = typeof data.port === "string" && data.port !== "" ? data.port : "串口";
							const when = typeof data.unix === "number" ? ` · ${formatLocalTime(data.unix)}` : "";
							setStatus({
								tone: "ok",
								text: `已同步 · ${port}${when}`
							});
						} else setStatus({
							tone: "error",
							text: syncFailureText(data.error, data.message)
						});
					} catch {
						setStatus({
							tone: "error",
							text: "同步失败（无法连接本地服务）"
						});
					} finally {
						setSyncing(false);
					}
				})();
			}, [syncing, timezone]);
			const controlStyle = {
				fontSize: "12px",
				padding: "4px 10px",
				borderRadius: "6px",
				border: "1px solid rgba(127, 127, 127, 0.4)",
				background: "rgba(127, 127, 127, 0.12)",
				color: "inherit"
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: "8px",
					padding: "4px 2px"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: "13px",
							fontWeight: 600
						},
						children: "开发板时间"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: "8px",
							alignItems: "center",
							flexWrap: "wrap"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								htmlFor: selectId,
								style: {
									fontSize: "12px",
									opacity: .75
								},
								children: "时区"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
								id: selectId,
								value: timezone,
								disabled: saving || syncing,
								onChange: (event) => handleTimezoneChange(event.target.value),
								style: controlStyle,
								children: TIMEZONE_OPTIONS.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: option.id,
									children: option.label
								}, option.id))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: syncing,
								onClick: handleSync,
								style: {
									...controlStyle,
									cursor: syncing ? "default" : "pointer",
									opacity: syncing ? .6 : 1
								},
								children: syncing ? "同步中…" : "同步到开发板"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						htmlFor: autoSyncId,
						style: {
							display: "flex",
							alignItems: "center",
							gap: "6px",
							fontSize: "12px",
							cursor: "pointer"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							id: autoSyncId,
							type: "checkbox",
							checked: autoSync,
							disabled: savingAutoSync,
							onChange: (event) => handleAutoSyncChange(event.target.checked),
							style: {
								accentColor: "inherit",
								margin: 0
							}
						}), "自动对时（连上开发板就校准时间）"]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: "11px",
							lineHeight: 1.5,
							opacity: .6
						},
						children: "默认开启：插件启动和每次连接开发板时，按上面选的时区把 host 时间写进板子。关闭后只有点「同步到开发板」 才会写时间。"
					}),
					status === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						role: "status",
						"aria-live": "polite",
						style: {
							fontSize: "12px",
							opacity: status.tone === "info" ? .6 : .9,
							color: status.tone === "error" ? "#e5534b" : "inherit"
						},
						children: status.text
					})
				]
			});
		}
		// src/client/FirmwareFlash.tsx
		/**
		* 「固件烧录」设置区块：浏览器端只负责展示固件身份、发起 / 取消烧录、渲染进度与日志；
		* 真正碰串口的烧录由宿主（Node 侧，同源 `/airremote/flash` WebSocket 路由）执行。
		*
		* 为什么不再用浏览器 Web Serial：DSH 桌面窗口是 Electron，宿主显式设置了
		* `setDevicePermissionHandler(() => false)`，浏览器侧的 Web Serial API 拿不到任何串口；
		* 而正式插件必须自包含，不能要求用户另开浏览器。宿主本来就有 serialport 依赖和
		* 串口占用协调（`/airremote/serial-hold`），把烧录放宿主既可用，也不会和「时间同步」抢串口。
		*
		* 固定协议：
		*   浏览器 → 宿主：{type:'start'} / {type:'cancel'}
		*   宿主 → 浏览器：
		*     {type:'state', phase:'idle'|'running'|'done'|'error'|'cancelled'}
		*     {type:'log', line}
		*     {type:'progress', percent, written, total}
		*     {type:'done', port, seconds}
		*     {type:'error', code, message}
		*     {type:'ping', at}
		*
		* 多连接语义：宿主允许同时挂多条 WS，设置页这条只是「观察者 + 可操作者」。
		* 已有烧录在跑时再发 start 会收到 `{type:'error', code:'busy'}`，但**连接不再断开**，
		* 所以它按普通错误显示、并保持可重试；`ping` 等未知 / 心跳消息一律静默忽略。
		*
		* 挂载只做两件事：GET `/airremote/firmware/manifest`、建立**一次** WS。不自动烧录、
		* 不轮询、不监听插拔；断线后只有用户点「重新连接」才会重连。
		*/
		const MAX_LOG_LINES = 200;
		const SUPPORTED_CHIP = "esp32c6";
		const FLASH_WS_PATH = "/airremote/flash";
		const NVS_WARNING = "烧录按段写入 bootloader / 分区表 / app / ota，不写 NVS 分区：开发板上的蓝牙配对、Wi-Fi 配网与时区都会保留。若烧录后仍出现配对异常，请在 Windows 删除该设备后重新配对。";
		const NVS_CONFIRM = "烧录会保留开发板上的蓝牙配对、Wi-Fi 配网与时区（不写 NVS 分区）。";
		/** 取消烧录的二次确认：中途中断会留下写了一半的固件，板子起不来。 */
		const CANCEL_CONFIRM = "中断烧录会清空 flash，开发板将无法启动，必须重新烧录才能恢复。确定中断？";
		/** 取消后的状态文案：强调板子当前不可启动，引导用户立刻重烧。 */
		const CANCELLED_TEXT = "烧录已中断，开发板处于不可启动状态，请重新烧录";
		/** 取消按钮旁边的小字，提前告知后果。 */
		const CANCEL_HINT = "中断烧录会让开发板无法启动，需重新烧录才能恢复";
		/** 宿主 error code → 中文。没有列出的 code（含 `internal`）直接用宿主的 message。 */
		const ERROR_TEXT = {
			"no-board": "未找到开发板（USB VID 303A）",
			"open-failed": "串口打不开（可能被占用）",
			timeout: "板子没有响应",
			rejected: "板子拒绝了命令",
			busy: "串口正被占用",
			"sha256-mismatch": "固件文件损坏（sha256 不匹配）",
			cancelled: "已取消"
		};
		function errorText(error) {
			if (error instanceof Error) return error.message === "" ? error.name : error.message;
			return typeof error === "string" ? error : "未知错误";
		}
		function formatBytes(bytes) {
			if (!Number.isFinite(bytes) || bytes < 0) return "未知";
			if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
			if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
			return `${bytes} B`;
		}
		function formatBuiltAt(value) {
			if (value === void 0 || value === "") return "未知";
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return value;
			return date.toLocaleString();
		}
		function formatSeconds(seconds) {
			if (seconds === null || !Number.isFinite(seconds)) return "耗时未知";
			return `${seconds.toFixed(1)}s`;
		}
		function describeError(code, message) {
			const known = ERROR_TEXT[code];
			if (known !== void 0) return known;
			const trimmed = message.trim();
			return trimmed === "" ? "烧录失败" : trimmed;
		}
		function parseManifest(value) {
			if (typeof value !== "object" || value === null) return null;
			const record = value;
			if (typeof record.version !== "string" || record.version === "") return null;
			if (typeof record.size !== "number" || !Number.isFinite(record.size) || record.size <= 0) return null;
			if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) return null;
			return {
				version: record.version,
				builtAt: typeof record.builtAt === "string" ? record.builtAt : void 0,
				size: record.size,
				sha256: record.sha256,
				chip: typeof record.chip === "string" && record.chip !== "" ? record.chip : SUPPORTED_CHIP
			};
		}
		function readPhase(value) {
			if (value === "idle" || value === "running" || value === "done") return value;
			if (value === "busy" || value === "error" || value === "cancelled") return value;
			return null;
		}
		/**
		* 设置区块：只有「固件身份 + 开始/取消 + 进度 + 日志」。
		* 串口选择、VID/PID、擦除整片这些都属于宿主侧决策，浏览器不再参与。
		*/
		function FirmwareFlash() {
			const [manifest, setManifest] = (0, react.useState)(null);
			const [manifestError, setManifestError] = (0, react.useState)(null);
			const [connection, setConnection] = (0, react.useState)("connecting");
			const [phase, setPhase] = (0, react.useState)("idle");
			const [startSent, setStartSent] = (0, react.useState)(false);
			const [cancelSent, setCancelSent] = (0, react.useState)(false);
			const [progress, setProgress] = (0, react.useState)(null);
			const [status, setStatus] = (0, react.useState)(null);
			const [lines, setLines] = (0, react.useState)([]);
			const socketRef = (0, react.useRef)(null);
			const logBoxRef = (0, react.useRef)(null);
			const appendLine = (0, react.useCallback)((line) => {
				setLines((previous) => {
					const next = previous.concat(line);
					return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
				});
			}, []);
			/** 处理宿主推来的每一条消息；只依赖稳定的 setter，因此引用恒定。 */
			const handleServerMessage = (0, react.useCallback)((raw) => {
				if (typeof raw !== "string") return;
				let value;
				try {
					value = JSON.parse(raw);
				} catch {
					return;
				}
				if (typeof value !== "object" || value === null) return;
				const message = value;
				switch (message.type) {
					case "state": {
						const next = readPhase(message.phase);
						if (next === null) return;
						setPhase(next);
						setStartSent(false);
						setCancelSent(false);
						if (next === "cancelled") setStatus({
							kind: "error",
							text: CANCELLED_TEXT
						});
						return;
					}
					case "busy": {
						setPhase("busy");
						setStartSent(false);
						const detail = typeof message.message === "string" ? message.message.trim() : "";
						setStatus({
							kind: "error",
							text: detail === "" ? "宿主侧已有烧录在进行中，请等它结束后重试。" : detail
						});
						return;
					}
					case "log":
						if (typeof message.line !== "string") return;
						appendLine(message.line);
						return;
					case "progress": {
						const written = typeof message.written === "number" && Number.isFinite(message.written) ? message.written : 0;
						const total = typeof message.total === "number" && Number.isFinite(message.total) ? message.total : 0;
						const computed = total > 0 ? Math.round(written / total * 100) : 0;
						const rawPercent = typeof message.percent === "number" && Number.isFinite(message.percent) ? message.percent : computed;
						setProgress({
							percent: Math.max(0, Math.min(100, Math.round(rawPercent))),
							written,
							total
						});
						return;
					}
					case "done": {
						const port = typeof message.port === "string" && message.port !== "" ? message.port : "未知串口";
						const seconds = typeof message.seconds === "number" && Number.isFinite(message.seconds) ? message.seconds : null;
						setPhase("done");
						setStartSent(false);
						setCancelSent(false);
						setProgress((previous) => previous === null ? previous : {
							...previous,
							percent: 100
						});
						setStatus({
							kind: "done",
							port,
							seconds
						});
						return;
					}
					case "error": {
						const code = typeof message.code === "string" ? message.code : "internal";
						const hostMessage = typeof message.message === "string" ? message.message.trim() : "";
						const text = code === "busy" && hostMessage !== "" ? hostMessage : describeError(code, hostMessage);
						setStartSent(false);
						setCancelSent(false);
						if (code === "cancelled") {
							setPhase("cancelled");
							setStatus({
								kind: "error",
								text: CANCELLED_TEXT
							});
							return;
						}
						setPhase("error");
						setStatus({
							kind: "error",
							text
						});
						return;
					}
					case "ping": return;
					default: return;
				}
			}, [appendLine]);
			/**
			* 建一次连接。只有两种调用者：挂载时（一次）+ 用户点「重新连接」。
			* 没有重连定时器，onclose 之后不会再自己连回去。
			*/
			const connect = (0, react.useCallback)(() => {
				const current = socketRef.current;
				if (current !== null && (current.readyState === WebSocket.CONNECTING || current.readyState === WebSocket.OPEN)) return;
				const url = `${location.protocol === "https:" ? "wss://" : "ws://"}${location.host}${FLASH_WS_PATH}`;
				let socket;
				try {
					socket = new WebSocket(url);
				} catch (error) {
					setConnection("closed");
					setStatus({
						kind: "error",
						text: `连接烧录服务失败：${errorText(error)}`
					});
					return;
				}
				socketRef.current = socket;
				setConnection("connecting");
				setStatus(null);
				socket.onopen = () => {
					if (socketRef.current !== socket) return;
					setConnection("open");
				};
				socket.onmessage = (event) => {
					if (socketRef.current !== socket) return;
					handleServerMessage(event.data);
				};
				socket.onerror = () => void 0;
				socket.onclose = () => {
					if (socketRef.current !== socket) return;
					socketRef.current = null;
					setConnection("closed");
					setStartSent(false);
					setCancelSent(false);
				};
			}, [handleServerMessage]);
			(0, react.useEffect)(() => {
				let alive = true;
				(async () => {
					try {
						const response = await fetch("/airremote/firmware/manifest", {
							headers: { Accept: "application/json" },
							cache: "no-store"
						});
						const body = await response.json().catch(() => null);
						if (!alive) return;
						if (!response.ok) {
							const record = typeof body === "object" && body !== null ? body : null;
							const message = record !== null && typeof record.message === "string" ? record.message : `HTTP ${response.status}`;
							setManifestError(message);
							return;
						}
						const parsed = parseManifest(body);
						if (parsed === null) {
							setManifestError("固件清单格式不正确");
							return;
						}
						setManifest(parsed);
					} catch (error) {
						if (!alive) return;
						setManifestError(errorText(error));
					}
				})();
				return () => {
					alive = false;
				};
			}, []);
			(0, react.useEffect)(() => {
				connect();
				return () => {
					const socket = socketRef.current;
					socketRef.current = null;
					if (socket === null) return;
					socket.onopen = null;
					socket.onmessage = null;
					socket.onerror = null;
					socket.onclose = null;
					socket.close();
				};
			}, [connect]);
			(0, react.useEffect)(() => {
				const box = logBoxRef.current;
				if (box !== null) box.scrollTop = box.scrollHeight;
			}, [lines]);
			/** 往宿主发一条指令；连接不在时给出可见提示而不是静默失败。 */
			const send = (0, react.useCallback)((payload) => {
				const socket = socketRef.current;
				if (socket === null || socket.readyState !== WebSocket.OPEN) {
					setStatus({
						kind: "error",
						text: "烧录服务未连接，请先点「重新连接」。"
					});
					return false;
				}
				socket.send(JSON.stringify(payload));
				return true;
			}, []);
			const manifestChipOk = manifest !== null && manifest.chip.toLowerCase() === SUPPORTED_CHIP;
			const inFlight = phase === "running" || startSent;
			const canStart = connection === "open" && manifest !== null && manifestChipOk && !inFlight;
			const canCancel = connection === "open" && phase === "running" && !cancelSent;
			const handleStart = (0, react.useCallback)(() => {
				const current = manifest;
				if (current === null) {
					setStatus({
						kind: "error",
						text: "内置固件不可用，无法烧录。"
					});
					return;
				}
				if (!manifestChipOk) {
					setStatus({
						kind: "error",
						text: `固件清单芯片为「${current.chip}」，与 ESP32-C6 不匹配，已禁用烧录。`
					});
					return;
				}
				if (inFlight) return;
				if (!window.confirm(`即将烧录固件 v${current.version}\nsha256：${current.sha256.slice(0, 8)}…\n芯片：${SUPPORTED_CHIP}\n\n将覆盖开发板上的固件。${NVS_CONFIRM}\n\n过程中请勿拔线。确定继续？`)) {
					setStatus({
						kind: "info",
						text: "已取消烧录"
					});
					return;
				}
				setProgress(null);
				setLines([]);
				setCancelSent(false);
				setStatus({
					kind: "info",
					text: "已发送烧录指令，等待宿主接管串口…"
				});
				if (!send({ type: "start" })) return;
				setStartSent(true);
			}, [
				inFlight,
				manifest,
				manifestChipOk,
				send
			]);
			const handleCancel = (0, react.useCallback)(() => {
				if (!canCancel) return;
				if (!window.confirm(CANCEL_CONFIRM)) return;
				if (!send({ type: "cancel" })) return;
				setCancelSent(true);
				setStatus({
					kind: "info",
					text: "已发送中断请求，等待宿主结束烧录…"
				});
			}, [canCancel, send]);
			const controlStyle = {
				fontSize: "12px",
				padding: "4px 10px",
				borderRadius: "6px",
				border: "1px solid rgba(127, 127, 127, 0.4)",
				background: "rgba(127, 127, 127, 0.12)",
				color: "inherit"
			};
			const mutedStyle = {
				fontSize: "12px",
				opacity: .6
			};
			const sha256Short = manifest === null ? "" : manifest.sha256.slice(0, 8);
			const showRetry = connection === "open" && !inFlight && manifest !== null && (phase === "error" || phase === "cancelled" || status !== null && status.kind === "error");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: "10px",
					padding: "4px 2px"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: "13px",
							fontWeight: 600
						},
						children: "固件烧录"
					}),
					manifestError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: mutedStyle,
						children: ["内置固件不可用：", manifestError]
					}) : manifest === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: mutedStyle,
						children: "正在读取内置固件信息…"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "grid",
							gridTemplateColumns: "auto 1fr",
							columnGap: "12px",
							rowGap: "3px",
							fontSize: "12px"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { opacity: .65 },
								children: "版本"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: { fontWeight: 600 },
								children: ["固件 v", manifest.version]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { opacity: .65 },
								children: "构建时间"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: formatBuiltAt(manifest.builtAt) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { opacity: .65 },
								children: "大小"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: formatBytes(manifest.size) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { opacity: .65 },
								children: "sha256"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								title: manifest.sha256,
								children: [sha256Short, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { opacity: .6 },
									children: "…"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { opacity: .65 },
								children: "芯片"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: manifest.chip })
						]
					}),
					manifest !== null && !manifestChipOk ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							fontSize: "12px",
							color: "#e5534b"
						},
						children: [
							"固件清单芯片为「",
							manifest.chip,
							"」，与 ESP32-C6 不匹配，已禁用烧录。"
						]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: "11px",
							opacity: .6,
							lineHeight: 1.55
						},
						children: NVS_WARNING
					}),
					connection === "closed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						role: "status",
						style: {
							display: "flex",
							gap: "8px",
							alignItems: "center",
							flexWrap: "wrap",
							fontSize: "12px",
							lineHeight: 1.55,
							padding: "6px 8px",
							borderRadius: "6px",
							background: "rgba(229, 83, 75, 0.1)",
							color: "#e5534b"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "已断开，点「重新连接」" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: connect,
							style: {
								...controlStyle,
								padding: "2px 8px",
								cursor: "pointer",
								color: "inherit"
							},
							children: "重新连接"
						})]
					}) : connection === "connecting" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: mutedStyle,
						children: "正在连接烧录服务…"
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: "8px",
							alignItems: "center",
							flexWrap: "wrap"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: !canStart,
								onClick: handleStart,
								style: {
									...controlStyle,
									cursor: canStart ? "pointer" : "default",
									opacity: canStart ? 1 : .6
								},
								children: inFlight ? "烧录中…" : "开始烧录"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: !canCancel,
								onClick: handleCancel,
								style: {
									...controlStyle,
									cursor: canCancel ? "pointer" : "default",
									opacity: canCancel ? 1 : .6
								},
								children: cancelSent ? "取消中…" : "取消"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: "11px",
									opacity: .6,
									color: "#e5534b"
								},
								children: CANCEL_HINT
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: "11px",
									opacity: .55
								},
								children: "由宿主通过 USB 串口烧录，浏览器不接触串口"
							})
						]
					}),
					progress === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: "4px"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: "8px",
								alignItems: "center",
								fontSize: "12px"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								phase === "running" ? "写入中" : "写入",
								" · ",
								progress.percent,
								"%"
							] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: { opacity: .6 },
								children: [
									formatBytes(progress.written),
									" / ",
									formatBytes(progress.total)
								]
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							role: "progressbar",
							"aria-valuemin": 0,
							"aria-valuemax": 100,
							"aria-valuenow": progress.percent,
							style: {
								height: "6px",
								borderRadius: "3px",
								background: "rgba(127, 127, 127, 0.2)",
								overflow: "hidden"
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
								height: "100%",
								width: `${progress.percent}%`,
								background: "#4c8bf5",
								transition: "width 120ms linear"
							} })
						})]
					}),
					status === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						role: "status",
						"aria-live": "polite",
						style: {
							display: "flex",
							gap: "8px",
							alignItems: "center",
							flexWrap: "wrap",
							fontSize: "12px",
							opacity: status.kind === "info" ? .7 : .95,
							color: status.kind === "error" ? "#e5534b" : "inherit"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: status.kind === "done" ? `烧录完成 · 固件 v${manifest === null ? "?" : manifest.version} · ${status.port} · ${formatSeconds(status.seconds)}；配对/配网/时区已保留。` : status.text }), showRetry ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: handleStart,
							style: {
								...controlStyle,
								padding: "2px 8px",
								cursor: "pointer"
							},
							children: "重试"
						}) : null]
					}),
					lines.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						ref: logBoxRef,
						style: {
							maxHeight: "180px",
							overflow: "auto",
							border: "1px solid rgba(127, 127, 127, 0.25)",
							borderRadius: "6px",
							padding: "6px 8px",
							background: "rgba(127, 127, 127, 0.08)",
							fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
							fontSize: "11px",
							lineHeight: 1.45,
							whiteSpace: "pre-wrap",
							wordBreak: "break-all"
						},
						children: lines.map((line, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: line === "" ? "\xA0" : line }, index))
					})
				]
			});
		}
		// src/client/voice-state.ts
		function createVoiceState() {
			let snapshot = {
				phase: "idle",
				detail: "",
				lastTranscript: ""
			};
			const listeners = /* @__PURE__ */ new Set();
			return {
				get: () => snapshot,
				set(next) {
					snapshot = {
						...snapshot,
						...next
					};
					for (const listener of listeners) listener();
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				}
			};
		}
		// src/client/virtual-mic.ts
		const VIRTUAL_DEVICE_ID = "airremote";
		const VIRTUAL_DEVICE_LABEL = "Air Remote (ESP32-C6)";
		const AUDIO_ROUTE = "/airremote/audio";
		const VOICE_PREFERENCE_KEY = "dsh.voice-input.microphone";
		const BOARD_SAMPLE_RATE = 16e3;
		const JITTER_SECONDS = .12;
		const START_LEAD_SECONDS = .08;
		const RECONNECT_DELAYS_MS = [
			1e3,
			2500,
			5e3
		];
		const sessions = /* @__PURE__ */ new Map();
		function isVirtualConstraints(constraints) {
			const audio = constraints?.audio;
			if (typeof audio !== "object" || audio === null) return false;
			const deviceId = audio.deviceId;
			if (typeof deviceId === "string") return deviceId === VIRTUAL_DEVICE_ID;
			if (typeof deviceId === "object" && deviceId !== null && "exact" in deviceId) {
				const exact = deviceId.exact;
				if (typeof exact === "string") return exact === VIRTUAL_DEVICE_ID;
				if (Array.isArray(exact)) return exact.includes(VIRTUAL_DEVICE_ID);
			}
			return false;
		}
		function audioUrl(options) {
			if (options.audioUrl !== void 0) return options.audioUrl;
			const injected = globalThis.__AIRREMOTE_AUDIO_URL__;
			if (typeof injected === "string" && injected !== "") return injected;
			const origin = typeof location === "undefined" ? "" : location.origin;
			if (origin.startsWith("http://") || origin.startsWith("https://")) return `${origin.replace(/^http/, "ws")}${AUDIO_ROUTE}`;
			return `ws://127.0.0.1:${typeof location === "undefined" ? "57648" : location.port || "57648"}${AUDIO_ROUTE}`;
		}
		function decodePcm16(buffer) {
			const view = new DataView(buffer);
			const count = Math.floor(buffer.byteLength / 2);
			const samples = new Float32Array(count);
			for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
			return samples;
		}
		function resample(samples, from, to) {
			if (from === to || samples.length === 0) return samples;
			const ratio = to / from;
			const length = Math.max(1, Math.round(samples.length * ratio));
			const out = new Float32Array(length);
			for (let i = 0; i < length; i++) {
				const position = i / ratio;
				const left = Math.floor(position);
				const right = Math.min(samples.length - 1, left + 1);
				const fraction = position - left;
				out[i] = samples[left] * (1 - fraction) + samples[right] * fraction;
			}
			return out;
		}
		var VirtualMicSession = class {
			stream;
			context;
			destination;
			track;
			status;
			url;
			ws;
			begun = false;
			ended = false;
			reconnectAttempt = 0;
			reconnectTimer;
			pending = [];
			pendingSamples = 0;
			nextTime = 0;
			started = false;
			sources = /* @__PURE__ */ new Set();
			resumeOnGesture = () => {
				this.resume();
			};
			constructor(context, destination, status, url) {
				this.context = context;
				this.destination = destination;
				this.stream = destination.stream;
				this.track = this.stream.getAudioTracks()[0];
				this.status = status;
				this.url = url;
				this.labelTrack();
				this.patchTrackStop();
			}
			labelTrack() {
				try {
					Object.defineProperty(this.track, "label", {
						configurable: true,
						get: () => VIRTUAL_DEVICE_LABEL
					});
				} catch {}
				try {
					const original = this.track.getSettings.bind(this.track);
					Object.defineProperty(this.track, "getSettings", {
						configurable: true,
						value: () => ({
							...original(),
							deviceId: VIRTUAL_DEVICE_ID,
							groupId: VIRTUAL_DEVICE_ID
						})
					});
				} catch {}
			}
			patchTrackStop() {
				const original = this.track.stop.bind(this.track);
				try {
					Object.defineProperty(this.track, "stop", {
						configurable: true,
						value: () => {
							original();
							this.dispose();
						}
					});
				} catch {}
				this.track.addEventListener("ended", () => this.dispose(), { once: true });
			}
			/** Called from the MediaRecorder.start patch, i.e. only for real capture, not settings previews. */
			begin() {
				if (this.begun || this.ended) return;
				this.begun = true;
				this.status?.set({
					phase: "connecting",
					detail: "正在连接开发板…"
				});
				this.resume();
				if (typeof document !== "undefined") document.addEventListener("pointerdown", this.resumeOnGesture, { once: true });
				this.connect();
			}
			resume() {
				if (this.context.state === "suspended") return this.context.resume();
				return Promise.resolve();
			}
			connect() {
				if (this.ended) return;
				let socket;
				try {
					socket = new WebSocket(this.url);
				} catch (error) {
					this.fail(`无法连接音频通道：${error instanceof Error ? error.message : String(error)}`);
					return;
				}
				socket.binaryType = "arraybuffer";
				this.ws = socket;
				socket.onopen = () => {
					if (this.ended) {
						socket.close();
						return;
					}
					this.reconnectAttempt = 0;
					this.status?.set({
						phase: "waiting",
						detail: "等待开发板（请在板子上点 Voice）…"
					});
					socket.send(JSON.stringify({ type: "start" }));
				};
				socket.onmessage = (event) => {
					if (this.ended) return;
					if (typeof event.data === "string") this.onControl(event.data);
					else if (event.data instanceof ArrayBuffer) this.ingest(event.data);
				};
				socket.onerror = () => {};
				socket.onclose = () => {
					this.ws = void 0;
					if (this.ended) return;
					if (this.reconnectAttempt < RECONNECT_DELAYS_MS.length) {
						const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt];
						this.reconnectAttempt += 1;
						this.status?.set({
							phase: "reconnecting",
							detail: `音频通道断开，${String(Math.round(delay / 1e3))} 秒后重连…`
						});
						this.reconnectTimer = window.setTimeout(() => {
							this.reconnectTimer = void 0;
							this.connect();
						}, delay);
					} else this.fail("音频通道断开，请重新点击官方麦克风");
				};
			}
			onControl(text) {
				let message;
				try {
					message = JSON.parse(text);
				} catch {
					return;
				}
				if (message.type === "state") {
					const state = typeof message.state === "string" ? message.state : "";
					const detail = typeof message.detail === "string" ? message.detail : "";
					if (state === "live") this.status?.set({
						phase: "live",
						detail: detail === "" ? "录音中" : detail
					});
					else if (state === "error") this.status?.set({
						phase: "error",
						detail
					});
					else if (state === "ended") this.status?.set({
						phase: "done",
						detail
					});
					else this.status?.set({
						phase: "connecting",
						detail
					});
					return;
				}
				if (message.type === "ended") {
					const reason = typeof message.reason === "string" ? message.reason : "";
					const detail = typeof message.detail === "string" ? message.detail : "";
					this.ended = true;
					sessions.delete(this.stream);
					this.stopSources();
					try {
						this.ws?.close();
					} catch {}
					this.ws = void 0;
					if (reason === "error" || reason === "timeout") this.status?.set({
						phase: "error",
						detail
					});
					else this.status?.set({
						phase: "done",
						detail: detail === "" ? "已完成" : detail
					});
					this.scheduleClose();
					return;
				}
				if (message.type === "busy") this.fail(typeof message.detail === "string" ? message.detail : "另一个页面正在使用 Air Remote");
			}
			ingest(buffer) {
				if (buffer.byteLength < 2) return;
				const resampled = resample(decodePcm16(buffer), BOARD_SAMPLE_RATE, this.context.sampleRate);
				const audio = this.context.createBuffer(1, resampled.length, this.context.sampleRate);
				audio.getChannelData(0).set(resampled);
				this.pending.push(audio);
				this.pendingSamples += resampled.length;
				this.pump();
			}
			pump() {
				if (this.ended) return;
				if (!this.started) {
					if (this.pendingSamples < this.context.sampleRate * JITTER_SECONDS) return;
					this.started = true;
					this.nextTime = this.context.currentTime + START_LEAD_SECONDS;
				}
				while (this.pending.length > 0) {
					const buffer = this.pending.shift();
					this.pendingSamples -= buffer.length;
					if (this.nextTime < this.context.currentTime - .05) this.nextTime = this.context.currentTime + .05;
					if (this.nextTime - this.context.currentTime > 1) continue;
					const source = this.context.createBufferSource();
					source.buffer = buffer;
					source.connect(this.destination);
					source.onended = () => this.sources.delete(source);
					this.sources.add(source);
					source.start(this.nextTime);
					this.nextTime += buffer.duration;
				}
			}
			stopSources() {
				for (const source of this.sources) try {
					source.stop();
				} catch {}
				this.sources.clear();
				this.pending.length = 0;
				this.pendingSamples = 0;
			}
			fail(detail) {
				if (this.ended) return;
				this.ended = true;
				sessions.delete(this.stream);
				this.status?.set({
					phase: "error",
					detail
				});
				this.stopSources();
				try {
					this.ws?.close();
				} catch {}
				this.ws = void 0;
				this.scheduleClose();
			}
			/** Host ended the session or the official plugin stopped the track. */
			dispose() {
				if (this.ended) {
					this.scheduleClose();
					return;
				}
				this.ended = true;
				sessions.delete(this.stream);
				if (this.reconnectTimer !== void 0) window.clearTimeout(this.reconnectTimer);
				this.reconnectTimer = void 0;
				if (this.ws?.readyState === WebSocket.OPEN) try {
					this.ws.send(JSON.stringify({
						type: "stop",
						draft: true
					}));
				} catch {}
				try {
					this.ws?.close();
				} catch {}
				this.ws = void 0;
				this.stopSources();
				if (this.status?.get().phase !== "error") this.status?.set({
					phase: "done",
					detail: "已完成"
				});
				this.scheduleClose();
			}
			scheduleClose() {
				if (typeof document !== "undefined") document.removeEventListener("pointerdown", this.resumeOnGesture);
				window.setTimeout(() => {
					this.context.close().catch(() => void 0);
				}, 400);
			}
		};
		function createSession(status, url) {
			const context = new AudioContext({ latencyHint: "interactive" });
			const session = new VirtualMicSession(context, context.createMediaStreamDestination(), status, url);
			sessions.set(session.stream, {
				stream: session.stream,
				session
			});
			return session;
		}
		function seedPreference() {
			try {
				const raw = localStorage.getItem(VOICE_PREFERENCE_KEY);
				if (raw === null) {
					localStorage.setItem(VOICE_PREFERENCE_KEY, JSON.stringify({
						id: VIRTUAL_DEVICE_ID,
						label: VIRTUAL_DEVICE_LABEL
					}));
					return;
				}
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object" || parsed.id === "" || parsed.id === void 0) localStorage.setItem(VOICE_PREFERENCE_KEY, JSON.stringify({
					id: VIRTUAL_DEVICE_ID,
					label: VIRTUAL_DEVICE_LABEL
				}));
			} catch {}
		}
		/**
		* Install the device-list and acquisition patches. Returns an idempotent
		* disposer that restores every prototype method and releases live sessions.
		*/
		function installVirtualMicrophone(options = {}) {
			if (typeof navigator === "undefined" || navigator.mediaDevices === void 0) return () => void 0;
			const media = navigator.mediaDevices;
			const prototype = Object.getPrototypeOf(media);
			const originalEnumerate = prototype.enumerateDevices;
			const originalGetUserMedia = prototype.getUserMedia;
			if (typeof originalEnumerate !== "function" || typeof originalGetUserMedia !== "function") return () => void 0;
			const url = audioUrl(options);
			seedPreference();
			prototype.enumerateDevices = async function enumerateDevices() {
				const devices = await originalEnumerate.call(this);
				if (devices.some((device) => device.deviceId === "airremote")) return devices;
				const virtual = {
					deviceId: VIRTUAL_DEVICE_ID,
					groupId: VIRTUAL_DEVICE_ID,
					kind: "audioinput",
					label: VIRTUAL_DEVICE_LABEL,
					toJSON() {
						return {
							deviceId: VIRTUAL_DEVICE_ID,
							groupId: VIRTUAL_DEVICE_ID,
							kind: "audioinput",
							label: VIRTUAL_DEVICE_LABEL
						};
					}
				};
				return [...devices, virtual];
			};
			prototype.getUserMedia = async function getUserMedia(constraints) {
				if (isVirtualConstraints(constraints)) return createSession(options.status, url).stream;
				return originalGetUserMedia.call(this, constraints);
			};
			const recorderPrototype = typeof MediaRecorder === "undefined" ? void 0 : MediaRecorder.prototype;
			const originalStart = recorderPrototype?.start;
			if (recorderPrototype !== void 0 && typeof originalStart === "function") recorderPrototype.start = function start(...args) {
				try {
					sessions.get(this.stream)?.session.begin();
				} catch {}
				return originalStart.apply(this, args);
			};
			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				prototype.enumerateDevices = originalEnumerate;
				prototype.getUserMedia = originalGetUserMedia;
				if (recorderPrototype !== void 0 && typeof originalStart === "function") recorderPrototype.start = originalStart;
				for (const entry of [...sessions.values()]) {
					sessions.delete(entry.stream);
					entry.session.dispose();
				}
			};
		}
		// src/client/index.ts
		/**
		* Client entry: install the virtual microphone that the official DSH
		* voice-input plugin consumes. There is deliberately no microphone button here
		* — the official plugin owns the trigger, recording UI and recognition.
		*/
		const inject = ["slots"];
		async function apply(ctx) {
			const voiceState = createVoiceState();
			const disposeMicrophone = installVirtualMicrophone({ status: voiceState });
			ctx.effect(() => disposeMicrophone, "dsh-airremote virtual microphone");
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "dsh-airremote-status",
				order: 16,
				inject: () => ({ voiceState })
			}, AirRemoteBar));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "airremote-time",
				order: 40,
				label: "开发板时间"
			}, DevBoardTime));
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "airremote-firmware",
				order: 41,
				label: "固件烧录"
			}, FirmwareFlash));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
