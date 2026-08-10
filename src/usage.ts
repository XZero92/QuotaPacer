import type { UsageViewState, UsageWindow } from "./types";

export const INITIAL_USAGE_STATE: UsageViewState = {
  connection: "starting",
  windows: [],
  featuredWindowId: null,
  fetchedAt: null,
  lastSuccessfulAt: null,
  errorMessage: null,
};

export function compareUsageWindows(left: UsageWindow, right: UsageWindow) {
  return (
    left.remainingPercent - right.remainingPercent ||
    (left.resetsAt ?? Number.MAX_SAFE_INTEGER) -
      (right.resetsAt ?? Number.MAX_SAFE_INTEGER) ||
    (left.windowDurationMins ?? Number.MAX_SAFE_INTEGER) -
      (right.windowDurationMins ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id)
  );
}

export function sortedWindows(windows: UsageWindow[]) {
  return [...windows].sort(compareUsageWindows);
}

export function featuredWindow(state: UsageViewState) {
  const declared = state.windows.find(
    (window) => window.id === state.featuredWindowId,
  );
  return declared ?? sortedWindows(state.windows)[0] ?? null;
}

export function formatWindowDuration(minutes: number | null) {
  if (minutes === null) return "사용량 한도";
  if (minutes === 300) return "5시간";
  if (minutes === 10_080) return "주간";
  if (minutes < 60) return `${minutes}분`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}일`;
  if (minutes % 60 === 0) return `${minutes / 60}시간`;
  return `${minutes}분`;
}

export function formatResetTime(timestamp: number | null) {
  if (timestamp === null) return "리셋 시각 미정";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp * 1_000));
}

export function usageTone(remainingPercent: number) {
  if (remainingPercent < 20) return "danger";
  if (remainingPercent <= 50) return "warning";
  return "normal";
}

export function staleAgeLabel(
  lastSuccessfulAt: number | null,
  now = Date.now(),
) {
  if (lastSuccessfulAt === null) return null;
  const minutes = Math.max(
    0,
    Math.floor((now - lastSuccessfulAt * 1_000) / 60_000),
  );
  return `${minutes}분 전`;
}

export function staleLabel(lastSuccessfulAt: number | null, now = Date.now()) {
  const age = staleAgeLabel(lastSuccessfulAt, now);
  return age === null ? "업데이트 지연" : `업데이트 지연 · ${age}`;
}
