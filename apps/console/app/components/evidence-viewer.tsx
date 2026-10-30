"use client";
import { startTransition, useEffect, useState, useRef, type CSSProperties } from "react";
import {
  MagnifyingGlassPlus,
  DownloadSimple,
  Play,
  Pause,
  CaretLeft,
  CaretRight,
  ArrowCounterClockwise,
} from "@phosphor-icons/react";
import type { EvidenceView } from "../../../../dist/packages/contracts/src/review.js";
import { read, message } from "./api";
import { Tabs, Dialog, EmptyState, Notice, Loading, Status } from "./ui";
import s from "./workbench.module.css";
import {
  recordingTimeline,
  recordingTracks,
  runtimeFactSummaries,
  scenarioSteps,
  type ScenarioStepSummary,
  type DiagnosticChannelSummary,
  type RuntimeFactSummary,
} from "../../../../dist/packages/contracts/src/evidence-display.js";
import { counted } from "./result-display";
// Recording time as a player shows it: 0:03.2.
const clock = (ms: number) => {
  const minutes = Math.floor(ms / 60000);
  return `${minutes}:${((ms - minutes * 60000) / 1000).toFixed(1).padStart(4, "0")}`;
};
// A recorded moment in local time, to the millisecond: 9:25:08.514 AM.
const moment = (iso: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  }).format(new Date(iso));
const day = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
function takenAt(image: { startedAt: string | null; endedAt: string | null }) {
  if (!image.startedAt || !image.endedAt) return "Its time wasn’t recorded.";
  return day(image.startedAt) === day(image.endedAt)
    ? `It was taken on ${day(image.startedAt)}, between ${moment(image.startedAt)} and ${moment(image.endedAt)}.`
    : `It was taken between ${day(image.startedAt)}, ${moment(image.startedAt)} and ${day(image.endedAt)}, ${moment(image.endedAt)}.`;
}
// Each test player records its own view. A frame list names the player when there are several.
const playerName = (actor: string | null) => actor ?? "Unknown player";
export function EvidenceViewer({
  assetBase,
  item,
  passId,
  onPass,
  preferred = "images",
  showObservationNavigation = true,
  onDelivery,
}: {
  assetBase: string;
  item: EvidenceView;
  passId: string;
  onPass: (id: string) => void;
  preferred?: "images" | "observations" | "source";
  showObservationNavigation?: boolean;
  onDelivery?: (kind: "images" | "observations" | "source", id: string, delivered: boolean) => void;
}) {
  const [tab, setTab] = useState(preferred),
    [frame, setFrame] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    [heldFrames, setHeldFrames] = useState(0),
    [buffering, setBuffering] = useState(false),
    [source, setSource] = useState<string | null>(null),
    [sourceId, setSourceId] = useState(""),
    [sourceLoading, setSourceLoading] = useState(false),
    [error, setError] = useState(""),
    [zoom, setZoom] = useState(false),
    [dimensions, setDimensions] = useState(""),
    [compare, setCompare] = useState(""),
    [compareFrame, setCompareFrame] = useState(""),
    [sourceAttempt, setSourceAttempt] = useState(0),
    [imageAttempt, setImageAttempt] = useState(0),
    [copied, setCopied] = useState(false);
  const pass = item.passes.find((pass) => pass.id === passId);
  const sourceIdentity = item.sources.map((file) => file.id).join(":");
  const capture = pass?.images[frame];
  // Playback follows one test player at a time, so it never alternates between two views. The
  // track follows the frame on screen, so a link to a frame opens the view of its player.
  const tracks = recordingTracks(pass?.images ?? [], pass?.observations).map((actor) => ({
    actor,
    frames: recordingTimeline(pass?.images ?? [], pass?.observations, actor),
  }));
  const track =
    tracks.find((item) => item.frames.some((entry) => entry.index === frame)) ?? tracks[0];
  const recording = track?.frames ?? [];
  const recordingPosition = recording.findIndex((image) => image.index === frame);
  const recordedFrame = recording[recordingPosition];
  const original = useRef<HTMLImageElement>(null);
  // Frames ahead of the playhead are fetched once and held in memory, so playback does not
  // wait on every image. Evidence responses are never cached by the browser.
  const held = useRef({
    urls: new Map<string, string>(),
    loading: new Set<string>(),
    failed: new Set<string>(),
    controller: new AbortController(),
  });
  const delivery = useRef(onDelivery);
  delivery.current = onDelivery;
  useEffect(() => {
    if (tab === "observations" && pass)
      delivery.current?.(
        "observations",
        pass.id,
        !!pass.observations &&
          !(typeof pass.observations === "object" && "unavailable" in pass.observations),
      );
  }, [tab, pass?.id]);
  useEffect(() => {
    const restore = () => {
      const params = new URLSearchParams(window.location.search),
        view = params.get("view");
      const requestedFrame = Number(params.get("frame") ?? (recording[0]?.index ?? 0) + 1);
      setPlaying(false);
      setFrame(
        Number.isSafeInteger(requestedFrame)
          ? Math.max(0, Math.min((pass?.images.length ?? 1) - 1, requestedFrame - 1))
          : 0,
      );
      const selectedTab =
        !pass && item.sources.length
          ? "source"
          : view === "images" || view === "observations" || view === "source"
            ? view
            : preferred;
      setTab(selectedTab);
      const selectedSource = params.get("source");
      setSourceId(
        item.sources.some((source) => source.id === selectedSource)
          ? selectedSource!
          : selectedTab === "source"
            ? (item.sources[0]?.id ?? "")
            : "",
      );
      const comparison = item.passes.find(
        (candidate) => candidate.id === params.get("compare") && candidate.id !== pass?.id,
      );
      setCompare(comparison?.id ?? "");
      setCompareFrame(
        comparison?.images.some((image) => image.id === params.get("compareFrame"))
          ? params.get("compareFrame")!
          : "",
      );
    };
    restore();
    window.addEventListener("popstate", restore);
    setError("");
    const image = original.current;
    setDimensions(
      image?.complete && image.naturalWidth ? `${image.naturalWidth} × ${image.naturalHeight}` : "",
    );
    setCopied(false);
    return () => window.removeEventListener("popstate", restore);
  }, [item.id, passId, preferred, sourceIdentity]);
  function address(values: Record<string, string>, replace = false) {
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(values)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    window.history[replace ? "replaceState" : "pushState"](
      null,
      "",
      `${window.location.pathname}?${params}`,
    );
  }
  useEffect(() => {
    setSource(null);
    setCopied(false);
    setSourceLoading(false);
    setError("");
    if (!sourceId || tab !== "source") return;
    const controller = new AbortController();
    setSourceLoading(true);
    void read<{ text: string }>(
      `${assetBase}${assetBase.includes("?") ? "&" : "?"}item=${item.id}&source=${sourceId}`,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) {
          setSource(value.text);
          delivery.current?.("source", sourceId, true);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(message(cause));
          delivery.current?.("source", sourceId, false);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setSourceLoading(false);
      });
    return () => controller.abort();
  }, [assetBase, item.id, sourceId, tab, sourceAttempt]);
  const imageUrl = (id: string, image: string) =>
    `${assetBase}${assetBase.includes("?") ? "&" : "?"}item=${item.id}&pass=${id}&image=${image}`;
  useEffect(() => {
    const frames = held.current;
    return () => {
      frames.controller.abort();
      for (const url of frames.urls.values()) URL.revokeObjectURL(url);
      held.current = {
        urls: new Map(),
        loading: new Set(),
        failed: new Set(),
        controller: new AbortController(),
      };
    };
  }, [item.id, passId]);
  useEffect(() => {
    if (tab !== "images" || !pass || recordingPosition < 0) return;
    const frames = held.current;
    // Playing buffers further ahead; a paused player keeps only the next steps ready. A few
    // requests at a time leave room for the frame on screen.
    const ahead = playing ? 12 : 2,
      parallel = playing ? 3 : 1;
    for (const entry of recording.slice(recordingPosition + 1, recordingPosition + 1 + ahead)) {
      if (frames.loading.size >= parallel) break;
      // A frame that failed once is left to the image itself, which shows why; it is never
      // fetched again in a loop.
      if (frames.urls.has(entry.id) || frames.loading.has(entry.id) || frames.failed.has(entry.id))
        continue;
      frames.loading.add(entry.id);
      void fetch(imageUrl(pass.id, entry.id), { signal: frames.controller.signal })
        .then((response) => (response.ok ? response.blob() : null))
        .then((blob) => {
          if (frames.controller.signal.aborted) return;
          if (!blob) {
            frames.failed.add(entry.id);
            return;
          }
          frames.urls.set(entry.id, URL.createObjectURL(blob));
          // Hold at most 60 frames; the oldest go first, never the one on screen.
          for (const [id, url] of frames.urls) {
            if (frames.urls.size <= 60) break;
            if (id === capture?.id) continue;
            URL.revokeObjectURL(url);
            frames.urls.delete(id);
          }
        })
        .catch(() => {
          if (!frames.controller.signal.aborted) frames.failed.add(entry.id);
        })
        .finally(() => {
          frames.loading.delete(entry.id);
          if (!frames.controller.signal.aborted) setHeldFrames((count) => count + 1);
        });
    }
  }, [tab, pass?.id, recordingPosition, playing, heldFrames]);
  const atEnd = recording.length > 0 && recordingPosition === recording.length - 1;
  function togglePlay() {
    if (playing) {
      setPlaying(false);
      setBuffering(false);
      return;
    }
    // Play starts from the first recorded frame when stopped at the end or on a snapshot.
    if (recordingPosition < 0 || atEnd) {
      setFrame(recording[0]!.index);
      setDimensions("");
      address({ frame: String(recording[0]!.index + 1) }, true);
    }
    setPlaying(true);
  }
  // Another player's view opens at the same moment of play, and playback continues there.
  function chooseTrack(actor: string) {
    const frames = tracks.find((item) => (item.actor ?? "") === actor)?.frames ?? [];
    if (!frames.length) return;
    const at = recordedFrame?.start ?? frames[0]!.start;
    const nearest = frames.reduce((best, entry) =>
      Math.abs(entry.start - at) < Math.abs(best.start - at) ? entry : best,
    );
    setFrame(nearest.index);
    setDimensions("");
    address({ frame: String(nearest.index + 1) });
    setError("");
  }
  function chooseFrame(index: number) {
    setPlaying(false);
    setBuffering(false);
    setFrame(index);
    setDimensions("");
    address({ frame: String(index + 1) });
    setError("");
  }
  useEffect(() => {
    if (!playing || !dimensions || dimensions === "Unavailable") return;
    const next = recording[recordingPosition + 1];
    if (!next || !recordedFrame) {
      setPlaying(false);
      return;
    }
    // Like a video, playback waits for the next frame instead of skipping it, unless it could
    // not be fetched; then the image loads it directly and shows any failure.
    if (!held.current.urls.has(next.id) && !held.current.failed.has(next.id)) {
      setBuffering(true);
      return;
    }
    setBuffering(false);
    // Wait for each image to load. Acquisition gaps stay visible; this is sampled review, not video.
    const timer = setTimeout(
      () => {
        setFrame(next.index);
        setDimensions("");
        address({ frame: String(next.index + 1) }, true);
      },
      Math.max(100, (next.start - recordedFrame.start) / speed),
    );
    return () => clearTimeout(timer);
  }, [playing, frame, dimensions, passId, heldFrames, speed]);
  return (
    <section
      className={s.stack}
      style={{ minWidth: 0, gridTemplateColumns: "minmax(0, 1fr)" }}
      aria-label="Evidence viewer"
    >
      {showObservationNavigation && (item.passes.length > 1 || item.plannedPasses > 1) && (
        <div className={s.field} style={{ justifyItems: "start" }}>
          <label htmlFor="evidence-pass">Observation</label>
          <select
            id="evidence-pass"
            value={pass?.id ?? ""}
            aria-describedby="evidence-pass-count"
            onChange={(e) => onPass(e.target.value)}
          >
            {item.passes.map((pass) => (
              <option value={pass.id} key={pass.id}>
                Observation {pass.number}
              </option>
            ))}
          </select>
          <small id="evidence-pass-count">
            {item.passes.length} of {counted(item.plannedPasses, "observation")} available
          </small>
        </div>
      )}
      <Tabs label="Evidence views">
        {(["images", "observations", "source"] as const).map((value) => (
          <button
            key={value}
            aria-current={tab === value ? "page" : undefined}
            onClick={() => {
              setTab(value);
              address({ view: value });
              if (value === "source" && !sourceId) setSourceId(item.sources[0]?.id ?? "");
            }}
          >
            {value === "images"
              ? "Images"
              : value === "observations"
                ? "Recorded behavior"
                : "Code"}
          </button>
        ))}
      </Tabs>
      {error && (
        <Notice>
          {error}
          <button
            className={s.secondary}
            onClick={() => {
              setError("");
              if (tab === "source") setSourceAttempt((value) => value + 1);
              else setImageAttempt((value) => value + 1);
            }}
          >
            Reload {tab === "source" ? "code" : "image"}
          </button>
        </Notice>
      )}
      {tab === "images" ? (
        <>
          {capture && pass ? (
            <>
              {tracks.length > 1 && (
                <div className={s.field} style={{ justifyItems: "start" }}>
                  <label htmlFor="evidence-player">Test player</label>
                  <select
                    id="evidence-player"
                    value={track?.actor ?? ""}
                    aria-describedby="evidence-player-note"
                    onChange={(event) => chooseTrack(event.target.value)}
                  >
                    {tracks.map((item) => (
                      <option key={item.actor ?? ""} value={item.actor ?? ""}>
                        {playerName(item.actor)}
                      </option>
                    ))}
                  </select>
                  <small id="evidence-player-note">
                    Each test player recorded its own view. Playback shows one view at a time.
                  </small>
                </div>
              )}
              <div className={s.screen}>
                <div className={s.viewer}>
                  <button
                    className={s.viewerButton}
                    onClick={() => setZoom(true)}
                    disabled={!dimensions || dimensions === "Unavailable"}
                    aria-label="Zoom image"
                  >
                    <img
                      key={imageAttempt}
                      ref={original}
                      src={held.current.urls.get(capture.id) ?? imageUrl(pass.id, capture.id)}
                      alt={`Original image, observation ${pass.number}, frame ${frame + 1}`}
                      onLoad={(e) => {
                        setError("");
                        setDimensions(
                          `${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`,
                        );
                        delivery.current?.("images", capture.id, true);
                      }}
                      onError={() => {
                        setDimensions("Unavailable");
                        setPlaying(false);
                        delivery.current?.("images", capture.id, false);
                        setError(
                          "The browser could not load this image. The other evidence is still available.",
                        );
                      }}
                    />
                  </button>
                </div>
                {recording.length > 0 && (
                  <div
                    className={s.player}
                    role="group"
                    aria-label="Recording playback"
                    data-own-keys
                    onKeyDown={(event) => {
                      if (event.target instanceof HTMLInputElement) return;
                      if (event.target instanceof HTMLSelectElement) return;
                      if (event.key === "k") togglePlay();
                      else if (event.key === "ArrowLeft" && recordingPosition > 0)
                        chooseFrame(recording[recordingPosition - 1]!.index);
                      else if (event.key === "ArrowRight" && !atEnd)
                        chooseFrame(recording[Math.max(0, recordingPosition + 1)]!.index);
                      else return;
                      event.preventDefault();
                    }}
                  >
                    <button
                      className={s.playerButton}
                      onClick={togglePlay}
                      aria-label={
                        playing ? "Pause recording" : atEnd ? "Replay recording" : "Play recording"
                      }
                    >
                      {playing ? (
                        <Pause size={18} weight="fill" aria-hidden />
                      ) : atEnd ? (
                        <ArrowCounterClockwise size={18} weight="bold" aria-hidden />
                      ) : (
                        <Play size={18} weight="fill" aria-hidden />
                      )}
                    </button>
                    <button
                      className={s.playerButton}
                      disabled={recordingPosition <= 0}
                      onClick={() => chooseFrame(recording[recordingPosition - 1]!.index)}
                      aria-label="Previous frame"
                    >
                      <CaretLeft size={18} weight="bold" aria-hidden />
                    </button>
                    <button
                      className={s.playerButton}
                      disabled={atEnd}
                      onClick={() =>
                        chooseFrame(recording[Math.max(0, recordingPosition + 1)]!.index)
                      }
                      aria-label="Next frame"
                    >
                      <CaretRight size={18} weight="bold" aria-hidden />
                    </button>
                    <span className={s.playerTime}>
                      {recordedFrame ? clock(recordedFrame.elapsedMs) : "Snapshot"} /{" "}
                      {clock(recording.at(-1)!.elapsedMs)}
                    </span>
                    <input
                      className={s.scrubber}
                      type="range"
                      aria-label="Seek recording"
                      min={1}
                      max={recording.length}
                      value={Math.max(1, recordingPosition + 1)}
                      style={
                        {
                          "--progress": `${recording.length > 1 ? (100 * Math.max(0, recordingPosition)) / (recording.length - 1) : 100}%`,
                        } as CSSProperties
                      }
                      aria-valuetext={
                        recordedFrame
                          ? `Frame ${recordingPosition + 1} of ${recording.length}, ${(recordedFrame.elapsedMs / 1000).toFixed(1)} seconds`
                          : "Separate snapshot"
                      }
                      onChange={(event) =>
                        chooseFrame(recording[Number(event.target.value) - 1]!.index)
                      }
                    />
                    <span className={s.playerFrame}>
                      {playing && buffering
                        ? "Loading next frame…"
                        : `Frame ${recordingPosition < 0 ? "—" : recordingPosition + 1} of ${recording.length}`}
                    </span>
                    <select
                      className={s.playerSpeed}
                      aria-label="Playback speed"
                      value={speed}
                      onChange={(event) => setSpeed(Number(event.target.value))}
                    >
                      {[0.5, 1, 2, 4, 8].map((value) => (
                        <option key={value} value={value}>
                          {value}×
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div className={s.row}>
                <span className={s.small}>
                  {dimensions === "Unavailable"
                    ? "Size unknown"
                    : dimensions
                      ? `${dimensions} · Original size`
                      : "Loading size…"}
                </span>
                <button
                  className={s.textButton}
                  disabled={!dimensions || dimensions === "Unavailable"}
                  onClick={() => setZoom(true)}
                >
                  <MagnifyingGlassPlus size={17} aria-hidden />
                  Zoom
                </button>
                <a
                  className={s.textButton}
                  href={imageUrl(pass.id, capture.id)}
                  download={`observation-${pass.number}-frame-${frame + 1}.png`}
                >
                  <DownloadSimple size={17} aria-hidden />
                  Download image
                </a>
              </div>
              <p className={s.small}>
                {recording.length > 0
                  ? "Playback shows still images at their recorded times. It isn’t continuous video, so nothing between two images is recorded."
                  : "These are still images, not real-time video."}
              </p>
              <details>
                <summary>Recording details</summary>
                <p className={s.small} data-recording-details>
                  {recordedFrame ? "Gameplay recording" : "Separate snapshot"} · {capture.label}
                  {capture.actor && ` · ${capture.actor}’s view`}. {takenAt(capture)}
                  {recordedFrame &&
                    ` It is ${(recordedFrame.elapsedMs / 1000).toFixed(3)}s after the start of play and ${recordedFrame.gapMs}ms after the previous image of this view.`}
                </p>
                <p className={s.small}>
                  Image times are approximate. Separate snapshots come from their own session and
                  aren’t part of playback.
                </p>
                {recordedFrame && pass.clock !== undefined && (
                  <p className={s.small} data-clock>
                    {pass.clock
                      ? `Events use the Studio clock, and images use the clock of the recording computer. Basalt lines them up to within ±${milliseconds(pass.clock.uncertaintyMs)}, with an offset of ${pass.clock.offsetMs < 0 ? "−" : "+"}${milliseconds(Math.abs(pass.clock.offsetMs))}.`
                      : "Basalt couldn’t line up the Studio clock with the images, so events have no place on the recording."}
                  </p>
                )}
                {recordedFrame && pass.frameBudget !== undefined && (
                  <p className={s.small} data-frame-budget>
                    A judge check gets at most {counted(pass.frameBudget, "image")} of this
                    recording. Playback shows every recorded image.
                  </p>
                )}
                <p className={s.small}>
                  Playback shows each image for at least 0.1 seconds, so it can run slower than the
                  game. Check the times before you decide how fast the game was.
                </p>
                {pass.events?.length ? (
                  <label className={s.field}>
                    Jump to an event
                    <select
                      value=""
                      onChange={(event) => {
                        if (event.target.value) chooseFrame(Number(event.target.value));
                      }}
                    >
                      <option value="">Choose an event</option>
                      {pass.events.map((event) => {
                        const at = Date.parse(event.at);
                        const captured =
                          recording.length &&
                          at >= recording[0]!.start &&
                          at <= recording.at(-1)!.end;
                        const nearest = captured
                          ? recording.reduce((best, frame) =>
                              Math.abs(frame.start - at) < Math.abs(best.start - at) ? frame : best,
                            )
                          : null;
                        return (
                          <option
                            key={`${event.id}:${event.at}`}
                            value={nearest?.index ?? ""}
                            disabled={!nearest}
                          >
                            {event.id} ·{" "}
                            {nearest
                              ? `nearest sample ${Math.abs(nearest.start - at)}ms away`
                              : "outside recorded time"}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                ) : null}
                <label className={s.field}>
                  Choose image
                  <select
                    value={frame}
                    onChange={(event) => chooseFrame(Number(event.target.value))}
                  >
                    <optgroup label="Separate snapshots">
                      {pass.images.map((image, index) =>
                        tracks.some((item) =>
                          item.frames.some((entry) => entry.index === index),
                        ) ? null : (
                          <option key={image.id} value={index}>
                            {image.label} · Context image {index + 1}
                          </option>
                        ),
                      )}
                    </optgroup>
                    {tracks.map((item) => (
                      <optgroup
                        key={item.actor ?? ""}
                        label={
                          tracks.length > 1
                            ? `Gameplay recording · ${playerName(item.actor)}`
                            : "Gameplay recording"
                        }
                      >
                        {item.frames.map((entry, index) => (
                          <option key={entry.id} value={entry.index}>
                            Frame {index + 1} · {(entry.elapsedMs / 1000).toFixed(3)}s
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
              </details>
              <Dialog
                open={zoom}
                onClose={() => setZoom(false)}
                title={`Full size · ${dimensions}`}
              >
                <div
                  style={{ overflow: "auto", maxHeight: "70vh" }}
                  tabIndex={0}
                  role="region"
                  data-own-keys
                  aria-label="Full-size image. Use the arrow keys to scroll."
                >
                  {zoom && (
                    <DeliveredImage
                      url={imageUrl(pass.id, capture.id)}
                      alt={`Original image, observation ${pass.number}, frame ${frame + 1}`}
                      originalSize
                    />
                  )}
                </div>
                <p className={s.small}>Scroll to see the full-size image.</p>
              </Dialog>
            </>
          ) : (
            <EmptyState title="No images in this observation">
              Look at the code and recorded behavior instead. A missing image doesn’t mean a
              criterion is met.
            </EmptyState>
          )}
          {showObservationNavigation && item.passes.length > 1 && (
            <details>
              <summary>Compare another observation</summary>
              <div className={s.field}>
                <label htmlFor="comparison-pass">Observation to compare</label>
                <select
                  id="comparison-pass"
                  value={compare}
                  onChange={(e) => {
                    setCompare(e.target.value);
                    setCompareFrame("");
                    address({ compare: e.target.value, compareFrame: "" });
                  }}
                >
                  <option value="">Choose an observation</option>
                  {item.passes
                    .filter((other) => other.id !== pass?.id)
                    .map((other) => (
                      <option key={other.id} value={other.id}>
                        Observation {other.number}
                      </option>
                    ))}
                </select>
                {(() => {
                  const other = item.passes.find((p) => p.id === compare);
                  const image = other?.images.find((image) => image.id === compareFrame);
                  return other ? (
                    <>
                      <p className={s.small}>
                        Choose the frame yourself. The same frame number can show a different moment
                        in the game.
                      </p>
                      <label htmlFor="comparison-frame">Frame to compare</label>
                      <select
                        id="comparison-frame"
                        value={compareFrame}
                        onChange={(e) => {
                          setCompareFrame(e.target.value);
                          address({ compareFrame: e.target.value });
                        }}
                      >
                        <option value="">Choose a frame</option>
                        {other.images.map((image, index) => (
                          <option key={image.id} value={image.id}>
                            {image.label}
                            {image.actor && ` · ${image.actor}`} · Frame {index + 1} ·{" "}
                            {image.startedAt ? moment(image.startedAt) : "No time"}
                          </option>
                        ))}
                      </select>
                      {image && (
                        <div className={s.viewer}>
                          <DeliveredImage
                            key={image.id}
                            url={imageUrl(other.id, image.id)}
                            alt={`Observation ${other.number} for comparison, ${image.label}`}
                          />
                        </div>
                      )}
                    </>
                  ) : compare ? (
                    <p className={s.small}>This observation has no matching frame.</p>
                  ) : null;
                })()}
              </div>
            </details>
          )}
        </>
      ) : tab === "observations" ? (
        <div style={{ minWidth: 0 }}>
          <h3>What happened during play</h3>
          <p className={s.small}>This view shows the exact recorded times and values.</p>
          <ScenarioSteps observations={pass?.observations} plan={pass?.scenarioPlan} />
          <RuntimeFacts value={pass?.observations} />
          <details>
            <summary>Raw data</summary>
            <pre className={s.code}>{JSON.stringify(pass?.observations ?? {}, null, 2)}</pre>
          </details>
        </div>
      ) : (
        <div className={s.stack}>
          <div className={s.field}>
            <label htmlFor="evidence-source">Source file</label>
            <select
              id="evidence-source"
              value={sourceId}
              onChange={(e) => {
                setSourceId(e.target.value);
                setSource(null);
                address({ source: e.target.value });
              }}
            >
              <option value="">Choose a source file</option>
              {item.sources.map((file) => (
                <option key={file.id} value={file.id}>
                  {file.path}
                </option>
              ))}
            </select>
          </div>
          {sourceLoading ? (
            <Loading label="Loading code" />
          ) : !item.sources.length ? (
            <EmptyState title="No code files">
              Images and recorded behavior are in the other views.
            </EmptyState>
          ) : source !== null ? (
            source.length === 0 ? (
              <p role="status">This file is empty.</p>
            ) : (
              <>
                <button
                  className={s.secondary}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(source)
                      .then(() => setCopied(true))
                      .catch(() =>
                        setError(
                          "The browser couldn’t copy the code. Select it below and copy it yourself.",
                        ),
                      );
                  }}
                >
                  {copied ? "Code copied" : "Copy code"}
                </button>
                <pre className={s.code} tabIndex={0} aria-label="Code" data-own-keys>
                  {source}
                </pre>
              </>
            )
          ) : sourceId && !error ? (
            <p>The code did not load.</p>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function DeliveredImage({
  url,
  alt,
  originalSize = false,
  lazy = false,
}: {
  url: string;
  alt: string;
  originalSize?: boolean;
  /** A long list of images loads each image only when it comes near the screen. */
  lazy?: boolean;
}) {
  const [state, setState] = useState("loading"),
    [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    request.current++;
    setState("loading");
    return () => {
      request.current++;
    };
  }, [url, attempt]);
  return (
    <>
      {/* A list of lazy images would announce one loading status for each image. */}
      {state === "loading" && !lazy && <Loading label="Loading image" />}
      {state === "failed" && (
        <Notice>
          The browser could not load or decode this image.{" "}
          <button
            className={s.secondary}
            onClick={() => {
              setState("loading");
              setAttempt(attempt + 1);
            }}
          >
            Retry image
          </button>
        </Notice>
      )}
      <img
        key={`${url}:${attempt}`}
        src={url}
        alt={alt}
        loading={lazy ? "lazy" : undefined}
        style={{
          ...(originalSize ? { maxWidth: "none" } : {}),
          ...(state === "failed" ? { display: "none" } : {}),
        }}
        onLoad={(event) => {
          const image = event.currentTarget;
          const ticket = request.current;
          // A decode finishing mid-typing is background work; it must not hold up keystrokes.
          void image
            .decode()
            .then(() => {
              if (ticket === request.current) startTransition(() => setState("ready"));
            })
            .catch(() => {
              if (ticket === request.current) startTransition(() => setState("failed"));
            });
        }}
        onError={() => {
          request.current++;
          setState("failed");
        }}
      />
    </>
  );
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(3)} s`;
const milliseconds = (ms: number) =>
  `${ms.toLocaleString("en-US", { maximumFractionDigits: 1 })} ms`;
// Only a time bound in the rubric makes a step that was not seen a failure, and a code check
// gives that answer. So neither of these outcomes uses the red mark of a failed check.
const stepOutcomes: Record<
  ScenarioStepSummary["outcome"],
  { label: string; tone: "neutral" | "warning"; note: string | null }
> = {
  observed: { label: "Observed", tone: "neutral", note: null },
  not_observed_within_horizon: {
    label: "Not seen in time",
    tone: "warning",
    note: "Studio didn’t see the start of this step within its time window, so the step didn’t act or capture anything. On its own, this isn’t a failure.",
  },
  acquisition_failed: {
    label: "Couldn’t read",
    tone: "neutral",
    note: "Studio couldn’t check the start of this step, or didn’t get its schedule. This step is incomplete.",
  },
};

/** Every step of each scenario, also a step that Studio did not see in time and so recorded no fact. */
function ScenarioSteps({
  observations,
  plan,
}: {
  observations: unknown;
  plan: Parameters<typeof scenarioSteps>[1];
}) {
  const scenarios = scenarioSteps(observations, plan);
  if (!scenarios.some((scenario) => scenario.steps.length)) return null;
  return (
    <section className={s.scenarioSteps} aria-labelledby="scenario-steps">
      <h4 id="scenario-steps">Scenario steps</h4>
      <p className={s.small}>Times are seconds after the scenario started, on the Studio clock.</p>
      {scenarios.map((scenario) => (
        <section key={`${scenario.scenarioId}:${scenario.context}`}>
          <h5>
            {scenario.label ?? "Scenario"} · {scenario.context}
          </h5>
          <ol className={s.stepList}>
            {scenario.steps.map((step) => {
              const outcome = stepOutcomes[step.outcome];
              return (
                <li key={step.id} data-step-outcome={step.outcome}>
                  <div className={s.stepHead}>
                    <strong>{step.id.replaceAll("-", " ")}</strong>
                    <Status tone={outcome.tone}>{outcome.label}</Status>
                  </div>
                  {outcome.note && <p className={s.small}>{outcome.note}</p>}
                  <dl className={s.factGrid}>
                    <div>
                      <dt>Started looking</dt>
                      <dd>{seconds(step.dueMs)}</dd>
                    </div>
                    {step.horizonMs !== null && (
                      <div>
                        <dt>Time window</dt>
                        <dd>{seconds(step.horizonMs)}</dd>
                      </div>
                    )}
                    {step.anchorMs !== null && (
                      <div>
                        <dt>Start seen</dt>
                        <dd>
                          {seconds(step.anchorMs)}
                          {step.pollIntervalMs !== null && `, ±${step.pollIntervalMs} ms`}
                          {step.anchorPreexisting && ", already true at the first look"}
                        </dd>
                      </div>
                    )}
                    {step.action && (
                      <div>
                        <dt>Action</dt>
                        <dd>
                          {step.action.kind.replaceAll("_", " ")} ·{" "}
                          {step.action.succeeded ? "started" : "didn’t start"}
                          {step.actedMs !== null && ` at ${seconds(step.actedMs)}`}
                        </dd>
                      </div>
                    )}
                    {step.capturedMs !== null && (
                      <div>
                        <dt>Captured</dt>
                        <dd>{seconds(step.capturedMs)}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Facts recorded</dt>
                      <dd>{step.facts}</dd>
                    </div>
                  </dl>
                  {step.requirement && (
                    <p className={s.stepRequirement}>
                      {/* A quote that ends in a stop gets no second stop. */}
                      {`The rubric asks for this within ${seconds(step.requirement.withinMs)}: “${step.requirement.quote}”${/[.!?]$/u.test(step.requirement.quote) ? "" : "."} A code check gives that answer.`}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </section>
  );
}

function RuntimeFacts({ value }: { value: unknown }) {
  const facts = runtimeFactSummaries(value);
  return facts.length ? (
    <div className={s.stack} style={{ minWidth: 0, gridTemplateColumns: "minmax(0, 1fr)" }}>
      <p className={s.small}>
        {facts.length} recorded facts. These measurements describe what happened. A signature or a
        trace doesn’t prove that the mechanic is correct.
      </p>
      <ul className={s.runtimeFacts}>
        {facts.map((fact, index) => (
          <li key={index} data-runtime-fact>
            <div className={s.factHead}>
              <h4>{fact.name.replaceAll("-", " ")}</h4>
              <span className={s.small}>{fact.context}</span>
            </div>
            {fact.entries.length > 0 && (
              <dl className={s.factGrid}>
                {fact.entries.map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {fact.diagnostics && <DiagnosticChannels channels={fact.diagnostics} />}
            {fact.trace && <RuntimeTrace trace={fact.trace} factId={fact.name} />}
          </li>
        ))}
      </ul>
    </div>
  ) : (
    <p className={s.small}>This observation has no measurements.</p>
  );
}

const channelNames: Record<DiagnosticChannelSummary["channel"], string> = {
  messages: "Errors in Output",
  scriptErrors: "Script errors",
};
/** Recorded errors, identical ones counted together, with each script error's source and stack. */
function DiagnosticChannels({ channels }: { channels: DiagnosticChannelSummary[] }) {
  return (
    <div className={s.diagnosticChannels}>
      {channels.every((channel) => channel.kept > 0) && (
        <p className={s.small}>
          The same error can appear in both lists, so their counts aren’t added together.
        </p>
      )}
      {channels.map((channel) => (
        <section key={channel.channel}>
          <h5>{channelNames[channel.channel]}</h5>
          <p className={s.small}>
            {!channel.kept
              ? "None recorded."
              : `${channel.kept} recorded` +
                (channel.groups.length < channel.kept
                  ? `, ${channel.groups.length} different ${channel.groups.length === 1 ? "message" : "messages"}`
                  : "") +
                "." +
                (channel.full ? " The list is full, so later errors aren’t included." : "")}
          </p>
          {channel.groups.length > 0 && (
            <ul className={s.errorGroups}>
              {channel.groups.map((group, index) => (
                <li key={index}>
                  <span className={s.errorCount}>{group.count}×</span>
                  <div>
                    <code>{group.message}</code>
                    {channel.channel === "scriptErrors" && (
                      <span className={s.tableMeta}>{group.source ?? "Source not recorded"}</span>
                    )}
                    {group.stackTrace && (
                      <details>
                        <summary>Stack trace</summary>
                        <pre className={s.code}>{group.stackTrace}</pre>
                      </details>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function RuntimeTrace({
  trace,
  factId,
}: {
  trace: NonNullable<RuntimeFactSummary["trace"]>;
  factId: string;
}) {
  const [all, setAll] = useState(false),
    [page, setPage] = useState(0);
  const indices = all
    ? Array.from({ length: trace.samples.length }, (_, index) => index).slice(
        page * 20,
        page * 20 + 20,
      )
    : trace.highlighted;
  return (
    <section aria-label={`Measured timeline for ${factId}`}>
      <p className={s.small}>
        {trace.samples.length} samples · observed span {trace.durationMs}ms · largest sample gap{" "}
        {trace.maxGapMs}ms. Coordinates are in studs, and times are relative to this fact’s
        observation window.
      </p>
      <p className={s.small}>
        This table shows the first and last readings and the largest changes. Use them to find
        moments worth examining. They aren’t pass or fail results.
      </p>
      <div
        style={{ overflowX: "auto", maxWidth: "100%" }}
        tabIndex={0}
        role="region"
        data-own-keys
        aria-label={`Scrollable measurement table for ${factId}`}
      >
        <table>
          <caption>{factId} · original sample indices and values</caption>
          <thead>
            <tr>
              <th scope="col">Sample</th>
              {trace.columns.map((key) => (
                <th scope="col" key={key}>
                  {key === "elapsedMs"
                    ? "Elapsed (ms)"
                    : key === "x"
                      ? "Target x"
                      : key.replace(/([A-Z])/g, " $1")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {indices.map((index) => (
              <tr key={index}>
                <th scope="row">{index + 1}</th>
                {trace.columns.map((key) => (
                  <td key={key} title={String(trace.samples[index]![key])}>
                    {trace.samples[index]![key]!.toFixed(key === "elapsedMs" ? 0 : 3)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        className={s.secondary}
        onClick={() => {
          setAll(!all);
          setPage(0);
        }}
      >
        {all ? "Show key readings only" : "Show every reading"}
      </button>
      {all && (
        <div className={s.row}>
          <button className={s.secondary} disabled={page === 0} onClick={() => setPage(page - 1)}>
            Previous readings
          </button>
          <span>
            Sample page {page + 1} of {Math.ceil(trace.samples.length / 20)}
          </span>
          <button
            className={s.secondary}
            disabled={(page + 1) * 20 >= trace.samples.length}
            onClick={() => setPage(page + 1)}
          >
            Next readings
          </button>
        </div>
      )}
    </section>
  );
}
