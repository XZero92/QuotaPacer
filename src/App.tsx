import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  CliInfo,
  PaceViewState,
  PaceWindowView,
  UsageViewState,
  UsageWindow,
} from "./types";
import {
  featuredWindow,
  formatResetTime,
  formatWindowDuration,
  INITIAL_USAGE_STATE,
  sortedWindows,
  staleLabel,
  usageTone,
} from "./usage";
import "./App.css";

type OverlaySize = "small" | "middle" | "large";
const INITIAL_PACE_STATE: PaceViewState = { windows: [], updatedAt: null };

function isOverlaySize(value: unknown): value is OverlaySize {
  return value === "small" || value === "middle" || value === "large";
}

function errorTitle(connection: UsageViewState["connection"]) {
  switch (connection) {
    case "cli_missing":
      return "Codex CLI가 필요합니다";
    case "cli_unsupported":
      return "Codex CLI를 업데이트해 주세요";
    case "login_required":
      return "Codex 로그인이 필요합니다";
    case "unsupported_auth":
      return "ChatGPT 로그인이 필요합니다";
    case "error":
      return "사용량을 불러오지 못했습니다";
    default:
      return "Codex 사용량";
  }
}

function windowLabel(window: UsageWindow) {
  const duration = formatWindowDuration(window.windowDurationMins);
  return window.bucketLabel ? `${duration} · ${window.bucketLabel}` : duration;
}

function WindowHeadingLabel({ window }: { window: UsageWindow }) {
  return (
    <strong className="window-label">
      <span className="brand-label">Codex</span>
      <span className="label-separator" aria-hidden="true">
        ·
      </span>
      <span>{windowLabel(window)}</span>
    </strong>
  );
}

function EmptySurface({
  usage,
  compact = false,
}: {
  usage: UsageViewState;
  compact?: boolean;
}) {
  const title =
    usage.connection === "starting"
      ? "사용량 확인 중"
      : usage.connection === "no_limits"
        ? "사용량 한도 없음"
        : errorTitle(usage.connection);

  if (compact) {
    return (
      <div className="small-card is-empty" aria-label={title}>
        <div className="small-ring" aria-hidden="true">
          <strong>—</strong>
        </div>
        <div className="small-copy">
          <strong>Codex</strong>
          <small>
            {usage.connection === "starting" ? "확인 중" : "상태 확인"}
          </small>
        </div>
      </div>
    );
  }

  return (
    <div className="empty-surface">
      <strong>
        <span className="brand-label">Codex</span>
        <span aria-hidden="true"> · </span>
        <span>{title}</span>
      </strong>
      <small>{usage.errorMessage ?? "Codex 계정 상태를 확인합니다"}</small>
    </div>
  );
}

function SmallOverlay({
  usage,
  featured,
}: {
  usage: UsageViewState;
  featured: UsageWindow | null;
}) {
  if (!featured) return <EmptySurface usage={usage} compact />;

  return (
    <div
      className={`small-card tone-${usageTone(featured.remainingPercent)} ${
        usage.connection === "stale" ? "is-stale" : ""
      }`}
      aria-label={`Codex · ${windowLabel(featured)} 제한 ${featured.remainingPercent}% 남음`}
    >
      <div
        className="small-ring"
        style={
          {
            "--remaining": featured.remainingPercent,
          } as React.CSSProperties
        }
        aria-label={`${featured.remainingPercent}% 남음 원형 게이지`}
      >
        <strong>{featured.remainingPercent}%</strong>
      </div>
      <div className="small-copy">
        <strong>Codex</strong>
        <small>
          {formatWindowDuration(featured.windowDurationMins)}
          {usage.connection === "stale" ? " · 지연" : ""}
        </small>
      </div>
      {usage.connection === "stale" && (
        <i className="stale-dot" aria-hidden="true" />
      )}
    </div>
  );
}

