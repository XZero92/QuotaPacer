import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  CliInfo,
  LargePlanVisualization,
  OverlayOpacityPhase,
  OverlayOpacityUpdate,
  PacePlanBreakdownView,
  PaceViewState,
  PaceWindowView,
  UsageViewState,
  UsageWindow,
} from "./types";
import { DEFAULT_OVERLAY_OPACITY, MIN_OVERLAY_OPACITY } from "./types";
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
const PLAN_DEVIATION_RANGE = 20;

function isOverlaySize(value: unknown): value is OverlaySize {
  return value === "small" || value === "middle" || value === "large";
}

function isLargePlanVisualization(
  value: unknown,
): value is LargePlanVisualization {
  return value === "deviation" || value === "weeklyAllocation";
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

function plannedRemainingPercent(pace: PaceWindowView | undefined) {
  if (
    pace?.plannedUsedPercent === null ||
    pace?.plannedUsedPercent === undefined ||
    !Number.isFinite(pace.plannedUsedPercent)
  ) {
    return null;
  }

  return Math.max(0, Math.min(100, 100 - pace.plannedUsedPercent));
}

function SmallOverlay({
  usage,
  featured,
  pace,
}: {
  usage: UsageViewState;
  featured: UsageWindow | null;
  pace: PaceWindowView | undefined;
}) {
  if (!featured) return <EmptySurface usage={usage} compact />;

  const plannedRemaining = plannedRemainingPercent(pace);
  const planLabel =
    plannedRemaining === null
      ? ""
      : `, 계획 기준 ${Math.round(plannedRemaining)}% 남음`;

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
            "--plan-remaining": plannedRemaining ?? 0,
          } as React.CSSProperties
        }
        aria-label={`${featured.remainingPercent}% 남음 원형 게이지${planLabel}`}
      >
        {plannedRemaining !== null && (
          <i className="small-plan-marker" aria-hidden="true" />
        )}
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
  pace,
}: {
  usage: UsageViewState;
  featured: UsageWindow | null;
  pace: PaceWindowView | undefined;
}) {
  if (!featured) return <EmptySurface usage={usage} />;

  const plannedRemaining = plannedRemainingPercent(pace);
  const planLabel =
    plannedRemaining === null
      ? ""
      : `, 계획 기준 ${Math.round(plannedRemaining)}% 남음`;

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
        aria-label={`${featured.remainingPercent}% 남음${planLabel}`}
      >
        <span
          className={`tone-${usageTone(featured.remainingPercent)}`}
          style={{ width: `${featured.remainingPercent}%` }}
        />
        {plannedRemaining !== null && (
          <i
            className={`usage-plan-marker align-${markerAlignment(plannedRemaining)}`}
            style={{ left: `${plannedRemaining}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      <small>
        {usage.connection === "stale"
          ? staleLabel(usage.lastSuccessfulAt)
          : `${formatResetTime(featured.resetsAt)} 리셋`}
      </small>
    </div>
  );
}

type PaceDisplayStatus =
  "safe" | "planExceeded" | "earlyRisk" | "exhaustionRisk" | "unavailable";

function paceDisplayStatus(
  pace: PaceWindowView | undefined,
  resetsAt: number | null,
): PaceDisplayStatus {
  if (!pace) return "unavailable";

  const exhaustionBeforeReset =
    pace.projectedExhaustionAt !== null &&
    resetsAt !== null &&
    pace.projectedExhaustionAt < resetsAt;

  if (pace.status === "exhaustionRisk" && exhaustionBeforeReset) {
    return pace.earlyEstimate ? "earlyRisk" : "exhaustionRisk";
  }
  if (pace.status === "planExceeded") return "planExceeded";
  if (
    pace.forecastBasis !== "unavailable" &&
    (pace.projectedEndPercent !== null || pace.projectedExhaustionAt !== null)
  ) {
    return "safe";
  }
  return "unavailable";
}

function paceSummaryLabel(
  pace: PaceWindowView | undefined,
  resetsAt: number | null,
  status: PaceDisplayStatus,
) {
  const exhaustionAt = pace?.projectedExhaustionAt ?? null;
  const leadDuration =
    exhaustionAt !== null && resetsAt !== null && exhaustionAt < resetsAt
      ? formatLeadDuration(resetsAt - exhaustionAt)
      : null;

  switch (status) {
    case "safe": {
      if (exhaustionAt !== null && exhaustionAt === resetsAt) {
        return "초기화 시 100% 사용 예상";
      }
      if (
        pace?.projectedEndPercent !== null &&
        pace?.projectedEndPercent !== undefined
      ) {
        return `초기화 시 ${Math.round(pace.projectedEndPercent)}% 사용 예상`;
      }
      return "현재 페이스 유지 가능";
    }
    case "planExceeded": {
      const delta = Math.round(Math.abs(pace?.planDeltaPercentPoints ?? 0));
      return `계획보다 ${delta}%p 빠름`;
    }
    case "earlyRisk":
      return leadDuration === null
        ? "초기 추정 · 소진 가능성 있음"
        : `초기 추정 · ${leadDuration} 일찍 소진 가능`;
    case "exhaustionRisk":
      return leadDuration === null
        ? "초기화 전 소진 예상"
        : `${leadDuration} 일찍 소진`;
    default:
      return "예측 준비 중";
  }
}

function forecastBasisLabel(pace: PaceWindowView | undefined) {
  if (!pace || pace.forecastBasis === "unavailable") return null;
  if (pace.forecastBasis === "recent") {
    return `최근 ${Math.round((pace.observedHours ?? 0) * 10) / 10}시간`;
  }
  return "기간 평균";
}

function formatLeadDuration(seconds: number) {
  const totalMinutes = Math.max(0, Math.ceil(seconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    if (hours > 0) return `${days}일 ${hours}시간`;
    if (minutes > 0) return `${days}일 ${minutes}분`;
    return `${days}일`;
  }
  if (hours > 0) {
    if (minutes > 0) return `${hours}시간 ${minutes}분`;
    return `${hours}시간`;
  }
  return `${minutes}분`;
}

function markerAlignment(percent: number) {
  if (percent <= 8) return "start";
  if (percent >= 92) return "end";
  return "center";
}

type PlanColorStage = "reserve" | "near" | "borrow1" | "borrow2" | "borrow3";

function formatPlanDifference(delta: number) {
  const rounded = Math.round(Math.abs(delta));
  if (delta > 1) return `계획보다 ${rounded}%p 초과`;
  if (delta < -1) return `계획상 ${rounded}%p 여유`;
  return "계획 범위";
}

function planColorStage(
  delta: number,
  breakdown: PacePlanBreakdownView | null | undefined,
): PlanColorStage {
  if (delta < -1) return "reserve";
  if (delta <= 1) return "near";
  if (!breakdown) return "borrow1";

  let remaining = delta;
  let borrowedSegments = 0;
  for (
    let index = breakdown.currentSegmentIndex + 1;
    index < breakdown.segments.length;
    index += 1
  ) {
    const allocation = breakdown.segments[index].allocationPercent;
    if (allocation <= 0) continue;
    borrowedSegments += 1;
    if (remaining <= allocation) break;
    remaining -= allocation;
  }
  if (borrowedSegments <= 1) return "borrow1";
  if (borrowedSegments === 2) return "borrow2";
  return "borrow3";
}

function planColorStageLabel(stage: PlanColorStage) {
  switch (stage) {
    case "reserve":
      return "계획상 여유";
    case "near":
      return "계획 범위";
    case "borrow1":
      return "다음 계획 구간 사용";
    case "borrow2":
      return "두 번째 미래 구간 사용";
    case "borrow3":
      return "세 번째 이상 미래 구간 사용";
  }
}

function deviationStageBands(
  breakdown: PacePlanBreakdownView | null | undefined,
) {
  if (!breakdown) return [];
  const bands: Array<{
    left: number;
    width: number;
    stage: "borrow1" | "borrow2" | "borrow3";
    reachesTrackEnd: boolean;
  }> = [];
  let cumulative = 0;
  let borrowedSegments = 0;

  for (
    let index = breakdown.currentSegmentIndex + 1;
    index < breakdown.segments.length && cumulative < PLAN_DEVIATION_RANGE;
    index += 1
  ) {
    const allocation = breakdown.segments[index].allocationPercent;
    if (allocation <= 0) continue;
    borrowedSegments += 1;
    const start = borrowedSegments === 1 ? 1 : cumulative;
    cumulative += allocation;
    const end = Math.min(cumulative, PLAN_DEVIATION_RANGE);
    if (end <= start) continue;
    bands.push({
      left: 50 + (start / PLAN_DEVIATION_RANGE) * 50,
      width: ((end - start) / PLAN_DEVIATION_RANGE) * 50,
      stage:
        borrowedSegments === 1
          ? "borrow1"
          : borrowedSegments === 2
            ? "borrow2"
            : "borrow3",
      reachesTrackEnd: end === PLAN_DEVIATION_RANGE,
    });
  }
  return bands;
}

function allocationOverrunPieces(
  usedPercent: number,
  plannedUsedPercent: number,
  breakdown: PacePlanBreakdownView,
) {
  const pieces: Array<{
    left: number;
    width: number;
    stage: "borrow1" | "borrow2" | "borrow3";
  }> = [];
  let left = plannedUsedPercent;
  let remaining = Math.max(0, usedPercent - plannedUsedPercent);
  let borrowedSegments = 0;

  for (
    let index = breakdown.currentSegmentIndex + 1;
    index < breakdown.segments.length && remaining > 0;
    index += 1
  ) {
    const allocation = breakdown.segments[index].allocationPercent;
    if (allocation <= 0) continue;
    borrowedSegments += 1;
    const width = Math.min(allocation, remaining);
    pieces.push({
      left,
      width,
      stage:
        borrowedSegments === 1
          ? "borrow1"
          : borrowedSegments === 2
            ? "borrow2"
            : "borrow3",
    });
    left += allocation;
    remaining -= width;
  }
  return pieces;
}

function planSegmentLabel(startsAt: number) {
  return new Intl.DateTimeFormat("ko-KR", { weekday: "short" }).format(
    new Date(startsAt * 1000),
  );
}

function DeviationPlanGauge({
  usedPercent,
  pace,
}: {
  usedPercent: number;
  pace: PaceWindowView | undefined;
}) {
  const plannedPercent = pace?.plannedUsedPercent;
  const delta = pace?.planDeltaPercentPoints;
  const available =
    plannedPercent !== null &&
    plannedPercent !== undefined &&
    delta !== null &&
    delta !== undefined;

  if (!available) {
    return (
      <div className="plan-visual">
        <div className="plan-visual-heading">
          <span>계획 대비</span>
          <strong className="plan-visual-difference stage-near">
            계산 불가
          </strong>
        </div>
        <div className="deviation-labels" aria-hidden="true">
          <span>여유</span>
          <span>기준</span>
          <span>초과</span>
        </div>
        <div
          className="deviation-track is-unavailable"
          role="img"
          aria-label="권장선 계산 불가"
        >
          <i className="deviation-center" aria-hidden="true" />
        </div>
        <div className="plan-visual-detail">
          현재 {Math.round(usedPercent)}% · 계획선 —
        </div>
      </div>
    );
  }

  const normalized = Math.max(-1, Math.min(1, delta / PLAN_DEVIATION_RANGE));
  const markerPercent = 50 + normalized * 50;
  const nearPlanWidth = (1 / PLAN_DEVIATION_RANGE) * 100;
  const clipped = Math.abs(delta) > PLAN_DEVIATION_RANGE;
  const colorStage = planColorStage(delta, pace?.planBreakdown);
  const stageBands = deviationStageBands(pace?.planBreakdown);
  const direction = delta > 1 ? "over" : delta < -1 ? "under" : "near";

  return (
    <div className="plan-visual">
      <div className="plan-visual-heading">
        <span>계획 대비</span>
        <strong
          className={`plan-visual-difference direction-${direction} stage-${colorStage}`}
        >
          {formatPlanDifference(delta)}
        </strong>
      </div>
      <div className="deviation-labels" aria-hidden="true">
        <span>여유</span>
        <span>기준</span>
        <span>초과</span>
      </div>
      <div
        className="deviation-track"
        role="img"
        aria-label={`${formatPlanDifference(delta)}, ${planColorStageLabel(colorStage)}, 표시 범위 ±${PLAN_DEVIATION_RANGE}%p`}
      >
        {stageBands.map((band, index) => (
          <span
            className={`deviation-stage-band stage-${band.stage}${
              band.reachesTrackEnd ? " is-track-end" : ""
            }`}
            style={{ left: `${band.left}%`, width: `${band.width}%` }}
            key={`${band.stage}-${index}`}
            aria-hidden="true"
          />
        ))}
        <span
          className="deviation-near-zone"
          style={
            {
              "--near-width": `${nearPlanWidth}%`,
            } as CSSProperties
          }
          aria-hidden="true"
        />
        <i className="deviation-center" aria-hidden="true" />
        <span
          className={`deviation-marker marker-${direction} stage-${colorStage} ${
            clipped ? "is-clipped" : ""
          }`}
          style={{ left: `${markerPercent}%` }}
          aria-hidden="true"
        />
      </div>
      <div className="plan-visual-detail">
        현재 {Math.round(usedPercent)}% · 계획선 {Math.round(plannedPercent)}%
      </div>
    </div>
  );
}

function WeeklyAllocationGauge({
  usedPercent,
  pace,
  breakdown,
}: {
  usedPercent: number;
  pace: PaceWindowView;
  breakdown: PacePlanBreakdownView;
}) {
  const plannedPercent = pace.plannedUsedPercent!;
  const delta = pace.planDeltaPercentPoints!;
  const colorStage = planColorStage(delta, breakdown);
  const overrunPieces = allocationOverrunPieces(
    usedPercent,
    plannedPercent,
    breakdown,
  );
  const currentSegment = breakdown.segments[breakdown.currentSegmentIndex];
  const currentLabel = planSegmentLabel(currentSegment.startsAt);

  return (
    <div className="plan-visual">
      <div className="plan-visual-heading">
        <span>주간 계획 배분</span>
        <strong
          className={`plan-visual-difference direction-${
            delta > 1 ? "over" : delta < -1 ? "under" : "near"
          } stage-${colorStage}`}
        >
          {formatPlanDifference(delta)}
        </strong>
      </div>
      <div className="allocation-labels" aria-hidden="true">
        {breakdown.segments.map((segment, index) => (
          <span
            className={
              index === breakdown.currentSegmentIndex ? "is-current" : ""
            }
            style={{ flexBasis: `${segment.allocationPercent}%` }}
            key={segment.startsAt}
          >
            {segment.allocationPercent > 0
              ? planSegmentLabel(segment.startsAt)
              : null}
          </span>
        ))}
      </div>
      <div
        className="allocation-track"
        role="img"
        aria-label={`요일별 계획 배분, ${currentLabel} 시작 구간까지 ${Math.round(
          plannedPercent,
        )}%, 현재 ${Math.round(usedPercent)}%, ${formatPlanDifference(
          delta,
        )}, ${planColorStageLabel(colorStage)}`}
      >
        {breakdown.segments.map((segment, index) => {
          const left =
            index === 0 ? 0 : breakdown.segments[index - 1].cumulativePercent;
          return (
            <span
              className={`allocation-segment ${
                index < breakdown.currentSegmentIndex
                  ? "is-past"
                  : index === breakdown.currentSegmentIndex
                    ? "is-current"
                    : "is-future"
              } ${segment.allocationPercent === 0 ? "is-zero" : ""}`}
              style={{
                left: `${left}%`,
                width: `${segment.allocationPercent}%`,
              }}
              key={`${segment.startsAt}-segment`}
              aria-hidden="true"
            />
          );
        })}
        <span
          className="allocation-used"
          style={{ width: `${usedPercent}%` }}
          aria-hidden="true"
        />
        {overrunPieces.map((piece, index) => (
          <span
            className={`allocation-overrun stage-${piece.stage}`}
            style={{ left: `${piece.left}%`, width: `${piece.width}%` }}
            key={`${piece.stage}-${index}`}
            aria-hidden="true"
          />
        ))}
        {breakdown.segments.slice(0, -1).map((segment) => (
          <i
            className="allocation-boundary"
            style={{ left: `${segment.cumulativePercent}%` }}
            key={`${segment.startsAt}-boundary`}
            aria-hidden="true"
          />
        ))}
        <i
          className="allocation-plan-marker"
          style={{ left: `${plannedPercent}%` }}
          aria-hidden="true"
        />
      </div>
      <div className="plan-visual-detail">
        현재 {Math.round(usedPercent)}% · {currentLabel} 시작 구간까지{" "}
        {Math.round(plannedPercent)}%
      </div>
    </div>
  );
}

function PlanVisualization({
  usedPercent,
  pace,
  visualization,
}: {
  usedPercent: number;
  pace: PaceWindowView | undefined;
  visualization: LargePlanVisualization;
}) {
  const breakdown = pace?.planBreakdown;
  if (
    visualization === "weeklyAllocation" &&
    breakdown?.kind === "weekly" &&
    pace?.plannedUsedPercent !== null &&
    pace?.plannedUsedPercent !== undefined &&
    pace.planDeltaPercentPoints !== null &&
    pace.planDeltaPercentPoints !== undefined
  ) {
    return (
      <WeeklyAllocationGauge
        usedPercent={usedPercent}
        pace={pace}
        breakdown={breakdown}
      />
    );
  }
  return <DeviationPlanGauge usedPercent={usedPercent} pace={pace} />;
}

function ForecastTimeline({
  pace,
  resetsAt,
  updatedAt,
  status,
}: {
  pace: PaceWindowView | undefined;
  resetsAt: number | null;
  updatedAt: number | null;
  status: PaceDisplayStatus;
}) {
  const exhaustionAt = pace?.projectedExhaustionAt ?? null;
  const hasRange =
    updatedAt !== null && resetsAt !== null && resetsAt > updatedAt;
  const isRisk =
    (status === "earlyRisk" || status === "exhaustionRisk") &&
    exhaustionAt !== null &&
    hasRange &&
    exhaustionAt < resetsAt;
  const markerPercent = isRisk
    ? Math.max(
        0,
        Math.min(
          100,
          ((exhaustionAt - updatedAt) / (resetsAt - updatedAt)) * 100,
        ),
      )
    : null;
  const projectedEndPercent =
    exhaustionAt !== null && resetsAt !== null && exhaustionAt === resetsAt
      ? 100
      : pace?.projectedEndPercent;

  let accessibleDetail = "사용 기록이 더 필요합니다";
  if (isRisk) {
    accessibleDetail = `${formatLeadDuration(
      resetsAt - exhaustionAt,
    )} 일찍 소진`;
  } else if (
    status !== "unavailable" &&
    projectedEndPercent !== null &&
    projectedEndPercent !== undefined
  ) {
    accessibleDetail = `초기화 시 ${Math.round(projectedEndPercent)}% 사용 예상`;
  }

  const timelineLabel = isRisk
    ? `${formatResetTime(exhaustionAt)} 소진 예상, ${formatResetTime(
        resetsAt,
      )} 초기화, ${accessibleDetail}`
    : accessibleDetail;

  return (
    <div className={`forecast-timeline timeline-${status}`}>
      <div className="timeline-endpoints" aria-hidden="true">
        <span className={isRisk ? "timeline-exhaustion-label" : ""}>
          {isRisk ? `${formatResetTime(exhaustionAt)} 소진` : null}
        </span>
        <span>
          {resetsAt === null
            ? "초기화 시각 미정"
            : `${formatResetTime(resetsAt)} 초기화`}
        </span>
      </div>
      <div className="timeline-track" role="img" aria-label={timelineLabel}>
        {markerPercent !== null && (
          <span
            className={`timeline-marker align-${markerAlignment(markerPercent)}`}
            style={{ left: `${markerPercent}%` }}
          >
            <i aria-hidden="true" />
          </span>
        )}
      </div>
    </div>
  );
}

function PaceRow({
  window,
  pace,
  updatedAt,
  visualization,
}: {
  window: UsageWindow;
  pace: PaceWindowView | undefined;
  updatedAt: number | null;
  visualization: LargePlanVisualization;
}) {
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  const status = paceDisplayStatus(pace, window.resetsAt);
  const basisLabel = forecastBasisLabel(pace);

  return (
    <article className={`pace-row status-${status}`}>
      <div className="pace-heading">
        <strong className="window-label">{windowLabel(window)}</strong>
        <span className="pace-remaining">{window.remainingPercent}% 남음</span>
      </div>
      <div className="pace-summary">
        <strong>{paceSummaryLabel(pace, window.resetsAt, status)}</strong>
        {basisLabel !== null && <i>{basisLabel}</i>}
      </div>
      <ForecastTimeline
        pace={pace}
        resetsAt={window.resetsAt}
        updatedAt={updatedAt}
        status={status}
      />
      <PlanVisualization
        usedPercent={usedPercent}
        pace={pace}
        visualization={visualization}
      />
    </article>
  );
}

function LargeOverlay({
  usage,
  pace,
  planVisualization,
}: {
  usage: UsageViewState;
  pace: PaceViewState;
  planVisualization: LargePlanVisualization;
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
        {usage.connection === "stale" ? (
          <small>{staleLabel(usage.lastSuccessfulAt)}</small>
        ) : (
          <span className="pace-freshness" aria-label="최신 사용량" />
        )}
      </header>
      <div className="pace-rows">
        {windows.map((window) => (
          <PaceRow
            key={window.id}
            window={window}
            pace={paceByWindow.get(window.id)}
            updatedAt={pace.updatedAt}
            visualization={planVisualization}
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
  const [largePlanVisualization, setLargePlanVisualization] =
    useState<LargePlanVisualization>("deviation");
  const [opacity, setOpacity] = useState(DEFAULT_OVERLAY_OPACITY);
  const [opacityPhase, setOpacityPhase] =
    useState<OverlayOpacityPhase>("committed");
  const [sizeReady, setSizeReady] = useState(false);
  const draggingRef = useRef(false);
  const lastOpacityUpdateIdRef = useRef(-1);

  const applyOpacityUpdate = useCallback((update: OverlayOpacityUpdate) => {
    if (
      !Number.isInteger(update.updateId) ||
      update.updateId <= lastOpacityUpdateIdRef.current ||
      !Number.isInteger(update.opacityPercent) ||
      update.opacityPercent < MIN_OVERLAY_OPACITY ||
      update.opacityPercent > 100 ||
      !["preview", "committed", "reverted"].includes(update.phase)
    ) {
      return;
    }
    lastOpacityUpdateIdRef.current = update.updateId;
    setOpacity(update.opacityPercent);
    setOpacityPhase(update.phase);
  }, []);

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
    void Promise.all([
      invoke<OverlaySize>("get_overlay_size").then((size) => {
        if (isOverlaySize(size)) setSizeMode(size);
      }),
      invoke<LargePlanVisualization>("get_large_plan_visualization").then(
        (visualization) => {
          if (isLargePlanVisualization(visualization)) {
            setLargePlanVisualization(visualization);
          }
        },
      ),
      invoke<OverlayOpacityUpdate>("get_effective_overlay_opacity").then(
        applyOpacityUpdate,
      ),
    ]).finally(() => setSizeReady(true));
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
    const unlistenOverlayOpacity = listen<OverlayOpacityUpdate>(
      "ui://overlay-opacity-updated",
      (event) => applyOpacityUpdate(event.payload),
    );
    const unlistenLargePlanVisualization = listen<LargePlanVisualization>(
      "ui://large-plan-visualization-changed",
      (event) => {
        if (isLargePlanVisualization(event.payload)) {
          setLargePlanVisualization(event.payload);
        }
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
      void unlistenOverlayOpacity.then((unlisten) => unlisten());
      void unlistenLargePlanVisualization.then((unlisten) => unlisten());
      void unlistenPace.then((unlisten) => unlisten());
      void unlistenPickCli.then((unlisten) => unlisten());
    };
  }, [applyOpacityUpdate, chooseCli]);

  useEffect(() => {
    if (!sizeReady) return;
    void invoke("set_overlay_layout", {
      size: sizeMode,
      windowCount: usage.windows.length,
    });
  }, [sizeMode, sizeReady, usage.windows.length]);

  const featured = featuredWindow(usage);
  const featuredPace = featured
    ? pace.windows.find((window) => window.windowId === featured.id)
    : undefined;

  return (
    <main
      className={`overlay size-${sizeMode} ${
        sizeReady ? "is-size-ready" : ""
      } ${opacityPhase === "preview" ? "is-opacity-previewing" : ""}`}
      style={
        {
          "--overlay-opacity": opacity / 100,
        } as CSSProperties
      }
      data-tauri-drag-region
      onPointerDown={startDragging}
      onContextMenu={showContextMenu}
      title="드래그하여 이동 · 우클릭하여 메뉴 열기"
    >
      {sizeMode === "small" ? (
        <SmallOverlay usage={usage} featured={featured} pace={featuredPace} />
      ) : sizeMode === "middle" ? (
        <MiddleOverlay usage={usage} featured={featured} pace={featuredPace} />
      ) : (
        <LargeOverlay
          usage={usage}
          pace={pace}
          planVisualization={largePlanVisualization}
        />
      )}
    </main>
  );
}

export default App;
