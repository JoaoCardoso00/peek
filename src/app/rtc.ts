/** WebRTC helpers shared by the host and viewer sides. */
import type { Optimize, Resolution, StreamSettings } from "./identity";

export const VIDEO_MAX_BITRATE = 8_000_000;

let iceCache: RTCIceServer[] | null = null;

export async function fetchIceServers(): Promise<RTCIceServer[]> {
  if (iceCache) return iceCache;
  try {
    const response = await fetch("/api/ice", { cache: "no-store" });
    const body = (await response.json()) as { iceServers?: RTCIceServer[] };
    iceCache = body.iceServers ?? [];
  } catch {
    iceCache = [{ urls: "stun:stun.l.google.com:19302" }];
  }
  return iceCache;
}

/**
 * Screen content compresses much better with VP9/AV1 than VP8, and H264 keeps
 * hardware decoders busy on phones. Keep the browser's list, just reorder it.
 */
export function preferScreenCodecs(transceiver: RTCRtpTransceiver): void {
  try {
    const caps = RTCRtpSender.getCapabilities("video");
    if (!caps || typeof transceiver.setCodecPreferences !== "function") return;
    const order = ["video/VP9", "video/H264", "video/AV1", "video/VP8"];
    const rank = (codec: RTCRtpCodec) => {
      const index = order.indexOf(codec.mimeType);
      return index === -1 ? order.length : index;
    };
    const sorted = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
    transceiver.setCodecPreferences(sorted);
  } catch {
    // Not supported here. The default order still works.
  }
}

/** Buffers ICE candidates that arrive before the remote description is set. */
export class CandidateQueue {
  private pending: RTCIceCandidateInit[] = [];

  constructor(private readonly pc: RTCPeerConnection) {}

  async add(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.pc.remoteDescription) {
      await this.pc.addIceCandidate(candidate).catch(() => undefined);
    } else {
      this.pending.push(candidate);
    }
  }

  async flush(): Promise<void> {
    const queued = this.pending;
    this.pending = [];
    for (const candidate of queued) {
      await this.pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }
}

export function getDisplayMediaSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
}

const RESOLUTIONS: Record<Exclude<Resolution, "source">, { width: number; height: number }> = {
  "720": { width: 1280, height: 720 },
  "1080": { width: 1920, height: 1080 }
};

/** Capture constraints for the video track. Omitting width/height clears them, which is how "source" works. */
export function videoConstraints(settings: StreamSettings): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = { frameRate: { ideal: settings.fps, max: settings.fps } };
  if (settings.resolution !== "source") {
    const size = RESOLUTIONS[settings.resolution];
    constraints.width = { ideal: size.width };
    constraints.height = { ideal: size.height };
  }
  return constraints;
}

/** Resolves "auto": whole-screen captures are usually games; windows are usually apps with text. */
export function resolveOptimize(track: MediaStreamTrack, optimize: Optimize): "motion" | "detail" {
  if (optimize !== "auto") return optimize;
  const surface = (track.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface;
  return surface === "monitor" ? "motion" : "detail";
}

/**
 * contentHint is advisory (Chrome and Firefox use it, Safari ignores it).
 * degradationPreference on the sender is the explicit WebRTC control for
 * "keep frame rate" vs "keep resolution" when bandwidth runs short.
 */
export function applyContentHint(track: MediaStreamTrack, optimize: Optimize): void {
  track.contentHint = resolveOptimize(track, optimize);
}

export async function applyDegradation(sender: RTCRtpSender, mode: "motion" | "detail"): Promise<void> {
  try {
    const params = sender.getParameters();
    params.degradationPreference = mode === "motion" ? "maintain-framerate" : "maintain-resolution";
    await sender.setParameters(params);
  } catch {
    // Not supported here; contentHint is the fallback.
  }
}

export async function captureScreen(settings: StreamSettings): Promise<MediaStream> {
  const constraints: DisplayMediaStreamOptions & Record<string, unknown> = {
    video: videoConstraints(settings),
    // Always ask for audio; the picker lets the user opt in. The settings toggle mutes the track.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    // Chromium extras. Ignored elsewhere.
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    systemAudio: "include",
    monitorTypeSurfaces: "include"
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  const video = stream.getVideoTracks()[0];
  if (video) applyContentHint(video, settings.optimize);
  const audio = stream.getAudioTracks()[0];
  if (audio) audio.enabled = settings.audio;
  return stream;
}

/** Grabs the current frame as a small JPEG for the link preview. Returns null until video has data. */
export async function snapshotFrame(video: HTMLVideoElement, maxBytes: number): Promise<Blob | null> {
  if (video.readyState < 2 || video.videoWidth === 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
  const w = Math.round(video.videoWidth * scale);
  const h = Math.round(video.videoHeight * scale);
  ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  for (const quality of [0.6, 0.4, 0.25]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= maxBytes) return blob;
  }
  return null;
}
