import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { connect as connect$1 } from "node:tls";
import { execFile } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { dirname, join } from "node:path";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { readFile, stat } from "node:fs/promises";
function parseAudioFrame(payload) {
	if (payload.length <= 4) return void 0;
	if ((payload.length - 4) % 2 !== 0) return void 0;
	return {
		sequence: payload.readUInt32BE(0),
		pcm: payload.subarray(4)
	};
}
function encodeAudioFrame(sequence, pcm) {
	const out = Buffer.allocUnsafe(4 + pcm.length);
	out.writeUInt32BE(sequence >>> 0, 0);
	pcm.copy(out, 4);
	return out;
}
/** Signaling strings accepted by the firmware. */
const AUTH = "AUTH";
const READY2 = "READY2";
const CAPTURE = "CAPTURE";
const PULL = "PULL";
const WAIT = "WAIT";
const ABORT = "ABORT";
const DRAFTED = "DRAFTED";
const CANCELLED = "CANCELLED";
/** `AUTH ` plus the 64-character pairing token, exactly 69 bytes (checked by the firmware). */
function authMessage(token) {
	const normalized = token.trim();
	if (normalized.length !== 64) throw new Error(`airremote: pairing token must be 64 characters, got ${String(normalized.length)}`);
	return `${AUTH} ${normalized}`;
}
// src/host/ws.ts
/**
* Minimal RFC 6455 WebSocket implementation for the two links this plugin owns:
*
*  - browser  -> host: the `dsh-host-webserver` upgrade route (`/airremote/audio`)
*  - host     -> board: the TLS WebSocket client the ESP32-C6 `voice.c` serves on 47683
*
* The plugin deliberately carries no runtime dependency beyond Node builtins, so
* this file implements the small subset both peers need: the opening handshake,
* masked client frames, unmasked server frames, text/binary/close/ping/pong, and
* continuation frames. No extensions (permessage-deflate) are negotiated.
*/
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const EMPTY = Buffer.alloc(0);
function frameHeader(opcode, length, masked) {
	let header;
	if (length < 126) {
		header = Buffer.alloc(2);
		header[1] = length;
	} else if (length <= 65535) {
		header = Buffer.alloc(4);
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	header[0] = 128 | opcode & 15;
	header[1] |= masked ? 128 : 0;
	return header;
}
/** Encode one complete (unfragmented) frame. */
function encodeFrame(opcode, payload, masked) {
	const header = frameHeader(opcode, payload.length, masked);
	if (!masked) return Buffer.concat([header, payload]);
	const key = randomBytes(4);
	const body = Buffer.allocUnsafe(payload.length);
	for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ key[i & 3];
	return Buffer.concat([
		header,
		key,
		body
	]);
}
const OP_CONTINUATION = 0;
const OP_TEXT = 1;
const OP_BINARY = 2;
const OP_CLOSE = 8;
const OP_PING = 9;
const OP_PONG = 10;
/** Incremental frame parser shared by both ends. */
var FrameReader = class {
	masked;
	handlers;
	sendControl;
	notifyClose;
	buffer = EMPTY;
	fragments = [];
	fragmentOpcode = 0;
	closed = false;
	constructor(masked, handlers, sendControl, notifyClose) {
		this.masked = masked;
		this.handlers = handlers;
		this.sendControl = sendControl;
		this.notifyClose = notifyClose;
	}
	push(chunk) {
		if (chunk.length === 0 || this.closed) return;
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const parsed = this.parseOne();
			if (parsed === void 0) return;
			if (parsed === null) {
				this.closed = true;
				return;
			}
		}
	}
	/** @returns true when a frame was consumed, undefined when more bytes are needed, null when closed. */
	parseOne() {
		const b = this.buffer;
		if (b.length < 2) return void 0;
		const fin = (b[0] & 128) !== 0;
		const rsv = b[0] & 112;
		const opcode = b[0] & 15;
		const hasMask = (b[1] & 128) !== 0;
		let length = b[1] & 127;
		let offset = 2;
		if (rsv !== 0) {
			this.fail(1002, "reserved bits set");
			return null;
		}
		if (hasMask !== this.masked) {
			this.fail(1002, this.masked ? "client frame is not masked" : "server frame is masked");
			return null;
		}
		if (length === 126) {
			if (b.length < 4) return void 0;
			length = b.readUInt16BE(2);
			offset = 4;
		} else if (length === 127) {
			if (b.length < 10) return void 0;
			const big = b.readBigUInt64BE(2);
			if (big > BigInt(16777216)) {
				this.fail(1009, "frame too large");
				return null;
			}
			length = Number(big);
			offset = 10;
		}
		if (length > 8388608) {
			this.fail(1009, "frame too large");
			return null;
		}
		let maskKey;
		if (hasMask) {
			if (b.length < offset + 4) return void 0;
			maskKey = b.subarray(offset, offset + 4);
			offset += 4;
		}
		if (b.length < offset + length) return void 0;
		let payload = b.subarray(offset, offset + length);
		if (maskKey !== void 0) {
			const unmasked = Buffer.allocUnsafe(length);
			for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ maskKey[i & 3];
			payload = unmasked;
		}
		this.buffer = b.subarray(offset + length);
		if (opcode >= 8) {
			if (!fin || length > 125) {
				this.fail(1002, "invalid control frame");
				return null;
			}
			if (opcode === OP_CLOSE) {
				const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
				const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
				this.closed = true;
				try {
					this.sendControl(OP_CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : EMPTY);
				} catch {}
				this.notifyClose(code, reason);
				return null;
			}
			if (opcode === OP_PING) {
				this.sendControl(OP_PONG, payload);
				return true;
			}
			if (opcode === OP_PONG) return true;
			this.fail(1002, `unknown control opcode ${String(opcode)}`);
			return null;
		}
		if (opcode === OP_CONTINUATION) {
			if (this.fragmentOpcode === 0) {
				this.fail(1002, "continuation without a message");
				return null;
			}
			this.fragments.push(payload);
			if (fin) {
				const complete = Buffer.concat(this.fragments);
				const kind = this.fragmentOpcode;
				this.fragments = [];
				this.fragmentOpcode = 0;
				this.dispatch(kind, complete);
			}
			return true;
		}
		if (this.fragmentOpcode !== 0) {
			this.fail(1002, "new message before the previous one ended");
			return null;
		}
		if (fin) this.dispatch(opcode, payload);
		else {
			this.fragmentOpcode = opcode;
			this.fragments = [payload];
		}
		return true;
	}
	dispatch(opcode, payload) {
		if (opcode === OP_TEXT) this.handlers.onMessage?.({
			type: "text",
			text: payload.toString("utf8")
		});
		else if (opcode === OP_BINARY) this.handlers.onMessage?.({
			type: "binary",
			data: payload
		});
		else this.fail(1002, `unknown data opcode ${String(opcode)}`);
	}
	fail(code, reason) {
		this.closed = true;
		try {
			this.sendControl(OP_CLOSE, closePayload(code, reason));
		} catch {}
		this.notifyClose(code, reason);
	}
};
function closePayload(code, reason) {
	const text = Buffer.from(reason, "utf8").subarray(0, 123);
	const payload = Buffer.allocUnsafe(2 + text.length);
	payload.writeUInt16BE(code, 0);
	text.copy(payload, 2);
	return payload;
}
/** Shared connection wrapper around a duplex socket. */
var Connection = class {
	socket;
	incomingMasked;
	outgoingMasked;
	handlers;
	open = true;
	reader;
	closeSent = false;
	constructor(socket, incomingMasked, outgoingMasked, handlers, head) {
		this.socket = socket;
		this.incomingMasked = incomingMasked;
		this.outgoingMasked = outgoingMasked;
		this.handlers = handlers;
		this.reader = new FrameReader(incomingMasked, handlers, (opcode, payload) => {
			this.write(encodeFrame(opcode, payload, outgoingMasked));
		}, (code, reason) => {
			if (this.open) {
				this.open = false;
				handlers.onClose?.(code, reason);
			}
		});
		socket.on("data", (chunk) => {
			this.reader.push(chunk);
		});
		socket.on("error", (error) => {
			this.open = false;
			handlers.onError?.(error);
		});
		socket.on("close", () => {
			if (this.open) {
				this.open = false;
				handlers.onClose?.(1006, "socket closed");
			}
		});
		if (head !== void 0 && head.length > 0) this.reader.push(head);
	}
	write(data) {
		if (!this.open || this.socket.destroyed) return false;
		try {
			return this.socket.write(data);
		} catch (error) {
			this.open = false;
			this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
			return false;
		}
	}
	sendText(text) {
		return this.write(encodeFrame(OP_TEXT, Buffer.from(text, "utf8"), this.outgoingMasked));
	}
	sendBinary(data) {
		return this.write(encodeFrame(OP_BINARY, Buffer.from(data), this.outgoingMasked));
	}
	close(code = 1e3, reason = "") {
		if (!this.open || this.closeSent) return;
		this.closeSent = true;
		this.write(encodeFrame(OP_CLOSE, closePayload(code, reason), this.outgoingMasked));
		this.open = false;
		this.socket.end();
		setTimeout(() => this.socket.destroy(), 500).unref?.();
	}
	terminate() {
		this.open = false;
		this.socket.destroy();
	}
};
/** Complete the server-side opening handshake for one `upgrade` event. */
function acceptWebSocket(req, socket, head, handlers) {
	const key = req.headers["sec-websocket-key"];
	const upgrade = req.headers.upgrade;
	if (typeof key !== "string" || key.length === 0 || typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") {
		socket.destroy();
		throw new Error("websocket: not an RFC 6455 upgrade request");
	}
	if (req.headers["sec-websocket-version"] !== "13") {
		socket.write("HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\n\r\n");
		socket.destroy();
		throw new Error("websocket: unsupported version");
	}
	const accept = createHash("sha1").update(key + GUID).digest("base64");
	socket.write([
		"HTTP/1.1 101 Switching Protocols",
		"Upgrade: websocket",
		"Connection: Upgrade",
		`Sec-WebSocket-Accept: ${accept}`,
		"",
		""
	].join("\r\n"));
	return new Connection(socket, true, false, handlers, head);
}
/**
* Open a WebSocket client. The socket is returned after the 101 response, so
* callers can send AUTH immediately; connection failures reject.
*/
function connectWebSocket(options, handlers) {
	const timeoutMs = options.timeoutMs ?? 1e4;
	return new Promise((resolve, reject) => {
		let socket;
		let settled = false;
		let buffer = EMPTY;
		const fail = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				socket.destroy();
			} catch {}
			reject(error);
		};
		const timer = setTimeout(() => fail(/* @__PURE__ */ new Error(`websocket: connect timed out after ${String(timeoutMs)} ms`)), timeoutMs);
		timer.unref?.();
		if (options.tls === void 0) {
			socket = connect({
				host: options.host,
				port: options.port
			});
			socket.once("connect", sendUpgrade);
		} else {
			socket = connect$1({
				host: options.host,
				port: options.port,
				servername: options.tls.servername,
				ca: options.tls.ca,
				rejectUnauthorized: options.tls.rejectUnauthorized ?? false
			});
			socket.once("secureConnect", sendUpgrade);
		}
		socket.on("error", (error) => fail(error));
		socket.on("close", () => {
			if (!settled) fail(/* @__PURE__ */ new Error("websocket: socket closed before the handshake completed"));
		});
		function sendUpgrade() {
			const key = randomBytes(16).toString("base64");
			const hostHeader = options.host.includes(":") ? `[${options.host}]:${String(options.port)}` : `${options.host}:${String(options.port)}`;
			const request = [
				`GET ${options.path} HTTP/1.1`,
				`Host: ${hostHeader}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Key: ${key}`,
				"Sec-WebSocket-Version: 13",
				"",
				""
			].join("\r\n");
			socket.write(request);
			socket.on("data", (chunk) => {
				if (settled) return;
				buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
				const end = buffer.indexOf("\r\n\r\n");
				if (end === -1) {
					if (buffer.length > 16384) fail(/* @__PURE__ */ new Error("websocket: handshake response too large"));
					return;
				}
				const head = buffer.subarray(0, end).toString("latin1");
				const rest = buffer.subarray(end + 4);
				const lines = head.split("\r\n");
				if (/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "")?.[1] !== "101") {
					fail(/* @__PURE__ */ new Error(`websocket: upgrade rejected (${lines[0] ?? "no status line"})`));
					return;
				}
				const expected = createHash("sha1").update(key + GUID).digest("base64");
				const acceptLine = lines.find((line) => line.toLowerCase().startsWith("sec-websocket-accept:"));
				if (acceptLine === void 0 || acceptLine.slice(acceptLine.indexOf(":") + 1).trim() !== expected) {
					fail(/* @__PURE__ */ new Error("websocket: bad Sec-WebSocket-Accept"));
					return;
				}
				settled = true;
				clearTimeout(timer);
				resolve(new Connection(socket, false, true, handlers, rest));
			});
		}
	});
}
// src/host/board-session.ts
/**
* One board voice session: discover, AUTH, CAPTURE, then pull PCM frames until
* the browser stops. The protocol is strictly request/response because the
* firmware's `send_audio` drains its ring only when it receives `PULL`.
*/
const AUTH_TIMEOUT_MS = 6e3;
const GO_TIMEOUT_MS = 6e3;
const FIRST_AUDIO_TIMEOUT_MS = 12e3;
const PULL_TIMEOUT_MS = 1500;
const ACK_TIMEOUT_MS = 2500;
const MAX_SESSION_MS = 65e3;
var BoardSession = class {
	ws;
	state = "discovering";
	events;
	config;
	discovery;
	simulation;
	ended = false;
	captureComplete = false;
	terminalSent = false;
	pullOutstanding = false;
	sequenceSeen = 0;
	stopRequested;
	authTimer;
	goTimer;
	firstAudioTimer;
	pullTimer;
	pullTimeout;
	ackTimer;
	maxTimer;
	endResolve;
	endPromise;
	constructor(options) {
		this.config = options.config;
		this.discovery = options.discovery;
		this.simulation = options.simulation;
		this.events = options.events ?? {};
		this.endPromise = new Promise((resolve) => {
			this.endResolve = (reason, detail) => resolve({
				reason,
				detail
			});
		});
	}
	/** Resolves when the session ends, for either side's reason. */
	get finished() {
		return this.endPromise;
	}
	get currentState() {
		return this.state;
	}
	setState(state, detail) {
		this.state = state;
		this.events.onState?.(state, detail);
	}
	async start() {
		try {
			const target = await this.resolveTarget();
			this.setState("connecting", `连接 ${target.host}:${String(target.port)}…`);
			const token = this.config.pairingToken;
			if (token.length !== 64) throw new Error("airremote: pairing token missing; put the firmware token in ~/.dsh/airremote/pairing.txt");
			const ca = this.loadCa();
			const tls = this.simulation === void 0 && !this.config.simulate ? {
				ca,
				servername: ca === void 0 ? void 0 : "airremote.local",
				rejectUnauthorized: ca !== void 0
			} : void 0;
			const ws = await connectWebSocket({
				host: target.host,
				port: target.port,
				path: "/voice",
				timeoutMs: 1e4,
				tls
			}, {
				onMessage: (message) => this.onMessage(message),
				onClose: (code, reason) => this.finish("closed", `board socket closed (${String(code)} ${reason})`),
				onError: (error) => this.finish("error", error.message)
			});
			this.ws = ws;
			this.setState("authenticating", "已连接，正在认证…");
			ws.sendText(authMessage(token));
			this.authTimer = this.timeout(AUTH_TIMEOUT_MS, () => this.finish("error", "板子未回复 READY2（认证超时）"));
		} catch (error) {
			this.finish("error", error instanceof Error ? error.message : String(error));
		}
	}
	async resolveTarget() {
		if (this.simulation !== void 0) return this.simulation;
		if (this.config.boardHost !== "") return {
			host: this.config.boardHost,
			port: this.config.boardPort
		};
		if (this.discovery === void 0) throw new Error("airremote: no discovery service and no boardHost configured");
		this.setState("discovering", "等待开发板（请在板子上点 Voice）…");
		return {
			host: (await this.discovery.wait(this.config.discoveryTimeoutMs)).host,
			port: this.config.boardPort
		};
	}
	loadCa() {
		try {
			if (existsSync(this.config.caFile)) {
				const text = readFileSync(this.config.caFile, "utf8").trim();
				if (text.includes("BEGIN CERTIFICATE")) return text;
			}
		} catch {}
	}
	timeout(ms, callback) {
		const timer = setTimeout(callback, ms);
		timer.unref?.();
		return timer;
	}
	clearTimers() {
		for (const timer of [
			this.authTimer,
			this.goTimer,
			this.firstAudioTimer,
			this.pullTimer,
			this.pullTimeout,
			this.ackTimer,
			this.maxTimer
		]) if (timer !== void 0) clearTimeout(timer);
		this.authTimer = void 0;
		this.goTimer = void 0;
		this.firstAudioTimer = void 0;
		this.pullTimer = void 0;
		this.pullTimeout = void 0;
		this.ackTimer = void 0;
		this.maxTimer = void 0;
	}
	onMessage(message) {
		if (this.ended) return;
		if (message.type === "binary") {
			this.pullOutstanding = false;
			if (this.pullTimeout !== void 0) clearTimeout(this.pullTimeout);
			this.pullTimeout = void 0;
			if (this.firstAudioTimer !== void 0) clearTimeout(this.firstAudioTimer);
			this.firstAudioTimer = void 0;
			const frame = parseAudioFrame(message.data);
			if (frame === void 0) return;
			this.sequenceSeen = frame.sequence;
			this.events.onPcm?.(frame.pcm, frame.sequence);
			this.schedulePull(0);
			return;
		}
		const text = message.text.trim();
		if (text === "READY2") {
			if (this.authTimer !== void 0) clearTimeout(this.authTimer);
			this.authTimer = void 0;
			this.setState("arming", "认证通过，请求录音…");
			this.ws?.sendText(CAPTURE);
			this.goTimer = this.timeout(GO_TIMEOUT_MS, () => this.finish("error", "板子未回复 GO（录音启动超时）"));
			return;
		}
		if (text === "GO") {
			if (this.goTimer !== void 0) clearTimeout(this.goTimer);
			this.goTimer = void 0;
			this.setState("live", "录音中");
			this.firstAudioTimer = this.timeout(FIRST_AUDIO_TIMEOUT_MS, () => this.finish("error", "板子已开始录音但 12 秒内没有音频帧"));
			this.maxTimer = this.timeout(MAX_SESSION_MS, () => {
				this.setState("finishing", "达到单次录音上限，正在收尾…");
				this.stop({ draft: true }).catch(() => void 0);
			});
			this.schedulePull(0);
			return;
		}
		if (text === "WAIT") {
			this.pullOutstanding = false;
			if (this.pullTimeout !== void 0) clearTimeout(this.pullTimeout);
			this.pullTimeout = void 0;
			this.schedulePull(8);
			return;
		}
		if (text === "SEND") {
			this.captureComplete = true;
			if (this.pullTimeout !== void 0) clearTimeout(this.pullTimeout);
			this.pullTimeout = void 0;
			this.setState("finishing", "板子录音结束，等待 DSH 停止…");
			return;
		}
		if (text === "CANCEL") {
			this.captureComplete = true;
			this.stopRequested = { draft: false };
			this.setState("finishing", "板子已取消");
			if (!this.terminalSent) {
				this.terminalSent = true;
				this.ws?.sendText(CANCELLED);
			}
			this.ackTimer = this.timeout(ACK_TIMEOUT_MS, () => this.finish("cancelled", "已取消"));
			return;
		}
		if (text === "ACK") {
			if (this.ackTimer !== void 0) clearTimeout(this.ackTimer);
			this.ackTimer = void 0;
			this.finish(this.stopRequested?.draft === false ? "cancelled" : "draft", "会话结束");
			return;
		}
	}
	schedulePull(delayMs) {
		if (this.ended || this.captureComplete) return;
		if (this.pullTimer !== void 0) clearTimeout(this.pullTimer);
		this.pullTimer = this.timeout(delayMs, () => {
			this.pullTimer = void 0;
			this.pull();
		});
	}
	pull() {
		if (this.ended || this.captureComplete || this.ws === void 0 || !this.ws.open) return;
		if (this.pullOutstanding) return;
		this.pullOutstanding = true;
		this.ws.sendText(PULL);
		if (this.pullTimeout !== void 0) clearTimeout(this.pullTimeout);
		this.pullTimeout = this.timeout(PULL_TIMEOUT_MS, () => {
			this.pullOutstanding = false;
			if (this.ended) return;
			if (this.state === "live") this.schedulePull(0);
		});
	}
	/** Ask the board to stop; resolves once the session has ended. */
	async stop(options = { draft: true }) {
		if (this.ended) return;
		this.stopRequested = options;
		this.clearTimers();
		this.setState("finishing", options.draft ? "正在结束板子录音…" : "正在取消…");
		if (this.ws === void 0 || !this.ws.open) {
			this.finish(options.draft ? "draft" : "cancelled", "连接已关闭");
			return;
		}
		if (this.captureComplete) {
			if (!this.terminalSent) {
				this.terminalSent = true;
				this.ws.sendText(options.draft ? DRAFTED : CANCELLED);
			}
		} else this.ws.sendText(ABORT);
		this.ackTimer = this.timeout(ACK_TIMEOUT_MS, () => {
			this.finish(options.draft ? "draft" : "cancelled", "板子未回复 ACK，按本地结束处理");
		});
		await this.finished;
	}
	finish(reason, detail) {
		if (this.ended) return;
		this.ended = true;
		this.clearTimers();
		this.setState(reason === "error" || reason === "timeout" ? "error" : "ended", detail);
		try {
			this.ws?.close(1e3, reason);
		} catch {}
		this.ws = void 0;
		this.events.onEnd?.(reason, detail);
		this.endResolve?.(reason, detail);
	}
	get lastSequence() {
		return this.sequenceSeen;
	}
};
// src/host/audio-route.ts
var AudioRoute = class {
	active;
	disposed = false;
	options;
	constructor(options) {
		this.options = options;
	}
	/** `webServer.registerUpgrade` handler. */
	handler = (req, socket, head) => {
		if (this.disposed) {
			socket.destroy();
			return;
		}
		if (!this.originAllowed(req)) {
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			socket.destroy();
			return;
		}
		if (this.active !== void 0) {
			const rejected = acceptWebSocket(req, socket, head, {});
			rejected.sendText(JSON.stringify({
				type: "busy",
				detail: "另一个页面正在使用 Air Remote"
			}));
			rejected.close(1008, "busy");
			return;
		}
		let connection;
		const active = {
			connection: void 0,
			session: void 0,
			lastSeen: Date.now(),
			heartbeat: setInterval(() => void 0, 6e4)
		};
		connection = acceptWebSocket(req, socket, head, {
			onMessage: (message) => {
				active.lastSeen = Date.now();
				if (message.type === "binary") return;
				let parsed;
				try {
					parsed = JSON.parse(message.text);
				} catch {
					return;
				}
				if (parsed.type === "start") this.start(active, parsed);
				else if (parsed.type === "stop") {
					const draft = parsed.draft !== false;
					this.active?.session.stop({ draft });
				} else if (parsed.type === "ping") connection?.sendText(JSON.stringify({
					type: "pong",
					at: Date.now()
				}));
			},
			onClose: () => {
				if (this.active === active) {
					const session = active.session;
					this.active = void 0;
					session?.stop({ draft: false });
				}
			},
			onError: (error) => {
				this.options.logger?.(`airremote: browser socket error: ${error.message}`);
			}
		});
		active.connection = connection;
		clearInterval(active.heartbeat);
		active.heartbeat = setInterval(() => {
			if (Date.now() - active.lastSeen > 45e3) {
				connection?.close(1001, "idle");
				return;
			}
			connection?.sendText(JSON.stringify({
				type: "ping",
				at: Date.now()
			}));
		}, 15e3);
		active.heartbeat.unref?.();
		this.active = active;
		this.sendJson(connection, {
			type: "hello",
			device: "Air Remote (ESP32-C6)",
			simulate: this.options.simulation !== void 0
		});
	};
	/**
	* The route lives on the local DSH web server, whose upgrade path is outside
	* the page's cookie fence. Refuse cross-site WebSocket handshakes so another
	* local origin cannot open the board microphone; Node clients (tests) send no
	* Origin and are allowed.
	*/
	originAllowed(req) {
		const origin = req.headers.origin;
		if (typeof origin !== "string" || origin === "") return true;
		try {
			const parsed = new URL(origin);
			if (parsed.protocol === "dsh-app:" || parsed.protocol === "file:") return true;
			return parsed.host === req.headers.host;
		} catch {
			return false;
		}
	}
	start(active, _message) {
		if (active.session !== void 0) return;
		const session = new BoardSession({
			config: this.options.config,
			discovery: this.options.discovery,
			simulation: this.options.simulation,
			events: {
				onState: (state, detail) => {
					this.sendJson(active.connection, {
						type: "state",
						state,
						detail
					});
				},
				onPcm: (pcm, sequence) => {
					active.connection.sendBinary(pcm);
					if (sequence % 50 === 0) this.options.logger?.(`airremote: forwarded ${String(sequence)} audio frames`);
				},
				onEnd: (reason, detail) => {
					this.sendJson(active.connection, {
						type: "ended",
						reason,
						detail
					});
					if (this.active === active) this.active = void 0;
					clearInterval(active.heartbeat);
				}
			}
		});
		active.session = session;
		session.start();
	}
	sendJson(connection, value) {
		try {
			connection?.sendText(JSON.stringify(value));
		} catch {}
	}
	dispose() {
		this.disposed = true;
		const active = this.active;
		this.active = void 0;
		if (active !== void 0) {
			clearInterval(active.heartbeat);
			active.session?.stop({ draft: false });
			active.connection.close(1001, "plugin disposed");
		}
	}
};
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
/** 当前环境的 IANA 时区名，只用于日志；取不到时回 `system`。 */
function systemTimezoneName() {
	try {
		const name = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return typeof name === "string" && name !== "" ? name : "system";
	} catch {
		return "system";
	}
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
// src/host/serial-port.ts
/**
* 串口：识别 ESP32-C6 开发板（USB VID 0x303A）并把时间 / 时区写进去。
*
* 两条通道：
*  - `serialport` npm 包可用时走它（首选）；
*  - 否则用一次性的 PowerShell 进程（`[System.IO.Ports.SerialPort]`），
*    一个脚本完成打开 / 写 / 读到匹配 / 关闭，用独特分隔符回传结果。
*
* 只做一次性动作：不轮询、不监听插拔、不留后台定时器。
*/
const require$1 = createRequire(import.meta.url);
/** Espressif 的 USB VID。固件用 USB-Serial/JTAG，端口一定挂在它下面。 */
const ESPRESSIF_VENDOR_ID = "303A";
/** 与 `voice.c` 的串口命令一致：115200 8N1，无流控。 */
const BOARD_BAUD_RATE = 115200;
/** 单条命令等回包的上限。 */
const COMMAND_TIMEOUT_MS = 3e3;
/** 一次同步（AR1T + AR1Z）的总时长上限。 */
const SYNC_TIMEOUT_MS = 1e4;
/** PowerShell 进程本身的超时（含进程启动开销）。 */
const POWERSHELL_TIMEOUT_MS = 15e3;
/** 同步失败：`code` 直接对应契约里的错误码。 */
var BoardSyncError = class extends Error {
	code;
	/** 已经收到 / 发出的原始行，便于界面上排查。 */
	lines;
	constructor(code, message, lines = []) {
		super(message);
		this.name = "BoardSyncError";
		this.code = code;
		this.lines = lines;
	}
};
let serialportProbe;
/** 排障开关：`AIRREMOTE_SERIAL_FORCE_PS=1` 时绕开 serialport，强制走 PowerShell 通道。 */
function serialportDisabled() {
	return (process.env.AIRREMOTE_SERIAL_FORCE_PS ?? "").trim() === "1";
}
/**
* 尝试加载 `serialport`，并用一次 `SerialPort.list()` 证明原生绑定真的可用
* （Node 大版本升级后 prebuild ABI 可能对不上，模块能 require 但一用就炸）。
* 失败时记住原文并永久回落到 PowerShell，免得每次同步都等一次失败。
*/
async function loadSerialport$1() {
	serialportProbe ??= (async () => {
		if (serialportDisabled()) return;
		try {
			const loaded = require$1("serialport");
			const SerialPort = loaded.SerialPort ?? loaded.default?.SerialPort;
			if (typeof SerialPort !== "function") throw new Error("serialport 里没有导出 SerialPort");
			await SerialPort.list();
			return { SerialPort };
		} catch (error) {
			error instanceof Error && error.message;
			return;
		}
	})();
	return serialportProbe;
}
/**
* 找一个 ESP32-C6 的串口。
*
* `preferred` 非空时直接用它（配置 / 环境变量里的显式指定）；
* 否则先问 `serialport`，再兜底查注册表，最后退到 CIM 的 PnP 设备。
* 全部失败返回 null——**不**把「只有一个串口」当作识别成功。
*/
async function findBoardPort(preferred = "") {
	const explicit = preferred.trim() !== "" ? preferred.trim() : (process.env.AIRREMOTE_SERIAL_PORT ?? "").trim();
	if (explicit !== "") return explicit;
	const module = await loadSerialport$1();
	if (module !== void 0) try {
		const board = (await module.SerialPort.list()).find((port) => (port.vendorId ?? "").toLowerCase() === ESPRESSIF_VENDOR_ID);
		if (board?.path !== void 0 && board.path !== "") return board.path;
	} catch {}
	const fromRegistry = await comPortsFrom(POWERSHELL_REGISTRY_SCRIPT);
	if (fromRegistry.length > 0) return fromRegistry[0];
	const fromDevices = await comPortsFrom(POWERSHELL_PNP_SCRIPT);
	return fromDevices.length > 0 ? fromDevices[0] : null;
}
/** 读 `HKLM\SYSTEM\CurrentControlSet\Enum\USB` 下 `VID_303A*` 设备的 `Device Parameters\PortName`。 */
const POWERSHELL_REGISTRY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Enum\USB' |
  Where-Object { $_.PSChildName -like 'VID_303A*' } |
  ForEach-Object {
    Get-ChildItem $_.PSPath | ForEach-Object {
      $name = (Get-ItemProperty -Path (Join-Path $_.PSPath 'Device Parameters') -Name PortName).PortName
      if ($name) { Write-Output $name }
    }
  }
exit 0
`;
/** 退一步：从 PnP 设备的 DeviceID 里匹配 `VID_303A`，再从名字里抠 COM 号。 */
const POWERSHELL_PNP_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-CimInstance Win32_PnPEntity |
  Where-Object { $_.DeviceID -like '*VID_303A*' -or $_.HardwareID -like '*VID_303A*' } |
  ForEach-Object { if ($_.Name -match '(COM\d+)') { Write-Output $Matches[1] } }
exit 0
`;
async function comPortsFrom(script) {
	try {
		const result = await runPowerShell(script, {}, POWERSHELL_TIMEOUT_MS);
		const ports = [];
		for (const line of result.stdout.split(/\r?\n/)) {
			const match = /^\s*(COM\d+)\s*$/i.exec(line);
			if (match !== null && !ports.includes(match[1].toUpperCase())) ports.push(match[1].toUpperCase());
		}
		return ports;
	} catch {
		return [];
	}
}
/**
* 通过串口把 UTC 秒和显示时区写给板子：`AR1T <unix>` → `AR1Z <minutes>`。
* 每条命令都要读到 OK；板子回 ERR 抛 `rejected`，等不到抛 `timeout`。
* 端口在 finally 里关闭，不留在后台。
*/
async function syncBoardTime(port, unixSeconds, minutes) {
	const target = port.trim();
	if (target === "") throw new BoardSyncError("open-failed", "没有可用的串口");
	const module = await loadSerialport$1();
	if (module !== void 0) return syncWithSerialport(module, target, unixSeconds, minutes);
	return syncWithPowerShell(target, unixSeconds, minutes);
}
async function syncWithSerialport(module, path, unixSeconds, minutes) {
	const deadline = Date.now() + SYNC_TIMEOUT_MS;
	const sent = [];
	const lines = [];
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let pending;
	/** 只有真正 new 出来的端口才需要关；构造就抛错时保持 undefined。 */
	let port;
	const take = (line) => {
		lines.push(line);
		const waiter = pending;
		if (waiter === void 0) return;
		if (waiter.ok.test(line)) {
			pending = void 0;
			waiter.resolve(line);
		} else if (waiter.fail.test(line)) {
			pending = void 0;
			waiter.reject(new BoardSyncError("rejected", "开发板拒绝了时间命令（AR1T ERR / AR1Z ERR）", lines.slice()));
		}
	};
	const onData = (chunk) => {
		buffer += decoder.write(chunk);
		let index = buffer.search(/[\r\n]/);
		while (index !== -1) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line !== "") take(line);
			index = buffer.search(/[\r\n]/);
		}
	};
	const onError = (error) => {
		const waiter = pending;
		pending = void 0;
		waiter?.reject(new BoardSyncError("internal", `串口出错：${error.message}`, lines.slice()));
	};
	/** 挂一个等待器：先把坑占好再写，避免漏掉立刻回的行。超时时间受整体预算约束。 */
	const expect = (ok, fail, message) => new Promise((resolve, reject) => {
		const budget = Math.max(1, Math.min(COMMAND_TIMEOUT_MS, deadline - Date.now()));
		const timer = setTimeout(() => {
			pending = void 0;
			reject(new BoardSyncError("timeout", message, lines.slice()));
		}, budget);
		timer.unref?.();
		pending = {
			ok,
			fail,
			resolve: (line) => {
				clearTimeout(timer);
				resolve(line);
			},
			reject: (error) => {
				clearTimeout(timer);
				reject(error);
			}
		};
	});
	try {
		port = new module.SerialPort({
			path,
			baudRate: BOARD_BAUD_RATE,
			dataBits: 8,
			stopBits: 1,
			parity: "none",
			rtscts: false,
			xon: false,
			xoff: false,
			autoOpen: false
		});
		await new Promise((resolve, reject) => {
			port.open((error) => {
				if (error === null || error === void 0) resolve();
				else reject(new BoardSyncError("open-failed", openFailureMessage(path, error), lines.slice()));
			});
		});
		port.on("data", onData);
		port.on("error", onError);
		const writeLine = (command) => new Promise((resolve, reject) => {
			port.write(`${command}\n`, (error) => {
				if (error === null || error === void 0) {
					sent.push(command);
					resolve();
				} else reject(new BoardSyncError("internal", `写串口失败：${error.message}`, lines.slice()));
			});
		});
		const timeCommand = `AR1T ${String(unixSeconds)}`;
		const timeReply = expect(/^AR1T OK\b/i, /^AR1T ERR\b/i, `等待 ${timeCommand} 的回包超时`);
		timeReply.catch(() => void 0);
		await writeLine(timeCommand);
		await timeReply;
		const zoneCommand = `AR1Z ${String(minutes)}`;
		const zoneReply = expect(/^AR1Z OK\b/i, /^AR1Z ERR\b/i, `等待 ${zoneCommand} 的回包超时`);
		zoneReply.catch(() => void 0);
		await writeLine(zoneCommand);
		await zoneReply;
		return {
			sent: sent.slice(),
			lines: lines.slice()
		};
	} catch (error) {
		pending = void 0;
		if (error instanceof BoardSyncError) throw error;
		throw new BoardSyncError("internal", `串口同步失败：${describeUnexpected(error)}`, lines.slice());
	} finally {
		pending = void 0;
		if (port !== void 0) {
			const detach = port.off ?? port.removeListener;
			try {
				detach?.("data", onData);
				detach?.("error", onError);
			} catch {}
			await closeSerialPort(port);
		}
	}
}
/** 打开失败时给人看的原因：把「被别的程序占着」说清楚，别只丢一个 Access denied。 */
function openFailureMessage(path, error) {
	const detail = error.message;
	if (/access is denied|access denied|拒绝访问|被拒绝/i.test(detail)) return `打开串口 ${path} 失败：端口被占用，请关闭串口监视器 / 烧录工具后重试（${detail}）`;
	return `打开串口 ${path} 失败：${detail}`;
}
/** 非预期异常的简短描述（类型 + 消息 + 栈顶一帧）。 */
function describeUnexpected(error) {
	if (!(error instanceof Error)) return String(error);
	const frame = (error.stack ?? "").split("\n").find((line) => line.trim().startsWith("at "));
	return frame === void 0 ? `${error.name}: ${error.message}` : `${error.name}: ${error.message} (${frame.trim()})`;
}
/**
* 关闭端口：正常 close 走回调；回调一直不来或流已经半死时用 `destroy()` 兜底。
* 无论走哪条路都只 resolve 一次，不会把异常再抛给调用方。
*/
function closeSerialPort(port) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve();
		};
		const destroy = () => {
			try {
				port.destroy?.();
			} catch {}
		};
		const timer = setTimeout(() => {
			destroy();
			finish();
		}, 1e3);
		timer.unref?.();
		try {
			port.close(() => {
				if (port.isOpen === true) destroy();
				finish();
			});
		} catch {
			destroy();
			finish();
		}
	});
}
const DELIMITER = "@@AR1:";
const POWERSHELL_SYNC_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$sp = New-Object System.IO.Ports.SerialPort
$sp.PortName = $env:AIRREMOTE_PS_PORT
$sp.BaudRate = [int]$env:AIRREMOTE_PS_BAUD
$sp.Parity = [System.IO.Ports.Parity]::None
$sp.DataBits = 8
$sp.StopBits = [System.IO.Ports.StopBits]::One
$sp.Handshake = [System.IO.Ports.Handshake]::None
$sp.NewLine = [string][char]10
$sp.ReadTimeout = 200
$sp.WriteTimeout = 1000

