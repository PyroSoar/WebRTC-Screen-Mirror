import { create } from "zustand";

export interface StreamInfo {
	videoMuted:      boolean;
	videoLabel:      string;
	videoWidth:      number;
	videoHeight:     number;
	audioMuted:      boolean;
	audioLabel:      string;
	audioSampleRate: number;
}

export type DisconnectReason = "broadcaster_stopped" | "network" | null;

interface WebRTCStore {
	// ── Viewer ────────────────────────────────────────────────────────────────
	connectionState?:     RTCPeerConnectionState;
	remoteStream?:        MediaStream;
	disconnectReason:     DisconnectReason;
	/** Display ID of the broadcaster we're watching (e.g. "昵称#a1b2") */
	broadcasterDisplayId: string;

	setConnectionState:     (s: RTCPeerConnectionState) => void;
	setRemoteStream:        (s: MediaStream | undefined) => void;
	setDisconnectReason:    (r: DisconnectReason) => void;
	setBroadcasterDisplayId:(id: string) => void;

	// ── Broadcaster ───────────────────────────────────────────────────────────
	isBroadcasting: boolean;
	viewerCount:    number;
	/** Display IDs of all currently connected viewers */
	viewerList:     string[];
	streamInfo?:    StreamInfo;

	setBroadcasting: (v: boolean) => void;
	setViewerCount:  (n: number) => void;
	setViewerList:   (list: string[]) => void;
	setStreamInfo:   (info: StreamInfo | undefined) => void;

	reset: () => void;
}

export const useWebRTCStore = create<WebRTCStore>((set) => ({
	connectionState:      undefined,
	remoteStream:         undefined,
	disconnectReason:     null,
	broadcasterDisplayId: "",

	setConnectionState:      (connectionState)      => set({ connectionState }),
	setRemoteStream:         (remoteStream)          => set({ remoteStream }),
	setDisconnectReason:     (disconnectReason)      => set({ disconnectReason }),
	setBroadcasterDisplayId: (broadcasterDisplayId)  => set({ broadcasterDisplayId }),

	isBroadcasting: false,
	viewerCount:    0,
	viewerList:     [],
	streamInfo:     undefined,

	setBroadcasting: (isBroadcasting) => set({ isBroadcasting }),
	setViewerCount:  (viewerCount)    => set({ viewerCount }),
	setViewerList:   (viewerList)     => set({ viewerList }),
	setStreamInfo:   (streamInfo)     => set({ streamInfo }),

	reset: () => set({
		connectionState:      undefined,
		remoteStream:         undefined,
		disconnectReason:     null,
		broadcasterDisplayId: "",
		isBroadcasting:       false,
		viewerCount:          0,
		viewerList:           [],
		streamInfo:           undefined,
	}),
}));
