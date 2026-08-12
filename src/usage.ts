import type { UsageViewState, UsageWindow } from "./types";
import type { Language } from "./types";
import { locale, text } from "./i18n";

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

export function formatWindowDuration(
  minutes: number | null,
  language: Language = "ko",
) {
  if (minutes === null) return text(language, "사용량 한도", "Usage limit");
  if (minutes === 300) return text(language, "5시간", "5 hours");
  if (minutes === 10_080) return text(language, "주간", "Weekly");
  if (minutes < 60) return text(language, `${minutes}분`, `${minutes} min`);
  if (minutes % 1_440 === 0)
    return text(language, `${minutes / 1_440}일`, `${minutes / 1_440} days`);
  if (minutes % 60 === 0)
    return text(language, `${minutes / 60}시간`, `${minutes / 60} hours`);
  return text(language, `${minutes}분`, `${minutes} min`);
}

export function formatResetTime(
  timestamp: number | null,
  language: Language = "ko",
) {
  if (timestamp === null)
    return text(language, "리셋 시각 미정", "Reset time unknown");
  return new Intl.DateTimeFormat(locale(language), {
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
  language: Language = "ko",
) {
  if (lastSuccessfulAt === null) return null;
  const minutes = Math.max(
    0,
    Math.floor((now - lastSuccessfulAt * 1_000) / 60_000),
  );
  return text(language, `${minutes}분 전`, `${minutes} min ago`);
}

export function staleLabel(
  lastSuccessfulAt: number | null,
  now = Date.now(),
  language: Language = "ko",
) {
  const age = staleAgeLabel(lastSuccessfulAt, now, language);
  return age === null
    ? text(language, "업데이트 지연", "Update delayed")
    : text(language, `업데이트 지연 · ${age}`, `Update delayed · ${age}`);
}
