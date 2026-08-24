import { useCallback, useEffect, useRef, useState } from "react";
import { getName, getOrCreateViewerKey, setName as persistName } from "./identity";
import { CandidateQueue, fetchIceServers, hasTurnServer } from "./rtc";
import { Signal, signalUrl, type Frame } from "./signal";
import type { Viewer } from "./useHost";

export type ViewerStatus = "connecting" | "waiting" | "joining" | "live" | "ended" | "error";

const JOIN_TIMEOUT_MS = 12_000;
const MAX_AUTOMATIC_RETRIES = 1;

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
  const joinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const automaticRetries = useRef(0);

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
    if (joinTimer.current) clearTimeout(joinTimer.current);
    joinTimer.current = null;
  }, []);

  /** Rejoin with a fresh connection id so the host sends a new offer. */
  const rejoin = useCallback((automatic = false) => {
    closePeer();
    const signal = signalRef.current;
    signal?.close();
    signalRef.current = null;

    if (automatic && automaticRetries.current >= MAX_AUTOMATIC_RETRIES) {
      const hasTurn = hasTurnServer(iceRef.current);
      setError(
        hasTurn
          ? "Peek could not establish a media connection. Check the network and try again."
          : "This network needs a TURN relay, but this Peek deployment does not have one configured."
      );
      setStatus("error");
      return;
    }

    automaticRetries.current = automatic ? automaticRetries.current + 1 : 0;
    setError(null);
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
          if (joinTimer.current) clearTimeout(joinTimer.current);
          joinTimer.current = null;
          automaticRetries.current = 0;
          setError(null);
          setStatus("live");
        } else if (pc.connectionState === "failed") {
          rejoin(true);
        } else if (pc.connectionState === "disconnected") {
          disconnectTimer.current = setTimeout(() => {
            if (pc.connectionState !== "connected") rejoin(true);
          }, 4000);
        }
      };
      joinTimer.current = setTimeout(() => {
        if (pcRef.current === pc && pc.connectionState !== "connected") rejoin(true);
      }, JOIN_TIMEOUT_MS);

      try {
        await pc.setRemoteDescription(sdp);
        await queue.flush();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signal.send({ type: "signal", data: { sdp: pc.localDescription } });
      } catch (err) {
        console.error("answer failed", err);
        rejoin(true);
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
            setStatus((s) => (s === "live" || s === "joining" || s === "error" ? s : "joining"));
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
      url: signalUrl(roomId, "viewer", getName() || undefined, getOrCreateViewerKey()),
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

  const retry = useCallback(() => rejoin(false), [rejoin]);

  return { status, hostName, viewers, you, name, setName, muted, hasAudio, unmute, mute, error, retry };
}
