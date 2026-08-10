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
  OverlayAppearanceUpdate,
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

const cliMissing: UsageViewState = {
  connection: "cli_missing",
  windows: [],
  featuredWindowId: null,
  fetchedAt: null,
  lastSuccessfulAt: null,
  errorMessage:
    "Codex CLI를 찾을 수 없습니다. CLI를 설치하거나 실행 파일 경로를 선택해 주세요.",
};

function mockStartup(
  size: "small" | "middle" | "large" = "middle",
  usage = weeklyOnly,
  pace = weeklyPace,
  largePlanVisualization: LargePlanVisualization = "deviation",
  configuredCliPath: string | null = null,
  setCodexError: string | null = null,
  setVisualizationResult: Promise<OverlayAppearanceUpdate> | null = null,
) {
  mocks.invoke.mockImplementation(
    (command: string, args?: { largePlanVisualization?: string }) => {
    if (command === "get_usage_state") return Promise.resolve(usage);
    if (command === "get_pace_state") return Promise.resolve(pace);
    if (command === "get_overlay_size") return Promise.resolve(size);
    if (command === "get_effective_overlay_appearance")
      return Promise.resolve({
        appearance: {
          overlayOpacity: 100,
          largePlanVisualization,
        },
        phase: "committed",
        updateId: 0,
      });
    if (command === "get_codex_executable_preference")
      return Promise.resolve(configuredCliPath);
    if (command === "set_codex_executable" && setCodexError)
      return Promise.reject(setCodexError);
    if (command === "set_large_plan_visualization") {
      if (setVisualizationResult) return setVisualizationResult;
      return Promise.resolve({
        appearance: {
          overlayOpacity: 100,
          largePlanVisualization: args?.largePlanVisualization,
        },
        phase: "committed",
        updateId: 1,
      });
    }
    return Promise.resolve();
    },
  );
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
    const gauge = within(capsule).getByLabelText(
      "74% 남음 원형 게이지, 현재 시각 계획 기준 57% 남음",
    );
    expect(capsule).toHaveClass("small-card");
    expect(capsule).toHaveTextContent("Codex");
    expect(capsule).toHaveTextContent("주간");
    expect(
      getComputedStyle(capsule.querySelector(".small-copy") as HTMLElement)
        .paddingRight,
    ).toBe("0");
    expect(gauge).toHaveTextContent("74%");
    expect(gauge).toHaveStyle({
      "--remaining": "74",
      "--plan-remaining": "57.1",
    });
    expect(gauge.querySelector(".small-plan-marker")).toBeInTheDocument();
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
    const remaining = screen.getByText("74% 남음");
    expect(remaining).toHaveClass("middle-remaining");
    expect(remaining.closest(".middle-footer")).toBeInTheDocument();
    expect(
      screen.getByText("주간").closest(".middle-heading"),
    ).not.toContainElement(remaining);
    const meter = screen.getByLabelText(
      "74% 남음, 현재 시각 계획 기준 57% 남음",
    );
    expect(meter).toBeInTheDocument();
    expect(meter.querySelector(".usage-plan-marker")).toHaveStyle({
      left: "57.1%",
    });
    expect(screen.getByText(/리셋$/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "사용량 상세 펼치기" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Codex 사용량 상세" }),
    ).not.toBeInTheDocument();
  });

  it.each(["small", "middle", "large"] as const)(
    "%s은 더보기 메뉴 진입점을 제공한다",
    async (size) => {
      mockStartup(size);
      render(<App />);

      const button = await screen.findByRole("button", { name: "더보기 메뉴" });
      expect(button).toHaveAttribute("aria-haspopup", "menu");
    },
  );

  it("빈 상태와 CLI 오류 상태에서도 더보기 메뉴를 제공한다", async () => {
    mockStartup("middle", {
      ...weeklyOnly,
      connection: "no_limits",
      windows: [],
      featuredWindowId: null,
    });
    const firstRender = render(<App />);
    expect(
      await screen.findByRole("button", { name: "더보기 메뉴" }),
    ).toBeInTheDocument();
    firstRender.unmount();

    mockStartup("middle", cliMissing);
    render(<App />);
    expect(
      await screen.findByRole("button", { name: "더보기 메뉴" }),
    ).toBeInTheDocument();
  });

  it("CLI를 찾지 못하면 확장자 제한 없는 복구 선택을 제공한다", async () => {
    mockStartup("middle", cliMissing);
    mocks.open.mockResolvedValue("C:\\tools\\codex.cmd");
    render(<App />);

    const chooseButton = await screen.findByRole("button", {
      name: "CLI 선택",
    });
    fireEvent.pointerDown(chooseButton, { button: 0 });
    expect(mocks.startDragging).not.toHaveBeenCalled();

    fireEvent.click(chooseButton);
    await waitFor(() => {
      expect(mocks.open).toHaveBeenCalledWith({
        multiple: false,
        directory: false,
        title: "Codex CLI 실행 파일 선택",
      });
      expect(mocks.invoke).toHaveBeenCalledWith("set_codex_executable", {
        path: "C:\\tools\\codex.cmd",
      });
    });
  });

  it("CLI 선택을 취소하면 저장 명령을 호출하지 않는다", async () => {
    mockStartup("middle", cliMissing);
    mocks.open.mockResolvedValue(null);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "CLI 선택" }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalled());
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "set_codex_executable",
      expect.anything(),
    );
  });

  it("잘못된 CLI를 선택하면 오류를 표시하고 다시 선택할 수 있다", async () => {
    mockStartup(
      "middle",
      cliMissing,
      weeklyPace,
      "deviation",
      null,
      "설치된 Codex CLI가 app-server를 지원하지 않습니다.",
    );
    mocks.open.mockResolvedValue("C:\\tools\\old-codex.exe");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "CLI 선택" }));

    expect(
      await screen.findByText(
        "설치된 Codex CLI가 app-server를 지원하지 않습니다.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "CLI 선택" })).toBeEnabled();
  });

  it("저장된 경로가 실패하면 자동 탐지로 되돌릴 수 있다", async () => {
    mockStartup(
      "middle",
      { ...cliMissing, connection: "cli_unsupported" },
      weeklyPace,
      "deviation",
      "C:\\tools\\old-codex.exe",
    );
    render(<App />);

    expect(
      await screen.findByRole("button", { name: "다른 CLI 선택" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "자동 탐지" }));

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith("clear_codex_executable");
    });
  });

  it("small 오류 상태에서도 CLI 복구를 제공한다", async () => {
    mockStartup("small", cliMissing);
    render(<App />);

    expect(
      await screen.findByRole("button", { name: "CLI 선택" }),
    ).toBeInTheDocument();
  });

  it("로그인 오류와 정상 상태에서는 CLI 복구를 노출하지 않는다", async () => {
    mockStartup("middle", {
      ...cliMissing,
      connection: "login_required",
      errorMessage: "ChatGPT 계정으로 로그인한 Codex CLI가 필요합니다.",
    });
    const { unmount } = render(<App />);

    expect(
      await screen.findByText("Codex 로그인이 필요합니다"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /CLI 선택/ }),
    ).not.toBeInTheDocument();
    unmount();

    mockStartup();
    render(<App />);
    expect(await screen.findByText("74% 남음")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /CLI 선택/ }),
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

      const meter = await screen.findByLabelText(
        `${remainingPercent}% 남음, 현재 시각 계획 기준 57% 남음`,
      );
      const fill = meter.firstElementChild;

      expect(fill).toHaveClass(`tone-${tone}`);
      expect(getComputedStyle(fill!).getPropertyValue("--tone").trim()).toBe(
        `var(${token})`,
      );
    },
  );

  it.each([
    { size: "small" as const, marker: ".small-plan-marker" },
    { size: "middle" as const, marker: ".usage-plan-marker" },
  ])(
    "$size은 계획 정보가 없으면 기준점을 생략한다",
    async ({ size, marker }) => {
      mockStartup(size, weeklyOnly, { windows: [], updatedAt: null });
      render(<App />);

      expect(await screen.findByText("주간")).toBeInTheDocument();
      await waitFor(() => {
        expect(mocks.invoke).toHaveBeenCalledWith("get_pace_state");
      });
      expect(document.querySelector(marker)).not.toBeInTheDocument();
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
    const titleStatus = screen.getByText("Codex Pace").parentElement;
    expect(titleStatus).toHaveClass("pace-list-title-status");
    expect(
      within(titleStatus as HTMLElement).getByLabelText("최신 사용량"),
    ).toBeInTheDocument();
    expect(screen.queryByText("최신 사용량")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Codex$/)).not.toBeInTheDocument();
    expect(screen.getByText("계획상 17%p 여유")).toBeInTheDocument();
    expect(screen.getByText("계획보다 18%p 초과")).toBeInTheDocument();
    expect(screen.getByText("초기화 시 52% 사용 예상")).toBeInTheDocument();
    expect(screen.getByText("45분 일찍 소진")).toBeInTheDocument();
    expect(screen.queryByText("초기화 전 소진 예상")).not.toBeInTheDocument();
    expect(screen.getByText("누적 평균")).toBeInTheDocument();
    expect(screen.getByText("최근 8.3시간")).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        /현재 사용량 26%.*현재 시각 계획선 43%.*계획상 17%p 여유.*표시 범위 ±20%p/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        /소진 예상.*초기화.*최근 8.3시간의 평균 속도를 유지하면 초기화보다 45분 일찍 소진 예상/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        "누적 평균 속도를 유지하면 초기화 시 52% 사용 예상",
      ),
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
    expect(
      screen.getAllByRole("button", { name: /현재 7일 계획 표시/ }),
    ).toHaveLength(1);
    expect(
      container.querySelector(".plan-visual.with-transition"),
    ).not.toBeInTheDocument();

    mocks.listeners.get("ui://overlay-appearance-updated")?.({
      payload: {
        appearance: {
          overlayOpacity: 100,
          largePlanVisualization: "deviation",
        },
        phase: "preview",
        updateId: 1,
      },
    });
    await waitFor(() =>
      expect(container.querySelectorAll(".deviation-track")).toHaveLength(2),
    );
    await waitFor(() =>
      expect(
        container.querySelectorAll(".plan-visual.with-transition"),
      ).toHaveLength(1),
    );
    expect(
      container.querySelector(".allocation-track"),
    ).not.toBeInTheDocument();
  });

  it("Large 헤더 토글은 저장 성공 후 모든 주간 시각화를 전환하고 드래그를 시작하지 않는다", async () => {
    const secondWeeklyWindow = {
      ...weeklyOnly.windows[0],
      id: "codex:another-weekly",
    };
    mockStartup(
      "large",
      {
        ...weeklyOnly,
        windows: [weeklyOnly.windows[0], secondWeeklyWindow],
      },
      {
        ...weeklyPace,
        windows: [
          weeklyPace.windows[0],
          { ...weeklyPace.windows[0], windowId: secondWeeklyWindow.id },
        ],
      },
    );
    const { container } = render(<App />);
    const toggle = await screen.findByRole("button", {
      name: /현재 7일 계획 표시: 계획 대비.*주간 배분.*전환/,
    });
    expect(toggle.querySelector(".large-plan-toggle-switch")).toHaveTextContent(
      "⇄",
    );

    fireEvent.pointerDown(toggle);
    fireEvent.click(toggle);

    expect(mocks.startDragging).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_large_plan_visualization",
      { largePlanVisualization: "weeklyAllocation" },
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".allocation-track")).toHaveLength(2),
    );
    expect(
      screen.getByRole("button", {
        name: /현재 7일 계획 표시: 주간 배분.*계획 대비.*전환/,
      }),
    ).toHaveTextContent("주간 배분");
  });

  it("주간 시각화를 만들 수 없으면 Large 헤더 토글을 숨긴다", async () => {
    mockStartup("large", weeklyOnly, {
      ...weeklyPace,
      windows: [
        {
          ...weeklyPace.windows[0],
          planBreakdown: null,
        },
      ],
    });
    render(<App />);

    expect(await screen.findByText("Codex Pace")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /현재 7일 계획 표시/ }),
    ).not.toBeInTheDocument();
  });

  it("Large 표시 저장 중 중복 클릭을 막고 실패 상태에서 재시도한다", async () => {
    let rejectSave: ((reason?: unknown) => void) | undefined;
    const pendingSave = new Promise<OverlayAppearanceUpdate>((_, reject) => {
      rejectSave = reject;
    });
    mockStartup(
      "large",
      weeklyOnly,
      weeklyPace,
      "deviation",
      null,
      null,
      pendingSave,
    );
    render(<App />);
    const toggle = await screen.findByRole("button", {
      name: /현재 7일 계획 표시: 계획 대비/,
    });

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "set_large_plan_visualization",
      ),
    ).toHaveLength(1);
    expect(toggle).toBeDisabled();

    rejectSave?.("설정 파일을 저장할 수 없습니다.");
    const failedToggle = await screen.findByRole("button", {
      name: /표시 방식 저장 실패: 설정 파일을 저장할 수 없습니다/,
    });
    expect(failedToggle).toHaveTextContent("계획 대비");
    expect(failedToggle).toHaveClass("is-error");

    mocks.invoke.mockResolvedValue({
      appearance: {
        overlayOpacity: 100,
        largePlanVisualization: "weeklyAllocation",
      },
      phase: "committed",
      updateId: 1,
    });
    fireEvent.click(failedToggle);
    expect(
      await screen.findByRole("button", {
        name: /현재 7일 계획 표시: 주간 배분/,
      }),
    ).not.toHaveClass("is-error");
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
    expect(
      screen.getByLabelText(
        /초기 추정, 누적 평균 속도를 유지하면 초기화보다 2일 7시간 일찍 소진 가능/,
      ),
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
      "드래그하여 이동 · 우클릭 또는 더보기로 메뉴 열기",
    );

    fireEvent.contextMenu(overlay);

    expect(mocks.invoke).toHaveBeenCalledWith("show_overlay_context_menu");
  });

  it("더보기 버튼은 드래그하지 않고 버튼 아래에 네이티브 메뉴를 연다", async () => {
    render(<App />);
    const button = await screen.findByRole("button", { name: "더보기 메뉴" });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      x: 244,
      y: 6,
      left: 244,
      top: 6,
      right: 272,
      bottom: 34,
      width: 28,
      height: 28,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(button, { button: 0 });
    expect(mocks.startDragging).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(mocks.invoke).toHaveBeenCalledWith("show_overlay_context_menu", {
      position: { x: 244, y: 34 },
    });
  });

  it("트레이 크기 변경 이벤트를 즉시 반영한다", async () => {
    render(<App />);
    expect(await screen.findByText("주간")).toBeInTheDocument();

    mocks.listeners.get("ui://overlay-size-changed")?.({ payload: "small" });

    expect(
      await screen.findByLabelText("Codex · 주간 제한 74% 남음"),
    ).toBeInTheDocument();
  });

  it("최신 외형 미리보기만 투명도와 Large 표시 방식에 원자적으로 반영한다", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_usage_state") return Promise.resolve(weeklyOnly);
      if (command === "get_pace_state") return Promise.resolve(weeklyPace);
      if (command === "get_overlay_size") return Promise.resolve("large");
      if (command === "get_effective_overlay_appearance")
        return Promise.resolve({
          appearance: {
            overlayOpacity: 65,
            largePlanVisualization: "deviation",
          },
          phase: "committed",
          updateId: 4,
        });
      return Promise.resolve();
    });
    render(<App />);
    const overlay = await screen.findByTitle(
      "드래그하여 이동 · 우클릭 또는 더보기로 메뉴 열기",
    );

    expect(overlay).toHaveStyle({ "--overlay-opacity": "0.65" });
    expect(screen.getAllByText("계획 대비")).toHaveLength(2);
    mocks.listeners.get("ui://overlay-appearance-updated")?.({
      payload: {
        appearance: {
          overlayOpacity: 80,
          largePlanVisualization: "weeklyAllocation",
        },
        phase: "preview",
        updateId: 6,
      },
    });
    await waitFor(() =>
      expect(overlay).toHaveStyle({ "--overlay-opacity": "0.8" }),
    );
    expect(await screen.findByText("주간 계획 배분")).toBeInTheDocument();
    expect(overlay).toHaveClass("is-appearance-previewing");

    mocks.listeners.get("ui://overlay-appearance-updated")?.({
      payload: {
        appearance: {
          overlayOpacity: 40,
          largePlanVisualization: "deviation",
        },
        phase: "preview",
        updateId: 5,
      },
    });
    expect(overlay).toHaveStyle({ "--overlay-opacity": "0.8" });
    expect(screen.getByText("주간 계획 배분")).toBeInTheDocument();

    mocks.listeners.get("ui://overlay-appearance-updated")?.({
      payload: {
        appearance: {
          overlayOpacity: 65,
          largePlanVisualization: "unknown",
        },
        phase: "reverted",
        updateId: 7,
      },
    });
    expect(overlay).toHaveStyle({ "--overlay-opacity": "0.8" });
    expect(screen.getByText("주간 계획 배분")).toBeInTheDocument();
    expect(overlay).toHaveClass("is-appearance-previewing");

    mocks.listeners.get("ui://overlay-appearance-updated")?.({
      payload: {
        appearance: {
          overlayOpacity: 65,
          largePlanVisualization: "deviation",
        },
        phase: "reverted",
        updateId: 8,
      },
    });
    await waitFor(() =>
      expect(overlay).not.toHaveClass("is-appearance-previewing"),
    );
    expect(screen.getAllByText("계획 대비")).toHaveLength(2);
  });

  it("Large 표시 미리보기는 middle 오버레이의 크기를 바꾸지 않는다", async () => {
    render(<App />);
    expect(await screen.findByText("주간")).toBeInTheDocument();

    mocks.listeners.get("ui://overlay-appearance-updated")?.({
      payload: {
        appearance: {
          overlayOpacity: 80,
          largePlanVisualization: "weeklyAllocation",
        },
        phase: "preview",
        updateId: 1,
      },
    });

    expect(screen.getByText("74% 남음")).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Codex 페이스 예측" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /현재 7일 계획 표시/ }),
    ).not.toBeInTheDocument();
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
    expect(large).toHaveTextContent("2분 전");
    expect(
      within(large).getByLabelText("업데이트 지연 · 2분 전"),
    ).toBeInTheDocument();
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