function MiddleOverlay({
  usage,
  featured,
}: {
  usage: UsageViewState;
  featured: UsageWindow | null;
}) {
  if (!featured) return <EmptySurface usage={usage} />;

  return (
    <div className="middle-card">
      <div className="middle-heading">
        <WindowHeadingLabel window={featured} />
        <span className={`tone-text-${usageTone(featured.remainingPercent)}`}>
          {featured.remainingPercent}% 남음
        </span>
      </div>
      <div
        className="usage-meter"
        aria-label={`${featured.remainingPercent}% 남음`}
      >
        <span
          className={`tone-${usageTone(featured.remainingPercent)}`}
          style={{ width: `${featured.remainingPercent}%` }}
        />
      </div>
      <small>
        {usage.connection === "stale"
          ? staleLabel(usage.lastSuccessfulAt)
          : `${formatResetTime(featured.resetsAt)} 리셋`}
      </small>
    </div>
  );
}

function paceVerdict(pace: PaceWindowView | undefined) {
  if (!pace || pace.status === "unavailable") return "예측 준비 중";
  if (pace.status === "exhaustionRisk") return "초기화 전 소진 예상";
  return "초기화까지 충분";
}

function forecastBasisLabel(pace: PaceWindowView | undefined) {
  if (!pace || pace.forecastBasis === "unavailable") return "관측 대기";
  if (pace.forecastBasis === "recent") {
    return `최근 ${Math.round((pace.observedHours ?? 0) * 10) / 10}시간`;
  }
  return pace.earlyEstimate ? "기간 평균 · 초기 추정" : "기간 평균";
}

function forecastLabel(pace: PaceWindowView | undefined) {
  if (!pace || pace.forecastBasis === "unavailable") {
    return "사용 기록이 쌓이면 예측합니다";
  }
  if (pace.projectedExhaustionAt !== null) {
    return `${formatResetTime(pace.projectedExhaustionAt)} 소진 예상`;
  }
  if (pace.projectedEndPercent !== null) {
    return `초기화 시 ${Math.round(pace.projectedEndPercent)}% 사용 예상`;
  }
  return "소진 시각을 계산할 수 없습니다";
}

function planLabel(pace: PaceWindowView | undefined) {
  if (!pace || pace.planDeltaPercentPoints === null) return "권장선 계산 불가";
  const delta = Math.round(pace.planDeltaPercentPoints);
  if (delta > 0) return `계획보다 ${delta}%p 초과`;
  if (delta < 0) return `${Math.abs(delta)}%p 여유`;
  return "현재 권장과 동일";
}

function PaceRow({
  window,
  pace,
}: {
  window: UsageWindow;
  pace: PaceWindowView | undefined;
}) {
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  const plannedPercent =
    pace?.plannedUsedPercent === null || pace?.plannedUsedPercent === undefined
      ? null
      : Math.max(0, Math.min(100, pace.plannedUsedPercent));
  const status = pace?.status ?? "unavailable";

  return (
    <article className={`pace-row status-${status}`}>
      <div className="pace-heading">
        <strong className="window-label">{windowLabel(window)}</strong>
        <span className={`tone-text-${usageTone(window.remainingPercent)}`}>
          {window.remainingPercent}% 남음
        </span>
      </div>
      <strong className="pace-verdict">{paceVerdict(pace)}</strong>
      <div className="pace-forecast">
        <span>{forecastLabel(pace)}</span>
        <i>{forecastBasisLabel(pace)}</i>
      </div>
      <div
        className="pace-progress"
        aria-label={`${Math.round(usedPercent)}% 사용, 현재 권장 ${
          plannedPercent === null ? "계산 불가" : `${Math.round(plannedPercent)}%`
        }`}
      >
        <span style={{ width: `${usedPercent}%` }} />
        {plannedPercent !== null && (
          <>
            <i style={{ left: `${plannedPercent}%` }} aria-hidden="true" />
            <b style={{ left: `${plannedPercent}%` }}>현재 권장</b>
          </>
        )}
      </div>
      <div className="pace-footer">
        <span>{planLabel(pace)}</span>
        <small>{formatResetTime(window.resetsAt)} 초기화</small>
      </div>
    </article>
  );
}

