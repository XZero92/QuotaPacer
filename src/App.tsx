import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import type { CliInfo, UsageViewState } from "./types";
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

function App() {
  const [usage, setUsage] = useState<UsageViewState>(INITIAL_USAGE_STATE);
  const [expanded, setExpanded] = useState(false);
  const [cliInfo, setCliInfo] = useState<CliInfo | null>(null);
  const draggingRef = useRef(false);

  const collapse = useCallback(() => setExpanded(false), []);
  const collapseUnlessDragging = useCallback(() => {
    if (!draggingRef.current) collapse();
  }, [collapse]);
  const startDragging = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (event.button !== 0 || target.closest(".expand-button")) return;
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
    const info = await invoke<CliInfo>("set_codex_executable", { path });
    setCliInfo(info);
  }, []);

  useEffect(() => {
    void invoke<UsageViewState>("get_usage_state").then(setUsage);
    const unlistenUsage = listen<UsageViewState>(
      "usage://state-changed",
      (event) => setUsage(event.payload),
    );
    const unlistenCollapse = listen("ui://collapse", collapseUnlessDragging);
    const unlistenPickCli = listen("usage://pick-cli", () => void chooseCli());
    return () => {
      void unlistenUsage.then((unlisten) => unlisten());
      void unlistenCollapse.then((unlisten) => unlisten());
      void unlistenPickCli.then((unlisten) => unlisten());
    };
  }, [chooseCli, collapseUnlessDragging]);

  useEffect(() => {
    const height = expanded
      ? Math.min(420, Math.max(200, 176 + usage.windows.length * 54))
      : 48;
    void invoke("set_overlay_expanded", { expanded, height });
  }, [expanded, usage.windows.length]);

  const windows = useMemo(() => sortedWindows(usage.windows), [usage.windows]);
  const featured = featuredWindow(usage);
  const canPickCli = ["cli_missing", "cli_unsupported"].includes(
    usage.connection,
  );

  return (
    <main className={`overlay ${expanded ? "is-expanded" : ""}`}>
      <div
        className="capsule"
        data-tauri-drag-region
        onPointerDown={startDragging}
      >
        <span
          className="drag-handle"
          data-tauri-drag-region
          aria-hidden="true"
        />
        {featured ? (
          <>
            <span
              className={`usage-ring tone-${usageTone(featured.remainingPercent)}`}
              style={
                {
                  "--remaining": featured.remainingPercent,
                } as React.CSSProperties
              }
              aria-hidden="true"
            >
              <span>{featured.remainingPercent}</span>
            </span>
            <span className="capsule-copy">
              <strong className="capsule-title">
                <span className="codex-label">CODEX</span>
                <span className="capsule-title-separator" aria-hidden="true">
                  ·
                </span>
                <span className="capsule-title-text">
                  {formatWindowDuration(featured.windowDurationMins)}
                </span>
              </strong>
              <small>
                {usage.connection === "stale"
                  ? staleLabel(usage.lastSuccessfulAt)
                  : `${featured.remainingPercent}% 남음`}
              </small>
            </span>
          </>
        ) : (
          <span className="capsule-copy empty-copy">
            <strong className="capsule-title">
              <span className="codex-label">CODEX</span>
              <span className="capsule-title-separator" aria-hidden="true">
                ·
              </span>
              <span className="capsule-title-text">
                {usage.connection === "starting"
                  ? "사용량 확인 중"
                  : usage.connection === "no_limits"
                    ? "사용량 한도 없음"
                    : errorTitle(usage.connection)}
              </span>
            </strong>
            <small>
              {usage.errorMessage ?? "Codex 계정 상태를 확인합니다"}
            </small>
          </span>
        )}
        <button
          className="expand-button"
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "사용량 상세 접기" : "사용량 상세 펼치기"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "−" : "+"}
        </button>
      </div>

      {expanded && (
        <section className="details" aria-label="Codex 사용량 상세">
          <header>
            <div>
              <p className="eyebrow">CODEX USAGE</p>
              <h1>
                {windows.length > 0
                  ? "남은 사용량"
                  : errorTitle(usage.connection)}
              </h1>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={collapse}
              aria-label="접기"
            >
              ×
            </button>
          </header>

          {windows.length > 0 ? (
            <div
              className={`window-list ${usage.connection === "stale" ? "is-stale" : ""}`}
            >
              {windows.map((window) => (
                <article className="window-row" key={window.id}>
                  <div className="window-heading">
                    <span>
                      {formatWindowDuration(window.windowDurationMins)}
                      {window.bucketLabel ? ` · ${window.bucketLabel}` : ""}
                    </span>
                    <strong
                      className={`tone-text-${usageTone(window.remainingPercent)}`}
                    >
                      {window.remainingPercent}%
                    </strong>
                  </div>
                  <div
                    className="meter"
                    aria-label={`${window.remainingPercent}% 남음`}
                  >
                    <span
                      className={`tone-${usageTone(window.remainingPercent)}`}
                      style={{ width: `${window.remainingPercent}%` }}
                    />
                  </div>
                  <small>{formatResetTime(window.resetsAt)} 리셋</small>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <p>
                {usage.errorMessage ?? "현재 계정에 표시할 제한 창이 없습니다."}
              </p>
              {canPickCli && (
                <button type="button" onClick={() => void chooseCli()}>
                  CLI 경로 선택
                </button>
              )}
            </div>
          )}

          <footer>
            <span>
              {usage.connection === "stale"
                ? staleLabel(usage.lastSuccessfulAt)
                : usage.errorMessage
                  ? usage.errorMessage
                  : cliInfo && !cliInfo.meetsRecommendedVersion
                    ? "CLI 0.144.6 이상 권장"
                    : "60초마다 자동 갱신"}
            </span>
            <button type="button" onClick={() => void invoke("refresh_usage")}>
              새로고침
            </button>
          </footer>
        </section>
      )}
    </main>
  );
}

export default App;
