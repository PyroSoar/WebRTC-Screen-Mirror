import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AuthState {
	/** 6-digit signaling ID used for WebRTC connection routing */
	signalingId: string;
	/** 4-char random tag (e.g. "a1b2") — generated once per device, never changes */
	deviceTag: string;
	/** User-editable display name (empty string = no nickname) */
	nickname: string;
	setSignalingId: (id: string) => void;
	setDeviceTag: (tag: string) => void;
	setNickname: (name: string) => void;
}

export const useAuthStore = create<AuthState>()(
	persist(
		(set) => ({
			signalingId: "",
			deviceTag: "",
			nickname: "",
			setSignalingId: (signalingId) => set({ signalingId }),
			setDeviceTag: (deviceTag) => set({ deviceTag }),
			setNickname: (nickname) => set({ nickname }),
		}),
		{ name: "auth" },
	),
);

/** Returns the full display ID: "nickname#tag" or "#tag" if no nickname */
export function getDisplayId(nickname: string, deviceTag: string): string {
	return nickname ? `${nickname}#${deviceTag}` : `#${deviceTag}`;
}
