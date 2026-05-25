import { useWebRTCStore } from "~/stores/webRTC";
import { webSocketService } from "~/services/webSocket";

// ─── Types ────────────────────────────────────────────────────────────────────

export type BroadcastError =
	| { code: "NOT_SUPPORTED";    message: string }
	| { code: "PERMISSION_DENIED"; message: string }
	| { code: "UNKNOWN";          message: string };

type VideoSource = "screen" | "camera" | "both";
type AudioSource = "screen" | "microphone" | "both";

interface BroadcastOptions {
	videoSource: VideoSource;
	audioSource: AudioSource;
	muteVideo?: boolean;
	muteAudio?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RTC_CONFIG: RTCConfiguration = {
	iceServers: [
		{ urls: "stun:stun.l.google.com:19302" },
		{ urls: "stun:stun1.l.google.com:19302" },
	],
};

const CANVAS_W   = 1280;
const CANVAS_H   = 720;
const CANVAS_FPS = 30;

const PIP_W      = 240;
const PIP_H      = 135;
const PIP_MARGIN = 16;
const PIP_RADIUS = 10;

// ─── Module helpers ───────────────────────────────────────────────────────────

function broadcastError(code: BroadcastError["code"], message: string): BroadcastError {
	return { code, message };
}

function stopTracks(stream: MediaStream | null): void {
	stream?.getTracks().forEach(t => t.stop());
}

function requiresDisplayMedia(opts: Pick<BroadcastOptions, "videoSource" | "audioSource">): boolean {
	return opts.videoSource === "screen" || opts.videoSource === "both"
		|| opts.audioSource === "screen"  || opts.audioSource === "both";
}

function requiresUserMedia(opts: Pick<BroadcastOptions, "videoSource" | "audioSource">): boolean {
	return opts.videoSource === "camera" || opts.videoSource === "both"
		|| opts.audioSource === "microphone" || opts.audioSource === "both";
}

// ─── WebRTCService ────────────────────────────────────────────────────────────

class WebRTCService {
	private static instance: WebRTCService;

	// Broadcaster role: one peer connection per viewer
	private viewerPeers      = new Map<string, RTCPeerConnection>();
	private viewerDisplayIds = new Map<string, string>(); // signalingId → displayId
	private localStream:    MediaStream | null = null;
	private animFrameId:    number | null = null;

	// Viewer role: one peer connection to the broadcaster
	private broadcasterPc:     RTCPeerConnection | null = null;
	private broadcasterPeerId: string = "";

	private constructor() {
		webSocketService.registerHandler("ice_candidate", ({ from, data }: any) => {
			const pc = this.viewerPeers.get(from)
				?? (this.broadcasterPeerId === from ? this.broadcasterPc : null);
			pc?.addIceCandidate(new RTCIceCandidate(data)).catch(console.error);
		});

		webSocketService.registerHandler("answer", ({ from, data }: any) => {
			this.viewerPeers.get(from)
				?.setRemoteDescription(new RTCSessionDescription(data))
				.catch(console.error);
		});

		webSocketService.registerHandler("set_resolution", ({ from, data }: any) => {
			const pc = this.viewerPeers.get(from);
			if (!pc) return;
			const { maxWidth, maxHeight } = data as { maxWidth: number; maxHeight: number };
			const srcSettings = this.localStream?.getVideoTracks()[0]?.getSettings();
			const srcW  = srcSettings?.width  ?? maxWidth;
			const srcH  = srcSettings?.height ?? maxHeight;
			const scale = Math.max(1, srcW / maxWidth, srcH / maxHeight);
			for (const sender of pc.getSenders()) {
				if (sender.track?.kind !== "video") continue;
				const params = sender.getParameters();
				if (!params.encodings?.length) params.encodings = [{}];
				params.encodings[0].scaleResolutionDownBy = scale;
				sender.setParameters(params).catch(console.error);
			}
		});
	}

	static getInstance(): WebRTCService {
		if (!WebRTCService.instance) WebRTCService.instance = new WebRTCService();
		return WebRTCService.instance;
	}

	// ─── Capability check ─────────────────────────────────────────────────────

