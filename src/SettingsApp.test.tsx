import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditableSettings } from "./types";
import SettingsApp, { normalizeWeekdayWeights } from "./SettingsApp";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  hide: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  sessionId: 0,
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
  getCurrentWindow: () => ({ hide: mocks.hide }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: mocks.isPermissionGranted,
  requestPermission: mocks.requestPermission,
}));

const savedSettings: EditableSettings = {
  paceSettings: {
    weekdayWeights: [5, 5, 5, 5, 5, 5, 5],
    osNotificationsEnabled: false,
  },
  overlayOpacity: 100,
  language: "ko",
};

async function renderLoadedSettings() {
  render(<SettingsApp />);
  const slider = await screen.findByLabelText("오버레이 투명도");
  await waitFor(() => expect(slider).toBeEnabled());
  return slider;
}

describe("요일별 강도 계산", () => {
  it("0.1% 최대 나머지 방식으로 정확히 100%를 배분한다", () => {
    expect(normalizeWeekdayWeights([5, 5, 5, 5, 5, 5, 5])).toEqual([
      14.3, 14.3, 14.3, 14.3, 14.3, 14.3, 14.2,
    ]);
    expect(normalizeWeekdayWeights([8, 8, 8, 8, 8, 5, 5])).toEqual([
      16, 16, 16, 16, 16, 10, 10,
    ]);
    expect(normalizeWeekdayWeights([4, 4, 4, 4, 4, 10, 10])).toEqual([
      10, 10, 10, 10, 10, 25, 25,
    ]);
    expect(normalizeWeekdayWeights([0, 0, 0, 0, 0, 0, 0])).toEqual([
      14.3, 14.3, 14.3, 14.3, 14.3, 14.3, 14.2,
    ]);
  });
});

