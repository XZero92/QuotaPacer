import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LargePlanVisualization,
  PaceViewState,
  UsageViewState,
} from "./types";
import App from "./App";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  startDragging: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (name: string, callback: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(name, callback);
      return Promise.resolve(() => mocks.listeners.delete(name));
    },
  ),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: mocks.startDragging }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));

const weeklyOnly: UsageViewState = {
  connection: "ready",
  windows: [
    {
      id: "codex:primary",
      bucketId: "codex",
      bucketLabel: null,
      usedPercent: 26,
      remainingPercent: 74,
      windowDurationMins: 10_080,
      resetsAt: 1_000_000,
    },
  ],
  featuredWindowId: "codex:primary",
  fetchedAt: 649_216,
  lastSuccessfulAt: 649_216,
  errorMessage: null,
};

const weeklyPace: PaceViewState = {
  windows: [
    {
      windowId: "codex:primary",
      forecastBasis: "periodAverage",
      observedHours: 97.4,
      projectedExhaustionAt: null,
      projectedEndPercent: 52,
      plannedUsedPercent: 42.9,
      planDeltaPercentPoints: -16.9,
      planBreakdown: {
        kind: "weekly",
        currentSegmentIndex: 2,
        segments: Array.from({ length: 7 }, (_, index) => ({
          startsAt: 395_200 + index * 86_400,
          endsAt: 395_200 + (index + 1) * 86_400,
          allocationPercent: 100 / 7,
          cumulativePercent: ((index + 1) * 100) / 7,
        })),
      },
      status: "safe",
      earlyEstimate: false,
    },
  ],
  updatedAt: 649_216,
};

function mockStartup(
  size: "small" | "middle" | "large" = "middle",
  usage = weeklyOnly,
  pace = weeklyPace,
  largePlanVisualization: LargePlanVisualization = "deviation",
) {
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "get_usage_state") return Promise.resolve(usage);
    if (command === "get_pace_state") return Promise.resolve(pace);
    if (command === "get_overlay_size") return Promise.resolve(size);
    if (command === "get_large_plan_visualization")
      return Promise.resolve(largePlanVisualization);
    if (command === "get_effective_overlay_opacity")
      return Promise.resolve({
        opacityPercent: 100,
        phase: "committed",
        updateId: 0,
      });
    return Promise.resolve();
  });
}