	checkBroadcastSupport(opts: BroadcastOptions): BroadcastError | null {
		if (requiresDisplayMedia(opts) && typeof navigator?.mediaDevices?.getDisplayMedia !== "function") {
			return broadcastError("NOT_SUPPORTED",
				"此设备/浏览器不支持屏幕捕获。请在桌面浏览器上使用屏幕/屏幕声音功能。");
		}
		if (requiresUserMedia(opts) && typeof navigator?.mediaDevices?.getUserMedia !== "function") {
			return broadcastError("NOT_SUPPORTED", "此设备/浏览器不支持摄像头/麦克风访问。");
		}
		return null;
	}

	// ─── Canvas compositor (screen + camera PiP) ──────────────────────────────

	private startCompositor(screenStream: MediaStream, cameraStream: MediaStream): MediaStream {
		const canvas = document.createElement("canvas");
		canvas.width  = CANVAS_W;
		canvas.height = CANVAS_H;
		const ctx = canvas.getContext("2d")!;

		const makeVideoEl = (stream: MediaStream): HTMLVideoElement => {
			const v = document.createElement("video");
			v.srcObject = stream;
			v.muted     = true;
			v.autoplay  = true;
			v.play().catch(console.error);
			return v;
		};

		const screenEl = makeVideoEl(screenStream);
		const cameraEl = makeVideoEl(cameraStream);

		const pipX = CANVAS_W - PIP_W - PIP_MARGIN;
		const pipY = CANVAS_H - PIP_H - PIP_MARGIN;

		const draw = () => {
			// Full-canvas screen background
			if (screenEl.readyState >= 2) {
				ctx.drawImage(screenEl, 0, 0, CANVAS_W, CANVAS_H);
			} else {
				ctx.fillStyle = "#000";
				ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
			}

			// Camera PiP — letterboxed, rounded, with border
			if (cameraEl.readyState >= 2) {
				const vw    = cameraEl.videoWidth  || PIP_W;
				const vh    = cameraEl.videoHeight || PIP_H;
				const scale = Math.min(PIP_W / vw, PIP_H / vh);
				const dw    = vw * scale;
				const dh    = vh * scale;
				const dx    = pipX + (PIP_W - dw) / 2;
				const dy    = pipY + (PIP_H - dh) / 2;

				ctx.save();
				ctx.beginPath();
				ctx.roundRect(pipX, pipY, PIP_W, PIP_H, PIP_RADIUS);
				ctx.clip();
				ctx.fillStyle = "#111";
				ctx.fillRect(pipX, pipY, PIP_W, PIP_H);
				ctx.drawImage(cameraEl, dx, dy, dw, dh);
				ctx.restore();

				ctx.save();
				ctx.strokeStyle = "rgba(255,255,255,0.7)";
				ctx.lineWidth   = 2;
				ctx.beginPath();
				ctx.roundRect(pipX, pipY, PIP_W, PIP_H, PIP_RADIUS);
				ctx.stroke();
				ctx.restore();
			}

			this.animFrameId = requestAnimationFrame(draw);
		};

		draw();
		// @ts-ignore — captureStream is widely supported but absent from lib.dom.d.ts
		return canvas.captureStream(CANVAS_FPS) as MediaStream;
	}

	private stopCompositor(): void {
		if (this.animFrameId !== null) {
			cancelAnimationFrame(this.animFrameId);
			this.animFrameId = null;
		}
	}

	// ─── Broadcaster ──────────────────────────────────────────────────────────

