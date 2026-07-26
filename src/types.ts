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
