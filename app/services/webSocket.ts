import { useWebSocketStore, type WebSocketState } from "~/stores/webSocket";

interface WebSocketMessage<T = any> {
	type: string;
	to: string;
	data: T;
}

// Retry schedule: attempts map to delays in ms.
// First 3 retries are fast (within grace period, no UI shown).
// After that show "reconnecting" banner. Stop escalating to "failed" after ~15s total.
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000]; // total ~15.5s
const GRACE_PERIOD_MS = 3000; // don't show any error UI for first 3s

class WebSocketService {
	private static instance: WebSocketService;
	private ws: WebSocket | null = null;
	private url: string | null = null;

	// Retry state
	private retryAttempt = 0;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private graceTimer: ReturnType<typeof setTimeout> | null = null;
	private intentionalClose = false;
	private firstConnectTime: number | null = null;

	// Heartbeat
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
	private readonly HEARTBEAT_INTERVAL = 15000;
	private readonly HEARTBEAT_TIMEOUT = 5000;

	// Message handlers
	private messageHandlers: Map<string, (data: any) => void> = new Map();

	// Callbacks for connection events (used by app to re-initiate WebRTC)
	private onReconnectedCallbacks: Array<() => void> = [];

	private constructor() {}

	static getInstance(): WebSocketService {
		if (!WebSocketService.instance) {
			WebSocketService.instance = new WebSocketService();
		}
		return WebSocketService.instance;
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	connect(url: string) {
		this.url = url;
		this.intentionalClose = false;
		this.retryAttempt = 0;
		this.firstConnectTime = null;
		this._openSocket();
	}

	/** Intentional disconnect — stops all retries permanently */
	disconnect() {
		this.intentionalClose = true;
		this._clearTimers();
		this.stopHeartbeat();
		if (this.ws) {
			this.ws.onclose = null; // prevent retry on intentional close
			this.ws.close();
			this.ws = null;
		}
		this._setState("disconnected");
	}

	/** Manual reconnect (user pressed button) — resets attempt counter */
	reconnect() {
		if (!this.url) return;
		this.intentionalClose = false;
		this.retryAttempt = 0;
		this._clearTimers();
		this._openSocket();
	}

	sendMessage<T>(msg: WebSocketMessage<T>) {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	registerHandler(type: string, handler: (data: any) => void) {
		this.messageHandlers.set(type, handler);
	}

	/** Called when WS reconnects — e.g. to re-offer broadcaster/viewer */
	onReconnected(cb: () => void) {
		this.onReconnectedCallbacks.push(cb);
		return () => {
			this.onReconnectedCallbacks = this.onReconnectedCallbacks.filter(f => f !== cb);
		};
	}

	isConnected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	// ─── Internal ─────────────────────────────────────────────────────────────

	private _openSocket() {
		if (!this.url) return;
		if (this.ws) {
			this.ws.onclose = null;
			this.ws.close();
			this.ws = null;
		}

		this._setState("connecting");
		this.ws = new WebSocket(this.url);

		this.ws.onopen = () => {
			const wasReconnect = this.firstConnectTime !== null;
			this.firstConnectTime = Date.now();
			this.retryAttempt = 0;
			this._clearTimers();
			this._setState("connected");
			this.startHeartbeat();
			useWebSocketStore.getState().setReconnectAttempts(0);
			if (wasReconnect) {
				// Notify app layer so it can re-initiate WebRTC sessions
				this.onReconnectedCallbacks.forEach(cb => cb());
			}
		};

		this.ws.onclose = () => {
			if (this.intentionalClose) return;
			this.stopHeartbeat();
			this._scheduleRetry();
		};

		this.ws.onerror = () => {
			// onclose will fire after onerror, so nothing extra needed here
		};

		this.ws.onmessage = (msg) => {
			if (msg.data === "pong") {
				if (this.heartbeatTimeout) { clearTimeout(this.heartbeatTimeout); this.heartbeatTimeout = null; }
				return;
			}
			if (msg.data === "ping") { this.ws?.send("pong"); return; }
			try {
				const data = JSON.parse(msg.data);
				const handler = this.messageHandlers.get(data.type);
				if (handler) handler(data);
				else console.log("unknown message type:", data.type);
			} catch (e) {
				console.error("Failed to parse WS message:", e);
			}
		};
	}

	private _scheduleRetry() {
		if (this.intentionalClose) return;

		const attempt = this.retryAttempt;
		useWebSocketStore.getState().setReconnectAttempts(attempt);

		if (attempt >= RETRY_DELAYS_MS.length) {
			// Exhausted all retries (~15s of failures) → give up
			this._clearTimers();
			this._setState("failed");
			return;
		}

		const delay = RETRY_DELAYS_MS[attempt];
		this.retryAttempt++;

		// Grace period: for the first GRACE_PERIOD_MS don't change UI state
		// so brief fluctuations are invisible to the user
		if (!this.graceTimer && attempt === 0) {
			this.graceTimer = setTimeout(() => {
				this.graceTimer = null;
				// If still not connected after grace period, show reconnecting
				if (!this.isConnected() && !this.intentionalClose) {
					this._setState("reconnecting");
				}
			}, GRACE_PERIOD_MS);
		} else if (attempt >= 2) {
			// Grace period is over, make sure we're showing reconnecting
			this._setState("reconnecting");
		}

		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this._openSocket();
		}, delay);
	}

	private _clearTimers() {
		if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
		if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
	}

	private _setState(state: WebSocketState) {
		useWebSocketStore.getState().setWebSocketState(state);
	}

	// ─── Heartbeat ────────────────────────────────────────────────────────────

	private startHeartbeat() {
		this.stopHeartbeat();
		this.heartbeatInterval = setInterval(() => {
			if (this.ws?.readyState === WebSocket.OPEN) {
				this.ws.send("ping");
				this.heartbeatTimeout = setTimeout(() => {
					console.log("Heartbeat timeout");
					this.ws?.close(); // triggers onclose → retry
				}, this.HEARTBEAT_TIMEOUT);
			}
		}, this.HEARTBEAT_INTERVAL);
	}

	private stopHeartbeat() {
		if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
		if (this.heartbeatTimeout) { clearTimeout(this.heartbeatTimeout); this.heartbeatTimeout = null; }
	}
}

export const webSocketService = WebSocketService.getInstance();