function Emit([string]$tag, [string]$text) {
  [Console]::Out.WriteLine('@@AR1:' + $tag + '@@' + $text)
}

function Send-Wait([string]$command, [string]$okPattern, [string]$errPattern, [int]$timeoutMs) {
  try {
    $sp.WriteLine($command)
  } catch {
    Emit 'ERROR' ('write-failed:' + $_.Exception.Message)
    return 'error'
  }
  Emit 'SENT' $command
  $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
  $buffer = ''
  while ([DateTime]::UtcNow -lt $deadline) {
    $chunk = ''
    try { $chunk = $sp.ReadExisting() } catch { $chunk = '' }
    if ($chunk.Length -gt 0) {
      $buffer += $chunk
      $index = $buffer.IndexOf([char]10)
      while ($index -ge 0) {
        $line = $buffer.Substring(0, $index).Trim()
        $buffer = $buffer.Substring($index + 1)
        if ($line.Length -gt 0) {
          Emit 'LINE' $line
          if ($line -match $okPattern) { return 'ok' }
          if ($line -match $errPattern) { return 'err' }
        }
        $index = $buffer.IndexOf([char]10)
      }
    }
    Start-Sleep -Milliseconds 40
  }
  return 'timeout'
}

try { $sp.Open() } catch {
  Emit 'ERROR' ('open-failed:' + $_.Exception.Message)
  exit 2
}

