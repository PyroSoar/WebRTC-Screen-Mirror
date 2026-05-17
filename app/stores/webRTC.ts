import { create } from "zustand";

export interface StreamInfo {
	videoMuted: boolean;
	videoLabel: string;
	videoWidth: number;
	videoHeight: number;
	audioMuted: boolean;
	audioLabel: string;
	audioSampleRate: number;
}

export type DisconnectReason = "broadcaster_stopped" | "network" | null;

interface WebRTCStore {
	// Viewer
	connectionState?: RTCPeerConnectionState;
	remoteStream?: MediaStream;
	disconnectReason: DisconnectReason;
	setConnectionState: (s: RTCPeerConnectionState) => void;
	setRemoteStream: (s: MediaStream | undefined) => void;
	setDisconnectReason: (r: DisconnectReason) => void;
	// Broadcaster
	isBroadcasting: boolean;
	viewerCount: number;
	streamInfo?: StreamInfo;
	setBroadcasting: (v: boolean) => void;
	setViewerCount: (n: number) => void;
	setStreamInfo: (info: StreamInfo | undefined) => void;
	reset: () => void;
}

export const useWebRTCStore = create<WebRTCStore>((set) => ({
	connectionState: undefined,
	remoteStream: undefined,
	disconnectReason: null,
	isBroadcasting: false,
	viewerCount: 0,
	streamInfo: undefined,
	setConnectionState: (connectionState) => set({ connectionState }),
	setRemoteStream: (remoteStream) => set({ remoteStream }),
	setDisconnectReason: (disconnectReason) => set({ disconnectReason }),
	setBroadcasting: (isBroadcasting) => set({ isBroadcasting }),
	setViewerCount: (viewerCount) => set({ viewerCount }),
	setStreamInfo: (streamInfo) => set({ streamInfo }),
	reset: () => set({
		connectionState: undefined,
		remoteStream: undefined,
		disconnectReason: null,
		isBroadcasting: false,
		viewerCount: 0,
		streamInfo: undefined,
	}),
}));
