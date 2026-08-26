import { describe, expect, it } from "vitest";
import type { UsageViewState, UsageWindow } from "./types";
import {
  featuredWindow,
  formatCompactWindowDuration,
  formatWindowDuration,
  preferredCompactWindow,
  sortedWindows,
  staleAgeLabel,
  staleLabel,
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

  it("Compact는 주간 잔량과 관계없이 300분 창을 우선한다", () => {
    const weekly = window({
      id: "weekly",
      remainingPercent: 5,
      windowDurationMins: 10_080,
    });
    const fiveHours = window({
      id: "five-hours",
      remainingPercent: 98,
      windowDurationMins: 300,
    });
    expect(preferredCompactWindow(state([weekly, fiveHours]))?.id).toBe(
      "five-hours",
    );
  });

  it("여러 300분 창은 기존 정렬 규칙을 사용하고 소멸 시 기존 대표 창으로 대체한다", () => {
    const weekly = window({
      id: "weekly",
      remainingPercent: 5,
      windowDurationMins: 10_080,
    });
    const later = window({
      id: "later",
      remainingPercent: 40,
      resetsAt: 200,
    });
    const sooner = window({
      id: "sooner",
      remainingPercent: 40,
      resetsAt: 100,
    });
    expect(preferredCompactWindow(state([weekly, later, sooner]))?.id).toBe(
      "sooner",
    );
    expect(preferredCompactWindow(state([weekly]))?.id).toBe("weekly");
    expect(preferredCompactWindow(state([weekly, later]))?.id).toBe("later");
  });

  it("고정 및 동적 지속시간 라벨을 만든다", () => {
    expect(formatWindowDuration(300)).toBe("5시간");
    expect(formatWindowDuration(10_080)).toBe("주간");
    expect(formatWindowDuration(90)).toBe("90분");
    expect(formatWindowDuration(2_880)).toBe("2일");
    expect(formatWindowDuration(null)).toBe("사용량 한도");
    expect(formatWindowDuration(10_080, "en")).toBe("Weekly");
    expect(formatWindowDuration(90, "en")).toBe("90 min");
  });

  it("Small용 지속시간은 영어 단위를 한 줄 축약형으로 만든다", () => {
    expect(formatCompactWindowDuration(300)).toBe("5시간");
    expect(formatCompactWindowDuration(45)).toBe("45분");
    expect(formatCompactWindowDuration(300, "en")).toBe("5h");
    expect(formatCompactWindowDuration(45, "en")).toBe("45m");
  });

  it("색상 임계치를 경계값까지 적용한다", () => {
    expect(usageTone(51)).toBe("normal");
    expect(usageTone(50)).toBe("warning");
    expect(usageTone(20)).toBe("warning");
    expect(usageTone(19)).toBe("danger");
  });

  it("stale 경과 시간의 전체 라벨과 축약 라벨을 같은 기준으로 만든다", () => {
    const now = 180_000;

    expect(staleAgeLabel(180, now)).toBe("0분 전");
    expect(staleLabel(180, now)).toBe("업데이트 지연 · 0분 전");
    expect(staleAgeLabel(60, now)).toBe("2분 전");
    expect(staleLabel(60, now)).toBe("업데이트 지연 · 2분 전");
    expect(staleAgeLabel(null, now)).toBeNull();
    expect(staleLabel(null, now)).toBe("업데이트 지연");
  });
});