$state = 'ok'
try {
  $state = Send-Wait ('AR1T ' + $env:AIRREMOTE_PS_UNIX) '^AR1T OK' '^AR1T ERR' 3000
  if ($state -eq 'ok') {
    $state = Send-Wait ('AR1Z ' + $env:AIRREMOTE_PS_MINUTES) '^AR1Z OK' '^AR1Z ERR' 3000
  }
} finally {
  if ($sp.IsOpen) { try { $sp.Close() } catch { } }
}

if ($state -eq 'timeout') { exit 3 }
if ($state -eq 'err') { exit 4 }
if ($state -eq 'error') { exit 1 }
exit 0
`;
async function syncWithPowerShell(path, unixSeconds, minutes) {
	const result = await runPowerShell(POWERSHELL_SYNC_SCRIPT, {
		AIRREMOTE_PS_PORT: path,
		AIRREMOTE_PS_BAUD: String(BOARD_BAUD_RATE),
		AIRREMOTE_PS_UNIX: String(unixSeconds),
		AIRREMOTE_PS_MINUTES: String(minutes)
	}, POWERSHELL_TIMEOUT_MS);
	const sent = [];
	const lines = [];
	let openFailure = "";
	let writeFailure = "";
	for (const rawLine of result.stdout.split(/\r?\n/)) {
		const at = rawLine.indexOf(DELIMITER);
		if (at === -1) continue;
		const rest = rawLine.slice(at + 6);
		const close = rest.indexOf("@@");
		if (close === -1) continue;
		const tag = rest.slice(0, close);
		const text = rest.slice(close + 2);
		if (tag === "SENT") sent.push(text);
		else if (tag === "LINE") lines.push(text);
		else if (tag === "ERROR") {
			if (text.startsWith("open-failed:")) openFailure = text.slice(12);
			else writeFailure = text;
		}
	}
	if (openFailure !== "") throw new BoardSyncError("open-failed", `打开串口 ${path} 失败：${openFailure}`, lines);
	if (writeFailure !== "") throw new BoardSyncError("internal", `写串口失败：${writeFailure}`, lines);
	if (result.exitCode === 2) throw new BoardSyncError("open-failed", `打开串口 ${path} 失败`, lines);
	if (result.exitCode === 3) throw new BoardSyncError("timeout", `等待 ${sent.at(-1) ?? "AR1T"} 的回包超时`, lines);
	if (result.exitCode === 4) throw new BoardSyncError("rejected", "开发板拒绝了时间命令（AR1T ERR / AR1Z ERR）", lines);
	if (result.exitCode !== 0) throw new BoardSyncError("internal", `串口脚本失败：${result.stderr.trim() !== "" ? result.stderr.trim() : `退出码 ${String(result.exitCode)}`}`, lines);
	return {
		sent,
		lines
	};
}
/**
* 跑一次 PowerShell（`powershell.exe` 在 Windows 上一定存在，pwsh 不一定）。
* 用环境变量传参，避免把端口名拼进脚本引起转义问题。
*/
function runPowerShell(script, env, timeoutMs) {
	return new Promise((resolve, reject) => {
		execFile("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script
		], {
			timeout: timeoutMs,
			windowsHide: true,
			maxBuffer: 1048576,
			env: {
				...process.env,
				...env
			}
		}, (error, stdout, stderr) => {
			const code = error?.code;
			if (error !== null && typeof code === "string") {
				reject(new BoardSyncError("internal", `无法启动 PowerShell（${code}）：${error.message}`));
				return;
			}
			resolve({
				stdout: String(stdout ?? ""),
				stderr: String(stderr ?? ""),
				exitCode: error === null ? 0 : Number(code ?? 1)
			});
		});
	});
}
/** 与 client 约定的时区 id 形状：1..32 个 `[a-z0-9+_-]`（大小写不敏感）。 */
const TIMEZONE_PATTERN = /^[a-z0-9+_-]{1,32}$/i;
/** `<dataDir>/time.json` 的绝对路径。 */
function timePreferenceFile(dataDir) {
	return join(dataDir, "time.json");
}
/** 校验一个时区 id 是否符合契约允许的形状。 */
function isTimezoneId(value) {
	return typeof value === "string" && TIMEZONE_PATTERN.test(value.trim());
}
function parseUpdatedAt(value) {
	if (typeof value !== "string" || value === "") return null;
	return Number.isNaN(Date.parse(value)) ? null : value;
}
/**
* 读取保存的偏好。文件不存在、不是 JSON、字段类型不对时都按默认值处理。
* `autoSync` 只认布尔值，其余（含缺失）一律视为默认的「开启」。
*/
function readTimePreference(dataDir) {
	try {
		const parsed = JSON.parse(readFileSync(timePreferenceFile(dataDir), "utf8"));
		if (parsed === null || typeof parsed !== "object") return defaultPreference();
		const record = parsed;
		return {
			timezone: isTimezoneId(record.timezone) ? record.timezone.trim().toLowerCase() : DEFAULT_TIMEZONE,
			autoSync: typeof record.autoSync === "boolean" ? record.autoSync : true,
			updatedAt: parseUpdatedAt(record.updatedAt)
		};
	} catch {
		return defaultPreference();
	}
}
/**
* 写偏好：先读旧值把没传的字段补上，再「写 `time.json.tmp` + 同目录 rename」原子落盘，
* 读者不会看到半个文件。返回实际落盘的内容（时区统一存小写）。
*/
function writeTimePreference(dataDir, patch) {
	const current = readTimePreference(dataDir);
	const value = {
		timezone: (patch.timezone ?? current.timezone).trim().toLowerCase(),
		autoSync: patch.autoSync ?? current.autoSync,
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	const file = timePreferenceFile(dataDir);
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temporary, file);
	return value;
}
function defaultPreference() {
	return {
		timezone: DEFAULT_TIMEZONE,
		autoSync: true,
		updatedAt: null
	};
}
/** 记住多少个触发键；连接键会一直增长，只留最近这些。 */
const MAX_REMEMBERED_KEYS = 64;
/**
* 自动对时器。只持有「排期用的定时器集合」和「已尝试过的触发键」，
* 不监听串口、不留常驻轮询；`dispose()` 会清掉所有还没触发的定时器。
*/
var AutoTimeSync = class {
	options;
	startupDelayMs;
	sessionDelayMs;
	attempted = /* @__PURE__ */ new Set();
	timers = /* @__PURE__ */ new Set();
	disposed = false;
	constructor(options) {
		this.options = options;
		this.startupDelayMs = options.startupDelayMs ?? 4e3;
		this.sessionDelayMs = options.sessionDelayMs ?? 1500;
	}
	/** 插件启动后排一次对时；不 await、不抛错。 */
	armStartup() {
		this.schedule("startup", this.startupDelayMs);
	}
	/** 一次板子会话建立（WSS 音频路由被连上）后排一次对时；`session` 只要同一连接内唯一即可。 */
	notifySession(session) {
		this.schedule(`session:${session}`, this.sessionDelayMs);
	}
	/** 排期一次对时；同一个键只排一次。定时器 `unref`，不会拖住进程退出。 */
	schedule(key, delayMs) {
		if (this.disposed || this.attempted.has(key)) return;
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			this.run(key).catch(() => void 0);
		}, Math.max(0, delayMs));
		timer.unref?.();
		this.timers.add(timer);
	}
	/**
	* 真正执行一次。可以直接 `await`（测试 / 内部排期都走它）。
	* 返回值只用于日志与断言；调用方不需要区分失败原因。
	*/
	async run(key) {
		if (this.disposed) return { outcome: "disposed" };
		if (this.attempted.has(key)) return { outcome: "duplicate" };
		this.remember(key);
		let preference;
		try {
			preference = readTimePreference(this.options.dataDir);
		} catch (error) {
			this.warn(`airremote: 自动对时读不到 time.json，跳过（${describe$3(error)}）`);
			return { outcome: "failed" };
		}
		if (!preference.autoSync) return { outcome: "disabled" };
		const gate = this.options.gate;
		if (gate !== void 0 && !gate.tryEnter()) {
			this.log("airremote: 自动对时跳过（已有一次同步在进行）");
			return { outcome: "busy" };
		}
		const holder = this.options.serialHolder;
		const holderState = holder?.state();
		if (holderState !== void 0 && holderState.holder !== "none") {
			gate?.leave();
			this.log(`airremote: 自动对时跳过（串口被 ${holderState.holder} 占用）`);
			return { outcome: "locked" };
		}
		if (holder !== void 0 && !holder.acquire("sync")) {
			gate?.leave();
			this.log("airremote: 自动对时跳过（串口锁抢不到）");
			return { outcome: "locked" };
		}
		const lockHeld = holder !== void 0;
		const now = this.options.now?.() ?? Date.now();
		const unix = Math.floor(now / 1e3);
		const minutes = minutesForTimezone(preference.timezone, new Date(now));
		const portFinder = this.options.findPort ?? findBoardPort;
		const sync = this.options.sync ?? syncBoardTime;
		let port = null;
		try {
			port = await portFinder(this.options.serialPort);
			if (port === null) {
				this.log(`airremote: 自动对时跳过（没找到开发板串口，时区 ${preference.timezone}）`);
				return {
					outcome: "no-board",
					unix,
					minutes
				};
			}
			await sync(port, unix, minutes);
			this.log(`airremote: 自动对时完成 ${port} unix=${String(unix)} minutes=${String(minutes)} zone=${preference.timezone} system=${systemTimezoneName()}`);
			return {
				outcome: "synced",
				port,
				unix,
				minutes
			};
		} catch (error) {
			this.warn(`airremote: 自动对时失败（不重试）${port ?? "?"} ${errorCode(error)}：${describe$3(error)}`);
			return {
				outcome: "failed",
				port: port ?? void 0,
				unix,
				minutes
			};
		} finally {
			if (lockHeld) holder?.release("sync");
			gate?.leave();
		}
	}
	/** 清掉所有还没触发的定时器，并拒绝之后的排期。 */
	dispose() {
		this.disposed = true;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
	}
	remember(key) {
		this.attempted.add(key);
		while (this.attempted.size > MAX_REMEMBERED_KEYS) {
			const oldest = this.attempted.values().next().value;
			if (oldest === void 0) return;
			this.attempted.delete(oldest);
		}
	}
	log(message) {
		try {
			this.options.log?.(message);
		} catch {}
	}
	warn(message) {
		try {
			this.options.warn?.(message);
		} catch {}
	}
};
function errorCode(error) {
	return error instanceof BoardSyncError ? error.code : "internal";
}
function describe$3(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
// src/host/discovery.ts
/**
* UDP discovery for the ESP32-C6 voice session (`voice.c`):
*
*   board -> host   `AR1A` + 6-byte MAC, sent to the gateway and broadcast on 47682
*   host  -> board  `AR1?` + 16 bytes, answered with the same payload where byte 3 is `!`
*
* The board announces every 500 ms for up to 20 s after the user starts a voice
* session, so a browser session that starts a little later can still attach.
*/
const QUERY = Buffer.from("AR1?", "ascii");
function macText(bytes) {
	return [...bytes.subarray(0, 6)].map((value) => value.toString(16).padStart(2, "0")).join(":");
}
var BoardDiscovery = class {
	options;
	socket;
	probeTimer;
	waiters = /* @__PURE__ */ new Set();
	last;
	closed = false;
	probe;
	constructor(options) {
		this.options = options;
		this.probe = options.probe ?? true;
	}
	get latest() {
		return this.last;
	}
	async start() {
		if (this.socket !== void 0) return;
		const socket = createSocket({
			type: "udp4",
			reuseAddr: true
		});
		this.socket = socket;
		socket.on("error", () => {});
		socket.on("message", (message, remote) => {
			if (message.length < 10 || message[0] !== 65 || message[1] !== 82 || message[2] !== 49) return;
			if (message[3] !== 65 && message[3] !== 33) return;
			const board = {
				host: remote.address,
				mac: macText(message.subarray(4, 10)),
				at: Date.now()
			};
			this.last = board;
			for (const waiter of [...this.waiters]) waiter(board);
		});
		await new Promise((resolve, reject) => {
			const onError = (error) => {
				socket.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				socket.off("error", onError);
				resolve();
			};
			socket.once("error", onError);
			socket.once("listening", onListening);
			socket.bind(this.options.port, "0.0.0.0");
		});
		if (this.probe) {
			const query = Buffer.alloc(20);
			QUERY.copy(query, 0);
			this.probeTimer = setInterval(() => {
				if (this.closed) return;
				try {
					socket.send(query, 0, query.length, this.options.port, "255.255.255.255");
				} catch {}
			}, 1e3);
			this.probeTimer.unref?.();
		}
	}
	/** Wait for the next announcement, or use one seen within `maxAgeMs`. */
	wait(timeoutMs, maxAgeMs = 3e3) {
		if (this.last !== void 0 && Date.now() - this.last.at <= maxAgeMs) return Promise.resolve(this.last);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(/* @__PURE__ */ new Error(`airremote: board did not announce on UDP ${String(this.options.port)} within ${String(timeoutMs)} ms`));
			}, timeoutMs);
			timer.unref?.();
			const waiter = (board) => {
				clearTimeout(timer);
				this.waiters.delete(waiter);
				resolve(board);
			};
			this.waiters.add(waiter);
		});
	}
	close() {
		this.closed = true;
		if (this.probeTimer !== void 0) clearInterval(this.probeTimer);
		this.probeTimer = void 0;
		for (const waiter of this.waiters) this.waiters.delete(waiter);
		const socket = this.socket;
		this.socket = void 0;
		if (socket !== void 0) try {
			socket.close();
		} catch {}
	}
};
// src/host/fake-board.ts
/**
* In-process simulated board.
*
* It speaks the same request/response protocol as `firmware/components/app_voice/voice.c`
* (`AUTH`/`READY2`/`CAPTURE`/`GO`/`PULL`/`ABORT`/`ACK`) over a plain WebSocket,
* announces itself on the UDP discovery port, and loops a WAV file (or a
* synthesized tone when no file exists). This makes the whole host -> browser
* path testable without hardware.
*/
const FRAME_SAMPLES = 320;
const ANNOUNCE = Buffer.from("AR1A", "ascii");
function parseWav(bytes) {
	if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return;
	let at = 12;
	let channels = 0;
	let sampleRate = 0;
	let bits = 0;
	let data;
	while (at + 8 <= bytes.length) {
		const id = bytes.toString("ascii", at, at + 4);
		const size = bytes.readUInt32LE(at + 4);
		const body = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
		if (id === "fmt " && body.length >= 16) {
			if (body.readUInt16LE(0) !== 1) return void 0;
			channels = body.readUInt16LE(2);
			sampleRate = body.readUInt32LE(4);
			bits = body.readUInt16LE(14);
		} else if (id === "data") data = body;
		at += 8 + size + (size & 1);
	}
	if (data === void 0 || channels === 0 || sampleRate === 0 || bits !== 16) return void 0;
	const source = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
	const mono = new Int16Array(Math.floor(source.length / channels));
	for (let i = 0; i < mono.length; i++) {
		let sum = 0;
		for (let c = 0; c < channels; c++) sum += source[i * channels + c];
		mono[i] = Math.max(-32768, Math.min(32767, Math.round(sum / channels)));
	}
	if (sampleRate === 16e3) return {
		samples: mono,
		sampleRate
	};
	const ratio = 16e3 / sampleRate;
	const out = new Int16Array(Math.max(1, Math.floor(mono.length * ratio)));
	for (let i = 0; i < out.length; i++) {
		const position = i / ratio;
		const left = Math.floor(position);
		const right = Math.min(mono.length - 1, left + 1);
		const fraction = position - left;
		out[i] = Math.round(mono[left] * (1 - fraction) + mono[right] * fraction);
	}
	return {
		samples: out,
		sampleRate: 16e3
	};
}
/** A speech-like tone used when no WAV is configured: a warbling two-tone with pauses. */
function syntheticPcm() {
	const sampleRate = 16e3;
	const samples = new Int16Array(sampleRate * 4);
	for (let i = 0; i < samples.length; i++) {
		const t = i / sampleRate;
		const cycle = t % 4;
		const active = cycle < 2.4;
		const frequency = cycle < 1.2 ? 220 : 330;
		const envelope = active ? Math.min(1, cycle * 8, (2.4 - cycle) * 8) : 0;
		samples[i] = Math.round(Math.sin(2 * Math.PI * frequency * t) * .25 * 32767 * envelope);
	}
	return {
		samples,
		sampleRate
	};
}
function loadPcm(path) {
	if (existsSync(path)) try {
		const bytes = readFileSync(path);
		const wav = parseWav(bytes);
		if (wav !== void 0 && wav.samples.length > 0) return wav;
		if (bytes.length >= 2) return {
			samples: new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2)),
			sampleRate: 16e3
		};
	} catch {}
	return syntheticPcm();
}
var FakeBoard = class {
	server;
	udp;
	announceTimer;
	sockets = /* @__PURE__ */ new Set();
	pcm;
	offset = 0;
	sequence = 0;
	nextFrameAt = 0;
	host;
	options;
	constructor(options) {
		this.options = options;
		this.host = options.host ?? "127.0.0.1";
	}
	get address() {
		return {
			host: this.host,
			port: this.options.port
		};
	}
	async start() {
		if (this.server !== void 0) return;
		this.pcm = loadPcm(this.options.wavPath);
		const server = createServer((_req, res) => {
			res.writeHead(404);
			res.end();
		});
		this.server = server;
		server.on("upgrade", (req, socket, head) => {
			this.sockets.add(socket);
			socket.once("close", () => this.sockets.delete(socket));
			try {
				this.accept(req, socket, head);
			} catch {
				socket.destroy();
			}
		});
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.options.port, this.host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		this.announce();
		this.announceTimer = setInterval(() => this.announce(), 500);
		this.announceTimer.unref?.();
	}
	accept(req, socket, head) {
		let authenticated = false;
		let capturing = false;
		let closed = false;
		const connection = acceptWebSocket(req, socket, head, {
			onMessage: (message) => {
				if (closed) return;
				if (message.type !== "text") return;
				const text = message.text;
				if (!authenticated) {
					if (text === `AUTH ${this.options.token}`) {
						authenticated = true;
						connection.sendText(READY2);
					} else connection.close(1008, "AUTH required");
					return;
				}
				if (text === "CAPTURE") {
					capturing = true;
					this.nextFrameAt = Date.now();
					connection.sendText("GO");
					return;
				}
				if (text === "PULL") {
					if (!capturing || this.pcm === void 0) {
						connection.sendText(WAIT);
						return;
					}
					const now = Date.now();
					if (now + 3 < this.nextFrameAt) {
						connection.sendText(WAIT);
						return;
					}
					this.nextFrameAt = Math.max(this.nextFrameAt + 20, now + 20);
					const chunk = Buffer.allocUnsafe(FRAME_SAMPLES * 2);
					for (let i = 0; i < FRAME_SAMPLES; i++) {
						chunk.writeInt16LE(this.pcm.samples[this.offset], i * 2);
						this.offset = (this.offset + 1) % this.pcm.samples.length;
					}
					connection.sendBinary(encodeAudioFrame(this.sequence++, chunk));
					return;
				}
				if (text === "ABORT" || text === "DRAFTED" || text === "CANCELLED" || text === "SEND") {
					closed = true;
					connection.sendText("ACK");
					setTimeout(() => connection.close(), 20).unref?.();
				}
			},
			onClose: () => {
				closed = true;
			},
			onError: () => {
				closed = true;
			}
		});
	}
	announce() {
		try {
			if (this.udp === void 0) this.udp = createSocket({ type: "udp4" });
			const packet = Buffer.concat([ANNOUNCE, Buffer.from([
				2,
				0,
				0,
				0,
				0,
				1
			])]);
			this.udp.send(packet, 0, packet.length, this.options.discoveryPort, "127.0.0.1");
		} catch {}
	}
	stop() {
		if (this.announceTimer !== void 0) clearInterval(this.announceTimer);
		this.announceTimer = void 0;
		if (this.udp !== void 0) {
			try {
				this.udp.close();
			} catch {}
			this.udp = void 0;
		}
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		const server = this.server;
		this.server = void 0;
		if (server !== void 0) try {
			server.close();
		} catch {}
	}
};
// src/host/config.ts
/**
* Host-side runtime configuration.
*
* Values come from (highest priority first) the plugin entry config in
* `cordis.patch.yml`, environment variables, and files under the DSH home:
*
*   ~/.dsh/airremote/pairing.txt  - the 64-character token embedded in the firmware
*   ~/.dsh/airremote/server.crt   - the board's self-signed certificate (optional pin)
*   ~/.dsh/airremote/sim.wav      - speech used by the simulated board
*   ~/.dsh/airremote/time.json    - 设置页选的时区（`auto` 表示跟随系统）
*
* The pairing token is a secret: it is read from disk or the environment, never
* from the committed profile patch.
*/
function env(name) {
	const value = process.env[name];
	return value === void 0 || value.trim() === "" ? void 0 : value.trim();
}
function readToken(file) {
	try {
		return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
	} catch {
		return "";
	}
}
function resolveHostConfig(overrides = {}) {
	const dshHome = env("DSH_HOME") ?? join(homedir(), ".dsh");
	const dataDir = overrides.dataDir ?? env("AIRREMOTE_DATA_DIR") ?? join(dshHome, "airremote");
	const tokenFile = overrides.pairingTokenFile ?? env("AIRREMOTE_PAIRING_FILE") ?? join(dataDir, "pairing.txt");
	const pairingToken = overrides.pairingToken ?? env("AIRREMOTE_PAIRING_TOKEN") ?? readToken(tokenFile);
	const simulate = overrides.simulate ?? (env("AIRREMOTE_SIMULATE") === "1" || existsSync(join(dataDir, "simulate")));
	return {
		dataDir,
		pairingToken,
		caFile: overrides.caFile ?? env("AIRREMOTE_CA_FILE") ?? join(dataDir, "server.crt"),
		boardHost: overrides.boardHost ?? env("AIRREMOTE_BOARD_HOST") ?? "",
		boardPort: overrides.boardPort ?? Number(env("AIRREMOTE_BOARD_PORT") ?? "47683"),
		discoveryPort: overrides.discoveryPort ?? Number(env("AIRREMOTE_DISCOVERY_PORT") ?? "47682"),
		discoveryTimeoutMs: overrides.discoveryTimeoutMs ?? Number(env("AIRREMOTE_DISCOVERY_TIMEOUT_MS") ?? "30000"),
		simulate,
		simWav: overrides.simWav ?? env("AIRREMOTE_SIM_WAV") ?? join(dataDir, "sim.wav"),
		simPort: overrides.simPort ?? Number(env("AIRREMOTE_SIM_PORT") ?? "47684"),
		serialPort: overrides.serialPort ?? env("AIRREMOTE_SERIAL_PORT") ?? ""
	};
}
/** The simulated board needs a syntactically valid token; the value is never compared to the firmware. */
function simulatedToken(config) {
	return config.pairingToken.length === 64 ? config.pairingToken : "0".repeat(64);
}
// src/host/firmware-routes.ts
/**
* 「内置固件」的 HTTP 路由（contract: `/airremote/firmware/manifest`、`/airremote/firmware/image`）。
*
* 插件包里带一份从 0x0 整体烧写的合并镜像（`firmware/codex_air_remote-merged.bin`）
* 和它的描述文件（`firmware/manifest.json`），由 `scripts/bundle-firmware.mjs` 在开发机生成。
* 浏览器端用 Web Serial 把镜像流式写进板子，host 只负责静态下发：
*
*  - `GET /airremote/firmware/manifest` → manifest.json（缺少 / 损坏 → 503）
*  - `GET /airremote/firmware/image`    → 合并镜像，**流式**读盘（不 readFile 进内存）
*
* 这里不碰串口、不调用 idf/esptool、不留定时器。
*/
/** 合并镜像的文件名（相对 `firmwareDir`）。 */
const FIRMWARE_IMAGE_FILE = "codex_air_remote-merged.bin";
/** manifest 的文件名（相对 `firmwareDir`）。 */
const FIRMWARE_MANIFEST_FILE = "manifest.json";
var FirmwareRoutes = class {
	options;
	cached;
	constructor(options) {
		this.options = options;
	}
	/** 合并镜像的绝对路径。 */
	get imagePath() {
		return join(this.options.firmwareDir, FIRMWARE_IMAGE_FILE);
	}
	/** manifest 的绝对路径。 */
	get manifestPath() {
		return join(this.options.firmwareDir, FIRMWARE_MANIFEST_FILE);
	}
	/** `GET /airremote/firmware/manifest`。 */
	manifestHandler = async (req, res) => {
		if (!this.originAllowed(req)) {
			this.rejectForeignOrigin(res);
			return;
		}
		const method = (req.method ?? "GET").toUpperCase();
		if (method !== "GET" && method !== "HEAD") {
			this.sendJson(res, 405, {
				ok: false,
				error: "bad-request",
				message: "只支持 GET / HEAD"
			});
			return;
		}
		let manifest;
		try {
			manifest = await this.readManifest();
		} catch (error) {
			this.options.warn?.(`airremote: 内置固件 manifest 不可用：${describe$2(error)}`);
			this.sendUnavailable(res, `内置固件 manifest 不可用：${describe$2(error)}`);
			return;
		}
		this.sendJson(res, 200, manifest, method === "HEAD");
	};
	/** `GET /airremote/firmware/image`；支持 `If-None-Match` → 304。 */
	imageHandler = async (req, res) => {
		if (!this.originAllowed(req)) {
			this.rejectForeignOrigin(res);
			return;
		}
		const method = (req.method ?? "GET").toUpperCase();
		if (method !== "GET" && method !== "HEAD") {
			this.sendJson(res, 405, {
				ok: false,
				error: "bad-request",
				message: "只支持 GET / HEAD"
			});
			return;
		}
		let manifest;
		try {
			manifest = await this.readManifest();
		} catch (error) {
			this.options.warn?.(`airremote: 内置固件 manifest 不可用：${describe$2(error)}`);
			this.sendUnavailable(res, `内置固件 manifest 不可用：${describe$2(error)}`);
			return;
		}
		let size;
		try {
			size = (await stat(this.imagePath)).size;
		} catch (error) {
			this.options.warn?.(`airremote: 内置固件镜像不可读：${describe$2(error)}`);
			this.sendUnavailable(res, `内置固件镜像不可读：${describe$2(error)}`);
			return;
		}
		if (size !== manifest.size) {
			const message = `内置固件与 manifest 不一致（文件 ${String(size)} 字节 / manifest ${String(manifest.size)} 字节），请重跑 scripts/bundle-firmware.mjs`;
			this.options.warn?.(`airremote: ${message}`);
			this.sendUnavailable(res, message);
			return;
		}
		const headers = {
			etag: `"${manifest.sha256}"`,
			"cache-control": "no-store",
			"accept-ranges": "none"
		};
		if (matchesEtag(req.headers["if-none-match"], manifest.sha256)) {
			if (!res.headersSent && !res.writableEnded) res.writeHead(304, headers);
			res.end();
			return;
		}
		if (res.headersSent || res.writableEnded) return;
		res.writeHead(200, {
			...headers,
			"content-type": "application/octet-stream",
			"content-length": size,
			"content-disposition": `attachment; filename="${FIRMWARE_IMAGE_FILE}"`,
			"x-airremote-firmware-version": manifest.version
		});
		if (method === "HEAD") {
			res.end();
			return;
		}
		const stream = createReadStream(this.imagePath);
		/** 客户端提前断开 / 出错都要把读流关掉，不然文件句柄会挂着。 */
		res.on("close", () => {
			stream.destroy();
		});
		stream.on("error", (error) => {
			this.options.warn?.(`airremote: 读取内置固件失败：${describe$2(error)}`);
			stream.destroy();
			res.destroy(error);
		});
		stream.pipe(res);
	};
	/**
	* 启动自检：manifest 能不能读、bin 在不在、大小对不对。
	* 返回问题列表（空数组 = 一切正常）；**不抛错**，调用方只打日志。
	*/
	async selfCheck() {
		const problems = [];
		let manifest;
		try {
			manifest = await this.readManifest();
		} catch (error) {
			const missing = error?.code === "ENOENT";
			problems.push({
				code: missing ? "manifest-missing" : "manifest-invalid",
				path: this.manifestPath,
				message: missing ? `内置固件缺失：找不到 ${this.manifestPath}，请先在开发机跑 scripts/bundle-firmware.mjs` : `内置固件 manifest 损坏：${this.manifestPath}（${describe$2(error)}）`
			});
			return problems;
		}
		try {
			const actual = (await stat(this.imagePath)).size;
			if (actual !== manifest.size) problems.push({
				code: "size-mismatch",
				path: this.imagePath,
				message: `内置固件大小与 manifest 不符：${this.imagePath} 是 ${String(actual)} 字节，manifest 写的是 ${String(manifest.size)} 字节，请重跑 scripts/bundle-firmware.mjs`
			});
		} catch {
			problems.push({
				code: "image-missing",
				path: this.imagePath,
				message: `内置固件缺失：找不到 ${this.imagePath}，请先在开发机跑 scripts/bundle-firmware.mjs`
			});
		}
		return problems;
	}
	/** 读 manifest：按 mtime+size 缓存，烧录期间会连读两次，不重复解析。 */
	async readManifest() {
		const info = await stat(this.manifestPath);
		const cached = this.cached;
		if (cached !== void 0 && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.manifest;
		const raw = await readFile(this.manifestPath, "utf8");
		const manifest = normalizeManifest$1(JSON.parse(raw));
		this.cached = {
			mtimeMs: info.mtimeMs,
			size: info.size,
			manifest
		};
		this.options.log?.(`airremote: 内置固件 v${manifest.version}（${String(manifest.size)} 字节）`);
		return manifest;
	}
	/** 与 `time-routes.ts` 相同的同源策略。 */
	originAllowed(req) {
		const origin = req.headers.origin;
		if (typeof origin !== "string" || origin === "") return true;
		try {
			const parsed = new URL(origin);
			if (parsed.protocol === "dsh-app:" || parsed.protocol === "file:") return true;
			return parsed.host === req.headers.host;
		} catch {
			return false;
		}
	}
	rejectForeignOrigin(res) {
		this.sendJson(res, 403, {
			ok: false,
			error: "forbidden",
			message: "跨站请求被拒绝（Origin 与 Host 不一致）"
		});
	}
	sendUnavailable(res, message) {
		this.sendJson(res, 503, {
			ok: false,
			error: "unavailable",
			message
		});
	}
	sendJson(res, status, body, headOnly = false) {
		if (res.headersSent || res.writableEnded) return;
		const payload = `${JSON.stringify(body)}\n`;
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(payload),
			"cache-control": "no-store"
		});
		res.end(headOnly ? void 0 : payload);
	}
};
/** 校验并规整 manifest：字段缺失或类型不对直接抛错（路由回 503）。 */
function normalizeManifest$1(value) {
	if (value === null || typeof value !== "object") throw new Error("manifest 不是 JSON 对象");
	const record = value;
	const text = (key) => {
		const field = record[key];
		if (typeof field !== "string" || field.trim() === "") throw new Error(`manifest 缺少字符串字段 ${key}`);
		return field.trim();
	};
	const size = record.size;
	if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) throw new Error("manifest 的 size 必须是正整数");
	const offset = record.flashOffset;
	if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) throw new Error("manifest 的 flashOffset 必须是非负整数");
	const sha256 = text("sha256").toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("manifest 的 sha256 必须是 64 位小写 hex");
	return {
		plugin: text("plugin"),
		chip: text("chip"),
		version: text("version"),
		commit: typeof record.commit === "string" ? record.commit.trim() : "",
		flashOffset: offset,
		size,
		sha256,
		builtAt: text("builtAt")
	};
}
/** `If-None-Match` 命中当前 sha256（允许 `W/` 前缀与逗号列表）。 */
function matchesEtag(header, sha256) {
	const raw = Array.isArray(header) ? header.join(",") : header;
	if (typeof raw !== "string" || raw.trim() === "") return false;
	for (const part of raw.split(",")) {
		const token = part.trim().replace(/^W\//i, "");
		if (token === "*") return true;
		if (token === `"${sha256}"` || token === sha256) return true;
	}
	return false;
}
function describe$2(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
// src/host/serial-transport.ts
/**
* node-serialport → esptool-js Transport 适配层（已在真机 ESP32-C6 / COM7 上跑通）。
*
* 用法：
*   const info = await readChipInfo('COM7')
*   // 烧录见 `flash-service.ts`
*
* 设计要点（踩过的坑都写在这里，改之前先读完）：
*  - 只实现 esptool-js `Transport` 真正会调到的 WebSerial 子集：
*    open / close / readable / writable / setSignals / getInfo / getVid / getPid（+ 可选 setBaudRate）。
*  - 读写缓冲自己做（不用 ReadableStream），这样 cancel() 能立刻唤醒挂起的 read()，
*    `waitForUnlock` 不会死循环。
*  - 收尾必须 `transport.disconnect()` → `device.forceUnlock()` → `device.close()`，
*    关不掉时 destroy() 兜底——和 `serial-port.ts` 的 close 模式一致。
*    **任何异常路径都必须走 `releaseSerial()`**，否则 Windows 的独占句柄会一直挂着，
*    之后所有 open 都是 Access denied，只能拔插 USB 或杀宿主进程。
*  - 芯片从 stub / 下载模式回到 App **必须**用 EN 脉冲（RTS 拉高 200ms 再拉低）。
*    `loader.after('hard_reset')` 无效（它走 RTS，而 node-serialport 推不动 RTS：
*    `@serialport/bindings-cpp` 打开端口时写死 `RTS_CONTROL_DISABLE`）；
*    `UsbJtagSerialReset` 会**进**下载模式。唯一可行的是关串口后用一次性 PowerShell
*    设 `RtsEnable`。所以 `pulseEnReset()` 必须在本文件里、串口关闭之后调用。
*  - esptool-js 用**变量**形式的动态 import 加载：它自带的 d.ts `/// <reference
*    types="w3c-web-serial" />` 在本仓库没装（也不需要），字面量 import 会让 tsc
*    去找这个类型包；变量形式既绕过类型解析，也绕过打包器的静态收集。
*/
const require = createRequire(import.meta.url);
const OPEN_TIMEOUT_MS = 5e3;
const CLOSE_TIMEOUT_MS = 1e3;
const SIGNAL_TIMEOUT_MS = 2e3;
/** esptool-js 的 ROM 波特率：USB-Serial/JTAG 下 baud 只是名义值，实际走 USB 全速。 */
const ROM_BAUD_RATE = 115200;
let serialportModule;
/**
* 加载 `serialport`（原生绑定）。宿主是 ESM bundle，用 `createRequire(import.meta.url)`
* 从插件包自己的 node_modules 解析——`serial-port.ts` 也是同一套办法。
*/
function loadSerialport() {
	if (serialportModule !== void 0) return serialportModule;
	const loaded = require("serialport");
	const SerialPort = loaded.SerialPort ?? loaded.default?.SerialPort;
	if (typeof SerialPort !== "function") throw new Error("serialport 里没有导出 SerialPort");
	serialportModule = { SerialPort };
	return serialportModule;
}
/** 列出串口；`serialport` 不可用时抛错（烧录本来就依赖它，不能静默降级）。 */
async function listSerialPorts() {
	return loadSerialport().SerialPort.list();
}
/** 按名字（大小写不敏感）找一条端口记录；找不到返回 undefined。 */
async function findSerialPortEntry(port) {
	const target = port.trim().toUpperCase();
	return (await listSerialPorts()).find((entry) => (entry.path ?? "").toUpperCase() === target);
}
/**
* WebSerial `SerialPort` 的 Node 等价物：只覆盖 esptool-js 用到的部分。
* 结构化类型，运行时被 `Transport` 直接使用（`ESPLoader` 只鸭子类型调用，不检查原型）。
*/
var NodeSerialPortDevice = class {
	path;
	vendorId;
	productId;
	module;
	readable = {
		locked: false,
		getReader: () => {
			this.readable.locked = true;
			return {
				read: () => this.read(),
				cancel: async () => this.end(),
				releaseLock: () => {
					this.readable.locked = false;
				}
			};
		},
		cancel: async () => this.end()
	};
	writable = {
		locked: false,
		getWriter: () => {
			this.writable.locked = true;
			return {
				write: async (chunk) => {
					try {
						await this.writeChunk(chunk);
					} finally {
						this.writable.locked = false;
					}
				},
				close: async () => {
					this.writable.locked = false;
				},
				releaseLock: () => {
					this.writable.locked = false;
				}
			};
		}
	};
	port;
	chunks = [];
	waiters = [];
	ended = true;
	listeners = [];
	constructor(path, vendorId, productId, module = loadSerialport()) {
		this.path = path;
		this.vendorId = vendorId;
		this.productId = productId;
		this.module = module;
	}
	getInfo() {
		return {
			usbVendorId: this.vendorId,
			usbProductId: this.productId
		};
	}
	getVid() {
		return this.vendorId;
	}
	getPid() {
		return this.productId;
	}
	async open(options = {}) {
		if (this.port?.isOpen === true) return;
		this.end();
		this.ended = false;
		this.chunks = [];
		this.waiters = [];
		const port = new this.module.SerialPort({
			path: this.path,
			baudRate: options.baudRate ?? 115200,
			dataBits: options.dataBits ?? 8,
			stopBits: options.stopBits ?? 1,
			parity: options.parity ?? "none",
			rtscts: false,
			xon: false,
			xoff: false,
			autoOpen: false
		});
		this.port = port;
		const onData = (chunk) => this.push(Uint8Array.from(chunk));
		const onClose = () => this.end();
		const onError = () => void 0;
		port.on("data", onData);
		port.on("close", onClose);
		port.on("error", onError);
		this.listeners = [
			["data", onData],
			["close", onClose],
			["error", onError]
		];
		await withTimeout(new Promise((resolve, reject) => port.open((error) => error ? reject(error) : resolve())), OPEN_TIMEOUT_MS, `打开 ${this.path} 超时`);
	}
	async close() {
		this.end();
		const port = this.port;
		this.port = void 0;
		if (port === void 0) return;
		for (const [event, handler] of this.listeners) try {
			port.off(event, handler);
		} catch {}
		this.listeners = [];
		await new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			const destroy = () => {
				try {
					port.destroy();
				} catch {}
			};
			const timer = setTimeout(() => {
				destroy();
				finish();
			}, CLOSE_TIMEOUT_MS);
			timer.unref?.();
			try {
				port.close(() => {
					if (port.isOpen === true) destroy();
					finish();
				});
			} catch {
				destroy();
				finish();
			}
		});
	}
	async setSignals(signals = {}) {
		const port = this.port;
		if (port === void 0 || !port.isOpen) return;
		const payload = {};
		if (typeof signals.dataTerminalReady === "boolean") payload.dtr = signals.dataTerminalReady;
		if (typeof signals.requestToSend === "boolean") payload.rts = signals.requestToSend;
		if (typeof signals.break === "boolean") payload.brk = signals.break;
		if (Object.keys(payload).length === 0) return;
		await withTimeout(new Promise((resolve, reject) => port.set(payload, (error) => error ? reject(error) : resolve())), SIGNAL_TIMEOUT_MS, "setSignals 超时");
	}
	/**
	* 就地改波特率（不重开端口）；`Transport.changeBaudrate()` 优先调它。
	* USB-Serial/JTAG 上 baud 只是名义值，改不改都不影响实际吞吐。
	*/
	async setBaudRate(baudRate) {
		const port = this.port;
		if (port === void 0 || !port.isOpen) return;
		await withTimeout(new Promise((resolve, reject) => port.update({ baudRate }, (error) => error ? reject(error) : resolve())), SIGNAL_TIMEOUT_MS, "setBaudRate 超时");
	}
	/** 写原始字节（不经 SLIP）：读普通控制台文本时用。 */
	async writeRaw(bytes) {
		await this.writeChunk(bytes);
	}
	/** 兜底：解除可能被遗弃的锁，避免 Transport.waitForUnlock 死循环。 */
	forceUnlock() {
		this.readable.locked = false;
		this.writable.locked = false;
	}
	read() {
		if (this.chunks.length > 0) return Promise.resolve({
			value: this.chunks.shift(),
			done: false
		});
		if (this.ended) return Promise.resolve({ done: true });
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}
	push(chunk) {
		if (this.ended || chunk.length === 0) return;
		const waiter = this.waiters.shift();
		if (waiter !== void 0) waiter({
			value: chunk,
			done: false
		});
		else this.chunks.push(chunk);
	}
	end() {
		if (this.ended && this.waiters.length === 0) return;
		this.ended = true;
		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters) waiter({ done: true });
	}
	writeChunk(chunk) {
		const port = this.port;
		if (port === void 0 || !port.isOpen) return Promise.reject(/* @__PURE__ */ new Error("串口未打开"));
		return new Promise((resolve, reject) => {
			port.write(chunk, (error) => {
				if (error) {
					reject(error);
					return;
				}
				port.drain(() => resolve());
			});
		});
	}
};
function withTimeout(promise, ms, message) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		timer.unref?.();
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}
/** 加载 esptool-js。失败说明依赖没装好——烧录没法继续，让调用方映射成 `internal`。 */
async function loadEsptool() {
	const loaded = await import(
		/* @vite-ignore */
		"esptool-js"
);
	if (typeof loaded.ESPLoader !== "function" || typeof loaded.Transport !== "function") throw new Error("esptool-js 里没有导出 ESPLoader / Transport");
	return {
		ESPLoader: loaded.ESPLoader,
		Transport: loaded.Transport
	};
}
/**
* 释放串口：`transport.disconnect()` → `forceUnlock()` → `device.close()`。
* 每一步都吞异常：收尾阶段抛错没有意义，但**必须全部执行**，漏一步就是句柄泄漏。
*/
async function releaseSerial(device, transport) {
	try {
		await transport?.disconnect();
	} catch {}
	try {
		device?.forceUnlock();
	} catch {}
	try {
		await device?.close();
	} catch {}
}
const POWERSHELL_EN_PULSE = String.raw`
$ErrorActionPreference = 'Stop'
$sp = New-Object System.IO.Ports.SerialPort
$sp.PortName = $env:AR_PORT
$sp.BaudRate = [int]$env:AR_BAUD
$sp.DataBits = 8
$sp.Parity = [System.IO.Ports.Parity]::None
$sp.StopBits = [System.IO.Ports.StopBits]::One
$sp.Handshake = [System.IO.Ports.Handshake]::None
$sp.ReadTimeout = 200
try {
  $sp.Open()
  $sp.RtsEnable = $true
  Start-Sleep -Milliseconds 200
  $sp.RtsEnable = $false
  Write-Output 'PULSE_OK'
} finally {
  if ($sp.IsOpen) { $sp.Close() }
}
exit 0
`;
/**
* 把芯片从 stub / 下载模式带回固件：RTS(EN) 拉高 200ms 再拉低。
*
* **调用前必须已经把串口关掉**（Windows 独占句柄，PowerShell 抢不到会报 Access denied）。
* PowerShell 是 `powershell.exe`（Windows 一定存在；pwsh 不一定），参数走环境变量。
*/
function pulseEnReset(port, baudRate = ROM_BAUD_RATE) {
	return new Promise((resolve, reject) => {
		execFile("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			POWERSHELL_EN_PULSE
		], {
			timeout: 1e4,
			windowsHide: true,
			env: {
				...process.env,
				AR_PORT: port,
				AR_BAUD: String(baudRate)
			}
		}, (error, stdout) => {
			if (error !== null || !String(stdout).includes("PULSE_OK")) {
				reject(/* @__PURE__ */ new Error(`EN 复位失败：${error?.message ?? String(stdout)}`));
				return;
			}
			resolve();
		});
	});
}
/** 烧录失败：`code` 直接对应契约里的错误码，`message` 是给人看的中文。 */
var FlashError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.name = "FlashError";
		this.code = code;
	}
};
/**
* 读并校验内置固件。sha256 在 host 侧重算，和 manifest 不一致直接拒绝——
* 这样镜像被截断 / 换包 / 半写入都不会烧进板子。
*/
async function loadFirmwareImage(firmwareDir) {
	const manifestPath = join(firmwareDir, FIRMWARE_MANIFEST_FILE);
	const imagePath = join(firmwareDir, FIRMWARE_IMAGE_FILE);
	let manifest;
	try {
		manifest = normalizeManifest(JSON.parse(await readFile(manifestPath, "utf8")));
	} catch (error) {
		throw new FlashError("internal", `内置固件 manifest 不可用（${manifestPath}）：${describe$1(error)}。请先在开发机跑 scripts/bundle-firmware.mjs`);
	}
	let data;
	try {
		data = await readFile(imagePath);
	} catch (error) {
		throw new FlashError("internal", `内置固件镜像不可读（${imagePath}）：${describe$1(error)}。请先在开发机跑 scripts/bundle-firmware.mjs`);
	}
	if (data.length !== manifest.size) throw new FlashError("sha256-mismatch", `内置固件大小与 manifest 不一致：${imagePath} 是 ${String(data.length)} 字节，manifest 写的是 ${String(manifest.size)} 字节`);
	const actual = createHash("sha256").update(data).digest("hex");
	if (actual !== manifest.sha256.toLowerCase()) throw new FlashError("sha256-mismatch", `内置固件 sha256 校验失败：${imagePath} 实际 ${actual}，manifest 是 ${manifest.sha256}。请重跑 scripts/bundle-firmware.mjs`);
	return {
		manifest,
		data: new Uint8Array(data)
	};
}
/**
* 烧录内置合并镜像。
*
* 副作用：占用串口 → 校验镜像 → 连接芯片（必要时上传 stub）→ 写 flash → MD5 校验 →
* 关串口 → EN 硬复位。无论成功、失败、取消，串口都会被关掉并复位芯片。
*/
async function flashFirmware(options) {
	const started = Date.now();
	const port = options.port.trim();
	const baudRate = options.baudRate ?? 460800;
	const romBaudRate = options.romBaudRate ?? 115200;
	if (port === "") throw new FlashError("no-board", "没有指定串口，找不到 ESP32-C6 开发板");
	throwIfAborted(options.signal);
	const image = await loadFirmwareImage(options.firmwareDir);
	throwIfAborted(options.signal);
	let device;
	let transport;
	let loader;
	/** 只有真的碰到了串口才需要 EN 复位；连 serialport 都没加载成功时不要空跑 Powershell。 */
	let touchedPort = false;
	try {
		const esptool = await loadEsptool();
		let entry;
		try {
			entry = await findSerialPortEntry(port);
		} catch (error) {
			throw new FlashError("internal", `串口不可用（${port}）：${describe$1(error)}`);
		}
		if (entry === void 0) throw new FlashError("no-board", `未找到串口 ${port}（ESP32-C6 没插好，或 USB 驱动还没就绪）`);
		device = new NodeSerialPortDevice(port, entry.vendorId !== void 0 ? Number.parseInt(entry.vendorId, 16) : void 0, entry.productId !== void 0 ? Number.parseInt(entry.productId, 16) : void 0);
		touchedPort = true;
		const terminal = {
			clean: () => void 0,
			write: (data) => emitLines(options.onLine, data),
			writeLine: (data) => emitLines(options.onLine, data)
		};
		transport = new esptool.Transport(device);
		loader = new esptool.ESPLoader({
			transport,
			baudrate: baudRate,
			romBaudrate: romBaudRate,
			terminal
		});
		await loader.main();
		throwIfAborted(options.signal);
		await loader.writeFlash({
			fileArray: [{
				data: image.data,
				address: 0
			}],
			flashSize: "keep",
			flashMode: "keep",
			flashFreq: "keep",
			eraseAll: false,
			compress: true,
			calculateMD5Hash: (bytes) => createHash("md5").update(bytes).digest("hex"),
			reportProgress: (_fileIndex, written, total) => {
				throwIfAborted(options.signal);
				if (total > 0) options.onProgress?.(Math.min(100, Math.round(written / total * 100)), written, total);
			}
		});
		options.onProgress?.(100, image.data.length, image.data.length);
		return {
			port,
			seconds: secondsSince(started),
			sha256: image.manifest.sha256,
			bytes: image.data.length
		};
	} catch (error) {
		throw mapFlashError(error, port);
	} finally {
		await releaseSerial(device, transport);
		if (touchedPort) try {
			await pulseEnReset(port);
		} catch (error) {
			options.onWarn?.(`airremote: ${port} EN 复位失败：${describe$1(error)}`);
		}
	}
}
/** 把任意异常映射成契约错误码。 */
function mapFlashError(error, port) {
	if (error instanceof FlashError) return error;
	if (isAbortError(error)) return new FlashError("cancelled", "烧录已取消");
	const message = describe$1(error);
	const name = error instanceof Error ? error.name : "";
	if (/access is denied|access denied|拒绝访问|being used by another process|EBUSY|EACCES|resource busy/i.test(message)) return new FlashError("busy", `串口 ${port} 被其它程序占用，请关闭串口监视器 / 烧录工具后重试（${message}）`);
	if (name === "TimeoutError" || /timed out|timeout|超时/i.test(message)) return new FlashError("timeout", `与 ${port} 通信超时：${message}`);
	if (/Failed to connect with the device|Failed to connect|no serial data received|could not open port/i.test(message)) return new FlashError("timeout", `连接 ${port} 上的 ESP32-C6 超时：${message}`);
	if (/Opening COM|Cannot open|Failed to open|打开 .* 超时/i.test(message)) return new FlashError("open-failed", `打开串口 ${port} 失败：${message}`);
	if (name === "ESPError" || /^Invalid (head of packet|response)|Unexpected response|Wrong argument|Command not found/i.test(message)) return new FlashError("rejected", `开发板拒绝了烧录命令：${message}`);
	if (/没有导出|Cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(message)) return new FlashError("internal", `烧录依赖不可用：${message}`);
	return new FlashError("internal", `烧录失败：${message}`);
}
/** 已经取消就立刻抛 `cancelled`（取消后不再碰串口）。 */
function throwIfAborted(signal) {
	if (signal?.aborted === true) throw new FlashError("cancelled", "烧录已取消");
}
function isAbortError(error) {
	return error instanceof FlashError && error.code === "cancelled";
}
/** esptool 的 terminal 输出是任意分片，按行拆开再回调。 */
function emitLines(onLine, data) {
	if (onLine === void 0 || data === "") return;
	for (const line of data.split(/\r?\n/)) if (line !== "") try {
		onLine(line);
	} catch {}
}
function secondsSince(startedAt) {
	return Math.round((Date.now() - startedAt) / 100) / 10;
}
function describe$1(error) {
	return error instanceof Error ? error.message : String(error);
}
/** 校验并规整 manifest：字段缺失或类型不对直接抛错（上层映射成 internal）。 */
function normalizeManifest(value) {
	if (value === null || typeof value !== "object") throw new Error("manifest 不是 JSON 对象");
	const record = value;
	const text = (key) => {
		const field = record[key];
		if (typeof field !== "string" || field.trim() === "") throw new Error(`manifest 缺少字符串字段 ${key}`);
		return field.trim();
	};
	const size = record.size;
	if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) throw new Error("manifest 的 size 必须是正整数");
	const offset = record.flashOffset;
	if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) throw new Error("manifest 的 flashOffset 必须是非负整数");
	const sha256 = text("sha256").toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("manifest 的 sha256 必须是 64 位小写 hex");
	return {
		plugin: text("plugin"),
		chip: text("chip"),
		version: text("version"),
		commit: typeof record.commit === "string" ? record.commit.trim() : "",
		flashOffset: offset,
		size,
		sha256,
		builtAt: text("builtAt")
	};
}
// src/host/flash-route.ts
/** 心跳间隔：只发 `ping` 保活，不据此判定 / 断开空闲连接。 */
const HEARTBEAT_INTERVAL_MS = 15e3;
var FlashRoute = class {
	/** 所有活着的连接；连/断都只动这个集合。 */
	clients = /* @__PURE__ */ new Set();
	/** 当前烧录任务；`undefined` = 空闲。只有它会产生「忙碌」。 */
	task;
	heartbeat;
	disposed = false;
	options;
	constructor(options) {
		this.options = options;
	}
	/** `webServer.registerUpgrade` handler。 */
	handler = (req, socket, head) => {
		if (this.disposed) {
			socket.destroy();
			return;
		}
		if (!this.originAllowed(req)) {
			socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
			socket.destroy();
			return;
		}
		const client = { connection: void 0 };
		const connection = acceptWebSocket(req, socket, head, {
			onMessage: (message) => {
				if (message.type === "binary") return;
				let parsed;
				try {
					parsed = JSON.parse(message.text);
				} catch {
					return;
				}
				if (parsed.type === "start") this.start(client);
				else if (parsed.type === "cancel") this.cancel(client, "客户端请求取消");
				else if (parsed.type === "ping") this.sendJson(client.connection, {
					type: "pong",
					at: Date.now()
				});
			},
			onClose: () => {
				if (client.connection !== void 0) this.clients.delete(client.connection);
				if (this.clients.size === 0) this.stopHeartbeat();
			},
			onError: (error) => {
				this.options.warn?.(`airremote: flash socket error: ${error.message}`);
			}
		});
		client.connection = connection;
		this.clients.add(connection);
		this.ensureHeartbeat();
		this.sendJson(connection, {
			type: "state",
			phase: this.task === void 0 ? "idle" : "running"
		});
	};
	/**
	* 与 `audio-route.ts` 完全相同的同源策略：页面请求会带 Origin，必须和 Host 一致；
	* `dsh-app:` / `file:` 是桌面壳，Node 客户端（测试）不带 Origin，都放行。
	*/
	originAllowed(req) {
		const origin = req.headers.origin;
		if (typeof origin !== "string" || origin === "") return true;
		try {
			const parsed = new URL(origin);
			if (parsed.protocol === "dsh-app:" || parsed.protocol === "file:") return true;
			return parsed.host === req.headers.host;
		} catch {
			return false;
		}
	}
	/** 只在有连接时开一个 interval；只发 ping，不因空闲关闭。 */
	ensureHeartbeat() {
		if (this.heartbeat !== void 0) return;
		this.heartbeat = setInterval(() => this.heartbeatTick(), HEARTBEAT_INTERVAL_MS);
		this.heartbeat.unref?.();
	}
	stopHeartbeat() {
		if (this.heartbeat === void 0) return;
		clearInterval(this.heartbeat);
		this.heartbeat = void 0;
	}
	heartbeatTick() {
		if (this.disposed || this.clients.size === 0) {
			this.stopHeartbeat();
			return;
		}
		this.broadcast({
			type: "ping",
			at: Date.now()
		});
	}
	/** 发起一次烧录；已有任务时只回 busy 错误，连接保持。 */
	start(client) {
		if (this.disposed) return;
		if (this.task !== void 0) {
			this.sendJson(client.connection, {
				type: "error",
				code: "busy",
				message: "已有一次烧录在进行，请等它结束"
			});
			return;
		}
		const holder = this.options.holder;
		if (holder !== void 0 && !holder.acquire("flash")) {
			this.sendJson(client.connection, {
				type: "state",
				phase: "error"
			});
			this.sendJson(client.connection, {
				type: "error",
				code: "busy",
				message: "串口正被其它操作占用，请稍后再试"
			});
			return;
		}
		const lockHeld = holder !== void 0;
		const controller = new AbortController();
		const task = { controller };
		this.task = task;
		this.broadcast({
			type: "state",
			phase: "running"
		});
		const flash = this.options.flash ?? flashFirmware;
		(async () => {
			try {
				const result = await flash({
					firmwareDir: this.options.firmwareDir,
					port: await this.resolvePort(),
					signal: controller.signal,
					onLine: (line) => this.broadcast({
						type: "log",
						line
					}),
					onProgress: (percent, written, total) => this.broadcast({
						type: "progress",
						percent,
						written,
						total
					}),
					onWarn: (message) => this.options.warn?.(message)
				});
				this.broadcast({
					type: "state",
					phase: "done"
				});
				this.broadcast({
					type: "done",
					port: result.port,
					seconds: result.seconds
				});
				this.options.logger?.(`airremote: 固件已烧录到 ${result.port}（${String(result.seconds)}s）`);
			} catch (error) {
				const code = error instanceof FlashError ? error.code : "internal";
				const message = error instanceof Error ? error.message : String(error);
				if (code === "cancelled") {
					this.broadcast({
						type: "state",
						phase: "cancelled"
					});
					this.options.logger?.(`airremote: 烧录已取消：${message}`);
				} else {
					this.broadcast({
						type: "state",
						phase: "error"
					});
					this.options.warn?.(`airremote: 烧录失败（${code}）：${message}`);
				}
				this.broadcast({
					type: "error",
					code,
					message
				});
			} finally {
				if (this.task === task) this.task = void 0;
				if (lockHeld) holder?.release("flash");
			}
		})();
	}
	/** 任意连接都可以取消；没有任务时只把「空闲」回给发起者。 */
	cancel(client, reason) {
		const task = this.task;
		if (task === void 0) {
			this.sendJson(client.connection, {
				type: "state",
				phase: "idle"
			});
			return;
		}
		this.options.logger?.(`airremote: ${reason}`);
		task.controller.abort();
	}
	/**
	* 烧录目标口：用注入的解析器（index.ts 传配置里的 `serialPort`，为空则自动发现），
	* 默认走 `findBoardPort('')`——与时间同步同一条发现路径。
	*/
	async resolvePort() {
		const found = await (this.options.resolvePort ?? (() => findBoardPort("")))();
		if (found === null || found.trim() === "") throw new FlashError("no-board", "未找到 ESP32-C6 开发板（USB VID 303A）");
		return found.trim();
	}
	/** 广播给所有连接；顺手清掉已经关掉的。 */
	broadcast(value) {
		for (const connection of this.clients) {
			if (!connection.open) {
				this.clients.delete(connection);
				continue;
			}
			this.sendJson(connection, value);
		}
	}
	sendJson(connection, value) {
		try {
			connection?.sendText(JSON.stringify(value));
		} catch {}
	}
	dispose() {
		this.disposed = true;
		this.stopHeartbeat();
		this.task?.controller.abort();
		const connections = [...this.clients];
		this.clients.clear();
		for (const connection of connections) try {
			connection.close(1001, "plugin disposed");
		} catch {}
	}
};
/** 请求体上限，和 `time-routes.ts` 保持一致。 */
const MAX_BODY_BYTES$1 = 4096;
var SerialHolder = class {
	ttlMs;
	now;
	holder = null;
	sinceMs = null;
	constructor(options = {}) {
		this.ttlMs = options.ttlMs ?? 3e5;
		this.now = options.now ?? Date.now;
	}
	/** 当前状态（顺便处理过期）。 */
	state() {
		this.expire();
		return this.holder === null ? {
			holder: "none",
			since: null
		} : {
			holder: this.holder,
			since: new Date(this.sinceMs ?? this.now()).toISOString()
		};
	}
	/** 抢锁：空闲（或已过期）时成功；已被别人持有则失败。重复抢同一把锁算成功（幂等，`since` 不刷新）。 */
	acquire(holder) {
		this.expire();
		if (this.holder === null) {
			this.holder = holder;
			this.sinceMs = this.now();
			return true;
		}
		return this.holder === holder;
	}
	/**
	* 放锁：只放自己持有的那把；`'none'` 表示强制清空（前端「取消烧录」兜底）。
	* 返回是否真的清空了。
	*/
	release(holder) {
		this.expire();
		if (this.holder === null) return true;
		if (holder !== "none" && this.holder !== holder) return false;
		this.holder = null;
		this.sinceMs = null;
		return true;
	}
	expire() {
		if (this.holder === null || this.sinceMs === null) return;
		if (this.now() - this.sinceMs < this.ttlMs) return;
		this.holder = null;
		this.sinceMs = null;
	}
};
/**
* 两条串口锁路由的处理体。`webServer.register` 只按路径匹配、不看方法，
* 所以每个 handler 自己按 `req.method` 分发。
*/
var SerialRoutes = class {
	options;
	constructor(options) {
		this.options = options;
	}
	/** `GET /airremote/serial-state` → `{ok:true, holder, since}`。 */
	stateHandler = async (req, res) => {
		if (!originAllowed(req)) {
			rejectForeignOrigin(res);
			return;
		}
		const method = (req.method ?? "GET").toUpperCase();
		if (method !== "GET" && method !== "HEAD") {
			sendJson(res, 405, {
				ok: false,
				error: "bad-request",
				message: "只支持 GET"
			});
			return;
		}
		sendJson(res, 200, {
			ok: true,
			...this.options.holder.state()
		}, method === "HEAD");
	};
	/** `POST /airremote/serial-hold` body `{"holder":"flash"|"none"}`：抢锁 / 放锁。 */
	holdHandler = async (req, res) => {
		if (!originAllowed(req)) {
			rejectForeignOrigin(res);
			return;
		}
		if ((req.method ?? "GET").toUpperCase() !== "POST") {
			sendJson(res, 405, {
				ok: false,
				error: "bad-request",
				message: "只支持 POST"
			});
			return;
		}
		let body;
		try {
			body = await readJsonBody$1(req);
		} catch (error) {
			sendJson(res, 400, {
				ok: false,
				error: "bad-request",
				message: error instanceof Error ? error.message : "请求体不合法"
			});
			return;
		}
		const requested = body !== null && typeof body === "object" ? body.holder : void 0;
		if (requested !== "flash" && requested !== "none" && requested !== "sync") {
			sendJson(res, 400, {
				ok: false,
				error: "bad-request",
				message: "holder 必须是 \"flash\"、\"sync\" 或 \"none\""
			});
			return;
		}
		if (requested === "none") {
			this.options.holder.release("none");
			this.options.log?.("airremote: 串口锁已由前端释放");
			sendJson(res, 200, {
				ok: true,
				...this.options.holder.state()
			});
			return;
		}
		if (!this.options.holder.acquire(requested)) {
			sendJson(res, 200, {
				ok: false,
				error: "busy",
				...this.options.holder.state(),
				message: "串口正被其它操作占用，请稍后再试"
			});
			return;
		}
		this.options.log?.(`airremote: 串口锁已交给 ${requested}`);
		sendJson(res, 200, {
			ok: true,
			...this.options.holder.state()
		});
	};
};
/**
* 与 `time-routes.ts` 完全相同的同源策略：页面请求会带 Origin，必须和 Host 一致；
* `dsh-app:` / `file:` 是桌面壳，Node 客户端（测试）不带 Origin，都放行。
*/
function originAllowed(req) {
	const origin = req.headers.origin;
	if (typeof origin !== "string" || origin === "") return true;
	try {
		const parsed = new URL(origin);
		if (parsed.protocol === "dsh-app:" || parsed.protocol === "file:") return true;
		return parsed.host === req.headers.host;
	} catch {
		return false;
	}
}
function rejectForeignOrigin(res) {
	sendJson(res, 403, {
		ok: false,
		error: "forbidden",
		message: "跨站请求被拒绝（Origin 与 Host 不一致）"
	});
}
function sendJson(res, status, body, headOnly = false) {
	if (res.headersSent || res.writableEnded) return;
	const payload = `${JSON.stringify(body)}\n`;
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store"
	});
	res.end(headOnly ? void 0 : payload);
}
/** 读 JSON 请求体：上限 4 KB，空体或非法 JSON 抛错。 */
async function readJsonBody$1(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.length;
		if (size > MAX_BODY_BYTES$1) throw new Error("请求体超过 4 KB");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") throw new Error("请求体为空，需要 JSON");
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("请求体不是合法 JSON");
	}
}
// src/host/sync-gate.ts
/**
* host 侧「同一时刻只允许一次串口校时」的闸门。
*
* 手动同步（`POST /airremote/sync-time`）和自动对时（`AutoTimeSync`）是两条独立路径，
* 但写的是同一个串口；只靠各自的 busy 标记挡不住对方（串口锁对同名的 `sync` 是幂等的），
* 所以由 `index.ts` 建一个实例注入两边共享。
*
* 纯内存、同步、不排队：抢不到就跳过，绝不让请求或对时等着。
*/
var SyncGate = class {
	busy = false;
	/** 抢闸门：已经有人用时返回 false。 */
	tryEnter() {
		if (this.busy) return false;
		this.busy = true;
		return true;
	}
	/** 放闸门：无论之前是谁抢到的，都直接清空（调用方保证成对使用）。 */
	leave() {
		this.busy = false;
	}
	/** 当前是否有人正在同步（只读，供日志 / 测试）。 */
	get locked() {
		return this.busy;
	}
};
// src/host/time-routes.ts
/** 请求体上限；两个 POST 的载荷都是几十字节，4 KB 足够并挡住放大攻击。 */
const MAX_BODY_BYTES = 4096;
/** 与契约一致的分钟偏移范围（东为正，480 = UTC+8）。 */
const MIN_MINUTES = -720;
const MAX_MINUTES = 840;
var BadRequestError = class extends Error {};
/**
* 三条路由的处理体。`webServer.register` 只按路径匹配、不区分方法，
* 所以 `/airremote/time` 用同一个 handler 内部按 `req.method` 分发
* （不能对同一路径注册两次：webserver 对重复 (kind, path) 会直接抛错）。
*/
var TimeRoutes = class {
	options;
	/** 同步进行中；第二次请求立即回 `busy`，不排队。 */
	syncing = false;
	disposed = false;
	constructor(options) {
		this.options = options;
	}
	/** `/airremote/time`。 */
	timeHandler = async (req, res) => {
		if (!this.originAllowed(req)) {
			this.rejectForeignOrigin(res);
			return;
		}
		const method = (req.method ?? "GET").toUpperCase();
		if (method === "GET") {
			this.sendPreference(res);
			return;
		}
		if (method === "POST") {
			await this.savePreference(req, res);
			return;
		}
		this.sendJson(res, 405, {
			ok: false,
			error: "bad-request",
			message: "只支持 GET / POST"
		});
	};
	/** `/airremote/sync-time`。 */
	syncTimeHandler = async (req, res) => {
		if (!this.originAllowed(req)) {
			this.rejectForeignOrigin(res);
			return;
		}
		if ((req.method ?? "GET").toUpperCase() !== "POST") {
			this.sendJson(res, 405, {
				ok: false,
				error: "bad-request",
				message: "只支持 POST"
			});
			return;
		}
		await this.sync(req, res);
	};
	dispose() {
		this.disposed = true;
	}
	/**
	* 与 `audio-route.ts` 相同的同源策略：页面请求会带 Origin，必须和 Host 一致；
	* `dsh-app:` / `file:` 是桌面壳，Node 客户端（测试）不带 Origin，都放行。
	*/
	originAllowed(req) {
		const origin = req.headers.origin;
		if (typeof origin !== "string" || origin === "") return true;
		try {
			const parsed = new URL(origin);
			if (parsed.protocol === "dsh-app:" || parsed.protocol === "file:") return true;
			return parsed.host === req.headers.host;
		} catch {
			return false;
		}
	}
	rejectForeignOrigin(res) {
		this.sendJson(res, 403, {
			ok: false,
			error: "forbidden",
			message: "跨站请求被拒绝（Origin 与 Host 不一致）"
		});
	}
	sendPreference(res) {
		const preference = readTimePreference(this.options.dataDir);
		this.sendJson(res, 200, {
			ok: true,
			timezone: preference.timezone,
			autoSync: preference.autoSync,
			updatedAt: preference.updatedAt
		});
	}
	/**
	* `POST /airremote/time`：`{timezone?}` 与 `{autoSync?}` 至少给一个，
	* 只改给出的字段，另一个沿用文件里的值。
	*/
	async savePreference(req, res) {
		let body;
		try {
			body = await readJsonBody(req);
		} catch (error) {
			this.badRequest(res, error);
			return;
		}
		if (body === null || typeof body !== "object") {
			this.badRequest(res, new BadRequestError("请求体必须是 JSON 对象"));
			return;
		}
		const timezone = body.timezone;
		const autoSync = body.autoSync;
		if (timezone === void 0 && autoSync === void 0) {
			this.sendJson(res, 400, {
				ok: false,
				error: "bad-request",
				message: "timezone 与 autoSync 至少要给一个"
			});
			return;
		}
		if (timezone !== void 0 && !isTimezoneId(timezone)) {
			this.sendJson(res, 400, {
				ok: false,
				error: "bad-request",
				message: "timezone 必须是 1..32 个 [a-z0-9+_-] 字符的字符串"
			});
			return;
		}
		if (autoSync !== void 0 && typeof autoSync !== "boolean") {
			this.sendJson(res, 400, {
				ok: false,
				error: "bad-request",
				message: "autoSync 必须是布尔值"
			});
			return;
		}
		const patch = {};
		if (timezone !== void 0) patch.timezone = timezone;
		if (autoSync !== void 0) patch.autoSync = autoSync;
		try {
			const saved = writeTimePreference(this.options.dataDir, patch);
			this.sendJson(res, 200, {
				ok: true,
				timezone: saved.timezone,
				autoSync: saved.autoSync,
				updatedAt: saved.updatedAt
			});
		} catch (error) {
			this.options.warn?.(`airremote: 保存时间设置失败：${describe(error)}`);
			this.sendJson(res, 200, {
				ok: false,
				error: "internal",
				message: `保存时间设置失败：${describe(error)}`
			});
		}
	}
	async sync(req, res) {
		let body;
		try {
			body = await readJsonBody(req);
		} catch (error) {
			this.badRequest(res, error);
			return;
		}
		const raw = body !== null && typeof body === "object" ? body.minutes : void 0;
		if (typeof raw !== "number" || !Number.isInteger(raw) || raw < MIN_MINUTES || raw > MAX_MINUTES) {
			this.sendJson(res, 400, {
				ok: false,
				error: "bad-request",
				message: `minutes 必须是 ${String(MIN_MINUTES)}..${String(MAX_MINUTES)} 之间的整数`
			});
			return;
		}
		const minutes = raw;
		if (this.disposed) {
			this.sendJson(res, 200, {
				ok: false,
				error: "internal",
				message: "插件正在卸载，请稍后重试",
				port: null,
				lines: []
			});
			return;
		}
		/** 串口互斥：浏览器正在烧录时不能抢口（烧录由前端 Web Serial 持有）。 */
		const holder = this.options.serialHolder;
		if (holder !== void 0 && holder.state().holder === "flash") {
			this.sendJson(res, 200, {
				ok: false,
				error: "busy",
				port: null,
				lines: [],
				message: "串口正被烧录占用"
			});
			return;
		}
		if (this.syncing) {
			this.sendJson(res, 200, {
				ok: false,
				error: "busy",
				port: null,
				lines: [],
				message: "已有一次时间同步正在进行，请稍候再试"
			});
			return;
		}
		/** 自动对时可能正用着串口：共享闸门抢不到就直接回 busy，不排队。 */
		const gate = this.options.gate;
		if (gate !== void 0 && !gate.tryEnter()) {
			this.sendJson(res, 200, {
				ok: false,
				error: "busy",
				port: null,
				lines: [],
				message: "自动对时正在写入时间，请稍候再试"
			});
			return;
		}
		if (holder !== void 0 && !holder.acquire("sync")) {
			gate?.leave();
			this.sendJson(res, 200, {
				ok: false,
				error: "busy",
				port: null,
				lines: [],
				message: "串口正被其它操作占用，请稍后再试"
			});
			return;
		}
		const lockHeld = holder !== void 0;
		const gateHeld = gate !== void 0;
		this.syncing = true;
		/** host 的时钟，不用浏览器时间。 */
		const unix = Math.floor(Date.now() / 1e3);
		let port = null;
		try {
			port = await findBoardPort(this.options.serialPort);
			if (port === null) {
				this.sendJson(res, 200, {
					ok: false,
					error: "no-board",
					port: null,
					lines: [],
					message: "未找到 ESP32-C6 开发板（USB VID 303A）"
				});
				return;
			}
			const result = await syncBoardTime(port, unix, minutes);
			this.options.log?.(`airremote: ${port} 时间已同步 unix=${String(unix)} minutes=${String(minutes)}`);
			this.sendJson(res, 200, {
				ok: true,
				port,
				unix,
				minutes,
				lines: result.lines
			});
		} catch (error) {
			const code = error instanceof BoardSyncError ? error.code : "internal";
			const lines = error instanceof BoardSyncError ? error.lines : [];
			this.options.warn?.(`airremote: ${port ?? "?"} 同步失败（${code}）：${describe(error)}`);
			this.sendJson(res, 200, {
				ok: false,
				error: code,
				port,
				lines,
				message: describe(error)
			});
		} finally {
			this.syncing = false;
			if (lockHeld) holder?.release("sync");
			if (gateHeld) gate?.leave();
		}
	}
	badRequest(res, error) {
		const message = error instanceof BadRequestError ? error.message : "请求体不合法";
		this.sendJson(res, 400, {
			ok: false,
			error: "bad-request",
			message
		});
	}
	sendJson(res, status, body) {
		if (res.headersSent || res.writableEnded) return;
		const payload = `${JSON.stringify(body)}\n`;
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(payload),
			"cache-control": "no-store"
		});
		res.end(payload);
	}
};
/** 读 JSON 请求体：上限 4 KB，空体或非法 JSON 抛 `bad-request`。 */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new BadRequestError("请求体超过 4 KB");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") throw new BadRequestError("请求体为空，需要 JSON");
	try {
		return JSON.parse(text);
	} catch {
		throw new BadRequestError("请求体不是合法 JSON");
	}
}
function describe(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}
// src/index.ts
/**
* 内置固件目录：`lib/index.js` 的上一级（插件包根）下的 `firmware/`。
* 用 `import.meta.url` 推，不用 `process.cwd()`、不写死仓库绝对路径，
* 这样 npm link / 安装到 profile 之后都能找到包内文件。
* （`lib/index.js` 与源码 `src/index.ts` 同在一个「上一级是包根」的深度，
* 所以 dev、build 两种形态解析结果一致。）
*/
const FIRMWARE_DIR = fileURLToPath(new URL("../firmware", import.meta.url));
/**
* dsh-airremote host entry.
*
* The host owns the board link and exposes it to the page over the
* `dsh-host-webserver` upgrade route `/airremote/audio`. The client half
* installs a synthetic microphone and feeds the official DSH voice-input
* plugin, so this plugin never renders its own microphone button.
*/
const name = "dsh-airremote";
/** The upgrade route needs the Web carrier; headless profiles simply do not load this plugin. */
const inject = ["webServer"];
async function apply(ctx, config = {}) {
	const resolved = resolveHostConfig(config);
	const logger = ctx.logger("dsh-airremote");
	const discovery = new BoardDiscovery({ port: resolved.discoveryPort });
	try {
		await discovery.start();
	} catch (error) {
		logger.warn(`UDP discovery unavailable on ${String(resolved.discoveryPort)}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let fake;
	let simulation;
	if (resolved.simulate) {
		fake = new FakeBoard({
			port: resolved.simPort,
			token: simulatedToken(resolved),
			wavPath: resolved.simWav,
			discoveryPort: resolved.discoveryPort
		});
		try {
			await fake.start();
			simulation = fake.address;
			logger.info(`simulated board listening on ws://${simulation.host}:${String(simulation.port)}/voice`);
		} catch (error) {
			logger.error(`simulated board failed: ${error instanceof Error ? error.message : String(error)}`);
			fake = void 0;
		}
	}
	/**
	* 串口锁 + 校时闸门：手动「同步到开发板」与自动对时共用，
	* 保证同一时刻只有一个写串口的动作（烧录持有 `flash` 时两边都跳过）。
	*/
	const serialHolder = new SerialHolder();
	const syncGate = new SyncGate();
	/**
	* 自动对时：连上板子（WSS 音频路由被连上）或插件刚启动时，把 host 时间 + 设置里的时区
	* 写进板子，不需要用户点按钮。排期在 `apply()` 末尾，只 setTimeout、不 await，
	* 失败只记 warn，绝不影响插件加载。
	*/
	const autoSync = new AutoTimeSync({
		dataDir: resolved.dataDir,
		serialPort: resolved.serialPort,
		serialHolder,
		gate: syncGate,
		log: (message) => logger.info(message),
		warn: (message) => logger.warn(message)
	});
	const route = new AudioRoute({
		config: resolved,
		discovery,
		simulation,
		logger: (message) => logger.info(message)
	});
	/** 每次 WSS 音频路由被连上算一次「板子会话建立」，给自动对时一个去重键。 */
	let audioSessions = 0;
	const disposeRoute = ctx.webServer.registerUpgrade({
		path: "/airremote/audio",
		handler: (req, socket, head) => {
			audioSessions += 1;
			try {
				autoSync.notifySession(String(audioSessions));
			} catch {}
			route.handler(req, socket, head);
		}
	});
	/**
	* 开发板时间设置：GET/POST `/airremote/time` 读写时区与自动对时开关，
	* POST `/airremote/sync-time` 把 host 当前时间与时区写进板子。
	* 路由只是「有人点按钮才动」的普通 HTTP handler，不带定时器；
	* 注册失败（旧版 webserver 没有 `register`）只告警，不能让插件加载失败。
	*/
	const timeRoutes = new TimeRoutes({
		dataDir: resolved.dataDir,
		serialPort: resolved.serialPort,
		serialHolder,
		gate: syncGate,
		log: (message) => logger.info(message),
		warn: (message) => logger.warn(message)
	});
	const disposeTimeRoutes = [];
	try {
		disposeTimeRoutes.push(ctx.webServer.register({
			kind: "exact",
			path: "/airremote/time",
			handler: timeRoutes.timeHandler
		}));
		disposeTimeRoutes.push(ctx.webServer.register({
			kind: "exact",
			path: "/airremote/sync-time",
			handler: timeRoutes.syncTimeHandler
		}));
	} catch (error) {
		logger.warn(`board time routes unavailable: ${error instanceof Error ? error.message : String(error)}`);
		for (const dispose of disposeTimeRoutes.splice(0)) try {
			dispose();
		} catch {}
	}
	/**
	* 内置固件下发：`GET /airremote/firmware/manifest` + `GET /airremote/firmware/image`
	* （前端用 Web Serial 把镜像写进板子），以及串口锁 `/airremote/serial-state`、
	* `/airremote/serial-hold`。
	*
	* 固件文件是 `scripts/bundle-firmware.mjs` 在开发机生成的，运行时只读。
	* 缺失时只 `logger.error`（语音/时间功能必须还能用），相应路由回 503。
	*/
	const firmwareRoutes = new FirmwareRoutes({
		firmwareDir: FIRMWARE_DIR,
		log: (message) => logger.info(message),
		warn: (message) => logger.warn(message)
	});
	for (const problem of await firmwareRoutes.selfCheck()) logger.error(`airremote: ${problem.message}`);
	const serialRoutes = new SerialRoutes({
		holder: serialHolder,
		log: (message) => logger.info(message),
		warn: (message) => logger.warn(message)
	});
	const disposeExtraRoutes = [];
	const extraRoutes = [
		{
			path: "/airremote/firmware/manifest",
			handler: firmwareRoutes.manifestHandler
		},
		{
			path: "/airremote/firmware/image",
			handler: firmwareRoutes.imageHandler
		},
		{
			path: "/airremote/serial-state",
			handler: serialRoutes.stateHandler
		},
		{
			path: "/airremote/serial-hold",
			handler: serialRoutes.holdHandler
		}
	];
	try {
		for (const route of extraRoutes) disposeExtraRoutes.push(ctx.webServer.register({
			kind: "exact",
			path: route.path,
			handler: route.handler
		}));
	} catch (error) {
		logger.warn(`airremote firmware routes unavailable: ${error instanceof Error ? error.message : String(error)}`);
		for (const dispose of disposeExtraRoutes.splice(0)) try {
			dispose();
		} catch {}
	}
	/**
	* 烧录 upgrade 路由：`/airremote/flash`。
	* 浏览器点「烧录」→ 这里用 esptool-js + node-serialport 在**宿主进程**里烧内置镜像
	* （不再用 Web Serial），烧录期间持有 `flash` 串口锁，`/airremote/sync-time` 回 busy。
	* 注册失败（旧版 webserver 没有 `registerUpgrade`）只告警，不能让插件加载失败。
	*/
	const flashRoute = new FlashRoute({
		firmwareDir: FIRMWARE_DIR,
		holder: serialHolder,
		resolvePort: () => findBoardPort(resolved.serialPort),
		logger: (message) => logger.info(message),
		warn: (message) => logger.warn(message)
	});
	let disposeFlashRoute;
	try {
		disposeFlashRoute = ctx.webServer.registerUpgrade({
			path: "/airremote/flash",
			handler: flashRoute.handler
		});
	} catch (error) {
		logger.warn(`flash route unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	let disposeTap;
	try {
		const url = `${ctx.webServer.getOrigin().replace(/^http/, "ws")}/airremote/audio`;
		const script = `<script>globalThis.__AIRREMOTE_AUDIO_URL__=${JSON.stringify(url).replaceAll("<", "\\u003c")}<\/script>`;
		disposeTap = ctx.webServer.tapIndex((html) => html.replace(/<head(?:\s[^>]*)?>/i, (tag) => `${tag}${script}`));
	} catch (error) {
		logger.warn(`cannot inject the audio URL: ${error instanceof Error ? error.message : String(error)}`);
	}
	logger.info(`ready: board=${resolved.boardHost === "" ? "discovery" : resolved.boardHost}:${String(resolved.boardPort)} simulate=${String(simulation !== void 0)} token=${resolved.pairingToken.length === 64 ? "loaded" : "missing"}`);
	/** 只排期、不 await：定时器 `unref`，插件启动不会被一次串口往返拖住。 */
	try {
		autoSync.armStartup();
	} catch (error) {
		logger.warn(`airremote: 自动对时排期失败：${error instanceof Error ? error.message : String(error)}`);
	}
	ctx.effect(() => {
		return () => {
			autoSync.dispose();
			disposeTap?.();
			disposeFlashRoute?.();
			disposeRoute();
			for (const dispose of disposeTimeRoutes) try {
				dispose();
			} catch {}
			for (const dispose of disposeExtraRoutes) try {
				dispose();
			} catch {}
			timeRoutes.dispose();
			route.dispose();
			flashRoute.dispose();
			fake?.stop();
			discovery.close();
		};
	}, "dsh-airremote board audio bridge");
}
export { apply, inject, name };
