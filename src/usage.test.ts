import { describe, expect, it } from "vitest";
import type { UsageViewState, UsageWindow } from "./types";
import {
  featuredWindow,
  formatWindowDuration,
  sortedWindows,
  usageTone,
} from "./usage";

function window(overrides: Partial<UsageWindow>): UsageWindow {
  return {
    id: "codex:primary",
    bucketId: "codex",
    bucketLabel: null,
    usedPercent: 20,
    remainingPercent: 80,
    windowDurationMins: 300,
    resetsAt: null,
    ...overrides,
  };
}

function state(windows: UsageWindow[]): UsageViewState {
  return {
    connection: "ready",
    windows,
    featuredWindowId: null,
    fetchedAt: 1,
    lastSuccessfulAt: 1,
    errorMessage: null,
  };
}

describe("사용량 표시 규칙", () => {
  it("남은 비율, 리셋, 지속시간, ID 순으로 대표 창을 선택한다", () => {
    const windows = [
      window({
        id: "z",
        remainingPercent: 20,
        resetsAt: 200,
        windowDurationMins: 60,
      }),
      window({
        id: "b",
        remainingPercent: 20,
        resetsAt: 100,
        windowDurationMins: 120,
      }),
      window({
        id: "a",
        remainingPercent: 20,
        resetsAt: 100,
        windowDurationMins: 120,
      }),
      window({ id: "most", remainingPercent: 70 }),
    ];
    expect(featuredWindow(state(windows))?.id).toBe("a");
    expect(sortedWindows(windows).map(({ id }) => id)).toEqual([
      "a",
      "b",
      "z",
      "most",
    ]);
  });

  it("고정 및 동적 지속시간 라벨을 만든다", () => {
    expect(formatWindowDuration(300)).toBe("5시간");
    expect(formatWindowDuration(10_080)).toBe("주간");
    expect(formatWindowDuration(90)).toBe("90분");
    expect(formatWindowDuration(2_880)).toBe("2일");
    expect(formatWindowDuration(null)).toBe("사용량 한도");
  });

  it("색상 임계치를 경계값까지 적용한다", () => {
    expect(usageTone(51)).toBe("normal");
    expect(usageTone(50)).toBe("warning");
    expect(usageTone(20)).toBe("warning");
    expect(usageTone(19)).toBe("danger");
  });
});
