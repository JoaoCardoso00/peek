import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createHome, tokenFor, type StreamSettings } from "./identity";
import { getDisplayMediaSupported } from "./rtc";
import { useHost, type Viewer } from "./useHost";
import { useViewer } from "./useViewer";

type Role = { kind: "loading" } | { kind: "host"; token: string } | { kind: "viewer" };

export function Stage({ roomId }: { roomId: string }) {
  const [role, setRole] = useState<Role>({ kind: "loading" });

  useEffect(() => {
    const token = tokenFor(roomId);
    setRole(token ? { kind: "host", token } : { kind: "viewer" });
  }, [roomId]);

  if (role.kind === "loading") return <main className="stage" data-state="loading" />;
  if (role.kind === "host") return <HostStage roomId={roomId} token={role.token} />;
  return <ViewerStage roomId={roomId} />;
}

// ---------------------------------------------------------------------------
// Host

function HostStage({ roomId, token }: { roomId: string; token: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const host = useHost(roomId, token, videoRef);
  const [toast, showToast] = useToast();
  const [supported, setSupported] = useState(true);
  const stageRef = useRef<HTMLElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [watchersOpen, setWatchersOpen] = useState(false);
  const hudHidden = useAutoHideHud(stageRef, host.status === "live", settingsOpen || watchersOpen);

  useEffect(() => {
    setSupported(getDisplayMediaSupported());
  }, []);

  const changeSource = async () => {
    setSettingsOpen(false);
    const switched = await host.switchSource();
    if (switched) showToast("Now sharing the new source.");
  };

  const onShare = async () => {
    const result = await host.start();
    if (!result.started) return;
    if (result.copied) showToast("Link copied. Paste it in Discord.");
    else showToast("Sharing. Use Copy link to grab your link.");
  };

  const copy = async () => {
    const ok = await copyText(host.link);
    showToast(ok ? "Link copied." : "Couldn't copy. Select the address bar instead.");
  };

  const newLink = () => {
    const home = createHome();
    window.location.href = `/s/${home.id}`;
  };

  const state = host.status === "live" ? "live" : host.status === "starting" ? "connecting" : "host-idle";

  return (
    <>
      <main ref={stageRef} className={`stage${hudHidden ? " hud-hidden" : ""}`} data-state={state}>
        <video ref={videoRef} id="video" autoPlay playsInline muted />

        {host.status === "idle" && (
          <section className="panel">
            <div className="panel-icon">
              <ScreenIcon />
            </div>
            <h1>Share your screen</h1>
            <p className="lead">Pick a window and the link is copied for you. Paste it in Discord.</p>
            <button className="btn btn-primary btn-big" type="button" onClick={onShare} disabled={!supported}>
              Share your screen
            </button>
            {host.error && <p className="hint hint-error">{host.error}</p>}
            {!supported && (
              <p className="hint">
                This browser can't share a screen. Open this page in Chrome, Edge, Firefox, or Safari on a computer.
              </p>
            )}
            <button className="link-btn" type="button" onClick={newLink}>
              Get a new link
            </button>
          </section>
        )}

        {host.status === "starting" && (
          <div className="connecting">
            <span className="spinner" aria-hidden="true" />
            <span>Pick what to share</span>
          </div>
        )}

        {host.status === "live" && (
          <div className="hud">
            <div className="hud-left">
              <span className="live-badge">Live</span>
              <span className="hud-name">Your screen</span>
              <Watchers
                viewers={host.viewers}
                you={null}
                name={host.name}
                onName={host.setName}
                open={watchersOpen}
                onToggle={() => setWatchersOpen((o) => !o)}
                onClose={() => setWatchersOpen(false)}
              />
            </div>
            <div className="hud-right">
              <button className="btn btn-ghost" type="button" onClick={changeSource}>
                <SwitchIcon />
                Change source
              </button>
              <button
                className={`btn btn-ghost${settingsOpen ? " is-on" : ""}`}
                type="button"
                aria-haspopup="true"
                aria-expanded={settingsOpen}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setSettingsOpen((o) => !o)}
              >
                <GearIcon />
                Settings
              </button>
              <button className="btn btn-ghost" type="button" onClick={copy}>
                Copy link
              </button>
              <button className="btn btn-danger" type="button" onClick={() => host.stop()}>
                Stop sharing
              </button>
            </div>
            {settingsOpen && (
              <StreamSettingsPopover
                settings={host.settings}
                hasAudioTrack={host.hasAudioTrack}
                onChange={host.updateSettings}
                onChangeSource={changeSource}
                onClose={() => setSettingsOpen(false)}
              />
            )}
          </div>
        )}
      </main>
      <Toast message={toast} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Stream settings (host only)

interface StreamSettingsPopoverProps {
  settings: StreamSettings;
  hasAudioTrack: boolean;
  onChange: (patch: Partial<StreamSettings>) => void;
  onChangeSource: () => void;
  onClose: () => void;
}

function StreamSettingsPopover({ settings, hasAudioTrack, onChange, onChangeSource, onClose }: StreamSettingsPopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="popover popover-hud" ref={ref} role="dialog" aria-label="Stream settings">
      <Segmented
        label="Resolution"
        value={settings.resolution}
        options={[
          { value: "720", label: "720p" },
          { value: "1080", label: "1080p" },
          { value: "source", label: "Source" }
        ]}
        onChange={(resolution) => onChange({ resolution })}
      />
      <Segmented
        label="Frame rate"
        value={settings.fps}
        options={[
          { value: 30, label: "30 fps" },
          { value: 60, label: "60 fps" }
        ]}
        onChange={(fps) => onChange({ fps })}
      />
      <Segmented
        label="Optimize for"
        value={settings.optimize}
        options={[
          { value: "auto", label: "Auto" },
          { value: "motion", label: "Motion" },
          { value: "detail", label: "Text" }
        ]}
        onChange={(optimize) => onChange({ optimize })}
      />
      <div className="setting">
        <div className="setting-label">Audio</div>
        {hasAudioTrack ? (
          <Segmented
            value={settings.audio}
            options={[
              { value: true, label: "On" },
              { value: false, label: "Off" }
            ]}
            onChange={(audio) => onChange({ audio })}
          />
        ) : (
          <p className="setting-note">
            This capture has no audio. Use{" "}
            <button className="link-btn" type="button" onClick={onChangeSource}>
              Change source
            </button>{" "}
            and tick "Share audio" in the picker.
          </p>
        )}
      </div>
      <p className="setting-note">Changes apply right away. Resolution and frame rate are upper bounds; the browser picks what the source allows.</p>
    </div>
  );
}

interface SegmentedProps<T> {
  label?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}

function Segmented<T extends string | number | boolean>({ label, value, options, onChange }: SegmentedProps<T>) {
  const control = (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={option.value === value ? "is-on" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
  if (!label) return control;
  return (
    <div className="setting">
      <div className="setting-label">{label}</div>
      {control}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Viewer

function ViewerStage({ roomId }: { roomId: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewer = useViewer(roomId, videoRef);
  const [toast, showToast] = useToast();
  const stageRef = useRef<HTMLElement | null>(null);
  const [watchersOpen, setWatchersOpen] = useState(false);
  const hudHidden = useAutoHideHud(stageRef, viewer.status === "live", watchersOpen);

  const copy = async () => {
    const ok = await copyText(`${window.location.origin}/s/${roomId}`);
    showToast(ok ? "Link copied." : "Couldn't copy. Select the address bar instead.");
  };

  const fullscreen = () => {
    const stage = stageRef.current;
    const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else if (stage?.requestFullscreen) {
      void stage.requestFullscreen();
    } else if (video?.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    }
  };

  const state =
    viewer.status === "live"
      ? "live"
      : viewer.status === "joining" || viewer.status === "connecting"
        ? "connecting"
        : viewer.status;

  return (
    <>
      <main ref={stageRef} className={`stage${hudHidden ? " hud-hidden" : ""}`} data-state={state}>
        <video ref={videoRef} id="video" autoPlay playsInline />

        {viewer.status === "connecting" && (
          <div className="connecting">
            <span className="spinner" aria-hidden="true" />
            <span>Connecting</span>
          </div>
        )}

        {viewer.status === "joining" && (
          <div className="connecting">
            <span className="spinner" aria-hidden="true" />
            <span>Joining {viewer.hostName}'s stream</span>
          </div>
        )}

        {viewer.status === "waiting" && (
          <section className="panel">
            <div className="pulse" aria-hidden="true" />
            <h1>Waiting for {viewer.hostName} to start sharing</h1>
            <p className="lead">Keep this tab open. The stream shows up here on its own.</p>
          </section>
        )}

        {viewer.status === "ended" && (
          <section className="panel">
            <h1>Stream ended</h1>
            <p className="lead">If {viewer.hostName} shares again, it will show up here.</p>
          </section>
        )}

        {viewer.status === "error" && (
          <section className="panel">
            <h1>Can't join</h1>
            <p className="lead">{viewer.error}</p>
            <button className="btn btn-ghost" type="button" onClick={viewer.retry}>
              Try again
            </button>
          </section>
        )}

        {viewer.status === "live" && viewer.muted && (
          <button className="tap-unmute" type="button" onClick={viewer.unmute}>
            <SpeakerIcon />
            Tap to unmute
          </button>
        )}

        {viewer.status === "live" && (
          <div className="hud">
            <div className="hud-left">
              <span className="live-badge">Live</span>
              <span className="hud-name">{viewer.hostName}'s screen</span>
              <Watchers
                viewers={viewer.viewers}
                you={viewer.you}
                name={viewer.name}
                onName={viewer.setName}
                open={watchersOpen}
                onToggle={() => setWatchersOpen((o) => !o)}
                onClose={() => setWatchersOpen(false)}
              />
            </div>
            <div className="hud-right">
              <button className="btn btn-ghost" type="button" onClick={copy}>
                Copy link
              </button>
              {viewer.hasAudio && !viewer.muted && (
                <button className="btn btn-ghost" type="button" onClick={viewer.mute}>
                  Mute
                </button>
              )}
              {viewer.hasAudio && viewer.muted && (
                <button className="btn btn-ghost" type="button" onClick={viewer.unmute}>
                  Unmute
                </button>
              )}
              <button className="btn btn-ghost hide-on-phone" type="button" onClick={fullscreen}>
                Fullscreen
              </button>
            </div>
          </div>
        )}
      </main>
      <Toast message={toast} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared chrome

interface WatchersProps {
  viewers: Viewer[];
  you: string | null;
  name: string;
  onName: (name: string) => void;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}

/** "N watching" pill with the list of names, sitting in the HUD like Discord's stream bar. */
function Watchers({ viewers, you, name, onName, open, onToggle, onClose }: WatchersProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <>
      <button
        className={`pill${viewers.length > 0 ? " is-live" : ""}`}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onToggle}
      >
        <EyeIcon />
        <span>{viewers.length}</span>
      </button>
      {open && (
        <div className="popover popover-hud popover-hud-left" ref={popoverRef}>
          <div className="popover-title">Watching</div>
          <ul>
            {viewers.length === 0 && <li className="empty">Nobody yet</li>}
            {viewers.map((v) => (
              <li key={v.id}>
                <span className="avatar">{v.name.slice(0, 1).toUpperCase()}</span>
                <span>
                  {v.name}
                  {v.id === you ? " (you)" : ""}
                </span>
              </li>
            ))}
          </ul>
          <label className="popover-you">
            <span>{you ? "You" : "Name"}</span>
            <input
              maxLength={32}
              defaultValue={name}
              placeholder={you ? "Guest" : "Someone"}
              onBlur={(e) => onName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
        </div>
      )}
    </>
  );
}

function Toast({ message }: { message: string | null }) {
  return (
    <div className={`toast${message ? " is-visible" : ""}`} role="status" aria-live="polite">
      {message}
    </div>
  );
}

function useToast(): [string | null, (message: string) => void] {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((next: string) => {
    setMessage(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), 2600);
  }, []);
  return [message, show];
}

/** Hides the bottom bar after the pointer rests, like a video player. */
function useAutoHideHud(stageRef: React.RefObject<HTMLElement | null>, active: boolean, pinned = false): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const stage = stageRef.current;
    if (!active || !stage || pinned) {
      setHidden(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wake = () => {
      setHidden(false);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setHidden(true), 2500);
    };
    wake();
    stage.addEventListener("pointermove", wake);
    stage.addEventListener("pointerdown", wake);
    return () => {
      if (timer) clearTimeout(timer);
      stage.removeEventListener("pointermove", wake);
      stage.removeEventListener("pointerdown", wake);
    };
  }, [active, pinned, stageRef]);
  return hidden;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function ScreenIcon() {
  return (
    <svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true">
      <path
        fill="currentColor"
        d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5v2h3v2H6v-2h3v-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v10h16V6H4zm6 2.5 5 2.5-5 2.5v-5z"
      />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 5c-5 0-9 4.2-10.5 7 1.5 2.8 5.5 7 10.5 7s9-4.2 10.5-7C21 9.2 17 5 12 5zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"
      />
    </svg>
  );
}

function SwitchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M7 7h9V4l4 4-4 4V9H7V7zm10 10H8v3l-4-4 4-4v3h9v2z"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.7 7.7 0 0 0-1.7-1L15 3H9l-.3 2.9a7.7 7.7 0 0 0-1.7 1l-2.5-1-2 3.5L4.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.7 7.7 0 0 0 1.7 1L9 21h6l.3-2.9a7.7 7.7 0 0 0 1.7-1l2.5 1 2-3.5L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
      />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z" />
    </svg>
  );
}
