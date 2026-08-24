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
  Language,
  LargePlanVisualization,
  OverlayAppearancePhase,
  OverlayAppearanceUpdate,
  PacePlanBreakdownView,
  PaceViewState,
  PaceWindowView,
  UsageViewState,
  UsageWindow,
} from "./types";
import { DEFAULT_OVERLAY_OPACITY, MIN_OVERLAY_OPACITY } from "./types";
import {
  DEFAULT_LANGUAGE,
  isLanguage,
  LanguageProvider,
  locale,
  text,
  useLanguage,
} from "./i18n";
import {
  featuredWindow,
  formatResetTime,
  formatWindowDuration,
  INITIAL_USAGE_STATE,
  sortedWindows,
  staleAgeLabel,
  staleLabel,
  usageTone,
} from "./usage";
import "./App.css";

type OverlaySize = "small" | "middle" | "large";
const INITIAL_PACE_STATE: PaceViewState = { windows: [], updatedAt: null };
const PLAN_DEVIATION_RANGE = 20;

interface CliRecoveryActions {
  configuredPath: string | null;
  error: string | null;
  pending: boolean;
  choose: () => Promise<void>;
  useAutomatic: () => Promise<void>;
}

interface OverlayMenuPosition {
  x: number;
  y: number;
}

function isOverlaySize(value: unknown): value is OverlaySize {
  return value === "small" || value === "middle" || value === "large";
}

function isLargePlanVisualization(
  value: unknown,
): value is LargePlanVisualization {
  return value === "deviation" || value === "weeklyAllocation";
}

function errorTitle(
  connection: UsageViewState["connection"],
  language: Language,
) {
  switch (connection) {
    case "cli_missing":
      return text(language, "Codex CLI가 필요합니다", "Codex CLI required");
    case "cli_unsupported":
      return text(
        language,
        "Codex CLI를 업데이트해 주세요",
        "Update Codex CLI",
      );
    case "login_required":
      return text(
        language,
        "Codex 로그인이 필요합니다",
        "Codex login required",
      );
    case "unsupported_auth":
      return text(
        language,
        "ChatGPT 로그인이 필요합니다",
        "ChatGPT login required",
      );
    case "error":
      return text(
        language,
        "사용량을 불러오지 못했습니다",
        "Couldn't load usage",
      );
    default:
      return text(language, "Codex 사용량", "Codex usage");
  }
}

function canRecoverCli(connection: UsageViewState["connection"]) {
  return connection === "cli_missing" || connection === "cli_unsupported";
}

function cliActionErrorMessage(error: unknown, language: Language) {
  if (language === "ko") {
    if (typeof error === "string") return error;
    if (error instanceof Error) return error.message;
  }
  return text(
    language,
    "Codex CLI 설정을 변경하지 못했습니다.",
    "Couldn't change the Codex CLI setting.",
  );
}

function windowLabel(window: UsageWindow, language: Language) {
  const duration = formatWindowDuration(window.windowDurationMins, language);
  return window.bucketLabel ? `${duration} · ${window.bucketLabel}` : duration;
}

function WindowHeadingLabel({ window }: { window: UsageWindow }) {
  const language = useLanguage();
  return (
    <strong className="window-label">
      <span className="brand-label">Codex</span>
      <span className="label-separator" aria-hidden="true">
        ·
      </span>
      <span>{windowLabel(window, language)}</span>
    </strong>
  );
}

function MoreMenuButton({
  onOpen,
}: {
  onOpen: (position: OverlayMenuPosition) => void;
}) {
  const language = useLanguage();
  return (
    <button
      type="button"
      className="more-menu-button"
      aria-label={text(language, "더보기 메뉴", "More menu")}
      aria-haspopup="menu"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        onOpen({ x: bounds.left, y: bounds.bottom });
      }}
    >
      <svg viewBox="0 0 16 4" aria-hidden="true">
        <circle cx="2" cy="2" r="1.5" />
        <circle cx="8" cy="2" r="1.5" />
        <circle cx="14" cy="2" r="1.5" />
      </svg>
    </button>
  );
}

