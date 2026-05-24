import { useWebSocketStore, type WebSocketState } from "~/stores/webSocket";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WsMessage<T = unknown> {
	type: string;
	to: string;
	data: T;
}

type MessageHandler = (data: unknown) => void;

// ─── Constants ────────────────────────────────────────────────────────────────

// Retry delays after each failed connection attempt.
// Total wait before giving up: 500+1000+2000+4000+8000 ≈ 15.5s
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

// Brief disconnects within this window are hidden from the user (no banner shown)
const GRACE_PERIOD_MS = 3000;

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS  =  5_000;

// ─── WebSocketService ─────────────────────────────────────────────────────────

class WebSocketService {
	private static instance: WebSocketService;

	private socket: WebSocket | null = null;
	private serverUrl: string | null = null;
	private handlers = new Map<string, MessageHandler>();

	// Retry state
	private retryAttempt = 0;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private graceTimer: ReturnType<typeof setTimeout> | null = null;
	private closing = false; // true when disconnect() was called intentionally

	// Heartbeat
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

	private constructor() {}

	static getInstance(): WebSocketService {
		if (!WebSocketService.instance) {
			WebSocketService.instance = new WebSocketService();
		}
		return WebSocketService.instance;
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	connect(url: string): void {
		this.serverUrl = url;
		this.closing = false;
		this.retryAttempt = 0;
		this.openSocket();
	}

	/** Intentional disconnect — stops all retries permanently */
	disconnect(): void {
		this.closing = true;
		this.clearTimers();
		this.stopHeartbeat();
		if (this.socket) {
			this.socket.onclose = null; // prevent retry handler from firing
			this.socket.close();
			this.socket = null;
		}
		this.setState("disconnected");
	}

	/** Manual reconnect triggered by user — resets attempt counter */
	reconnect(): void {
		if (!this.serverUrl) return;
		this.closing = false;
		this.retryAttempt = 0;
		this.clearTimers();
		this.openSocket();
	}

	send<T>(msg: WsMessage<T>): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify(msg));
		}
	}

	/** @deprecated use send() */
	sendMessage<T>(msg: WsMessage<T>): void {
		this.send(msg);
	}

	registerHandler(type: string, handler: MessageHandler): void {
		this.handlers.set(type, handler);
	}

	isConnected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	// ─── Connection ───────────────────────────────────────────────────────────

	private openSocket(): void {
		if (!this.serverUrl) return;

		// Close existing socket without triggering the retry handler
		if (this.socket) {
			this.socket.onclose = null;
			this.socket.close();
			this.socket = null;
		}

		this.setState("connecting");
		this.socket = new WebSocket(this.serverUrl);

		this.socket.onopen = () => {
			this.retryAttempt = 0;
			this.clearTimers();
			this.setState("connected");
			this.startHeartbeat();
			useWebSocketStore.getState().setReconnectAttempts(0);
		};

		this.socket.onclose = () => {
			if (this.closing) return;
			this.stopHeartbeat();
			this.scheduleRetry();
		};

		// onerror always fires before onclose — no extra handling needed
		this.socket.onerror = () => {};

		this.socket.onmessage = ({ data }) => {
			if (data === "pong") {
				// Clear heartbeat timeout — server is alive
				if (this.heartbeatTimeoutTimer) {
					clearTimeout(this.heartbeatTimeoutTimer);
					this.heartbeatTimeoutTimer = null;
				}
				return;
			}
			if (data === "ping") {
				this.socket?.send("pong");
				return;
			}
			try {
				const msg = JSON.parse(data) as { type: string };
				const handler = this.handlers.get(msg.type);
				if (handler) handler(msg);
				else console.warn("[WS] unhandled message type:", msg.type);
			} catch {
				console.error("[WS] failed to parse message:", data);
			}
		};
	}

	// ─── Retry logic ──────────────────────────────────────────────────────────

	private scheduleRetry(): void {
		if (this.closing) return;

		const attempt = this.retryAttempt;
		useWebSocketStore.getState().setReconnectAttempts(attempt);

		if (attempt >= RETRY_DELAYS_MS.length) {
			this.clearTimers();
			this.setState("failed");
			return;
		}

		// Start grace timer on first failure — if we reconnect within GRACE_PERIOD_MS
		// the user sees nothing. After the grace period, show the reconnecting banner.
		if (attempt === 0) {
			this.graceTimer = setTimeout(() => {
				this.graceTimer = null;
				if (!this.isConnected() && !this.closing) this.setState("reconnecting");
			}, GRACE_PERIOD_MS);
		} else {
			this.setState("reconnecting");
		}

		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.retryAttempt++;
			this.openSocket();
		}, RETRY_DELAYS_MS[attempt]);
	}

	private clearTimers(): void {
		if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
		if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
	}

	private setState(state: WebSocketState): void {
		useWebSocketStore.getState().setWebSocketState(state);
	}

	// ─── Heartbeat ────────────────────────────────────────────────────────────

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatInterval = setInterval(() => {
			if (this.socket?.readyState !== WebSocket.OPEN) return;
			this.socket.send("ping");
			this.heartbeatTimeoutTimer = setTimeout(() => {
				console.warn("[WS] heartbeat timeout — closing socket");
				this.socket?.close(); // triggers onclose → scheduleRetry
			}, HEARTBEAT_TIMEOUT_MS);
		}, HEARTBEAT_INTERVAL_MS);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
		if (this.heartbeatTimeoutTimer) { clearTimeout(this.heartbeatTimeoutTimer); this.heartbeatTimeoutTimer = null; }
	}
}

export const webSocketService = WebSocketService.getInstance();
