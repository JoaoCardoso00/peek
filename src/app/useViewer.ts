import { useCallback, useEffect, useRef, useState } from "react";
import { getName, setName as persistName } from "./identity";
import { CandidateQueue, fetchIceServers } from "./rtc";
import { Signal, signalUrl, type Frame } from "./signal";
import type { Viewer } from "./useHost";

export type ViewerStatus = "connecting" | "waiting" | "joining" | "live" | "ended" | "error";

export function useViewer(roomId: string, videoRef: React.RefObject<HTMLVideoElement | null>) {
  const [status, setStatus] = useState<ViewerStatus>("connecting");
  const [hostName, setHostName] = useState("the host");
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [you, setYou] = useState<string | null>(null);
  const [name, setNameState] = useState("");
  const [muted, setMuted] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signalRef = useRef<Signal | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const queueRef = useRef<CandidateQueue | null>(null);
  const iceRef = useRef<RTCIceServer[]>([]);
  const disconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closePeer = useCallback(() => {
    const pc = pcRef.current;
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    pcRef.current = null;
    queueRef.current = null;
    if (disconnectTimer.current) clearTimeout(disconnectTimer.current);
    disconnectTimer.current = null;
  }, []);

  /** Rejoin with a fresh viewer id so the host sends a new offer. */
  const rejoin = useCallback(() => {
    closePeer();
    const signal = signalRef.current;
    if (!signal) return;
    signal.close();
    signalRef.current = null;
    setStatus("connecting");
    connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closePeer]);

  const attach = useCallback(
    (stream: MediaStream) => {
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      // The host always negotiates an audio sender. Only count it once data flows.
      const audioTrack = stream.getAudioTracks()[0];
      const syncAudio = () => setHasAudio(!!audioTrack && !audioTrack.muted);
      if (audioTrack) {
        audioTrack.addEventListener("mute", syncAudio);
        audioTrack.addEventListener("unmute", syncAudio);
      }
      syncAudio();
      video.muted = false;
      video.play().then(
        () => setMuted(false),
        () => {
          // Autoplay with sound was blocked. Play silently and offer a tap to unmute.
          video.muted = true;
          setMuted(true);
          void video.play().catch(() => undefined);
        }
      );
    },
    [videoRef]
  );

  const acceptOffer = useCallback(
    async (sdp: RTCSessionDescriptionInit) => {
      const signal = signalRef.current;
      if (!signal) return;
      closePeer();
      setStatus("joining");

      const pc = new RTCPeerConnection({ iceServers: iceRef.current });
      const queue = new CandidateQueue(pc);
      pcRef.current = pc;
      queueRef.current = queue;

      pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (stream) attach(stream);
      };
      pc.onicecandidate = (event) => {
        if (event.candidate) signal.send({ type: "signal", data: { candidate: event.candidate.toJSON() } });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          if (disconnectTimer.current) clearTimeout(disconnectTimer.current);
          disconnectTimer.current = null;
          setStatus("live");
        } else if (pc.connectionState === "failed") {
          rejoin();
        } else if (pc.connectionState === "disconnected") {
          disconnectTimer.current = setTimeout(() => {
            if (pc.connectionState !== "connected") rejoin();
          }, 4000);
        }
      };

      try {
        await pc.setRemoteDescription(sdp);
        await queue.flush();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signal.send({ type: "signal", data: { sdp: pc.localDescription } });
      } catch (err) {
        console.error("answer failed", err);
        rejoin();
      }
    },
    [attach, closePeer, rejoin]
  );

  const handleFrame = useCallback(
    (frame: Frame) => {
      switch (frame.type) {
        case "state": {
          setHostName(String(frame.hostName));
          setViewers((frame.viewers as Viewer[]) ?? []);
          setYou(String(frame.you));
          if (frame.live) {
            setStatus((s) => (s === "live" || s === "joining" ? s : "joining"));
          } else {
            closePeer();
            setStatus((s) => (s === "ended" ? s : "waiting"));
          }
          return;
        }
        case "viewers":
          setViewers((frame.viewers as Viewer[]) ?? []);
          return;
        case "signal": {
          const data = frame.data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
          if (!data) return;
          if (data.sdp) void acceptOffer(data.sdp);
          else if (data.candidate) void queueRef.current?.add(data.candidate);
          return;
        }
        case "ended":
          closePeer();
          if (videoRef.current) videoRef.current.srcObject = null;
          setStatus("ended");
          return;
        case "error":
          if (frame.code === "full") {
            setError(String(frame.message));
            setStatus("error");
            signalRef.current?.close();
          }
          return;
        default:
          return;
      }
    },
    [acceptOffer, closePeer, videoRef]
  );

  const connect = useCallback(() => {
    const signal = new Signal({
      url: signalUrl(roomId, "viewer", getName() || undefined),
      onOpen: () => undefined,
      onFrame: handleFrame,
      onClose: () => {
        // Server restarts or hibernation hiccups: the media keeps flowing over WebRTC.
        // The reconnect gives us a new viewer id; the host offers again if needed.
      }
    });
    signalRef.current = signal;
    signal.connect();
  }, [handleFrame, roomId]);

  useEffect(() => {
    setNameState(getName());
    let cancelled = false;
    void fetchIceServers().then((ice) => {
      if (cancelled) return;
      iceRef.current = ice;
      connect();
    });
    return () => {
      cancelled = true;
      signalRef.current?.close();
      signalRef.current = null;
      closePeer();
    };
  }, [closePeer, connect]);

  const unmute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    void video.play().then(() => setMuted(false)).catch(() => undefined);
  }, [videoRef]);

  const mute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    setMuted(true);
  }, [videoRef]);

  const setName = useCallback((value: string) => {
    persistName(value);
    setNameState(value);
    signalRef.current?.send({ type: "name", name: value });
  }, []);

  return { status, hostName, viewers, you, name, setName, muted, hasAudio, unmute, mute, error, retry: rejoin };
}