function EmptySurface({
  usage,
  compact = false,
  recovery,
  onOpenMenu,
}: {
  usage: UsageViewState;
  compact?: boolean;
  recovery?: CliRecoveryActions;
  onOpenMenu: (position: OverlayMenuPosition) => void;
}) {
  const language = useLanguage();
  const title =
    usage.connection === "starting"
      ? text(language, "사용량 확인 중", "Checking usage")
      : usage.connection === "no_limits"
        ? text(language, "사용량 한도 없음", "No usage limits")
        : errorTitle(usage.connection, language);

  if (compact) {
    return (
      <div className="small-card is-empty" aria-label={title}>
        <div className="small-ring" aria-hidden="true">
          <strong>—</strong>
        </div>
        <div className="small-copy">
          <strong>Codex</strong>
          {recovery ? (
            <button
              type="button"
              className="cli-recovery-compact"
              disabled={recovery.pending}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => void recovery.choose()}
            >
              {recovery.pending
                ? text(language, "확인 중", "Checking")
                : text(language, "CLI 선택", "Choose CLI")}
            </button>
          ) : (
            <small>
              {usage.connection === "starting"
                ? text(language, "확인 중", "Checking")
                : text(language, "상태 확인", "Check status")}
            </small>
          )}
        </div>
        <MoreMenuButton onOpen={onOpenMenu} />
      </div>
    );
  }

  return (
    <div className={`empty-surface ${recovery ? "is-actionable" : ""}`}>
      <div className="empty-surface-copy">
        <strong>
          <span className="brand-label">Codex</span>
          <span aria-hidden="true"> · </span>
          <span>{title}</span>
        </strong>
        <small>
          {recovery?.error ??
            (language === "ko" ? usage.errorMessage : null) ??
            text(
              language,
              "Codex 계정 상태를 확인합니다",
              "Check your Codex account status",
            )}
        </small>
      </div>
      {recovery && (
        <div className="cli-recovery-actions">
          <button
            type="button"
            disabled={recovery.pending}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void recovery.choose()}
          >
            {recovery.pending
              ? text(language, "확인 중", "Checking")
              : usage.connection === "cli_unsupported"
                ? text(language, "다른 CLI 선택", "Choose another CLI")
                : text(language, "CLI 선택", "Choose CLI")}
          </button>
          {recovery.configuredPath && (
            <button
              type="button"
              className="is-secondary"
              disabled={recovery.pending}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => void recovery.useAutomatic()}
            >
              {text(language, "자동 탐지", "Auto-detect")}
            </button>
          )}
        </div>
      )}
      <MoreMenuButton onOpen={onOpenMenu} />
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

function observedHoursLabel(pace: PaceWindowView) {
  return Math.round((pace.observedHours ?? 0) * 10) / 10;
}

function SmallOverlay({
  usage,
  featured,
  pace,
  recovery,
  onOpenMenu,
}: {
  usage: UsageViewState;
  featured: UsageWindow | null;
  pace: PaceWindowView | undefined;
  recovery?: CliRecoveryActions;
  onOpenMenu: (position: OverlayMenuPosition) => void;
}) {
  const language = useLanguage();
  if (!featured) {
    return (
      <EmptySurface
        usage={usage}
        compact
        recovery={recovery}
        onOpenMenu={onOpenMenu}
      />
    );
  }

  const plannedRemaining = plannedRemainingPercent(pace);
  const planLabel =
    plannedRemaining === null
      ? ""
      : text(
          language,
          `, 현재 시각 계획 기준 ${Math.round(plannedRemaining)}% 남음`,
          `, ${Math.round(plannedRemaining)}% remaining by the current plan`,
        );

  return (
    <div
      className={`small-card tone-${usageTone(featured.remainingPercent)} ${
        usage.connection === "stale" ? "is-stale" : ""
      }`}
      aria-label={text(
        language,
        `Codex · ${windowLabel(featured, language)} 제한 ${featured.remainingPercent}% 남음`,
        `Codex · ${windowLabel(featured, language)} limit, ${featured.remainingPercent}% remaining`,
      )}
    >
      <div
        className="small-ring"
        style={
          {
            "--remaining": featured.remainingPercent,
            "--plan-remaining": plannedRemaining ?? 0,
          } as React.CSSProperties
        }
        aria-label={text(
          language,
          `${featured.remainingPercent}% 남음 원형 게이지${planLabel}`,
          `Circular gauge, ${featured.remainingPercent}% remaining${planLabel}`,
        )}
      >
        {plannedRemaining !== null && (
          <i className="small-plan-marker" aria-hidden="true" />
        )}
        <strong>{featured.remainingPercent}%</strong>
      </div>
      <div className="small-copy">
        <strong>Codex</strong>
        <small>
          {formatWindowDuration(featured.windowDurationMins, language)}
          {usage.connection === "stale"
            ? text(language, " · 지연", " · delayed")
            : ""}
        </small>
      </div>
      {usage.connection === "stale" && (
        <i className="stale-dot" aria-hidden="true" />
      )}
      <MoreMenuButton onOpen={onOpenMenu} />
    </div>
  );
}

