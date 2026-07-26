import { describe, expect, it } from "vitest";
import type { UsageViewState, UsageWindow } from "./types";
import { calculatePace, paceLabel, type PaceView } from "./pace";

const usageWindow: UsageWindow = {
  id: "codex:primary",
  bucketId: "codex",
  bucketLabel: null,
  usedPercent: 26,
  remainingPercent: 74,
  windowDurationMins: 100,
  resetsAt: 10_000,
};

function state(overrides: Partial<UsageViewState> = {}): UsageViewState {
  return {
    connection: "ready",
    windows: [usageWindow],
    featuredWindowId: usageWindow.id,
    fetchedAt: 6_520,
    lastSuccessfulAt: 6_520,
    errorMessage: null,
    ...overrides,
  };
}

describe("균등 페이스", () => {
  it("소진율과 기간 경과율의 차이를 계산한다", () => {
    const pace = calculatePace(usageWindow, state());

    expect(pace.available).toBe(true);
    expect(pace.usedPercent).toBe(26);
    expect(pace.elapsedPercent).toBeCloseTo(42);
    expect(pace.deltaPercentPoints).toBeCloseTo(-16);
    expect(paceLabel(pace)).toBe("16%p 여유");
  });

  it("소진율이 기간 경과율보다 높으면 빠름으로 표시한다", () => {
    const pace = calculatePace(
      { ...usageWindow, usedPercent: 60, remainingPercent: 40 },
      state(),
    );

    expect(paceLabel(pace)).toBe("균등 페이스보다 18%p 빠름");
  });

  it("stale 상태에서는 마지막 성공 시각을 기준으로 계산한다", () => {
    const pace = calculatePace(
      usageWindow,
      state({
        connection: "stale",
        fetchedAt: 8_200,
        lastSuccessfulAt: 5_200,
      }),
    );

    expect(pace.elapsedPercent).toBeCloseTo(20);
    expect(pace.deltaPercentPoints).toBeCloseTo(6);
  });

  it.each([
    { windowDurationMins: null },
    { windowDurationMins: 0 },
    { resetsAt: null },
  ])("필수 제한 정보가 없으면 계산하지 않는다: %o", (override) => {
    const pace = calculatePace({ ...usageWindow, ...override }, state());

    expect(pace).toEqual({
      available: false,
      usedPercent: 26,
      elapsedPercent: null,
      deltaPercentPoints: null,
    });
    expect(paceLabel(pace)).toBe("페이스 계산 불가");
  });

  it("기준 시각이 없으면 계산하지 않는다", () => {
    const pace = calculatePace(
      usageWindow,
      state({ fetchedAt: null, lastSuccessfulAt: null }),
    );

    expect(pace.available).toBe(false);
  });

  it("기간 경과율을 0~100%로 제한한다", () => {
    expect(
      calculatePace(usageWindow, state({ fetchedAt: 1_000 })).elapsedPercent,
    ).toBe(0);
    expect(
      calculatePace(usageWindow, state({ fetchedAt: 20_000 })).elapsedPercent,
    ).toBe(100);
  });

  it("표시 차이를 가장 가까운 정수로 반올림한다", () => {
    const same: PaceView = {
      available: true,
      usedPercent: 50,
      elapsedPercent: 49.6,
      deltaPercentPoints: 0.4,
    };
    const faster: PaceView = {
      ...same,
      deltaPercentPoints: 2.6,
    };

    expect(paceLabel(same)).toBe("균등 페이스와 동일");
    expect(paceLabel(faster)).toBe("균등 페이스보다 3%p 빠름");
  });
});
