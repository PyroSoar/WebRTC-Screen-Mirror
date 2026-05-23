import { useWebRTCStore } from "~/stores/webRTC";
import { webSocketService } from "~/services/webSocket";

// ─── Types ────────────────────────────────────────────────────────────────────

export type BroadcastError =
	| { code: "NOT_SUPPORTED"; message: string }
	| { code: "PERMISSION_DENIED"; message: string }
	| { code: "UNKNOWN"; message: string };

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

const PIP_WIDTH = 240;
const PIP_HEIGHT = 135;
const PIP_MARGIN = 16;
const PIP_RADIUS = 10;
const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const CANVAS_FPS = 30;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBroadcastError(code: BroadcastError["code"], message: string): BroadcastError {
	return { code, message };
}

function stopTracks(stream: MediaStream | null) {
	stream?.getTracks().forEach(t => t.stop());
}

function needsDisplay(opts: Pick<BroadcastOptions, "videoSource" | "audioSource">): boolean {
	return opts.videoSource === "screen" || opts.videoSource === "both"
		|| opts.audioSource === "screen" || opts.audioSource === "both";
}

function needsUserMedia(opts: Pick<BroadcastOptions, "videoSource" | "audioSource">): boolean {
	return opts.videoSource === "camera" || opts.videoSource === "both"
		|| opts.audioSource === "microphone" || opts.audioSource === "both";
}

// ─── WebRTCService ────────────────────────────────────────────────────────────

class WebRTCService {
	private static instance: WebRTCService;

	// Broadcaster: one RTCPeerConnection per viewer
	private viewerPeers = new Map<string, RTCPeerConnection>();
	private localStream: MediaStream | null = null;
	private canvasAnimFrame: number | null = null;

	// Viewer: single connection to the broadcaster
	private broadcasterPc: RTCPeerConnection | null = null;
	private broadcasterPeerId = "";