describe("설정 창", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.hide.mockReset();
    mocks.isPermissionGranted.mockReset();
    mocks.requestPermission.mockReset();
    mocks.listeners.clear();
    mocks.sessionId = 0;
    mocks.hide.mockResolvedValue(undefined);
    mocks.isPermissionGranted.mockResolvedValue(false);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      window.clearTimeout(id),
    );
    mocks.invoke.mockImplementation(
      (command: string, args?: Record<string, unknown>) => {
        if (command === "begin_settings_session") {
          mocks.sessionId += 1;
          return Promise.resolve({
            sessionId: mocks.sessionId,
            settings: savedSettings,
          });
        }
        if (command === "save_editable_settings") {
          mocks.sessionId += 1;
          return Promise.resolve({
            sessionId: mocks.sessionId,
            settings: args?.settings,
          });
        }
        return Promise.resolve();
      },
    );
  });

  it("계획 모드와 숫자 입력 없이 요일별 강도 이퀄라이저를 표시한다", async () => {
    await renderLoadedSettings();

    expect(
      screen.queryByRole("radiogroup", { name: "계획 모드" }),
    ).not.toBeInTheDocument();
    expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);
    expect(
      screen.getAllByRole("slider", { name: /요일 상대 사용 강도$/ }),
    ).toHaveLength(7);
    expect(screen.getByLabelText("월요일 상대 사용 강도")).toHaveValue("5");
    expect(screen.getByText("합계 100.0%")).toBeInTheDocument();
    expect(screen.getAllByText("14.3%")).toHaveLength(6);
    expect(screen.getByText("14.2%")).toBeInTheDocument();
  });

  it("Large 계획 표시 방식은 설정 화면에서 제공하지 않는다", async () => {
    await renderLoadedSettings();

    expect(
      screen.queryByRole("radiogroup", { name: "Large 모드 7일 계획 표시" }),
    ).not.toBeInTheDocument();
  });

  it("연속된 투명도 변경은 최신 값 하나로 미리보기한다", async () => {
    const slider = await renderLoadedSettings();

    fireEvent.change(slider, { target: { value: "70" } });
    fireEvent.change(slider, { target: { value: "65" } });

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("preview_overlay_opacity", {
        sessionId: 1,
        revision: 1,
        overlayOpacity: 65,
      }),
    );
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "preview_overlay_opacity",
      ),
    ).toHaveLength(1);
  });

  it("한 요일의 강도만 바꾸고 실제 배분 합계를 100%로 유지한다", async () => {
    await renderLoadedSettings();
    const sliders = screen.getAllByRole("slider", {
      name: /요일 상대 사용 강도$/,
    });
    fireEvent.change(sliders[0], { target: { value: "10" } });

    expect(sliders[0]).toHaveValue("10");
    sliders.slice(1).forEach((slider) => expect(slider).toHaveValue("5"));
    expect(screen.getByText("25.0%")).toBeInTheDocument();
    expect(screen.getAllByText("12.5%")).toHaveLength(6);
    expect(
      screen.getByText(/막대는 자동으로 움직이지 않습니다/),
    ).toBeInTheDocument();
  });

  it("프리셋으로 평일 중심과 주말 중심 강도를 적용한다", async () => {
    await renderLoadedSettings();
    fireEvent.click(screen.getByRole("button", { name: "평일 중심" }));
    expect(screen.getByLabelText("월요일 상대 사용 강도")).toHaveValue("8");
    expect(screen.getByLabelText("토요일 상대 사용 강도")).toHaveValue("5");
    expect(screen.getAllByText("16.0%")).toHaveLength(5);
    expect(screen.getAllByText("10.0%")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "주말 중심" }));
    expect(screen.getByLabelText("월요일 상대 사용 강도")).toHaveValue("4");
    expect(screen.getByLabelText("토요일 상대 사용 강도")).toHaveValue("10");
    expect(screen.getAllByText("10.0%")).toHaveLength(5);
    expect(screen.getAllByText("25.0%")).toHaveLength(2);
  });

  it("모든 요일이 0이 되는 마지막 조작을 막는다", async () => {
    await renderLoadedSettings();
    const sliders = screen.getAllByRole("slider", {
      name: /요일 상대 사용 강도$/,
    });
    sliders.slice(0, 6).forEach((slider) => {
      fireEvent.change(slider, { target: { value: "0" } });
    });
    fireEvent.change(sliders[6], { target: { value: "0" } });

    sliders.slice(0, 6).forEach((slider) => expect(slider).toHaveValue("0"));
    expect(sliders[6]).toHaveValue("5");
    expect(
      screen.getByText(/최소 한 요일의 사용 강도는 1 이상/),
    ).toBeInTheDocument();
  });

  it("잘못된 요일별 강도 초안은 균등 배분으로 복구한다", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "begin_settings_session") {
        return Promise.resolve({
          sessionId: 1,
          settings: {
            ...savedSettings,
            paceSettings: {
              ...savedSettings.paceSettings,
              weekdayWeights: [0, 0, 0, 0, 0, 0, 0],
            },
          },
        });
      }
      if (command === "save_editable_settings") {
        return Promise.resolve({ sessionId: 2, settings: savedSettings });
      }
      return Promise.resolve();
    });
    await renderLoadedSettings();

    expect(
      screen.getAllByRole("slider", { name: /요일 상대 사용 강도$/ }),
    ).toHaveLength(7);
    expect(screen.getByLabelText("월요일 상대 사용 강도")).toHaveValue("5");
    expect(
      screen.getAllByText(/잘못된 요일별 강도 초안을 균등 배분으로 복구/)
        .length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
  });

  it("투명도 수치는 기본으로 숨기고 슬라이더 조작 중에만 표시한다", async () => {
    const slider = await renderLoadedSettings();
    expect(screen.queryByTestId("opacity-tooltip")).not.toBeInTheDocument();

    fireEvent.pointerDown(slider);
    expect(screen.getByTestId("opacity-tooltip")).toHaveTextContent("100%");
    fireEvent.change(slider, { target: { value: "65" } });
    expect(screen.getByTestId("opacity-tooltip")).toHaveTextContent("65%");

    fireEvent.pointerUp(slider);
    expect(screen.queryByTestId("opacity-tooltip")).not.toBeInTheDocument();
  });

  it("강도, 알림 활성화와 투명도를 전역 저장으로 한 번에 확정한다", async () => {
    mocks.requestPermission.mockResolvedValue("granted");
    const slider = await renderLoadedSettings();

    fireEvent.click(screen.getByLabelText("OS 경고 알림 사용"));
    await waitFor(() => expect(mocks.requestPermission).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "평일 중심" }));
    fireEvent.change(slider, { target: { value: "65" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("save_editable_settings", {
        sessionId: 1,
        settings: expect.objectContaining({
          overlayOpacity: 65,
          paceSettings: expect.objectContaining({
            osNotificationsEnabled: true,
            weekdayWeights: [8, 8, 8, 8, 8, 5, 5],
          }),
        }),
      }),
    );
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
  });

  it("알림 권한 거부 시 인라인 경고를 유지한다고 안내한다", async () => {
    mocks.requestPermission.mockResolvedValue("denied");
    await renderLoadedSettings();
    fireEvent.click(screen.getByLabelText("OS 경고 알림 사용"));

    expect(
      await screen.findByText(/인라인 경고는 계속 표시됩니다/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("OS 경고 알림 사용")).not.toBeChecked();
  });

  it("미저장 닫기에서 계속 편집하거나 변경사항을 폐기할 수 있다", async () => {
    const slider = await renderLoadedSettings();
    fireEvent.change(slider, { target: { value: "65" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 닫기" }));

    expect(
      screen.getByRole("alertdialog", { name: "변경사항을 저장할까요?" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "계속 편집" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(mocks.hide).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "설정 닫기" }));
    fireEvent.click(screen.getByRole("button", { name: "변경사항 폐기" }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cancel_settings_session", {
        sessionId: 1,
      }),
    );
    expect(slider).toHaveValue("100");
    expect(mocks.hide).toHaveBeenCalled();
  });

  it("네이티브 닫기와 Esc도 동일한 미저장 확인 흐름을 사용한다", async () => {
    const slider = await renderLoadedSettings();
    fireEvent.change(slider, { target: { value: "65" } });

    mocks.listeners.get("ui://settings-close-requested")?.({
      payload: undefined,
    });
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  });

  it("닫기 확인에서 저장하면 새 세션을 정리한 뒤 창을 숨긴다", async () => {
    const slider = await renderLoadedSettings();
    fireEvent.change(slider, { target: { value: "65" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 닫기" }));
    fireEvent.click(screen.getAllByRole("button", { name: "저장" })[1]);

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("cancel_settings_session", {
        sessionId: 2,
      }),
    );
    expect(mocks.hide).toHaveBeenCalled();
  });

  it("설정 창을 다시 열면 미저장 초안 대신 최신 저장값을 불러온다", async () => {
    const slider = await renderLoadedSettings();
    fireEvent.change(slider, { target: { value: "65" } });
    mocks.invoke.mockImplementation(
      (command: string, args?: Record<string, unknown>) => {
        if (command === "begin_settings_session") {
          return Promise.resolve({
            sessionId: 2,
            settings: {
              ...savedSettings,
              overlayOpacity: 80,
            },
          });
        }
        if (command === "save_editable_settings") {
          return Promise.resolve({ sessionId: 3, settings: args?.settings });
        }
        return Promise.resolve();
      },
    );

    mocks.listeners.get("ui://settings-opened")?.({ payload: undefined });

    await waitFor(() => expect(slider).toHaveValue("80"));
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
  });

  it("설정 열기 요청이 초기 로드와 겹치면 세션 시작을 직렬화한다", async () => {
    let resolveFirst:
      | ((value: { sessionId: number; settings: EditableSettings }) => void)
      | undefined;
    let beginCalls = 0;
    mocks.invoke.mockImplementation((command: string) => {
      if (command !== "begin_settings_session") return Promise.resolve();
      beginCalls += 1;
      if (beginCalls === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        sessionId: 2,
        settings: { ...savedSettings, overlayOpacity: 80 },
      });
    });
    render(<SettingsApp />);
    await waitFor(() => expect(resolveFirst).toBeDefined());

    mocks.listeners.get("ui://settings-opened")?.({ payload: undefined });
    expect(beginCalls).toBe(1);
    resolveFirst?.({ sessionId: 1, settings: savedSettings });

    await waitFor(() => expect(beginCalls).toBe(2));
    expect(await screen.findByLabelText("오버레이 투명도")).toHaveValue("80");
  });

  it("권한 허용 후 변경사항을 폐기하면 앱 알림 값만 복원한다", async () => {
    mocks.requestPermission.mockResolvedValue("granted");
    await renderLoadedSettings();
    fireEvent.click(screen.getByLabelText("OS 경고 알림 사용"));
    await waitFor(() =>
      expect(screen.getByLabelText("OS 경고 알림 사용")).toBeChecked(),
    );

    fireEvent.click(screen.getByRole("button", { name: "설정 닫기" }));
    fireEvent.click(screen.getByRole("button", { name: "변경사항 폐기" }));

    await waitFor(() =>
      expect(screen.getByLabelText("OS 경고 알림 사용")).not.toBeChecked(),
    );
    expect(screen.getByText(/허용됨/)).toBeInTheDocument();
  });

  it("최근 이력 삭제는 즉시 실행하고 설정을 dirty로 만들지 않는다", async () => {
    await renderLoadedSettings();
    expect(
      screen.getByText(/최근 사용률 이력과 알림 중복 방지 상태를 최대 25시간/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "이력 삭제" }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("clear_pace_history"),
    );
    expect(
      await screen.findByText("최근 페이스 이력과 알림 상태를 삭제했습니다."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "설정 닫기" }));
    await waitFor(() => expect(mocks.hide).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("영어를 선택해 설정 화면을 전환하고 언어 값을 저장한다", async () => {
    await renderLoadedSettings();

    fireEvent.change(screen.getByLabelText("표시 언어"), {
      target: { value: "en" },
    });

    expect(mocks.invoke).toHaveBeenCalledWith("preview_language", {
      sessionId: 1,
      revision: 1,
      language: "en",
    });

    expect(
      screen.getByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();
    const weeklyPlanHeading = screen
      .getByText("Weekly usage plan")
      .closest(".weekly-plan-heading");
    const weeklyPlanHelp = screen.getByText(/allocation is normalized to 100%/);
    expect(weeklyPlanHeading).toContainElement(weeklyPlanHelp);
    expect(getComputedStyle(weeklyPlanHeading as HTMLElement).display).toBe(
      "grid",
    );
    expect(getComputedStyle(weeklyPlanHelp).gridColumn).toBe("1 / -1");
    const weekdayBoundaryHelp = screen.getByText(
      /Each day is a 24-hour segment/,
    );
    expect(getComputedStyle(weekdayBoundaryHelp).margin).toBe("0px");
    expect(getComputedStyle(weekdayBoundaryHelp).paddingTop).toBe("20px");
    expect(screen.getByLabelText("Display language")).toHaveValue("en");
    expect(
      screen.getAllByRole("slider", { name: /relative usage intensity$/ }),
    ).toHaveLength(7);
    for (const label of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    fireEvent.change(screen.getByLabelText("Display language"), {
      target: { value: "ko" },
    });
    expect(mocks.invoke).toHaveBeenCalledWith("preview_language", {
      sessionId: 1,
      revision: 2,
      language: "ko",
    });
    expect(
      screen.getAllByRole("slider", { name: /요일 상대 사용 강도$/ }),
    ).toHaveLength(7);

    fireEvent.change(screen.getByLabelText("표시 언어"), {
      target: { value: "en" },
    });
    expect(mocks.invoke).toHaveBeenCalledWith("preview_language", {
      sessionId: 1,
      revision: 3,
      language: "en",
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("save_editable_settings", {
        sessionId: 1,
        settings: expect.objectContaining({ language: "en" }),
      }),
    );
    expect(document.documentElement).toHaveAttribute("lang", "en");
  });
});