	async startBroadcast(opts: BroadcastOptions): Promise<void> {
		const { videoSource, audioSource, muteVideo = false, muteAudio = false } = opts;

		const supportError = this.checkBroadcastSupport(opts);
		if (supportError) throw supportError;

		let screenStream: MediaStream | null = null;
		let userStream:   MediaStream | null = null;

		try {
			if (requiresDisplayMedia(opts)) {
				screenStream = await navigator.mediaDevices.getDisplayMedia({
					video: true,
					audio: audioSource === "screen" || audioSource === "both",
				});
			}
			if (requiresUserMedia(opts)) {
				userStream = await navigator.mediaDevices.getUserMedia({
					video: videoSource === "camera" || videoSource === "both",
					audio: audioSource === "microphone" || audioSource === "both",
				});
			}
		} catch (err) {
			stopTracks(screenStream);
			stopTracks(userStream);
			if (err instanceof DOMException) {
				if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
					throw broadcastError("PERMISSION_DENIED", "用户拒绝了媒体权限请求。");
				}
				if (err.name === "NotSupportedError" || err.name === "NotFoundError") {
					throw broadcastError("NOT_SUPPORTED", `此设备不支持所选的媒体配置：${err.message}`);
				}
			}
			throw broadcastError("UNKNOWN", String(err));
		}

		// Screen audio must be explicitly shared — browser grants it only if the user
		// ticks "Share audio" in the permission dialog. Fail fast if it wasn't granted.
		if ((audioSource === "screen" || audioSource === "both")
			&& screenStream?.getAudioTracks().length === 0) {
			stopTracks(screenStream);
			stopTracks(userStream);
			throw broadcastError("PERMISSION_DENIED",
				"未获得屏幕声音权限。请在浏览器弹窗中勾选「同时分享音频」后重试。");
		}

		// Build the combined stream
		const combined = new MediaStream();

		if (!muteVideo) {
			if (videoSource === "screen") {
				screenStream?.getVideoTracks().forEach(t => combined.addTrack(t));
			} else if (videoSource === "camera") {
				userStream?.getVideoTracks().forEach(t => combined.addTrack(t));
			} else if (videoSource === "both" && screenStream && userStream) {
				this.startCompositor(screenStream, userStream)
					.getVideoTracks().forEach(t => combined.addTrack(t));
			}
		}

		if (!muteAudio) {
			if (audioSource === "screen") {
				screenStream?.getAudioTracks().forEach(t => combined.addTrack(t));
			} else if (audioSource === "microphone") {
				userStream?.getAudioTracks().forEach(t => combined.addTrack(t));
			} else if (audioSource === "both") {
				// Mix both sources into one track via AudioContext
				const audioCtx = new AudioContext();
				const dest     = audioCtx.createMediaStreamDestination();
				[screenStream, userStream].forEach(s => {
					if (s) audioCtx.createMediaStreamSource(s).connect(dest);
				});
				dest.stream.getAudioTracks().forEach(t => combined.addTrack(t));
			}
		}

		this.localStream = combined;
		useWebRTCStore.getState().setBroadcasting(true);

		// Synthesise display labels — combined/canvas tracks have meaningless browser-generated
		// labels, so we read the labels from the raw source tracks before mixing.
		const screenVideoLabel = screenStream?.getVideoTracks()[0]?.label ?? "";
		const cameraVideoLabel = userStream?.getVideoTracks()[0]?.label ?? "";
		const screenAudioLabel = screenStream?.getAudioTracks()[0]?.label ?? "";
		const micAudioLabel    = userStream?.getAudioTracks()[0]?.label ?? "";

		const videoLabel = videoSource === "both"   ? `${screenVideoLabel}\t${cameraVideoLabel}`
		                 : videoSource === "screen"  ? screenVideoLabel
		                 :                             cameraVideoLabel;

		const audioLabel = audioSource === "both"        ? `${screenAudioLabel}\t${micAudioLabel}`
		                 : audioSource === "screen"       ? screenAudioLabel
		                 :                                  micAudioLabel;

		const videoTrack    = combined.getVideoTracks()[0];
		const audioTrack    = combined.getAudioTracks()[0];
		const videoSettings = videoTrack?.getSettings();
		const audioSettings = audioTrack?.getSettings();

		useWebRTCStore.getState().setStreamInfo({
			videoMuted:      muteVideo,
			videoLabel,
			videoWidth:      videoSettings?.width      ?? 0,
			videoHeight:     videoSettings?.height     ?? 0,
			audioMuted:      muteAudio,
			audioLabel,
			audioSampleRate: audioSettings?.sampleRate ?? 0,
		});

		// If the user closes the screen-share picker in the browser, stop broadcasting
		screenStream?.getVideoTracks()[0]?.addEventListener("ended", () => this.stopBroadcast());
	}

