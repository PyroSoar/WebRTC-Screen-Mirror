import {
	Heading, VStack, Button, HStack, Spinner,
	Text, Spacer, Badge, Box, Checkbox, Input,
} from "@chakra-ui/react";
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { customAlphabet } from "nanoid/non-secure";
import {
	TriangleAlertIcon, MonitorIcon, UsersIcon,
	CopyIcon, CheckIcon, MicIcon, VideoIcon,
	InfoIcon, EyeIcon, WifiOffIcon, RefreshCwIcon, MapPinIcon, QrCodeIcon, PencilIcon,
} from "lucide-react";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useWebSocketStore } from "~/stores/webSocket";
import { webSocketService } from "~/services/webSocket";
import { useAuthStore, getDisplayId } from "~/stores/auth";
import { Alert } from "~/components/ui/alert";
import { Field } from "~/components/ui/field";
import { PinInput } from "~/components/ui/pin-input";
import { webRTCService, type BroadcastError } from "~/services/webRTC";
import { useWebRTCStore, type StreamInfo } from "~/stores/webRTC";
import { renderSVG } from "uqr";

// ─── Types ────────────────────────────────────────────────────────────────────

type VideoSrc = "screen" | "camera";
type AudioSrc = "screen" | "microphone";
type ToastType = "error" | "success" | "info";
type AppMode = null | "viewer" | "broadcaster";

interface ToastMsg { title: string; description: string; type: ToastType; }
interface Resolution { w: number; h: number; }
interface CfLocation { colo: string; city?: string; country?: string; }

// ─── Constants ────────────────────────────────────────────────────────────────

const RESOLUTIONS = [
	{ label: "原画",  key: "source", w: 7680, h: 4320 },
	{ label: "1080p", key: "1080p",  w: 1920, h: 1080 },
	{ label: "720p",  key: "720p",   w: 1280, h: 720  },
	{ label: "480p",  key: "480p",   w: 854,  h: 480  },
	{ label: "360p",  key: "360p",   w: 640,  h: 360  },
] as const;

const PIN_SCHEMA = z.object({
	code: z.string().min(1, "广播码不能为空").length(6, "广播码长度为6位"),
});

const TOAST_DURATION_MS  = 5000;
const COPY_FEEDBACK_MS   = 2000;
const RTC_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

