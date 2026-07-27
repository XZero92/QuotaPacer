import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaceViewState, UsageViewState } from "./types";
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
) {
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "get_usage_state") return Promise.resolve(usage);
    if (command === "get_pace_state") return Promise.resolve(pace);
    if (command === "get_overlay_size") return Promise.resolve(size);
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

  it("large는 상태 판정, 예측, 권장선을 모든 실제 제한 창에 표시한다", async () => {
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
    expect(screen.queryByText(/^Codex$/)).not.toBeInTheDocument();
    expect(screen.getByText("17%p 여유")).toBeInTheDocument();
    expect(screen.getByText("계획보다 18%p 초과")).toBeInTheDocument();
    expect(screen.getByText("초기화까지 충분")).toBeInTheDocument();
    expect(screen.getByText("초기화 전 소진 예상")).toBeInTheDocument();
    expect(screen.getByText("기간 평균")).toBeInTheDocument();
    expect(screen.getByText("최근 8.3시간")).toBeInTheDocument();
    expect(
      screen.getByLabelText("26% 사용, 현재 권장 43%"),
    ).toBeInTheDocument();
    expect(screen.getByText("주간")).toBeInTheDocument();
    expect(screen.getByText("5시간")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("set_overlay_layout", {
        size: "large",
        windowCount: 2,
      }),
    );
  });

  it("large는 페이스 갱신 이벤트의 계획 초과 상태를 반영한다", async () => {
    mockStartup("large");
    render(<App />);
    expect(await screen.findByText("초기화까지 충분")).toBeInTheDocument();

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

    expect(await screen.findByText("계획보다 4%p 초과")).toBeInTheDocument();
    expect(screen.getByText("초기화까지 충분")).toBeInTheDocument();
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
