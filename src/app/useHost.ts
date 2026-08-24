import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, getName, getSettings, setName as persistName, setSettings as persistSettings, type StreamSettings } from "./identity";
import {
  CandidateQueue,
  VIDEO_MAX_BITRATE,
  applyContentHint,
  applyDegradation,
  captureScreen,
  fetchIceServers,
  preferScreenCodecs,
  resolveOptimize,
  snapshotFrame,
  videoConstraints
} from "./rtc";
import { Signal, signalUrl, type Frame } from "./signal";

export interface Viewer {
  id: string;
  name: string;
}

interface ViewerConnection {
  id: string;
  name: string;
}

export type HostStatus = "idle" | "starting" | "live";

const THUMB_INTERVAL_MS = 12_000;
const THUMB_MAX_BYTES = 120_000;

interface Peer {
  pc: RTCPeerConnection;
  queue: CandidateQueue;
}

/** The user closed the picker. Not an error worth showing. */
function pickerCancelled(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotAllowedError";
}

export function useHost(roomId: string, token: string, videoRef: React.RefObject<HTMLVideoElement | null>) {
  const [status, setStatus] = useState<HostStatus>("idle");
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<string>("");
  const [name, setNameState] = useState<string>("");
  const [settings, setSettingsState] = useState<StreamSettings>(DEFAULT_SETTINGS);
  /** Whether the current capture came with an audio track (the user ticked "share audio" in the picker). */
  const [hasAudioTrack, setHasAudioTrack] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const settingsRef = useRef<StreamSettings>(DEFAULT_SETTINGS);
  const signalRef = useRef<Signal | null>(null);
  const peersRef = useRef<Map<string, Peer>>(new Map());
  const thumbTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const iceRef = useRef<RTCIceServer[]>([]);
  const onTrackEnded = useRef<() => void>(() => undefined);

  useEffect(() => {
    setNameState(getName());
    const saved = getSettings();
    settingsRef.current = saved;
    setSettingsState(saved);
  }, []);

  const link = typeof window === "undefined" ? "" : `${window.location.origin}/s/${roomId}${session ? `?v=${session}` : ""}`;

  const closePeer = useCallback((id: string) => {
    const peer = peersRef.current.get(id);
    if (!peer) return;
    peer.pc.onicecandidate = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    peersRef.current.delete(id);
  }, []);

  const offerTo = useCallback(
    async (viewerId: string) => {
      const stream = streamRef.current;
      const signal = signalRef.current;
      if (!stream || !signal) return;
      closePeer(viewerId);

      const pc = new RTCPeerConnection({ iceServers: iceRef.current });
      const queue = new CandidateQueue(pc);
      peersRef.current.set(viewerId, { pc, queue });

      const video = stream.getVideoTracks()[0];
      const audio = stream.getAudioTracks()[0];
      if (video) {
        const transceiver = pc.addTransceiver(video, {
          direction: "sendonly",
          streams: [stream],
          sendEncodings: [{ maxBitrate: VIDEO_MAX_BITRATE }]
        });
        preferScreenCodecs(transceiver);
      }
      // Always negotiate an audio sender, even with no audio track yet, so "Change source"
      // can add audio later with replaceTrack instead of a full renegotiation.
      pc.addTransceiver(audio ?? "audio", { direction: "sendonly", streams: [stream] });

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          signal.send({ type: "signal", to: viewerId, data: { candidate: event.candidate.toJSON() } });
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") closePeer(viewerId);
      };

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signal.send({ type: "signal", to: viewerId, data: { sdp: pc.localDescription } });
        if (video) {
          const sender = pc.getSenders().find((s) => s.track === video);
          if (sender) void applyDegradation(sender, resolveOptimize(video, settingsRef.current.optimize));
        }
      } catch (err) {
        console.error("offer failed", err);
        closePeer(viewerId);
      }
    },
    [closePeer]
  );

  const releaseStream = useCallback((stream: MediaStream | null) => {
    if (!stream) return;
    const video = stream.getVideoTracks()[0];
    if (video) video.removeEventListener("ended", onTrackEnded.current);
    stream.getTracks().forEach((track) => track.stop());
  }, []);

  const stop = useCallback(
    (message?: string) => {
      signalRef.current?.send({ type: "stop" });
      signalRef.current?.close();
      signalRef.current = null;
      for (const id of [...peersRef.current.keys()]) closePeer(id);
      releaseStream(streamRef.current);
      streamRef.current = null;
      if (thumbTimer.current) clearInterval(thumbTimer.current);
      thumbTimer.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setViewers([]);
      setHasAudioTrack(false);
      setStatus("idle");
      if (message) setError(message);
    },
    [closePeer, releaseStream, videoRef]
  );

  const uploadThumb = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    const blob = await snapshotFrame(video, THUMB_MAX_BYTES);
    if (!blob) return;
    await fetch(`/t/${roomId}/thumb.jpg`, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg", "x-peek-token": token },
      body: blob
    }).catch(() => undefined);
  }, [roomId, token, videoRef]);

  /** Points the preview and the "browser stop button" handler at a (new) capture. */
  const adoptStream = useCallback(
    (stream: MediaStream) => {
      streamRef.current = stream;
      setHasAudioTrack(stream.getAudioTracks().length > 0);
      const video = stream.getVideoTracks()[0];
      if (video) {
        // The browser's own "Stop sharing" bar ends the track; treat that as Stop.
        onTrackEnded.current = () => {
          if (streamRef.current === stream) stop();
        };
        video.addEventListener("ended", onTrackEnded.current);
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        void videoRef.current.play().catch(() => undefined);
      }
      setTimeout(() => void uploadThumb(), 1000);
    },
    [stop, uploadThumb, videoRef]
  );

  const handleFrame = useCallback(
    (frame: Frame) => {
      switch (frame.type) {
        case "hosted": {
          const list = (frame.viewers as Viewer[]) ?? [];
          const connections = (frame.connections as ViewerConnection[] | undefined) ?? list;
          setViewers(list);
          setStatus("live");
          for (const viewer of connections) void offerTo(viewer.id);
          return;
        }
        case "viewer-joined":
          void offerTo(String(frame.id));
          return;
        case "viewer-left":
          closePeer(String(frame.id));
          return;
        case "viewers":
          setViewers((frame.viewers as Viewer[]) ?? []);
          return;
        case "signal": {
          const from = String(frame.from);
          const peer = peersRef.current.get(from);
          const data = frame.data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
          if (!peer || !data) return;
          if (data.sdp) {
            void peer.pc
              .setRemoteDescription(data.sdp)
              .then(() => peer.queue.flush())
              .catch((err) => console.error("answer failed", err));
          } else if (data.candidate) {
            void peer.queue.add(data.candidate);
          }
          return;
        }
        case "error": {
          const code = String(frame.code);
          if (code === "replaced" || code === "taken") stop(String(frame.message));
          return;
        }
        default:
          return;
      }
    },
    [closePeer, offerTo, stop]
  );

  /**
   * Click 1 (this call) copies the link and opens the browser's picker.
   * Click 2 is the user choosing what to share. Then we're live.
   */
  const start = useCallback(async () => {
    setError(null);
    const nextSession = Date.now().toString(36);
    setSession(nextSession);
    const shareLink = `${window.location.origin}/s/${roomId}?v=${nextSession}`;
    // Copy inside the click so Safari and Firefox allow it.
    let copied = false;
    try {
      await navigator.clipboard.writeText(shareLink);
      copied = true;
    } catch {
      copied = false;
    }

    setStatus("starting");
    const [stream, ice] = await Promise.all([
      captureScreen(settingsRef.current).catch((err: unknown) => {
        if (!pickerCancelled(err)) console.error(err);
        return null;
      }),
      fetchIceServers(roomId)
    ]);
    if (!stream) {
      setStatus("idle");
      return { started: false, copied: false };
    }
    iceRef.current = ice;
    adoptStream(stream);

    const signal = new Signal({
      url: signalUrl(roomId, "host"),
      onOpen: () => signal.send({ type: "host", token, name: getName(), session: nextSession }),
      onFrame: handleFrame
    });
    signalRef.current = signal;
    signal.connect();

    thumbTimer.current = setInterval(() => void uploadThumb(), THUMB_INTERVAL_MS);
    return { started: true, copied };
  }, [adoptStream, handleFrame, roomId, token, uploadThumb]);

  /**
   * Swap what's being captured (other monitor, a window, a tab) while viewers keep watching.
   * replaceTrack on every sender means no renegotiation and no gap on the viewer side.
   */
  const switchSource = useCallback(async (): Promise<boolean> => {
    const previous = streamRef.current;
    if (!previous) return false;
    let next: MediaStream;
    try {
      next = await captureScreen(settingsRef.current);
    } catch (err) {
      if (!pickerCancelled(err)) console.error(err);
      return false;
    }
    const video = next.getVideoTracks()[0] ?? null;
    const audio = next.getAudioTracks()[0] ?? null;
    await Promise.all(
      [...peersRef.current.values()].flatMap(({ pc }) =>
        pc.getTransceivers().map((t) => {
          // receiver.track always exists and carries the m-line's kind, even on a sendonly transceiver.
          const replacement = t.receiver.track.kind === "video" ? video : audio;
          return t.sender.replaceTrack(replacement).catch(() => undefined);
        })
      )
    );
    releaseStream(previous);
    adoptStream(next);
    if (video) {
      const mode = resolveOptimize(video, settingsRef.current.optimize);
      for (const { pc } of peersRef.current.values()) {
        for (const sender of pc.getSenders()) {
          if (sender.track === video) void applyDegradation(sender, mode);
        }
      }
    }
    return true;
  }, [adoptStream, releaseStream]);

  const updateSettings = useCallback((patch: Partial<StreamSettings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettingsState(next);
    persistSettings(next);
    const stream = streamRef.current;
    if (!stream) return;
    const video = stream.getVideoTracks()[0];
    if (video) {
      void video.applyConstraints(videoConstraints(next)).catch(() => undefined);
      applyContentHint(video, next.optimize);
      const mode = resolveOptimize(video, next.optimize);
      for (const { pc } of peersRef.current.values()) {
        for (const sender of pc.getSenders()) {
          if (sender.track?.kind === "video") void applyDegradation(sender, mode);
        }
      }
    }
    const audio = stream.getAudioTracks()[0];
    if (audio) audio.enabled = next.audio;
  }, []);

  const setName = useCallback((value: string) => {
    persistName(value);
    setNameState(value);
    signalRef.current?.send({ type: "name", name: value });
  }, []);

  useEffect(() => () => stop(), [stop]);

  return {
    status,
    viewers,
    error,
    link,
    name,
    setName,
    settings,
    updateSettings,
    hasAudioTrack,
    start,
    stop,
    switchSource,
    clearError: () => setError(null)
  };
}