// Alphabet for device tag: lowercase letters + digits, no ambiguous chars
const TAG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function isMobile(): boolean {
	return typeof navigator !== "undefined"
		&& /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function getInitialPin(): string | null {
	if (typeof window === "undefined") return null;
	const pin = new URLSearchParams(window.location.search).get("pin");
	return pin && /^\d{6}$/.test(pin) ? pin : null;
}

// IATA airport code → Chinese city name
const IATA_CITY: Record<string, string> = {
	AMS:"阿姆斯特丹", ATL:"亚特兰大", BKK:"曼谷", BOM:"孟买", BOS:"波士顿",
	CAN:"广州", CDG:"巴黎", CPH:"哥本哈根", DEL:"新德里", DFW:"达拉斯",
	DOH:"多哈", DUB:"都柏林", EWR:"纽约", FCO:"罗马", FRA:"法兰克福",
	GRU:"圣保罗", HAN:"河内", HEL:"赫尔辛基", HKG:"香港", HND:"东京",
	IAD:"华盛顿", IAH:"休斯顿", ICN:"首尔", JFK:"纽约", JNB:"约翰内斯堡",
	KIX:"大阪", KUL:"吉隆坡", LAX:"洛杉矶", LHR:"伦敦", LIS:"里斯本",
	MAD:"马德里", MEL:"墨尔本", MEX:"墨西哥城", MIA:"迈阿密", MNL:"马尼拉",
	MUC:"慕尼黑", MXP:"米兰", NRT:"东京", ORD:"芝加哥", OSL:"奥斯陆",
	PEK:"北京", PDX:"波特兰", PVG:"上海", SCL:"圣地亚哥", SEA:"西雅图",
	SFO:"旧金山", SIN:"新加坡", SJC:"圣何塞", SYD:"悉尼", TLV:"特拉维夫",
	TPE:"台北", VIE:"维也纳", WAW:"华沙", YYZ:"多伦多", ZRH:"苏黎世",
};

const COUNTRY_NAME: Record<string, string> = {
	US:"美国", CN:"中国", HK:"中国香港", TW:"中国台湾", SG:"新加坡",
	JP:"日本", KR:"韩国", GB:"英国", DE:"德国", FR:"法国",
	NL:"荷兰", AU:"澳大利亚", CA:"加拿大", IN:"印度", BR:"巴西",
};

let cfLocationCache: CfLocation | null = null;

async function fetchCfLocation(): Promise<CfLocation | null> {
	if (cfLocationCache) return cfLocationCache;
	try {
		const res = await fetch("/cdn-cgi/trace", { cache: "no-store" });
		if (!res.ok) return null;
		const text = await res.text();
		const get = (key: string) => text.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim() ?? "";
		const colo = get("colo");
		const loc  = get("loc");
		cfLocationCache = {
			colo,
			city:    IATA_CITY[colo]    ?? colo,
			country: COUNTRY_NAME[loc]  ?? loc,
		};
		return cfLocationCache;
	} catch {
		return null;
	}
}

function formatCfLocation(loc: CfLocation): string {
	const parts = (loc.city !== loc.country && loc.country)
		? `${loc.city}, ${loc.country}` : loc.city;
	return parts ? `${loc.colo} · ${parts}` : loc.colo;
}

function friendlyVideoLabel(label: string): string {
	const classify = (raw: string) => {
		const l = raw.toLowerCase();
		if (/screen|display|monitor|entire|window/.test(l)) return "屏幕";
		if (/camera|facetime|webcam/.test(l)) return "摄像头";
		return raw || "未知";
	};
	if (label.includes("\t")) {
		const [, cam] = label.split("\t").map(classify);
		return `屏幕 + ${cam}`;
	}
	return classify(label);
}

function friendlyAudioLabel(label: string): string {
	const classify = (raw: string) => {
		const l = raw.toLowerCase();
		if (/screen|display|system|output/.test(l)) return "屏幕声音";
		if (/mic|microphone|input/.test(l)) return "麦克风";
		return raw || "未知";
	};
	if (label.includes("\t")) {
		const [, mic] = label.split("\t").map(classify);
		return `屏幕声音 + ${mic}`;
	}
	return classify(label);
}

function srcSetsToOptions(videoSrcs: Set<VideoSrc>, audioSrcs: Set<AudioSrc>) {
	const screen = videoSrcs.has("screen"), camera = videoSrcs.has("camera");
	const mic = audioSrcs.has("microphone"), screenAudio = audioSrcs.has("screen");
	const videoSource = screen && camera ? "both" : screen ? "screen" : camera ? "camera" : null;
	const audioSource = mic && screenAudio ? "both" : screenAudio ? "screen" : mic ? "microphone" : null;
	return { videoSource, audioSource } as const;
}

function toggleSet<T>(prev: Set<T>, item: T): Set<T> {
	const next = new Set(prev);
	next.has(item) ? next.delete(item) : next.add(item);
	return next;
}

function getShareUrl(signalingId: string): string {
	if (typeof window === "undefined") return "";
	return `${window.location.origin}${window.location.pathname}?pin=${signalingId}`;
}

// ─── Route exports ────────────────────────────────────────────────────────────

export function meta() {
	return [
		{ title: "WebBeam" },
		{ name: "description", content: "无线投播" },
	];
}

export async function clientLoader() {
	const store = useAuthStore.getState();

	// Initialise persistent device identity on first launch
	if (!store.signalingId) store.setSignalingId(customAlphabet("0123456789", 6)());
	if (!store.deviceTag)   store.setDeviceTag(customAlphabet(TAG_ALPHABET, 4)());

	const { signalingId, deviceTag, nickname } = useAuthStore.getState();
	const myDisplayId = getDisplayId(nickname, deviceTag);

	webSocketService.connect(`wss://signaling.pexni.com/connect?id=${signalingId}`);

	// Broadcaster: incoming offer carries the viewer's displayId in metadata
	webSocketService.registerHandler("offer", ({ from, data, displayId }: any) => {
		if (useWebRTCStore.getState().isBroadcasting) {
			webRTCService.handleViewerOffer(from, data, displayId ?? from);
			// Reply answer carries broadcaster's displayId
			webSocketService.send({
				type: "answer_meta",
				to: from,
				data: { displayId: myDisplayId },
			});
		}
	});

	// Viewer: incoming answer
	webSocketService.registerHandler("answer", ({ data }: any) => {
		if (!useWebRTCStore.getState().isBroadcasting) {
			webRTCService.handleBroadcasterAnswer(data);
		}
	});

	// Viewer: receive broadcaster's display ID sent alongside the answer
	webSocketService.registerHandler("answer_meta", ({ data }: any) => {
		useWebRTCStore.getState().setBroadcasterDisplayId(data?.displayId ?? "");
	});

	webSocketService.registerHandler("broadcast_ended", () => {
		useWebRTCStore.getState().setDisconnectReason("broadcaster_stopped");
	});

	return null;
}
clientLoader.hydrate = true as const;

// ─── Home ─────────────────────────────────────────────────────────────────────

export default function Home() {
	const { signalingId, deviceTag, nickname, setNickname } = useAuthStore();
	const {
		remoteStream, connectionState, isBroadcasting,
		viewerCount, viewerList, streamInfo, disconnectReason, broadcasterDisplayId,
	} = useWebRTCStore();
	const { webSocketState } = useWebSocketStore();

	const myDisplayId = getDisplayId(nickname, deviceTag);

	// Refs
	const videoRef            = useRef<HTMLVideoElement>(null);
	const audioRef            = useRef<HTMLAudioElement>(null);
	const wasConnectedRef     = useRef(false);
	const retryCodeRef        = useRef("");
	const pendingPinFiredRef  = useRef(false);

	// UI state
	const [mode, setMode]               = useState<AppMode>(null);
	const [toast, setToast]             = useState<ToastMsg | null>(null);
	const [cfLocation, setCfLocation]   = useState<CfLocation | null>(null);
	const [editingName, setEditingName] = useState(false);
	const [nameInput, setNameInput]     = useState(nickname);

	// Broadcaster state
	const mobile = useMemo(isMobile, []);
	const [videoSrcs, setVideoSrcs] = useState<Set<VideoSrc>>(new Set(mobile ? ["camera"] : ["screen"]));
	const [audioSrcs, setAudioSrcs] = useState<Set<AudioSrc>>(new Set(mobile ? ["microphone"] : ["screen"]));
	const [codeCopied, setCodeCopied] = useState(false);
	const [showQr, setShowQr]         = useState(false);

	// Viewer state
	const [selectedRes, setSelectedRes] = useState("source");
	const [showInfo, setShowInfo]       = useState(false);
	const [sourceRes, setSourceRes]     = useState<Resolution | null>(null);
	const [currentRes, setCurrentRes]   = useState<Resolution | null>(null);
	const [connBroken, setConnBroken]   = useState(false);
	const [retrying, setRetrying]       = useState(false);

	const [pendingPin] = useState(getInitialPin);

	// Derived
	const isConnected  = connectionState === "connected";
	const isConnecting = connectionState === "connecting" || connectionState === "new";
	const hasVideo     = useMemo(
		() => Boolean(remoteStream?.getVideoTracks().some(t => t.readyState === "live")),
		[remoteStream],
	);
	const visibleResolutions = useMemo(
		() => RESOLUTIONS.filter(r => r.key === "source" || !sourceRes || r.h <= sourceRes.h),
		[sourceRes],
	);

	// ── Toast ──────────────────────────────────────────────────────────────────
	const showToast = useCallback((title: string, description: string, type: ToastType = "error") => {
		setToast({ title, description, type });
		setTimeout(() => setToast(null), TOAST_DURATION_MS);
	}, []);

	const showBroadcastError = useCallback((err: BroadcastError) => showToast(
		err.code === "NOT_SUPPORTED"    ? "此设备不支持该功能"
		: err.code === "PERMISSION_DENIED" ? "权限被拒绝"
		: "广播失败",
		err.message,
	), [showToast]);

	// ── Effects ────────────────────────────────────────────────────────────────

	useEffect(() => { fetchCfLocation().then(setCfLocation); }, []);

	useEffect(() => {
		if (!remoteStream || !isConnected) return;
		const el = hasVideo ? videoRef.current : audioRef.current;
		if (el && el.srcObject !== remoteStream) el.srcObject = remoteStream;

		const vid = videoRef.current;
		if (!vid) return;
		const onMeta = () => {
			if (vid.videoWidth) setCurrentRes({ w: vid.videoWidth, h: vid.videoHeight });
		};
		vid.addEventListener("loadedmetadata", onMeta);
		return () => vid.removeEventListener("loadedmetadata", onMeta);
	}, [remoteStream, isConnected, hasVideo]);

	useEffect(() => {
		if (!isConnected || !remoteStream) return;
		const iv = setInterval(() => {
			const vid = videoRef.current;
			if (!vid?.videoWidth) return;
			const res = { w: vid.videoWidth, h: vid.videoHeight };
			setCurrentRes(res);
			setSourceRes(prev => (!prev || res.w * res.h > prev.w * prev.h) ? res : prev);
		}, 1000);
		return () => clearInterval(iv);
	}, [isConnected, remoteStream]);

	useEffect(() => {
		if (isConnected) {
			wasConnectedRef.current = true;
			setConnBroken(false);
		} else if (
			(connectionState === "disconnected" || connectionState === "failed") &&
			wasConnectedRef.current
		) {
			setConnBroken(true);
		}
	}, [connectionState, isConnected]);

	// Auto-retry on viewer network drop (exponential backoff)
	useEffect(() => {
		if (!connBroken || disconnectReason !== "network" || !retryCodeRef.current) return;
		let attempt = 0;
		let timer: ReturnType<typeof setTimeout>;
		const tryNext = () => {
			if (attempt >= RTC_RETRY_DELAYS_MS.length) { setRetrying(false); return; }
			setRetrying(true);
			timer = setTimeout(async () => {
				try {
					await connectViewer(retryCodeRef.current);
					setConnBroken(false);
					setRetrying(false);
					wasConnectedRef.current = true;
					useWebRTCStore.getState().setDisconnectReason(null);
				} catch {
					attempt++;
					tryNext();
				}
			}, RTC_RETRY_DELAYS_MS[attempt++]);
		};
		tryNext();
		return () => clearTimeout(timer);
	}, [connBroken, disconnectReason]);

	// Auto-connect from ?pin= URL param
	useEffect(() => {
		if (!pendingPin || pendingPinFiredRef.current || webSocketState !== "connected") return;
		pendingPinFiredRef.current = true;
		setMode("viewer");
		setValue("code", pendingPin, { shouldValidate: true });
		connectViewer(pendingPin);
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pendingPin, webSocketState]);

	// ── Form ───────────────────────────────────────────────────────────────────
	const { register, handleSubmit, setValue, formState: { errors } } = useForm<z.infer<typeof PIN_SCHEMA>>({
		resolver: zodResolver(PIN_SCHEMA),
	});

	// Send our displayId alongside the WebRTC offer so the broadcaster knows who we are
	const connectViewer = useCallback(async (code: string) => {
		retryCodeRef.current = code;
		try {
			await webRTCService.connectToBroadcaster(code);
			// Tell the broadcaster our display ID via a side-channel message
			webSocketService.send({
				type: "viewer_hello",
				to: code,
				data: { displayId: myDisplayId },
			});
		} catch {
			showToast("连接失败", "找不到对应的广播，请确认广播码是否正确。");
		}
	}, [myDisplayId, showToast]);

	const onSubmitViewer = handleSubmit(({ code }) => connectViewer(code));
	// Defer by one tick to let react-hook-form update its internal state before we submit
	const onPinComplete  = (value: string) => {
		setValue("code", value, { shouldValidate: true });
		setTimeout(() => connectViewer(value), 0);
	};

	// ── Broadcaster actions ────────────────────────────────────────────────────
	const onStartBroadcast = async () => {
		const { videoSource, audioSource } = srcSetsToOptions(videoSrcs, audioSrcs);
		if (!videoSource && !audioSource) {
			showToast("请至少选择一个来源", "视频和音频不能同时为空。");
			return;
		}
		const effectiveVideo = (videoSource ?? "camera") as "screen" | "camera" | "both";
		const effectiveAudio = (audioSource ?? "microphone") as "screen" | "microphone" | "both";
		const supportErr = webRTCService.checkBroadcastSupport({ videoSource: effectiveVideo, audioSource: effectiveAudio });
		if (supportErr) { showBroadcastError(supportErr); return; }
		try {
			await webRTCService.startBroadcast({
				videoSource: effectiveVideo, audioSource: effectiveAudio,
				muteVideo: !videoSource, muteAudio: !audioSource,
			});
		} catch (err) {
			showBroadcastError(err as BroadcastError);
		}
	};

	const onCopyCode = async () => {
		await navigator.clipboard.writeText(signalingId);
		setCodeCopied(true);
		setTimeout(() => setCodeCopied(false), COPY_FEEDBACK_MS);
	};

	const onCopyShareLink = () => {
		navigator.clipboard.writeText(getShareUrl(signalingId));
		showToast("已复制", "分享链接已复制到剪贴板。", "success");
	};

	const onCopyQrCode = async () => {
		const svg  = renderSVG(getShareUrl(signalingId));
		const blob = new Blob([svg], { type: "image/svg+xml" });
		try {
			await navigator.clipboard.write([new ClipboardItem({ "image/svg+xml": blob })]);
			showToast("已复制", "二维码已复制到剪贴板（SVG格式）。", "success");
		} catch {
			const a = document.createElement("a");
			a.href     = URL.createObjectURL(blob);
			a.download = `webbeam-${signalingId}.svg`;
			a.click();
			showToast("已下载", "二维码已保存为SVG文件。", "info");
		}
	};

	// ── Viewer actions ─────────────────────────────────────────────────────────
	const resetViewer = () => {
		setSelectedRes("source");
		setShowInfo(false);
		setSourceRes(null);
		setCurrentRes(null);
		setConnBroken(false);
		setRetrying(false);
		wasConnectedRef.current = false;
		retryCodeRef.current    = "";
		const store = useWebRTCStore.getState();
		store.setDisconnectReason(null);
		store.setBroadcasterDisplayId("");
		webRTCService.disconnectViewer();
	};

	const onSelectResolution = (r: typeof RESOLUTIONS[number]) => {
		setSelectedRes(r.key);
		try {
			webRTCService.requestResolution(r.w, r.h);
			showToast("画质已切换", `已切换至 ${r.label}`, "success");
		} catch {
			showToast("切换失败", "无法切换画质，请稍后重试。");
		}
	};

	// ── Nickname editing ───────────────────────────────────────────────────────
	const onSaveNickname = () => {
		setNickname(nameInput.trim());
		setEditingName(false);
	};

	// ══════════════════════════════════════════════════════════════════════════
	// Broadcaster view
	// ══════════════════════════════════════════════════════════════════════════
	if (isBroadcasting) {
		return (
			<VStack p={4} pt={16} pb={8} gap={5} maxW="550px" mx="auto" w="full" overflowY="auto">
				<WsBanner />
				<Toast msg={toast} onClose={() => setToast(null)} />

				{/* 1. Status */}
				<VStack gap={1} textAlign="center">
					<HStack><MonitorIcon size={20} /><Text fontWeight="semibold">正在广播</Text></HStack>
					<Text fontSize="xs" color="fg.muted">你的设备ID：{myDisplayId}</Text>
					<Text fontSize="sm" color="fg.muted">将以下广播码分享给想要观看的人</Text>
				</VStack>

				{/* 2. Label */}
				<Text fontSize="sm" color="fg.muted">你的广播码</Text>

				{/* 3. Pin + copy */}
				<HStack gap={3}>
					<Text fontSize="4xl" fontWeight="bold" letterSpacing={6} fontFamily="mono">{signalingId}</Text>
					<Button size="sm" variant="ghost" onClick={onCopyCode} title="复制广播码">
						{codeCopied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
					</Button>
				</HStack>

				{/* 4. Share buttons */}
				<HStack gap={2} flexWrap="wrap" justify="center">
					<Button size="sm" variant="outline" onClick={onCopyShareLink} gap={1}>
						<CopyIcon size={13} />复制分享链接
					</Button>
					<Button size="sm" variant="outline" onClick={() => setShowQr(true)} gap={1}>
						<QrCodeIcon size={13} />查看二维码
					</Button>
					<Button size="sm" variant="outline" onClick={onCopyQrCode} gap={1}>
						<QrCodeIcon size={13} />复制二维码
					</Button>
				</HStack>

				{/* 5. Stop */}
				<Button colorPalette="red" variant="subtle" onClick={() => webRTCService.stopBroadcast()}>
					停止广播
				</Button>

				{/* 6. Stream info */}
				{streamInfo && <StreamInfoPanel info={streamInfo} cfLocation={cfLocation} />}

				{/* 7. Self-preview */}
				<SelfPreview localStream={webRTCService.getLocalStream()} />

				{/* 8. Viewer count + list */}
				<VStack w="full" align="start" gap={2}>
					<HStack gap={2}>
						<UsersIcon size={16} />
						<Text fontSize="sm">{viewerCount === 0 ? "暂无观看者" : `${viewerCount} 人正在观看`}</Text>
						{viewerCount > 0 && <Badge colorPalette="green" variant="subtle">{viewerCount}</Badge>}
					</HStack>
					{viewerList.length > 0 && (
						<VStack align="start" gap={1} pl={6} w="full">
							{viewerList.map((vid, i) => (
								<Text key={i} fontSize="xs" color="fg.muted" fontFamily="mono">{vid}</Text>
							))}
						</VStack>
					)}
				</VStack>

				{showQr && <QrModal url={getShareUrl(signalingId)} onClose={() => setShowQr(false)} />}
			</VStack>
		);
	}

	// ══════════════════════════════════════════════════════════════════════════
	// Viewer view
	// ══════════════════════════════════════════════════════════════════════════
	if (isConnected || connBroken) {
		const isBroadcasterStopped = disconnectReason === "broadcaster_stopped";

		return (
			<Box position="fixed" top={0} left={0} w="100vw" h="100dvh"
				bg="black" overflow="hidden" display="flex" flexDirection="column"
			>
				<WsBanner />

				<Box flex={1} position="relative" overflow="hidden">
					{hasVideo ? (
						<video ref={videoRef} autoPlay playsInline controls style={{
							position: "absolute", top: 0, left: 0,
							width: "100%", height: "100%",
							objectFit: "contain", backgroundColor: "black",
						}} />
					) : (
						<Box position="absolute" top={0} left={0} w="100%" h="100%"
							display="flex" flexDirection="column"
							alignItems="center" justifyContent="center" gap={4}
						>
							<audio ref={audioRef} autoPlay controls style={{ width: "min(400px, 90vw)" }} />
							<VStack gap={2} textAlign="center">
								<MicIcon size={36} color="#666" />
								<Text color="whiteAlpha.500" fontSize="sm">仅音频广播</Text>
							</VStack>
						</Box>
					)}

					{/* Connection broken overlay */}
					{connBroken && (
						<Box position="absolute" inset={0} bg="rgba(0,0,0,0.82)"
							display="flex" alignItems="center" justifyContent="center" zIndex={20}
						>
							<VStack gap={4} px={6} py={6} bg="gray.900" borderRadius="xl"
								textAlign="center" maxW="xs" borderWidth={1}
								borderColor={isBroadcasterStopped ? "orange.500" : "red.500"}
							>
								{isBroadcasterStopped ? (
									<>
										<MonitorIcon size={28} color="orange" />
										<Text color="orange.300" fontWeight="bold" fontSize="lg">广播已结束</Text>
										<Text color="whiteAlpha.700" fontSize="sm">广播方已主动停止广播</Text>
										<Button size="sm" colorPalette="orange" variant="subtle" onClick={resetViewer}>
											返回首页
										</Button>
									</>
								) : (
									<>
										<WifiOffIcon size={28} color="#fc8181" />
										<Text color="red.300" fontWeight="bold" fontSize="lg">网络连接中断</Text>
										<Text color="whiteAlpha.700" fontSize="sm">
											{retrying ? "正在自动重连..." : "网络连接已断开"}
										</Text>
										{retrying && <Spinner size="sm" color="red.300" />}
										<HStack gap={2}>
											<Button size="sm" variant="ghost" color="whiteAlpha.700" onClick={resetViewer}>
												返回首页
											</Button>
											{!retrying && (
												<Button size="sm" colorPalette="red" gap={1}
													onClick={() => connectViewer(retryCodeRef.current)}
												>
													<RefreshCwIcon size={13} />手动重连
												</Button>
											)}
										</HStack>
									</>
								)}
							</VStack>
						</Box>
					)}

					{/* Info overlay */}
					{showInfo && !connBroken && (
						<Box position="absolute" top={3} left={3} zIndex={10}
							bg="rgba(0,0,0,0.82)" color="white" px={3} py={2}
							borderRadius="md" fontSize="xs"
						>
							<VStack align="start" gap={1}>
								<Text fontWeight="bold" fontSize="sm">媒体信息</Text>
								{broadcasterDisplayId && (
									<Text>广播方：{broadcasterDisplayId}</Text>
								)}
								{hasVideo && <>
									<Text>原始分辨率：{sourceRes ? `${sourceRes.w}×${sourceRes.h}` : "检测中..."}</Text>
									<Text>当前分辨率：{currentRes ? `${currentRes.w}×${currentRes.h}` : "检测中..."}</Text>
								</>}
								<Text>音频：{remoteStream?.getAudioTracks().length ? "有" : "无"}</Text>
								{cfLocation && (
									<HStack gap={1} color="whiteAlpha.600">
										<MapPinIcon size={11} />
										<Text>中继节点：{formatCfLocation(cfLocation)}</Text>
									</HStack>
								)}
							</VStack>
						</Box>
					)}
				</Box>

				{/* Toolbar */}
				<HStack p={3} w="full" justify="space-between" align="center" gap={2}
					style={{ background: "rgba(0,0,0,0.75)", flexShrink: 0 }}
				>
					<HStack gap={1} flex={1} flexWrap="wrap">
						{!connBroken && hasVideo && visibleResolutions.map(r => (
							<Button key={r.key} size="xs"
								variant={selectedRes === r.key ? "solid" : "ghost"}
								color={selectedRes === r.key ? undefined : "white"}
								onClick={() => onSelectResolution(r)}
							>
								{r.label}
							</Button>
						))}
					</HStack>
					<HStack gap={2} flexShrink={0}>
						{!connBroken && (
							<Button size="sm" variant="ghost" color="white" onClick={() => setShowInfo(v => !v)}>
								<InfoIcon size={16} />
							</Button>
						)}
						<Button colorPalette="red" size="sm" onClick={resetViewer}>
							{connBroken ? "返回首页" : "断开连接"}
						</Button>
					</HStack>
				</HStack>

				<Toast msg={toast} onClose={() => setToast(null)} />
			</Box>
		);
	}

	// ══════════════════════════════════════════════════════════════════════════
	// Landing view
	// ══════════════════════════════════════════════════════════════════════════
	return (
		<VStack p={4} pt={16} h="dvh" gap={5} maxW="sm" mx="auto">
			<WsBanner />
			<Toast msg={toast} onClose={() => setToast(null)} />

			{/* Device identity */}
			<VStack gap={1} textAlign="center" w="full">
				<Heading fontSize="2xl">WebBeam</Heading>
				<Text fontSize="sm" color="fg.muted">无线投播</Text>
				<Box pt={2}>
					{editingName ? (
						<HStack gap={2} justify="center">
							<Input
								size="sm" value={nameInput} maxW="32"
								placeholder="输入昵称（可留空）"
								onChange={e => setNameInput(e.target.value)}
								onKeyDown={e => { if (e.key === "Enter") onSaveNickname(); if (e.key === "Escape") setEditingName(false); }}
								autoFocus
							/>
							<Button size="sm" onClick={onSaveNickname}>保存</Button>
							<Button size="sm" variant="ghost" onClick={() => setEditingName(false)}>取消</Button>
						</HStack>
					) : (
						<HStack gap={1} justify="center" color="fg.muted">
							<Text fontSize="xs" fontFamily="mono">{myDisplayId}</Text>
							<Button size="xs" variant="ghost" onClick={() => { setNameInput(nickname); setEditingName(true); }}>
								<PencilIcon size={11} />
							</Button>
						</HStack>
					)}
				</Box>
			</VStack>

			{mode === null && (
				<VStack w="full" gap={3}>
					<Button w="full" size="lg" variant="outline" gap={2} onClick={() => setMode("viewer")}>
						<EyeIcon size={18} />我要观看
					</Button>
					<Button w="full" size="lg" variant="subtle" gap={2} onClick={() => setMode("broadcaster")}>
						<MonitorIcon size={18} />我要广播
					</Button>
				</VStack>
			)}

			{mode === "viewer" && (
				<VStack w="full" gap={4}>
					<VStack w="full" gap={4} asChild>
						<form method="post" onSubmit={onSubmitViewer}>
							<Field label="输入广播码" invalid={!!errors.code} errorText={errors.code?.message} w="full">
								<PinInput count={6} placeholder="" pattern="\d" autoFocus
									onValueComplete={d => onPinComplete(d.valueAsString)}
									{...register("code")}
								/>
							</Field>
							<Button w="full" type="submit" loading={isConnecting}>
								{isConnecting ? "连接中..." : "观看广播"}
							</Button>
						</form>
					</VStack>
					<Button w="full" variant="ghost" size="sm" onClick={() => setMode(null)}>返回</Button>
				</VStack>
			)}

			{mode === "broadcaster" && (
				<VStack w="full" gap={4} align="stretch">
					<SourceCheckboxGroup
						label="视频来源" icon={<VideoIcon size={14} />}
						options={[
							{ key: "screen",  label: "屏幕",   hidden: mobile },
							{ key: "camera",  label: "摄像头" },
						]}
						isChecked={k => videoSrcs.has(k as VideoSrc)}
						onToggle={k  => setVideoSrcs(p => toggleSet(p, k as VideoSrc))}
					/>
					<SourceCheckboxGroup
						label="音频来源" icon={<MicIcon size={14} />}
						options={[
							{ key: "screen",     label: "屏幕声音", hidden: mobile },
							{ key: "microphone", label: "麦克风"   },
						]}
						isChecked={k => audioSrcs.has(k as AudioSrc)}
						onToggle={k  => setAudioSrcs(p => toggleSet(p, k as AudioSrc))}
					/>
					<Button w="full" variant="subtle" size="lg" onClick={onStartBroadcast} gap={2}>
						<MonitorIcon size={18} />开始广播
					</Button>
					<Button w="full" variant="ghost" size="sm" onClick={() => setMode(null)}>返回</Button>
				</VStack>
			)}
		</VStack>
	);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function WsBanner() {
	const { webSocketState, reconnectAttempts } = useWebSocketStore();
	if (webSocketState === "connected" || webSocketState === "disconnected") return null;
	const isFailed = webSocketState === "failed";
	return (
		<HStack pos="fixed" top="4" left="0" w="full" px="2" zIndex={999} justifyContent="center">
			<Alert variant="subtle" status={isFailed ? "error" : "info"}
				icon={isFailed ? <TriangleAlertIcon /> : <Spinner size="sm" />}
				maxW="sm" alignItems="center" asChild
			>
				<HStack h="6" gap={2}>
					<Text fontSize="sm">
						{webSocketState === "connecting"   && "正在连接服务器..."}
						{webSocketState === "reconnecting" && `重连中（第 ${reconnectAttempts} 次）...`}
						{isFailed                          && "服务器连接失败"}
					</Text>
					<Spacer />
					{isFailed && <Button size="xs" onClick={() => webSocketService.reconnect()}>重试</Button>}
				</HStack>
			</Alert>
		</HStack>
	);
}

function Toast({ msg, onClose }: { msg: ToastMsg | null; onClose: () => void }) {
	if (!msg) return null;
	const bg = msg.type === "success" ? "green.600" : msg.type === "info" ? "blue.600" : "red.500";
	return (
		<Box pos="fixed" top="4" left="50%" transform="translateX(-50%)" zIndex={1000}
			bg={bg} color="white" px={4} py={3} borderRadius="md" boxShadow="lg" maxW="sm" w="90%"
		>
			<HStack justify="space-between" align="start" gap={3}>
				<VStack align="start" gap={0}>
					<Text fontWeight="bold" fontSize="sm">{msg.title}</Text>
					<Text fontSize="xs" opacity={0.9}>{msg.description}</Text>
				</VStack>
				<Button size="xs" variant="ghost" color="white" onClick={onClose} flexShrink={0}>✕</Button>
			</HStack>
		</Box>
	);
}

function SourceCheckboxGroup({ label, icon, options, isChecked, onToggle }: {
	label: string;
	icon: React.ReactNode;
	options: { key: string; label: string; hidden?: boolean }[];
	isChecked: (key: string) => boolean;
	onToggle:  (key: string) => void;
}) {
	return (
		<VStack align="stretch" gap={2}>
			<HStack gap={1}>
				{icon}
				<Text fontSize="xs" color="fg.muted" fontWeight="medium">{label}</Text>
			</HStack>
			<HStack gap={4}>
				{options.filter(o => !o.hidden).map(o => (
					<Checkbox.Root key={o.key} checked={isChecked(o.key)} onCheckedChange={() => onToggle(o.key)}>
						<Checkbox.HiddenInput />
						<Checkbox.Control />
						<Checkbox.Label fontSize="sm">{o.label}</Checkbox.Label>
					</Checkbox.Root>
				))}
			</HStack>
		</VStack>
	);
}

function StreamInfoRow({ icon, label, children }: {
	icon: React.ReactNode;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<HStack gap={2}>
			{icon}
			<Text color="fg.muted">{label}：{children}</Text>
		</HStack>
	);
}

function StreamInfoPanel({ info, cfLocation }: { info: StreamInfo; cfLocation: CfLocation | null }) {
	const resolution = info.videoWidth && info.videoHeight
		? `${info.videoWidth}×${info.videoHeight}` : null;
	const sampleRate = info.audioSampleRate
		? `${(info.audioSampleRate / 1000).toFixed(1)}kHz` : null;

	return (
		<VStack gap={1} px={4} py={3} borderRadius="md" bg="bg.subtle"
			align="start" w="full" maxW="550px" fontSize="sm"
		>
			<StreamInfoRow icon={<VideoIcon size={13} />} label="视频">
				{info.videoMuted
					? <Text as="span" color="fg.muted">（已关闭）</Text>
					: <>
						<Text as="span" fontWeight="medium" color="fg">{friendlyVideoLabel(info.videoLabel)}</Text>
						{resolution && <Text as="span" color="fg.muted">（{resolution}）</Text>}
					</>
				}
			</StreamInfoRow>
			<StreamInfoRow icon={<MicIcon size={13} />} label="音频">
				{info.audioMuted
					? <Text as="span" color="fg.muted">（已关闭）</Text>
					: <>
						<Text as="span" fontWeight="medium" color="fg">{friendlyAudioLabel(info.audioLabel)}</Text>
						{sampleRate && <Text as="span" color="fg.muted">（{sampleRate}）</Text>}
					</>
				}
			</StreamInfoRow>
			{cfLocation && (
				<StreamInfoRow icon={<MapPinIcon size={13} />} label="中继节点">
					<Text as="span" fontWeight="medium" color="fg">{formatCfLocation(cfLocation)}</Text>
				</StreamInfoRow>
			)}
		</VStack>
	);
}

function QrModal({ url, onClose }: { url: string; onClose: () => void }) {
	const svg = renderSVG(url, { border: 2 });
	return (
		<Box position="fixed" inset={0} zIndex={2000}
			bg="rgba(0,0,0,0.6)" display="flex" alignItems="center" justifyContent="center"
			onClick={onClose}
		>
			<VStack bg="white" p={6} borderRadius="xl" gap={4} maxW="xs" w="90%"
				onClick={e => e.stopPropagation()}
			>
				<Text fontWeight="bold" color="gray.800" fontSize="md">扫码观看广播</Text>
				<Box w="full" borderRadius="md" overflow="hidden"
					dangerouslySetInnerHTML={{ __html: svg }}
					css={{ "& svg": { width: "100%", height: "auto", display: "block" } }}
				/>
				<Text fontSize="xs" color="gray.500" textAlign="center" wordBreak="break-all">{url}</Text>
				<Button size="sm" variant="ghost" onClick={onClose} w="full">关闭</Button>
			</VStack>
		</Box>
	);
}

function SelfPreview({ localStream }: { localStream: MediaStream | null }) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const audioRef = useRef<HTMLAudioElement>(null);
	const [expanded, setExpanded] = useState(false);
	const hasVideoTrack = Boolean(localStream?.getVideoTracks().some(t => t.readyState === "live"));

	useEffect(() => {
		if (!expanded || !localStream) return;
		if (hasVideoTrack) {
			const vid = videoRef.current;
			if (vid && vid.srcObject !== localStream) vid.srcObject = localStream;
		} else {
			const aud = audioRef.current;
			if (aud && aud.srcObject !== localStream) aud.srcObject = localStream;
		}
	}, [localStream, expanded, hasVideoTrack]);

	if (!localStream) return null;

	return (
		<VStack w="full" align="stretch" gap={2}>
			<Button size="sm" variant="ghost" gap={2} justifyContent="flex-start"
				onClick={() => setExpanded(v => !v)}
			>
				{expanded ? "▲" : "▼"}{hasVideoTrack ? "预览本地画面" : "预览本地音频"}
			</Button>
			{expanded && (
				hasVideoTrack ? (
					<Box borderRadius="md" overflow="hidden" w="full">
						<video ref={videoRef} autoPlay playsInline muted controls
							style={{ width: "100%", display: "block" }}
						/>
					</Box>
				) : (
					<Box px={3} py={2} borderRadius="md" bg="bg.subtle">
						<audio ref={audioRef} autoPlay muted controls style={{ width: "100%" }} />
					</Box>
				)
			)}
		</VStack>
	);
}