describe("Codex 사용량 오버레이", () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.invoke.mockReset();
    mocks.open.mockReset();
    mocks.startDragging.mockReset();
    mocks.startDragging.mockResolvedValue(undefined);
    mockStartup();
  });

  it("small은 캡슐 안의 원형 게이지와 동적 제한 기간을 표시한다", async () => {
    mockStartup("small");
    render(<App />);

    const capsule = await screen.findByLabelText("Codex · 주간 제한 74% 남음");
    const gauge = within(capsule).getByLabelText("74% 남음 원형 게이지");
    expect(capsule).toHaveClass("small-card");
    expect(capsule).toHaveTextContent("Codex");
    expect(capsule).toHaveTextContent("주간");
    expect(gauge).toHaveTextContent("74%");
    expect(gauge).toHaveStyle({ "--remaining": "74" });
    expect(screen.queryByText("5시간")).not.toBeInTheDocument();
  });

  it("small은 임의 제한 기간도 하드코딩하지 않고 표시한다", async () => {
    mockStartup("small", {
      ...weeklyOnly,
      windows: [
        {
          ...weeklyOnly.windows[0],
          id: "codex:45m",
          windowDurationMins: 45,
        },
      ],
      featuredWindowId: "codex:45m",
    });
    render(<App />);

    expect(await screen.findByText("45분")).toBeInTheDocument();
  });

  it("middle은 대표 제한 창을 바 게이지와 리셋 정보로 표시한다", async () => {
    render(<App />);

    expect(await screen.findByText("주간")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("74% 남음")).toBeInTheDocument();
    expect(screen.getByLabelText("74% 남음")).toBeInTheDocument();
    expect(screen.getByText(/리셋$/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "사용량 상세 펼치기" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Codex 사용량 상세" }),
    ).not.toBeInTheDocument();
  });

  it.each([
    { remainingPercent: 74, tone: "normal", token: "--color-actual" },
    { remainingPercent: 50, tone: "warning", token: "--color-plan-warning" },
    {
      remainingPercent: 19,
      tone: "danger",
      token: "--color-exhaustion-danger",
    },
  ])(
    "middle 게이지는 잔여량 $remainingPercent%에 $tone 색상을 적용한다",
    async ({ remainingPercent, tone, token }) => {
      mockStartup("middle", {
        ...weeklyOnly,
        windows: [
          {
            ...weeklyOnly.windows[0],
            usedPercent: 100 - remainingPercent,
            remainingPercent,
          },
        ],
      });
      render(<App />);

      const meter = await screen.findByLabelText(`${remainingPercent}% 남음`);
      const fill = meter.firstElementChild;

      expect(fill).toHaveClass(`tone-${tone}`);
      expect(getComputedStyle(fill!).getPropertyValue("--tone").trim()).toBe(
        `var(${token})`,
      );
    },
  );

  it("large는 상태 판정, 편차 게이지, forecast timeline을 모든 실제 제한 창에 표시한다", async () => {
    const multiWindow: UsageViewState = {
      ...weeklyOnly,
      windows: [
        weeklyOnly.windows[0],
        {
          id: "codex:secondary",
          bucketId: "codex",
          bucketLabel: null,
          usedPercent: 60,
          remainingPercent: 40,
          windowDurationMins: 300,
          resetsAt: 659_656,
        },
      ],
    };
    mockStartup("large", multiWindow, {
      windows: [
        weeklyPace.windows[0],
        {
          windowId: "codex:secondary",
          forecastBasis: "recent",
          observedHours: 8.25,
          projectedExhaustionAt: 657_000,
          projectedEndPercent: 125,
          plannedUsedPercent: 42,
          planDeltaPercentPoints: 18,
          status: "exhaustionRisk",
          earlyEstimate: false,
        },
      ],
      updatedAt: 649_216,
    });
    render(<App />);

    expect(
      await screen.findByRole("region", { name: "Codex 페이스 예측" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Codex Pace")).toBeInTheDocument();
    expect(screen.getByLabelText("최신 사용량")).toBeInTheDocument();
    expect(screen.queryByText("최신 사용량")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Codex$/)).not.toBeInTheDocument();
    expect(screen.getByText("계획상 17%p 여유")).toBeInTheDocument();
    expect(screen.getByText("계획보다 18%p 초과")).toBeInTheDocument();
    expect(screen.getByText("초기화 시 52% 사용 예상")).toBeInTheDocument();
    expect(screen.getByText("45분 일찍 소진")).toBeInTheDocument();
    expect(screen.queryByText("초기화 전 소진 예상")).not.toBeInTheDocument();
    expect(screen.getByText("기간 평균")).toBeInTheDocument();
    expect(screen.getByText("최근 8.3시간")).toBeInTheDocument();
    expect(
      screen.getByLabelText(/계획상 17%p 여유.*표시 범위 ±20%p/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/소진 예상.*초기화.*45분 일찍 소진/),
    ).toBeInTheDocument();
    expect(screen.getByText("현재 26% · 계획선 43%")).toBeInTheDocument();
    expect(screen.getByText("주간")).toBeInTheDocument();
    expect(screen.getByText("5시간")).toBeInTheDocument();
    const riskRow = screen.getByText("45분 일찍 소진").closest(".pace-row");
    const timeline = riskRow?.querySelector(".forecast-timeline");
    const gauge = riskRow?.querySelector(".plan-visual");
    expect(riskRow).not.toBeNull();
    expect(timeline).not.toBeNull();
    expect(gauge).not.toBeNull();
    expect(Array.from(riskRow!.children).indexOf(timeline!)).toBeLessThan(
      Array.from(riskRow!.children).indexOf(gauge!),
    );
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("set_overlay_layout", {
        size: "large",
        windowCount: 2,
      }),
    );
  });

  it("주간 배분 선택은 7일 제한에만 적용하고 다른 제한 창은 편차 게이지로 대체한다", async () => {
    const secondary = {
      ...weeklyOnly.windows[0],
      id: "codex:secondary",
      windowDurationMins: 300,
    };
    mockStartup(
      "large",
      {
        ...weeklyOnly,
        windows: [weeklyOnly.windows[0], secondary],
      },
      {
        ...weeklyPace,
        windows: [
          weeklyPace.windows[0],
          {
            ...weeklyPace.windows[0],
            windowId: secondary.id,
            planBreakdown: null,
          },
        ],
      },
      "weeklyAllocation",
    );
    const { container } = render(<App />);

    expect(
      await screen.findByLabelText(/요일별 계획 배분/),
    ).toBeInTheDocument();
    expect(container.querySelectorAll(".allocation-track")).toHaveLength(1);
    expect(container.querySelectorAll(".deviation-track")).toHaveLength(1);

    mocks.listeners.get("ui://large-plan-visualization-changed")?.({
      payload: "deviation",
    });
    await waitFor(() =>
      expect(container.querySelectorAll(".deviation-track")).toHaveLength(2),
    );
    expect(
      container.querySelector(".allocation-track"),
    ).not.toBeInTheDocument();
  });

  it("large는 페이스 갱신 이벤트의 계획 초과 상태를 반영한다", async () => {
    mockStartup("large");
    render(<App />);
    expect(
      await screen.findByText("초기화 시 52% 사용 예상"),
    ).toBeInTheDocument();

    mocks.listeners.get("pace://state-changed")?.({
      payload: {
        ...weeklyPace,
        windows: [
          {
            ...weeklyPace.windows[0],
            status: "planExceeded",
            planDeltaPercentPoints: 4,
          },
        ],
      },
    });

    expect(await screen.findByText("계획보다 4%p 빠름")).toBeInTheDocument();
    expect(screen.getByText("계획보다 4%p 초과")).toBeInTheDocument();
  });

  it("large는 계획 차이의 raw 1%p 경계를 적용하고 초과 구간만 강조한다", async () => {
    mockStartup(
      "large",
      {
        ...weeklyOnly,
        windows: [{ ...weeklyOnly.windows[0], usedPercent: 44 }],
      },
      {
        ...weeklyPace,
        windows: [
          {
            ...weeklyPace.windows[0],
            plannedUsedPercent: 42.9,
            planDeltaPercentPoints: 1.01,
            status: "planExceeded",
          },
        ],
      },
    );
    const { container } = render(<App />);

    expect(await screen.findByText("계획보다 1%p 빠름")).toBeInTheDocument();
    expect(screen.getByText("계획보다 1%p 초과")).toBeInTheDocument();
    const overrun = container.querySelector<HTMLElement>(
      ".deviation-stage-band.stage-borrow1",
    );
    expect(overrun).toHaveStyle({ left: "52.5%" });

    mocks.listeners.get("pace://state-changed")?.({
      payload: {
        ...weeklyPace,
        windows: [
          {
            ...weeklyPace.windows[0],
            plannedUsedPercent: 43,
            planDeltaPercentPoints: 1,
            status: "safe",
          },
        ],
      },
    });

    expect(
      await screen.findByText("초기화 시 52% 사용 예상"),
    ).toBeInTheDocument();
    expect(screen.getByText("계획 범위")).toBeInTheDocument();
    expect(
      screen.getByLabelText(/계획 범위.*표시 범위 ±20%p/),
    ).toBeInTheDocument();
    expect(
      container.querySelector(".deviation-marker.marker-near"),
    ).toHaveClass("stage-near");
  });

  it("large는 초기 소진 추정과 확정 소진 위험을 서로 다른 상태로 표시한다", async () => {
    const riskPace: PaceViewState = {
      windows: [
        {
          ...weeklyPace.windows[0],
          projectedExhaustionAt: 800_000,
          projectedEndPercent: 120,
          status: "exhaustionRisk",
          earlyEstimate: true,
        },
      ],
      updatedAt: weeklyPace.updatedAt,
    };
    mockStartup("large", weeklyOnly, riskPace);
    const { container } = render(<App />);

    expect(
      await screen.findByText(/초기 추정 · 2일 7시간 일찍 소진 가능/),
    ).toBeInTheDocument();
    expect(container.querySelector(".status-earlyRisk")).toBeInTheDocument();
    expect(
      Number.parseFloat(
        container.querySelector<HTMLElement>(".timeline-marker")?.style.left ??
          "",
      ),
    ).toBeCloseTo(43, 0);

    mocks.listeners.get("pace://state-changed")?.({
      payload: {
        ...riskPace,
        windows: [{ ...riskPace.windows[0], earlyEstimate: false }],
      },
    });

    expect(await screen.findByText("2일 7시간 일찍 소진")).toBeInTheDocument();
    expect(
      container.querySelector(".status-exhaustionRisk"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/초기화보다 약/)).not.toBeInTheDocument();
  });

  it("large 편차 게이지는 표시 범위를 벗어난 marker를 양끝에 고정한다", async () => {
    const edgeUsage: UsageViewState = {
      ...weeklyOnly,
      windows: [
        { ...weeklyOnly.windows[0], id: "start" },
        { ...weeklyOnly.windows[0], id: "end", windowDurationMins: 300 },
      ],
    };
    mockStartup("large", edgeUsage, {
      windows: [
        {
          ...weeklyPace.windows[0],
          windowId: "start",
          planDeltaPercentPoints: -30,
        },
        {
          ...weeklyPace.windows[0],
          windowId: "end",
          planDeltaPercentPoints: 30,
        },
      ],
      updatedAt: weeklyPace.updatedAt,
    });
    const { container } = render(<App />);

    await screen.findByRole("region", { name: "Codex 페이스 예측" });
    expect(
      container.querySelector(".deviation-marker.marker-under.is-clipped"),
    ).toHaveStyle({
      left: "0%",
    });
    expect(
      container.querySelector(".deviation-marker.marker-over.is-clipped"),
    ).toHaveStyle({
      left: "100%",
    });
  });

  it("large는 예측 결측과 계획 결측을 명시하고 marker를 생략한다", async () => {
    mockStartup("large", weeklyOnly, {
      windows: [
        {
          ...weeklyPace.windows[0],
          forecastBasis: "unavailable",
          projectedEndPercent: null,
          plannedUsedPercent: null,
          planDeltaPercentPoints: null,
          status: "unavailable",
        },
      ],
      updatedAt: null,
    });
    const { container } = render(<App />);

    expect(await screen.findByText("예측 준비 중")).toBeInTheDocument();
    expect(screen.getByText("현재 26% · 계획선 —")).toBeInTheDocument();
    expect(screen.getByLabelText("권장선 계산 불가")).toBeInTheDocument();
    expect(
      screen.getByLabelText("사용 기록이 더 필요합니다"),
    ).toBeInTheDocument();
    expect(
      container.querySelector(".deviation-marker"),
    ).not.toBeInTheDocument();
    expect(container.querySelector(".timeline-marker")).not.toBeInTheDocument();
  });

  it("large는 초기화 시점과 같은 소진 예측을 안전 상태로 표시한다", async () => {
    mockStartup("large", weeklyOnly, {
      windows: [
        {
          ...weeklyPace.windows[0],
          projectedExhaustionAt: weeklyOnly.windows[0].resetsAt,
          projectedEndPercent: null,
          status: "exhaustionRisk",
        },
      ],
      updatedAt: weeklyPace.updatedAt,
    });
    const { container } = render(<App />);

    expect(
      await screen.findByText("초기화 시 100% 사용 예상"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("초기화 시 100% 사용 예상")).toHaveLength(1);
    expect(container.querySelector(".timeline-marker")).not.toBeInTheDocument();
  });

  it("large는 소진 선행 시간을 OS 알림과 같은 일·시간 단위로 표시한다", async () => {
    const resetsAt = weeklyOnly.windows[0].resetsAt!;
    mockStartup(
      "large",
      {
        ...weeklyOnly,
        windows: [{ ...weeklyOnly.windows[0], resetsAt }],
      },
      {
        windows: [
          {
            ...weeklyPace.windows[0],
            projectedExhaustionAt: resetsAt - (25 * 60 + 30) * 60,
            projectedEndPercent: 120,
            status: "exhaustionRisk",
          },
        ],
        updatedAt: weeklyPace.updatedAt,
      },
    );
    render(<App />);

    expect(await screen.findByText("1일 1시간 일찍 소진")).toBeInTheDocument();
  });

  it("우클릭하면 네이티브 오버레이 메뉴를 요청한다", async () => {
    render(<App />);
    const overlay = await screen.findByTitle(
      "드래그하여 이동 · 우클릭하여 메뉴 열기",
    );

    fireEvent.contextMenu(overlay);

    expect(mocks.invoke).toHaveBeenCalledWith("show_overlay_context_menu");
  });

  it("트레이 크기 변경 이벤트를 즉시 반영한다", async () => {
    render(<App />);
    expect(await screen.findByText("주간")).toBeInTheDocument();

    mocks.listeners.get("ui://overlay-size-changed")?.({ payload: "small" });

    expect(
      await screen.findByLabelText("Codex · 주간 제한 74% 남음"),
    ).toBeInTheDocument();
  });

  it("최신 투명도 미리보기만 오버레이 전체에 반영한다", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_usage_state") return Promise.resolve(weeklyOnly);
      if (command === "get_pace_state") return Promise.resolve(weeklyPace);
      if (command === "get_overlay_size") return Promise.resolve("middle");
      if (command === "get_effective_overlay_opacity")
        return Promise.resolve({
          opacityPercent: 65,
          phase: "committed",
          updateId: 4,
        });
      return Promise.resolve();
    });
    render(<App />);
    const overlay = await screen.findByTitle(
      "드래그하여 이동 · 우클릭하여 메뉴 열기",
    );

    expect(overlay).toHaveStyle({ "--overlay-opacity": "0.65" });
    mocks.listeners.get("ui://overlay-opacity-updated")?.({
      payload: {
        opacityPercent: 80,
        phase: "preview",
        updateId: 6,
      },
    });
    await waitFor(() =>
      expect(overlay).toHaveStyle({ "--overlay-opacity": "0.8" }),
    );
    expect(overlay).toHaveClass("is-opacity-previewing");

    mocks.listeners.get("ui://overlay-opacity-updated")?.({
      payload: {
        opacityPercent: 40,
        phase: "preview",
        updateId: 5,
      },
    });
    expect(overlay).toHaveStyle({ "--overlay-opacity": "0.8" });

    mocks.listeners.get("ui://overlay-opacity-updated")?.({
      payload: {
        opacityPercent: 65,
        phase: "reverted",
        updateId: 7,
      },
    });
    await waitFor(() =>
      expect(overlay).not.toHaveClass("is-opacity-previewing"),
    );
  });

  it("마지막 성공 값이 있으면 stale 상태를 지연 표시와 함께 유지한다", async () => {
    mockStartup("middle", {
      ...weeklyOnly,
      connection: "stale",
      lastSuccessfulAt: Math.floor(Date.now() / 1_000) - 120,
      errorMessage: "연결이 끊겼습니다.",
    });
    render(<App />);

    expect(
      await screen.findByText("업데이트 지연 · 2분 전"),
    ).toBeInTheDocument();
    expect(screen.getByText("주간")).toBeInTheDocument();
  });

  it("stale 상태에서도 small과 large 카드 전체를 흐리게 하지 않는다", async () => {
    const staleUsage: UsageViewState = {
      ...weeklyOnly,
      connection: "stale",
      lastSuccessfulAt: Math.floor(Date.now() / 1_000) - 120,
    };
    mockStartup("small", staleUsage);
    const firstRender = render(<App />);

    const small = await screen.findByLabelText("Codex · 주간 제한 74% 남음");
    expect(small).toHaveClass("is-stale");
    expect(getComputedStyle(small).opacity).not.toBe("0.58");
    firstRender.unmount();

    mockStartup("large", staleUsage);
    render(<App />);

    const large = await screen.findByRole("region", {
      name: "Codex 페이스 예측",
    });
    expect(large).toHaveClass("is-stale");
    expect(large).toHaveTextContent("업데이트 지연 · 2분 전");
    expect(getComputedStyle(large).opacity).not.toBe("0.68");
  });

  it("인증됐지만 제한 창이 없으면 퍼센티지를 만들지 않는다", async () => {
    mockStartup("middle", {
      ...weeklyOnly,
      connection: "no_limits",
      windows: [],
      featuredWindowId: null,
    });
    render(<App />);

    expect(await screen.findByText("사용량 한도 없음")).toBeInTheDocument();
    expect(screen.queryByText(/% 남음/)).not.toBeInTheDocument();
  });
});