	async handleViewerOffer(viewerId: string, offer: RTCSessionDescriptionInit, viewerDisplayId = ""): Promise<void> {
		if (!this.localStream) return;

		// Replace any stale connection for this viewer
		this.viewerPeers.get(viewerId)?.close();
		const pc = new RTCPeerConnection(RTC_CONFIG);
		this.viewerPeers.set(viewerId, pc);
		this.viewerDisplayIds.set(viewerId, viewerDisplayId || viewerId);

		this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream!));

		pc.onicecandidate = ({ candidate }) => {
			if (candidate) {
				webSocketService.send({ type: "ice_candidate", to: viewerId, data: candidate });
			}
		};

		pc.onconnectionstatechange = () => {
			if (pc.connectionState === "disconnected"
				|| pc.connectionState === "failed"
				|| pc.connectionState === "closed") {
				this.viewerPeers.delete(viewerId);
				this.viewerDisplayIds.delete(viewerId);
			}
			const store = useWebRTCStore.getState();
			store.setViewerCount(this.viewerPeers.size);
			store.setViewerList([...this.viewerDisplayIds.values()]);
		};

		await pc.setRemoteDescription(new RTCSessionDescription(offer));
		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);
		webSocketService.send({ type: "answer", to: viewerId, data: answer });
	}

	stopBroadcast(): void {
		// Notify all viewers before closing connections
		this.viewerPeers.forEach((pc, viewerId) => {
			webSocketService.send({ type: "broadcast_ended", to: viewerId, data: null });
			pc.close();
		});
		this.viewerPeers.clear();
		this.viewerDisplayIds.clear();

		this.stopCompositor();
		stopTracks(this.localStream);
		this.localStream = null;

		const store = useWebRTCStore.getState();
		store.setBroadcasting(false);
		store.setViewerCount(0);
		store.setStreamInfo(undefined);
	}

	// ─── Viewer ───────────────────────────────────────────────────────────────

	async connectToBroadcaster(broadcasterId: string): Promise<void> {
		this.disconnectViewer();
		this.broadcasterPeerId = broadcasterId;

		const pc = new RTCPeerConnection(RTC_CONFIG);
		this.broadcasterPc = pc;

		pc.onicecandidate = ({ candidate }) => {
			if (candidate) {
				webSocketService.send({ type: "ice_candidate", to: broadcasterId, data: candidate });
			}
		};

		pc.ontrack = ({ streams }) => {
			if (streams[0]) useWebRTCStore.getState().setRemoteStream(streams[0]);
		};

		pc.onconnectionstatechange = () => {
			const { connectionState } = pc;
			useWebRTCStore.getState().setConnectionState(connectionState);
			// If the RTC connection drops but the signaling WS is still alive,
			// the broadcaster is reachable — this is a receiver-side network issue.
			if ((connectionState === "disconnected" || connectionState === "failed")
				&& webSocketService.isConnected()) {
				useWebRTCStore.getState().setDisconnectReason("network");
			}
		};

		// Add transceivers before creating the offer so SDP includes both directions
		pc.addTransceiver("video", { direction: "recvonly" });
		pc.addTransceiver("audio", { direction: "recvonly" });

		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		webSocketService.send({ type: "offer", to: broadcasterId, data: offer });
	}

	async handleBroadcasterAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
		await this.broadcasterPc?.setRemoteDescription(new RTCSessionDescription(answer));
	}

	requestResolution(maxWidth: number, maxHeight: number): void {
		if (this.broadcasterPeerId) {
			webSocketService.send({
				type: "set_resolution",
				to: this.broadcasterPeerId,
				data: { maxWidth, maxHeight },
			});
		}
	}

	getLocalStream(): MediaStream | null {
		return this.localStream;
	}

	disconnectViewer(): void {
		const store = useWebRTCStore.getState();
		store.setConnectionState("disconnected");
		store.setRemoteStream(undefined);
		this.broadcasterPc?.close();
		this.broadcasterPc     = null;
		this.broadcasterPeerId = "";
	}
}

export const webRTCService = WebRTCService.getInstance();