function MiddleOverlay({
  usage,
  featured,
  pace,
  recovery,
  onOpenMenu,
}: {
  usage: UsageViewState;
  featured: UsageWindow | null;
  pace: PaceWindowView | undefined;
  recovery?: CliRecoveryActions;
  onOpenMenu: (position: OverlayMenuPosition) => void;
}) {
  const language = useLanguage();
  if (!featured) {
    return (
      <EmptySurface usage={usage} recovery={recovery} onOpenMenu={onOpenMenu} />
    );
  }

  const plannedRemaining = plannedRemainingPercent(pace);
  const planLabel =
    plannedRemaining === null
      ? ""
      : text(
          language,
          `, 현재 시각 계획 기준 ${Math.round(plannedRemaining)}% 남음`,
          `, ${Math.round(plannedRemaining)}% remaining by the current plan`,
        );

  return (
    <div className="middle-card">
      <div className="middle-heading">
        <WindowHeadingLabel window={featured} />
      </div>
      <div
        className="usage-meter"
        aria-label={text(
          language,
          `${featured.remainingPercent}% 남음${planLabel}`,
          `${featured.remainingPercent}% remaining${planLabel}`,
        )}
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
      <div className="middle-footer">
        <small>
          {usage.connection === "stale"
            ? staleLabel(usage.lastSuccessfulAt, undefined, language)
            : text(
                language,
                `${formatResetTime(featured.resetsAt, language)} 리셋`,
                `Resets ${formatResetTime(featured.resetsAt, language)}`,
              )}
        </small>
        <span
          className={`middle-remaining tone-text-${usageTone(featured.remainingPercent)}`}
          aria-hidden="true"
        >
          {text(
            language,
            `${featured.remainingPercent}% 남음`,
            `${featured.remainingPercent}% remaining`,
          )}
        </span>
      </div>
      <MoreMenuButton onOpen={onOpenMenu} />
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
  language: Language,
) {
  const exhaustionAt = pace?.projectedExhaustionAt ?? null;
  const leadDuration =
    exhaustionAt !== null && resetsAt !== null && exhaustionAt < resetsAt
      ? formatLeadDuration(resetsAt - exhaustionAt, language)
      : null;

  switch (status) {
    case "safe":
      return text(
        language,
        "현재 페이스 유지 가능",
        "Current pace is sustainable",
      );
    case "planExceeded": {
      const delta = Math.round(Math.abs(pace?.planDeltaPercentPoints ?? 0));
      return text(
        language,
        `계획보다 ${delta}%p 빠름`,
        `${delta} pp ahead of plan`,
      );
    }
    case "earlyRisk":
      return leadDuration === null
        ? text(language, "초기화 전 소진 가능", "May run out before reset")
        : text(
            language,
            `${leadDuration} 일찍 소진 가능`,
            `May run out ${leadDuration} early`,
          );
    case "exhaustionRisk":
      return leadDuration === null
        ? text(
            language,
            "초기화 전 소진 예상",
            "Expected to run out before reset",
          )
        : text(
            language,
            `${leadDuration} 일찍 소진`,
            `Runs out ${leadDuration} early`,
          );
    default:
      return text(language, "예측 준비 중", "Preparing forecast");
  }
}

function paceContextLabel(
  pace: PaceWindowView | undefined,
  resetsAt: number | null,
  status: PaceDisplayStatus,
  language: Language,
) {
  if (status === "safe") {
    const exhaustionAt = pace?.projectedExhaustionAt ?? null;
    if (exhaustionAt !== null && exhaustionAt === resetsAt) {
      return text(
        language,
        "초기화 시 100% 사용 예상",
        "Expected to reach 100% at reset",
      );
    }
    if (
      pace?.projectedEndPercent !== null &&
      pace?.projectedEndPercent !== undefined
    ) {
      return text(
        language,
        `초기화 시 ${Math.round(pace.projectedEndPercent)}% 사용 예상`,
        `Expected usage at reset: ${Math.round(pace.projectedEndPercent)}%`,
      );
    }
    return text(
      language,
      "초기화까지 사용 가능",
      "Usage should last through reset",
    );
  }
  if (status === "planExceeded") {
    return text(
      language,
      "계획으로 돌아가려면 페이스를 늦추세요",
      "Slow down to return to the plan",
    );
  }
  if (status === "earlyRisk") {
    return text(
      language,
      "누적 평균 · 페이스를 늦추세요",
      "Period average · slow down",
    );
  }
  if (status === "exhaustionRisk") {
    return text(
      language,
      "초기화까지 쓰려면 페이스를 늦추세요",
      "Slow down to keep usage available until reset",
    );
  }
  return text(
    language,
    "사용 기록이 더 필요합니다",
    "More usage history is needed",
  );
}

function paceStatusSymbol(status: PaceDisplayStatus) {
  if (status === "safe") return "✓";
  if (status === "unavailable") return "…";
  return "!";
}

function forecastBasisLabel(
  pace: PaceWindowView | undefined,
  language: Language,
) {
  if (!pace || pace.forecastBasis === "unavailable") return null;
  if (pace.earlyEstimate) {
    return text(
      language,
      `초기 · ${observedHoursLabel(pace)}시간`,
      `Early · ${observedHoursLabel(pace)}h`,
    );
  }
  if (pace.forecastBasis === "recent") {
    return text(
      language,
      `최근 ${observedHoursLabel(pace)}시간`,
      `Last ${observedHoursLabel(pace)} hours`,
    );
  }
  return text(language, "누적 평균", "Period average");
}

function forecastBasisDescription(
  pace: PaceWindowView | undefined,
  language: Language,
) {
  if (!pace || pace.forecastBasis === "unavailable") return null;
  if (pace.forecastBasis === "recent") {
    return text(
      language,
      `최근 ${observedHoursLabel(pace)}시간의 평균 속도`,
      `the average pace over the last ${observedHoursLabel(pace)} hours`,
    );
  }
  return text(language, "누적 평균 속도", "the period-average pace");
}

function formatLeadDuration(seconds: number, language: Language) {
  const totalMinutes = Math.max(0, Math.ceil(seconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    if (hours > 0)
      return text(language, `${days}일 ${hours}시간`, `${days}d ${hours}h`);
    if (minutes > 0)
      return text(language, `${days}일 ${minutes}분`, `${days}d ${minutes}m`);
    return text(language, `${days}일`, `${days}d`);
  }
  if (hours > 0) {
    if (minutes > 0)
      return text(
        language,
        `${hours}시간 ${minutes}분`,
        `${hours}h ${minutes}m`,
      );
    return text(language, `${hours}시간`, `${hours}h`);
  }
  return text(language, `${minutes}분`, `${minutes}m`);
}

function markerAlignment(percent: number) {
  if (percent <= 8) return "start";
  if (percent >= 92) return "end";
  return "center";
}

type PlanColorStage = "reserve" | "near" | "borrow1" | "borrow2" | "borrow3";

function formatPlanDifference(delta: number, language: Language) {
  const rounded = Math.round(Math.abs(delta));
  if (delta > 1)
    return text(
      language,
      `계획보다 ${rounded}%p 초과`,
      `${rounded} pp over plan`,
    );
  if (delta < -1)
    return text(
      language,
      `계획상 ${rounded}%p 여유`,
      `${rounded} pp under plan`,
    );
  return text(language, "계획 범위", "On plan");
}

function planColorStage(
  delta: number,
  plannedPercent: number,
  breakdown: PacePlanBreakdownView | null | undefined,
): PlanColorStage {
  if (delta < -1) return "reserve";
  if (delta <= 1) return "near";
  if (!breakdown) return "borrow1";

  let remaining = delta;
  let borrowedSegments = 0;
  for (const allocation of futurePlanAllocations(plannedPercent, breakdown)) {
    if (allocation <= 0) continue;
    borrowedSegments += 1;
    if (remaining <= allocation) break;
    remaining -= allocation;
  }
  if (borrowedSegments <= 1) return "borrow1";
  if (borrowedSegments === 2) return "borrow2";
  return "borrow3";
}

function planColorStageLabel(stage: PlanColorStage, language: Language) {
  switch (stage) {
    case "reserve":
      return text(language, "계획상 여유", "Plan reserve");
    case "near":
      return text(language, "계획 범위", "On plan");
    case "borrow1":
      return text(
        language,
        "가까운 미래 계획 사용",
        "Using the next plan segment",
      );
    case "borrow2":
      return text(
        language,
        "두 번째 미래 구간 사용",
        "Using the second future segment",
      );
    case "borrow3":
      return text(
        language,
        "세 번째 이상 미래 구간 사용",
        "Using the third or later future segment",
      );
  }
}

function deviationStageBands(
  plannedPercent: number,
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

  for (const allocation of futurePlanAllocations(plannedPercent, breakdown)) {
    if (cumulative >= PLAN_DEVIATION_RANGE) break;
    if (allocation <= 0) continue;
    borrowedSegments += 1;
    const start = Math.max(1, cumulative);
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

function futurePlanAllocations(
  plannedPercent: number,
  breakdown: PacePlanBreakdownView,
) {
  const currentSegment = breakdown.segments[breakdown.currentSegmentIndex];
  if (!currentSegment) return [];
  const currentRemaining = Math.max(
    0,
    currentSegment.cumulativePercent - plannedPercent,
  );
  return [
    currentRemaining,
    ...breakdown.segments
      .slice(breakdown.currentSegmentIndex + 1)
      .map((segment) => segment.allocationPercent),
  ];
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

  for (const allocation of futurePlanAllocations(
    plannedUsedPercent,
    breakdown,
  )) {
    if (remaining <= 0) break;
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

function planSegmentLabel(startsAt: number, language: Language) {
  return new Intl.DateTimeFormat(locale(language), { weekday: "short" }).format(
    new Date(startsAt * 1000),
  );
}

function DeviationPlanGauge({
  usedPercent,
  pace,
  animateTransition,
}: {
  usedPercent: number;
  pace: PaceWindowView | undefined;
  animateTransition: boolean;
}) {
  const language = useLanguage();
  const plannedPercent = pace?.plannedUsedPercent;
  const delta = pace?.planDeltaPercentPoints;
  const available =
    plannedPercent !== null &&
    plannedPercent !== undefined &&
    delta !== null &&
    delta !== undefined;

  if (!available) {
    return (
      <div
        className={`plan-visual ${animateTransition ? "with-transition" : ""}`}
      >
        <div className="plan-visual-heading">
          <span>{text(language, "계획 대비", "Plan variance")}</span>
          <strong className="plan-visual-difference stage-near">
            {text(language, "계산 불가", "Unavailable")}
          </strong>
        </div>
        <div className="deviation-labels" aria-hidden="true">
          <span>{text(language, "여유", "Under")}</span>
          <span>{text(language, "기준", "Plan")}</span>
          <span>{text(language, "초과", "Over")}</span>
        </div>
        <div
          className="deviation-track is-unavailable"
          role="img"
          aria-label={text(
            language,
            "권장선 계산 불가",
            "Plan line unavailable",
          )}
        >
          <i className="deviation-center" aria-hidden="true" />
        </div>
        <div className="plan-visual-detail">
          {text(language, "현재", "Current")} {Math.round(usedPercent)}% ·{" "}
          {text(language, "계획선", "plan line")} —
        </div>
      </div>
    );
  }

  const normalized = Math.max(-1, Math.min(1, delta / PLAN_DEVIATION_RANGE));
  const markerPercent = 50 + normalized * 50;
  const nearPlanWidth = (1 / PLAN_DEVIATION_RANGE) * 100;
  const clipped = Math.abs(delta) > PLAN_DEVIATION_RANGE;
  const colorStage = planColorStage(delta, plannedPercent, pace?.planBreakdown);
  const stageBands = deviationStageBands(plannedPercent, pace?.planBreakdown);
  const direction = delta > 1 ? "over" : delta < -1 ? "under" : "near";

  return (
    <div
      className={`plan-visual ${animateTransition ? "with-transition" : ""}`}
    >
      <div className="plan-visual-heading">
        <span>{text(language, "계획 대비", "Plan variance")}</span>
        <strong
          className={`plan-visual-difference direction-${direction} stage-${colorStage}`}
        >
          {formatPlanDifference(delta, language)}
        </strong>
      </div>
      <div className="deviation-labels" aria-hidden="true">
        <span>{text(language, "여유", "Under")}</span>
        <span>{text(language, "기준", "Plan")}</span>
        <span>{text(language, "초과", "Over")}</span>
      </div>
      <div
        className="deviation-track"
        role="img"
        aria-label={text(
          language,
          `현재 사용량 ${Math.round(usedPercent)}%, 현재 시각 계획선 ${Math.round(plannedPercent)}%, ${formatPlanDifference(delta, language)}, ${planColorStageLabel(colorStage, language)}, 표시 범위 ±${PLAN_DEVIATION_RANGE}%p`,
          `Current usage ${Math.round(usedPercent)}%, current plan line ${Math.round(plannedPercent)}%, ${formatPlanDifference(delta, language)}, ${planColorStageLabel(colorStage, language)}, display range ±${PLAN_DEVIATION_RANGE} pp`,
        )}
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
        {text(language, "현재", "Current")} {Math.round(usedPercent)}% ·{" "}
        {text(language, "계획선", "plan line")} {Math.round(plannedPercent)}%
      </div>
    </div>
  );
}

function WeeklyAllocationGauge({
  usedPercent,
  pace,
  breakdown,
  animateTransition,
}: {
  usedPercent: number;
  pace: PaceWindowView;
  breakdown: PacePlanBreakdownView;
  animateTransition: boolean;
}) {
  const language = useLanguage();
  const plannedPercent = pace.plannedUsedPercent!;
  const delta = pace.planDeltaPercentPoints!;
  const colorStage = planColorStage(delta, plannedPercent, breakdown);
  const overrunPieces = allocationOverrunPieces(
    usedPercent,
    plannedPercent,
    breakdown,
  );
  const currentSegment = breakdown.segments[breakdown.currentSegmentIndex];
  const currentLabel = planSegmentLabel(currentSegment.startsAt, language);

  return (
    <div
      className={`plan-visual ${animateTransition ? "with-transition" : ""}`}
    >
      <div className="plan-visual-heading">
        <span>
          {text(language, "주간 계획 배분", "Weekly plan allocation")}
        </span>
        <strong
          className={`plan-visual-difference direction-${
            delta > 1 ? "over" : delta < -1 ? "under" : "near"
          } stage-${colorStage}`}
        >
          {formatPlanDifference(delta, language)}
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
              ? planSegmentLabel(segment.startsAt, language)
              : null}
          </span>
        ))}
      </div>
      <div
        className="allocation-track"
        role="img"
        aria-label={text(
          language,
          `요일별 계획 배분, 현재 시각 계획선 ${Math.round(plannedPercent)}%, 현재 사용량 ${Math.round(usedPercent)}%, ${currentLabel} 시작 구간, ${formatPlanDifference(delta, language)}, ${planColorStageLabel(colorStage, language)}`,
          `Daily plan allocation, current plan line ${Math.round(plannedPercent)}%, current usage ${Math.round(usedPercent)}%, segment starting ${currentLabel}, ${formatPlanDifference(delta, language)}, ${planColorStageLabel(colorStage, language)}`,
        )}
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
        {text(language, "현재", "Current")} {Math.round(usedPercent)}% ·{" "}
        {text(
          language,
          `${currentLabel} 시작 구간까지`,
          `by the segment starting ${currentLabel}`,
        )}{" "}
        {Math.round(plannedPercent)}%
      </div>
    </div>
  );
}

type WeeklyAllocationPace = PaceWindowView & {
  plannedUsedPercent: number;
  planDeltaPercentPoints: number;
  planBreakdown: PacePlanBreakdownView;
};

function canUseWeeklyAllocation(
  pace: PaceWindowView | undefined,
): pace is WeeklyAllocationPace {
  return (
    pace?.planBreakdown?.kind === "weekly" &&
    pace.plannedUsedPercent !== null &&
    pace.planDeltaPercentPoints !== null
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
  const usesWeeklyAllocation =
    visualization === "weeklyAllocation" && canUseWeeklyAllocation(pace);
  const effectiveVisualization: LargePlanVisualization = usesWeeklyAllocation
    ? "weeklyAllocation"
    : "deviation";
  const [animateTransitions, setAnimateTransitions] = useState(false);
  const transitionMountedRef = useRef(false);
  useEffect(() => {
    if (!transitionMountedRef.current) {
      transitionMountedRef.current = true;
      return;
    }
    setAnimateTransitions(true);
  }, [effectiveVisualization]);

  if (usesWeeklyAllocation) {
    return (
      <WeeklyAllocationGauge
        usedPercent={usedPercent}
        pace={pace}
        breakdown={pace.planBreakdown}
        animateTransition={animateTransitions}
      />
    );
  }
  return (
    <DeviationPlanGauge
      usedPercent={usedPercent}
      pace={pace}
      animateTransition={animateTransitions}
    />
  );
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
  const language = useLanguage();
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
  const basisDescription = forecastBasisDescription(pace, language);

  let accessibleDetail = text(
    language,
    "사용 기록이 더 필요합니다",
    "More usage history is needed",
  );
  if (isRisk && basisDescription !== null) {
    const consequence =
      status === "earlyRisk"
        ? text(
            language,
            `${formatLeadDuration(resetsAt - exhaustionAt, language)} 일찍 소진 가능`,
            `may run out ${formatLeadDuration(resetsAt - exhaustionAt, language)} early`,
          )
        : text(
            language,
            `${formatLeadDuration(resetsAt - exhaustionAt, language)} 일찍 소진 예상`,
            `expected to run out ${formatLeadDuration(resetsAt - exhaustionAt, language)} early`,
          );
    accessibleDetail = text(
      language,
      `${status === "earlyRisk" ? "초기 추정, " : ""}${basisDescription}를 유지하면 초기화보다 ${consequence}`,
      `${status === "earlyRisk" ? "Early estimate: " : ""}maintaining ${basisDescription} means it ${consequence}`,
    );
  } else if (
    status !== "unavailable" &&
    basisDescription !== null &&
    projectedEndPercent !== null &&
    projectedEndPercent !== undefined
  ) {
    accessibleDetail = text(
      language,
      `${basisDescription}를 유지하면 초기화 시 ${Math.round(projectedEndPercent)}% 사용 예상`,
      `Maintaining ${basisDescription} gives an expected ${Math.round(projectedEndPercent)}% usage at reset`,
    );
  }

  const timelineLabel = isRisk
    ? text(
        language,
        `${formatResetTime(exhaustionAt, language)} 소진 예상, ${formatResetTime(resetsAt, language)} 초기화, ${accessibleDetail}`,
        `Expected exhaustion ${formatResetTime(exhaustionAt, language)}, reset ${formatResetTime(resetsAt, language)}, ${accessibleDetail}`,
      )
    : accessibleDetail;

  return (
    <div className={`forecast-timeline timeline-${status}`}>
      <div className="timeline-endpoints" aria-hidden="true">
        <span className={isRisk ? "timeline-exhaustion-label" : ""}>
          {isRisk
            ? text(
                language,
                `${formatResetTime(exhaustionAt, language)} 소진`,
                `Runs out ${formatResetTime(exhaustionAt, language)}`,
              )
            : null}
        </span>
        <span>
          {resetsAt === null
            ? text(language, "초기화 시각 미정", "Reset time unknown")
            : text(
                language,
                `${formatResetTime(resetsAt, language)} 초기화`,
                `Resets ${formatResetTime(resetsAt, language)}`,
              )}
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
  const language = useLanguage();
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  const status = paceDisplayStatus(pace, window.resetsAt);
  const basisLabel = forecastBasisLabel(pace, language);
  const contextLabel = paceContextLabel(
    pace,
    window.resetsAt,
    status,
    language,
  );

  return (
    <article className={`pace-row status-${status}`}>
      <div className="pace-heading">
        <strong className="window-label">
          {windowLabel(window, language)}
        </strong>
        <span
          className={`pace-remaining tone-text-${usageTone(window.remainingPercent)}`}
        >
          {text(
            language,
            `${window.remainingPercent}% 남음`,
            `${window.remainingPercent}% remaining`,
          )}
        </span>
      </div>
      <div className="pace-summary">
        <span className="pace-verdict">
          <span className="pace-status-symbol" aria-hidden="true">
            {paceStatusSymbol(status)}
          </span>
          <strong>
            {paceSummaryLabel(pace, window.resetsAt, status, language)}
          </strong>
        </span>
        {basisLabel !== null && <i>{basisLabel}</i>}
      </div>
      <div className="pace-context">{contextLabel}</div>
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
  planVisualizationPending,
  planVisualizationError,
  onPlanVisualizationChange,
  recovery,
  onOpenMenu,
}: {
  usage: UsageViewState;
  pace: PaceViewState;
  planVisualization: LargePlanVisualization;
  planVisualizationPending: boolean;
  planVisualizationError: string | null;
  onPlanVisualizationChange: (visualization: LargePlanVisualization) => void;
  recovery?: CliRecoveryActions;
  onOpenMenu: (position: OverlayMenuPosition) => void;
}) {
  const language = useLanguage();
  const windows = useMemo(() => sortedWindows(usage.windows), [usage.windows]);
  const paceByWindow = useMemo(
    () => new Map(pace.windows.map((window) => [window.windowId, window])),
    [pace.windows],
  );
  const canTogglePlanVisualization = windows.some((window) =>
    canUseWeeklyAllocation(paceByWindow.get(window.id)),
  );
  const currentVisualizationLabel =
    planVisualization === "deviation"
      ? text(language, "계획 대비", "Plan variance")
      : text(language, "주간 배분", "Weekly allocation");
  const nextVisualization: LargePlanVisualization =
    planVisualization === "deviation" ? "weeklyAllocation" : "deviation";
  const nextVisualizationAction =
    nextVisualization === "deviation"
      ? text(language, "계획 대비로", "to plan variance")
      : text(language, "주간 배분으로", "to weekly allocation");
  const toggleDescription = planVisualizationError
    ? text(
        language,
        `표시 방식 저장 실패: ${planVisualizationError}`,
        "Couldn't save the display mode.",
      )
    : text(
        language,
        `현재 7일 계획 표시: ${currentVisualizationLabel}. 클릭하면 ${nextVisualizationAction} 전환합니다.`,
        `Current 7-day plan display: ${currentVisualizationLabel}. Click to switch ${nextVisualizationAction}.`,
      );
  if (windows.length === 0) {
    return (
      <EmptySurface usage={usage} recovery={recovery} onOpenMenu={onOpenMenu} />
    );
  }

  const compactStaleAge =
    staleAgeLabel(usage.lastSuccessfulAt, undefined, language) ??
    text(language, "지연", "Delayed");

  return (
    <div
      className={`pace-list ${usage.connection === "stale" ? "is-stale" : ""}`}
      role="region"
      aria-label={text(language, "Codex 페이스 예측", "Codex pace forecast")}
    >
      <header className="pace-list-header">
        <div className="pace-list-title-status">
          <strong>Codex Pace</strong>
          {usage.connection === "stale" ? (
            <span
              className="pace-freshness-status is-stale"
              aria-label={staleLabel(
                usage.lastSuccessfulAt,
                undefined,
                language,
              )}
            >
              <i className="pace-freshness" aria-hidden="true" />
              <small aria-hidden="true">{compactStaleAge}</small>
            </span>
          ) : (
            <span
              className="pace-freshness"
              aria-label={text(language, "최신 사용량", "Latest usage")}
            />
          )}
        </div>
        <div className="pace-list-header-actions">
          {canTogglePlanVisualization && (
            <button
              type="button"
              className={`large-plan-toggle ${
                planVisualizationError ? "is-error" : ""
              }`}
              aria-busy={planVisualizationPending}
              aria-describedby={
                planVisualizationError ? "large-plan-toggle-error" : undefined
              }
              aria-label={toggleDescription}
              disabled={planVisualizationPending}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onPlanVisualizationChange(nextVisualization)}
            >
              {currentVisualizationLabel}
              <span className="large-plan-toggle-switch" aria-hidden="true">
                ⇄
              </span>
              {planVisualizationError && (
                <span className="large-plan-toggle-warning" aria-hidden="true">
                  !
                </span>
              )}
            </button>
          )}
          <MoreMenuButton onOpen={onOpenMenu} />
          {planVisualizationError && (
            <span
              id="large-plan-toggle-error"
              className="visually-hidden"
              role="status"
            >
              {text(
                language,
                `표시 방식 저장 실패: ${planVisualizationError}`,
                "Couldn't save the display mode.",
              )}
            </span>
          )}
        </div>
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
  const [language, setLanguage] = useState<Language>(DEFAULT_LANGUAGE);
  const [usage, setUsage] = useState<UsageViewState>(INITIAL_USAGE_STATE);
  const [pace, setPace] = useState<PaceViewState>(INITIAL_PACE_STATE);
  const [sizeMode, setSizeMode] = useState<OverlaySize>("middle");
  const [largePlanVisualization, setLargePlanVisualization] =
    useState<LargePlanVisualization>("deviation");
  const [opacity, setOpacity] = useState(DEFAULT_OVERLAY_OPACITY);
  const [appearancePhase, setAppearancePhase] =
    useState<OverlayAppearancePhase>("committed");
  const [configuredCliPath, setConfiguredCliPath] = useState<string | null>(
    null,
  );
  const [cliActionError, setCliActionError] = useState<string | null>(null);
  const [cliActionPending, setCliActionPending] = useState(false);
  const [planVisualizationError, setPlanVisualizationError] = useState<
    string | null
  >(null);
  const [planVisualizationPending, setPlanVisualizationPending] =
    useState(false);
  const [sizeReady, setSizeReady] = useState(false);
  const draggingRef = useRef(false);
  const planVisualizationPendingRef = useRef(false);
  const lastAppearanceUpdateIdRef = useRef(-1);

  const applyAppearanceUpdate = useCallback(
    (update: OverlayAppearanceUpdate) => {
      const appearance = update?.appearance;
      if (
        !Number.isInteger(update?.updateId) ||
        update.updateId <= lastAppearanceUpdateIdRef.current ||
        !Number.isInteger(appearance?.overlayOpacity) ||
        appearance.overlayOpacity < MIN_OVERLAY_OPACITY ||
        appearance.overlayOpacity > 100 ||
        !isLargePlanVisualization(appearance?.largePlanVisualization) ||
        !["preview", "committed", "reverted"].includes(update?.phase)
      ) {
        return;
      }
      lastAppearanceUpdateIdRef.current = update.updateId;
      setOpacity(appearance.overlayOpacity);
      setLargePlanVisualization(appearance.largePlanVisualization);
      setAppearancePhase(update.phase);
    },
    [],
  );

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
      title: text(
        language,
        "Codex CLI 실행 파일 선택",
        "Choose the Codex CLI executable",
      ),
    });
    if (typeof path !== "string") return;
    setCliActionPending(true);
    setCliActionError(null);
    try {
      await invoke<CliInfo>("set_codex_executable", { path });
      setConfiguredCliPath(path);
    } catch (error) {
      setCliActionError(cliActionErrorMessage(error, language));
    } finally {
      setCliActionPending(false);
    }
  }, [language]);
  const useAutomaticCli = useCallback(async () => {
    setCliActionPending(true);
    setCliActionError(null);
    try {
      await invoke("clear_codex_executable");
      setConfiguredCliPath(null);
    } catch (error) {
      setCliActionError(cliActionErrorMessage(error, language));
    } finally {
      setCliActionPending(false);
    }
  }, [language]);
  const changePlanVisualization = useCallback(
    async (visualization: LargePlanVisualization) => {
      if (planVisualizationPendingRef.current) return;
      planVisualizationPendingRef.current = true;
      setPlanVisualizationPending(true);
      setPlanVisualizationError(null);
      try {
        const update = await invoke<OverlayAppearanceUpdate>(
          "set_large_plan_visualization",
          { largePlanVisualization: visualization },
        );
        applyAppearanceUpdate(update);
      } catch (error) {
        setPlanVisualizationError(String(error));
      } finally {
        planVisualizationPendingRef.current = false;
        setPlanVisualizationPending(false);
      }
    },
    [applyAppearanceUpdate],
  );
  const showContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      if (draggingRef.current) return;
      void invoke("show_overlay_context_menu");
    },
    [],
  );
  const showMenuAt = useCallback((position: OverlayMenuPosition) => {
    void invoke("show_overlay_context_menu", { position });
  }, []);

  useEffect(() => {
    void invoke<Language>("get_language").then((value) => {
      if (isLanguage(value)) setLanguage(value);
    });
    void invoke<UsageViewState>("get_usage_state").then(setUsage);
    void invoke<PaceViewState>("get_pace_state").then(setPace);
    void Promise.all([
      invoke<OverlaySize>("get_overlay_size").then((size) => {
        if (isOverlaySize(size)) setSizeMode(size);
      }),
      invoke<OverlayAppearanceUpdate>("get_effective_overlay_appearance").then(
        applyAppearanceUpdate,
      ),
      invoke<string | null>("get_codex_executable_preference").then((path) => {
        setConfiguredCliPath(typeof path === "string" ? path : null);
      }),
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
    const unlistenOverlayAppearance = listen<OverlayAppearanceUpdate>(
      "ui://overlay-appearance-updated",
      (event) => applyAppearanceUpdate(event.payload),
    );
    const unlistenPace = listen<PaceViewState>(
      "pace://state-changed",
      (event) => setPace(event.payload),
    );
    const unlistenLanguage = listen<Language>(
      "ui://language-changed",
      (event) => {
        if (isLanguage(event.payload)) setLanguage(event.payload);
      },
    );
    return () => {
      void unlistenUsage.then((unlisten) => unlisten());
      void unlistenOverlaySize.then((unlisten) => unlisten());
      void unlistenOverlayAppearance.then((unlisten) => unlisten());
      void unlistenPace.then((unlisten) => unlisten());
      void unlistenLanguage.then((unlisten) => unlisten());
    };
  }, [applyAppearanceUpdate]);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

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
  const cliRecovery = canRecoverCli(usage.connection)
    ? {
        configuredPath: configuredCliPath,
        error: cliActionError,
        pending: cliActionPending,
        choose: chooseCli,
        useAutomatic: useAutomaticCli,
      }
    : undefined;

  return (
    <LanguageProvider language={language}>
      <main
        className={`overlay size-${sizeMode} ${
          sizeReady ? "is-size-ready" : ""
        } ${appearancePhase === "preview" ? "is-appearance-previewing" : ""}`}
        style={
          {
            "--overlay-opacity": opacity / 100,
          } as CSSProperties
        }
        data-tauri-drag-region
        onPointerDown={startDragging}
        onContextMenu={showContextMenu}
      >
        {sizeMode === "small" ? (
          <SmallOverlay
            usage={usage}
            featured={featured}
            pace={featuredPace}
            recovery={cliRecovery}
            onOpenMenu={showMenuAt}
          />
        ) : sizeMode === "middle" ? (
          <MiddleOverlay
            usage={usage}
            featured={featured}
            pace={featuredPace}
            recovery={cliRecovery}
            onOpenMenu={showMenuAt}
          />
        ) : (
          <LargeOverlay
            usage={usage}
            pace={pace}
            planVisualization={largePlanVisualization}
            planVisualizationPending={planVisualizationPending}
            planVisualizationError={planVisualizationError}
            onPlanVisualizationChange={(visualization) =>
              void changePlanVisualization(visualization)
            }
            recovery={cliRecovery}
            onOpenMenu={showMenuAt}
          />
        )}
      </main>
    </LanguageProvider>
  );
}

export default App;
