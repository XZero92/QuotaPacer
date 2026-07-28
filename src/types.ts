export type ConnectionState =
  | "starting"
  | "ready"
  | "stale"
  | "no_limits"
  | "cli_missing"
  | "cli_unsupported"
  | "login_required"
  | "unsupported_auth"
  | "error";

export interface UsageWindow {
  id: string;
  bucketId: string;
  bucketLabel: string | null;
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface UsageViewState {
  connection: ConnectionState;
  windows: UsageWindow[];
  featuredWindowId: string | null;
  fetchedAt: number | null;
  lastSuccessfulAt: number | null;
  errorMessage: string | null;
}

export interface CliInfo {
  path: string;
  version: string;
  meetsRecommendedVersion: boolean;
  appServerSupported: boolean;
}

export type ForecastBasis = "recent" | "periodAverage" | "unavailable";
export type PaceStatus =
  "safe" | "planExceeded" | "exhaustionRisk" | "unavailable";

export interface PaceWindowView {
  windowId: string;
  forecastBasis: ForecastBasis;
  observedHours: number | null;
  projectedExhaustionAt: number | null;
  projectedEndPercent: number | null;
  plannedUsedPercent: number | null;
  planDeltaPercentPoints: number | null;
  status: PaceStatus;
  earlyEstimate: boolean;
}

export interface PaceViewState {
  windows: PaceWindowView[];
  updatedAt: number | null;
}

export type PacePlanMode = "even" | "weekday";

export interface PaceSettings {
  planMode: PacePlanMode;
  weekdayAllocations: number[];
  osNotificationsEnabled: boolean;
}

export interface EditableSettings {
  paceSettings: PaceSettings;
  overlayOpacity: number;
}

export interface SettingsSession {
  sessionId: number;
  settings: EditableSettings;
}

export type OverlayOpacityPhase = "preview" | "committed" | "reverted";

export interface OverlayOpacityUpdate {
  opacityPercent: number;
  phase: OverlayOpacityPhase;
  updateId: number;
}

export const MIN_OVERLAY_OPACITY = 40;
export const DEFAULT_OVERLAY_OPACITY = 100;
