import { create } from "zustand";

export type WebSocketState =
	| "connected"
	| "connecting"     // initial connect or reconnecting (within grace period)
	| "reconnecting"   // grace period expired, actively retrying
	| "failed"         // gave up after ~15s of continuous failure
	| "disconnected";  // intentionally disconnected (disconnect() called)

interface WebSocketStore {
	webSocketState: WebSocketState;
	reconnectAttempts: number;
	setWebSocketState: (state: WebSocketState) => void;
	setReconnectAttempts: (n: number) => void;
}

export const useWebSocketStore = create<WebSocketStore>((set) => ({
	webSocketState: "disconnected",
	reconnectAttempts: 0,
	setWebSocketState: (webSocketState) => set({ webSocketState }),
	setReconnectAttempts: (reconnectAttempts) => set({ reconnectAttempts }),
}));