function LargeOverlay({
  usage,
  pace,
}: {
  usage: UsageViewState;
  pace: PaceViewState;
}) {
  const windows = useMemo(() => sortedWindows(usage.windows), [usage.windows]);
  const paceByWindow = useMemo(
    () => new Map(pace.windows.map((window) => [window.windowId, window])),
    [pace.windows],
  );
  if (windows.length === 0) return <EmptySurface usage={usage} />;

  return (
    <div
      className={`pace-list ${usage.connection === "stale" ? "is-stale" : ""}`}
      role="region"
      aria-label="Codex 페이스 예측"
    >
      <header className="pace-list-header">
        <strong>Codex Pace</strong>
        <small>
          {usage.connection === "stale"
            ? staleLabel(usage.lastSuccessfulAt)
            : "최신 사용량"}
        </small>
      </header>
      <div className="pace-rows">
        {windows.map((window) => (
          <PaceRow
            key={window.id}
            window={window}
            pace={paceByWindow.get(window.id)}
          />
        ))}
      </div>
    </div>
  );
}

function App() {
  const [usage, setUsage] = useState<UsageViewState>(INITIAL_USAGE_STATE);
  const [pace, setPace] = useState<PaceViewState>(INITIAL_PACE_STATE);
  const [sizeMode, setSizeMode] = useState<OverlaySize>("middle");
  const [sizeReady, setSizeReady] = useState(false);
  const draggingRef = useRef(false);

  const startDragging = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      draggingRef.current = true;
      void getCurrentWindow()
        .startDragging()
        .catch(() => undefined)
        .finally(() => {
          window.setTimeout(() => {
            draggingRef.current = false;
          }, 250);
        });
    },
    [],
  );
  const chooseCli = useCallback(async () => {
    const path = await open({
      multiple: false,
      directory: false,
      title: "Codex CLI 실행 파일 선택",
      filters: [
        { name: "Codex CLI", extensions: ["exe", "cmd", "bat", "ps1"] },
      ],
    });
    if (typeof path !== "string") return;
    await invoke<CliInfo>("set_codex_executable", { path });
  }, []);
  const showContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      if (draggingRef.current) return;
      void invoke("show_overlay_context_menu");
    },
    [],
  );

  useEffect(() => {
    void invoke<UsageViewState>("get_usage_state").then(setUsage);
    void invoke<PaceViewState>("get_pace_state").then(setPace);
    void invoke<OverlaySize>("get_overlay_size")
      .then((size) => {
        if (isOverlaySize(size)) setSizeMode(size);
      })
      .finally(() => setSizeReady(true));
    const unlistenUsage = listen<UsageViewState>(
      "usage://state-changed",
      (event) => setUsage(event.payload),
    );
    const unlistenOverlaySize = listen<OverlaySize>(
      "ui://overlay-size-changed",
      (event) => {
        if (isOverlaySize(event.payload)) setSizeMode(event.payload);
      },
    );
    const unlistenPace = listen<PaceViewState>(
      "pace://state-changed",
      (event) => setPace(event.payload),
    );
    const unlistenPickCli = listen("usage://pick-cli", () => void chooseCli());
    return () => {
      void unlistenUsage.then((unlisten) => unlisten());
      void unlistenOverlaySize.then((unlisten) => unlisten());
      void unlistenPace.then((unlisten) => unlisten());
      void unlistenPickCli.then((unlisten) => unlisten());
    };
  }, [chooseCli]);

  useEffect(() => {
    if (!sizeReady) return;
    void invoke("set_overlay_layout", {
      size: sizeMode,
      windowCount: usage.windows.length,
    });
  }, [sizeMode, sizeReady, usage.windows.length]);

  const featured = featuredWindow(usage);

  return (
    <main
      className={`overlay size-${sizeMode} ${sizeReady ? "is-size-ready" : ""}`}
      data-tauri-drag-region
      onPointerDown={startDragging}
      onContextMenu={showContextMenu}
      title="드래그하여 이동 · 우클릭하여 메뉴 열기"
    >
      {sizeMode === "small" ? (
        <SmallOverlay usage={usage} featured={featured} />
      ) : sizeMode === "middle" ? (
        <MiddleOverlay usage={usage} featured={featured} />
      ) : (
        <LargeOverlay usage={usage} pace={pace} />
      )}
    </main>
  );
}

export default App;
