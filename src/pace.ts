import type { UsageViewState, UsageWindow } from "./types";

export interface PaceView {
  available: boolean;
  usedPercent: number;
  elapsedPercent: number | null;
  deltaPercentPoints: number | null;
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, value));
}

function referenceTimestamp(state: UsageViewState) {
  if (state.connection === "stale") return state.lastSuccessfulAt;
  return state.fetchedAt ?? state.lastSuccessfulAt;
}

export function calculatePace(
  window: UsageWindow,
  state: UsageViewState,
): PaceView {
  const usedPercent = clampPercent(window.usedPercent);
  const asOf = referenceTimestamp(state);
  const durationMinutes = window.windowDurationMins;
  const resetsAt = window.resetsAt;

  if (
    asOf === null ||
    resetsAt === null ||
    durationMinutes === null ||
    durationMinutes <= 0
  ) {
    return {
      available: false,
      usedPercent,
      elapsedPercent: null,
      deltaPercentPoints: null,
    };
  }

  const durationSeconds = durationMinutes * 60;
  const startsAt = resetsAt - durationSeconds;
  const elapsedPercent = clampPercent(
    ((asOf - startsAt) / durationSeconds) * 100,
  );

  return {
    available: true,
    usedPercent,
    elapsedPercent,
    deltaPercentPoints: usedPercent - elapsedPercent,
  };
}

export function paceLabel(pace: PaceView) {
  if (!pace.available || pace.deltaPercentPoints === null) {
    return "페이스 계산 불가";
  }

  const rounded = Math.round(pace.deltaPercentPoints);
  if (rounded === 0) return "균등 페이스와 동일";
  if (rounded > 0) return `균등 페이스보다 ${rounded}%p 빠름`;
  return `${Math.abs(rounded)}%p 여유`;
}