	private constructor() {
		webSocketService.registerHandler("ice_candidate", ({ from, data }) => {
			const pc = this.viewerPeers.get(from)
				?? (this.broadcasterPeerId === from ? this.broadcasterPc : null);
			pc?.addIceCandidate(new RTCIceCandidate(data)).catch(console.error);
		});

		// Broadcaster receives answers from viewers
		webSocketService.registerHandler("answer", ({ from, data }) => {
			this.viewerPeers.get(from)
				?.setRemoteDescription(new RTCSessionDescription(data))
				.catch(console.error);
		});

		// Broadcaster receives resolution requests from viewers
		webSocketService.registerHandler("set_resolution", ({ from, data }) => {
			const pc = this.viewerPeers.get(from);
			if (!pc) return;

			const { maxWidth, maxHeight } = data as { maxWidth: number; maxHeight: number };
			const sourceSettings = this.localStream?.getVideoTracks()[0]?.getSettings();
			const srcW = sourceSettings?.width ?? maxWidth;
			const srcH = sourceSettings?.height ?? maxHeight;
			const scale = Math.max(1, Math.max(srcW / maxWidth, srcH / maxHeight));

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

	// ─── Capability checks ────────────────────────────────────────────────────

	checkBroadcastSupport(opts: BroadcastOptions): BroadcastError | null {
		if (needsDisplay(opts) && typeof navigator?.mediaDevices?.getDisplayMedia !== "function") {
			return makeBroadcastError("NOT_SUPPORTED",
				"此设备/浏览器不支持屏幕捕获。请在桌面浏览器上使用屏幕/屏幕声音功能。");
		}
		if (needsUserMedia(opts) && typeof navigator?.mediaDevices?.getUserMedia !== "function") {
			return makeBroadcastError("NOT_SUPPORTED", "此设备/浏览器不支持摄像头/麦克风访问。");
		}
		return null;
	}

	// ─── Canvas compositor (screen + camera PiP) ──────────────────────────────

	private startCanvasCompositor(screenStream: MediaStream, cameraStream: MediaStream): MediaStream {
		const canvas = document.createElement("canvas");
		canvas.width = CANVAS_WIDTH;
		canvas.height = CANVAS_HEIGHT;
		const ctx = canvas.getContext("2d")!;

		const makeVideo = (stream: MediaStream) => {
			const v = document.createElement("video");
			v.srcObject = stream;
			v.muted = true;
			v.autoplay = true;
			v.play().catch(console.error);
			return v;
		};

		const screenVid = makeVideo(screenStream);
		const cameraVid = makeVideo(cameraStream);

		const pipX = CANVAS_WIDTH - PIP_WIDTH - PIP_MARGIN;
		const pipY = CANVAS_HEIGHT - PIP_HEIGHT - PIP_MARGIN;

		const draw = () => {
			// Background: screen
			if (screenVid.readyState >= 2) {
				ctx.drawImage(screenVid, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
			} else {
				ctx.fillStyle = "#000";
				ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
			}

			// PiP: camera
			if (cameraVid.readyState >= 2) {
				const vw = cameraVid.videoWidth || PIP_WIDTH;
				const vh = cameraVid.videoHeight || PIP_HEIGHT;
				const scale = Math.min(PIP_WIDTH / vw, PIP_HEIGHT / vh);
				const dw = vw * scale;
				const dh = vh * scale;
				const dx = pipX + (PIP_WIDTH - dw) / 2;
				const dy = pipY + (PIP_HEIGHT - dh) / 2;

				ctx.save();
				ctx.beginPath();
				ctx.roundRect(pipX, pipY, PIP_WIDTH, PIP_HEIGHT, PIP_RADIUS);
				ctx.clip();
				ctx.fillStyle = "#111";
				ctx.fillRect(pipX, pipY, PIP_WIDTH, PIP_HEIGHT);
				ctx.drawImage(cameraVid, dx, dy, dw, dh);
				ctx.restore();

				ctx.save();
				ctx.strokeStyle = "rgba(255,255,255,0.7)";
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.roundRect(pipX, pipY, PIP_WIDTH, PIP_HEIGHT, PIP_RADIUS);
				ctx.stroke();
				ctx.restore();
			}

			this.canvasAnimFrame = requestAnimationFrame(draw);
		};

		draw();
		// @ts-ignore — captureStream exists on HTMLCanvasElement
		return canvas.captureStream(CANVAS_FPS) as MediaStream;
	}

	private stopCanvasCompositor() {
		if (this.canvasAnimFrame !== null) {
			cancelAnimationFrame(this.canvasAnimFrame);
			this.canvasAnimFrame = null;
		}
	}

	// ─── Broadcaster ──────────────────────────────────────────────────────────

	async startBroadcast(opts: BroadcastOptions): Promise<void> {
		const { videoSource, audioSource, muteVideo = false, muteAudio = false } = opts;

		const supportError = this.checkBroadcastSupport(opts);
		if (supportError) throw supportError;

		let screenStream: MediaStream | null = null;
		let userStream: MediaStream | null = null;

		try {
			if (needsDisplay(opts)) {
				screenStream = await navigator.mediaDevices.getDisplayMedia({
					video: true,
					audio: audioSource === "screen" || audioSource === "both",
				});
			}
			if (needsUserMedia(opts)) {
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
					throw makeBroadcastError("PERMISSION_DENIED", "用户拒绝了媒体权限请求。");
				}
				if (err.name === "NotSupportedError" || err.name === "NotFoundError") {
					throw makeBroadcastError("NOT_SUPPORTED", `此设备不支持所选的媒体配置：${err.message}`);
				}
			}
			throw makeBroadcastError("UNKNOWN", String(err));
		}

		// Validate screen audio was actually granted
		if ((audioSource === "screen" || audioSource === "both")
			&& screenStream?.getAudioTracks().length === 0) {
			stopTracks(screenStream);
			stopTracks(userStream);
			throw makeBroadcastError("PERMISSION_DENIED",
				"未获得屏幕声音权限。请在浏览器弹窗中勾选「同时分享音频」后重试。");
		}

		const combined = new MediaStream();

		// Video tracks
		if (!muteVideo) {
			if (videoSource === "screen") {
				screenStream?.getVideoTracks().forEach(t => combined.addTrack(t));
			} else if (videoSource === "camera") {
				userStream?.getVideoTracks().forEach(t => combined.addTrack(t));
			} else if (videoSource === "both" && screenStream && userStream) {
				this.startCanvasCompositor(screenStream, userStream)
					.getVideoTracks().forEach(t => combined.addTrack(t));
			}
		}

		// Audio tracks
		if (!muteAudio) {
			if (audioSource === "screen") {
				screenStream?.getAudioTracks().forEach(t => combined.addTrack(t));
			} else if (audioSource === "microphone") {
				userStream?.getAudioTracks().forEach(t => combined.addTrack(t));
			} else if (audioSource === "both") {
				const ctx = new AudioContext();
				const dest = ctx.createMediaStreamDestination();
				[screenStream, userStream].forEach(s => {
					if (s) ctx.createMediaStreamSource(s).connect(dest);
				});
				dest.stream.getAudioTracks().forEach(t => combined.addTrack(t));
			}
		}

		this.localStream = combined;
		useWebRTCStore.getState().setBroadcasting(true);

		// Collect stream metadata for display
		// For "both" sources, the combined track label (canvas hash / AudioContext node name)
		// is meaningless, so we synthesise a friendly label from the raw source tracks.
		const screenVideoLabel = screenStream?.getVideoTracks()[0]?.label ?? "";
		const cameraVideoLabel = userStream?.getVideoTracks()[0]?.label ?? "";
		const screenAudioLabel = screenStream?.getAudioTracks()[0]?.label ?? "";
		const micAudioLabel    = userStream?.getAudioTracks()[0]?.label ?? "";

		const videoLabel =
			videoSource === "both" ? `${screenVideoLabel}	${cameraVideoLabel}`
			: videoSource === "screen" ? screenVideoLabel
			: cameraVideoLabel;

		const audioLabel =
			audioSource === "both" ? `${screenAudioLabel}	${micAudioLabel}`
			: audioSource === "screen" ? screenAudioLabel
			: micAudioLabel;

		const videoTrack = combined.getVideoTracks()[0];
		const audioTrack = combined.getAudioTracks()[0];
		const vs = videoTrack?.getSettings();
		const as_ = audioTrack?.getSettings();
		useWebRTCStore.getState().setStreamInfo({
			videoMuted: muteVideo,
			videoLabel,
			videoWidth: vs?.width ?? 0,
			videoHeight: vs?.height ?? 0,
			audioMuted: muteAudio,
			audioLabel,
			audioSampleRate: as_?.sampleRate ?? 0,
		});

		// Stop broadcast automatically if user ends screen share via browser UI
		screenStream?.getVideoTracks()[0]?.addEventListener("ended", () => this.stopBroadcast());
	}

	async handleViewerOffer(viewerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
		if (!this.localStream) return;

		this.viewerPeers.get(viewerId)?.close();
		const pc = new RTCPeerConnection(RTC_CONFIG);
		this.viewerPeers.set(viewerId, pc);

		this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream!));

		pc.onicecandidate = ({ candidate }) => {
			if (candidate) {
				webSocketService.sendMessage({ type: "ice_candidate", to: viewerId, data: candidate });
			}
		};

		pc.onconnectionstatechange = () => {
			const { connectionState } = pc;
			if (connectionState === "disconnected" || connectionState === "failed" || connectionState === "closed") {
				this.viewerPeers.delete(viewerId);
			}
			useWebRTCStore.getState().setViewerCount(this.viewerPeers.size);
		};

		await pc.setRemoteDescription(new RTCSessionDescription(offer));
		const answer = await pc.createAnswer();
		await pc.setLocalDescription(answer);
		webSocketService.sendMessage({ type: "answer", to: viewerId, data: answer });
	}

	stopBroadcast(): void {
		this.viewerPeers.forEach((_, viewerId) => {
			webSocketService.sendMessage({ type: "broadcast_ended", to: viewerId, data: null });
		});
		this.stopCanvasCompositor();
		stopTracks(this.localStream);
		this.localStream = null;
		this.viewerPeers.forEach(pc => pc.close());
		this.viewerPeers.clear();

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
				webSocketService.sendMessage({ type: "ice_candidate", to: broadcasterId, data: candidate });
			}
		};

		pc.ontrack = ({ streams }) => {
			if (streams[0]) useWebRTCStore.getState().setRemoteStream(streams[0]);
		};

		pc.onconnectionstatechange = () => {
			const { connectionState } = pc;
			useWebRTCStore.getState().setConnectionState(connectionState);
			if ((connectionState === "disconnected" || connectionState === "failed")
				&& webSocketService.isConnected()) {
				useWebRTCStore.getState().setDisconnectReason("network");
			}
		};

		pc.addTransceiver("video", { direction: "recvonly" });
		pc.addTransceiver("audio", { direction: "recvonly" });

		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		webSocketService.sendMessage({ type: "offer", to: broadcasterId, data: offer });
	}

	async handleBroadcasterAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
		await this.broadcasterPc?.setRemoteDescription(new RTCSessionDescription(answer));
	}

	requestResolution(maxWidth: number, maxHeight: number): void {
		if (this.broadcasterPeerId) {
			webSocketService.sendMessage({
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
		this.broadcasterPc = null;
		this.broadcasterPeerId = "";
	}
}

export const webRTCService = WebRTCService.getInstance();
