import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditableSettings } from "./types";
import SettingsApp from "./SettingsApp";

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
    planMode: "even",
    weekdayAllocations: [14.3, 14.3, 14.3, 14.3, 14.3, 14.3, 14.2],
    osNotificationsEnabled: false,
  },
  overlayOpacity: 100,
};

async function renderLoadedSettings() {
  render(<SettingsApp />);
  const slider = await screen.findByLabelText("오버레이 투명도");
  await waitFor(() => expect(slider).toBeEnabled());
  return slider;
}

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

  it("균등 배분에서는 요약만 표시하고 요일 입력은 필요할 때만 렌더링한다", async () => {
    await renderLoadedSettings();

    expect(
      screen.getByText("월~일 동일 배분 · 하루 약 14.3%"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("월요일 배분율")).not.toBeInTheDocument();
    expect(screen.queryByText(/^합계 /)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "요일별 배분" }));

    expect(
      screen.queryByText("월~일 동일 배분 · 하루 약 14.3%"),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("spinbutton")).toHaveLength(7);
    expect(screen.getByText("합계 100.0%")).toBeInTheDocument();
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

  it("유효한 요일별 배분은 균등 모드를 거쳐도 보존한다", async () => {
    await renderLoadedSettings();
    fireEvent.click(screen.getByRole("radio", { name: "요일별 배분" }));
    fireEvent.change(screen.getByLabelText("월요일 배분율"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText("화요일 배분율"), {
      target: { value: "8.6" },
    });

    fireEvent.click(screen.getByRole("radio", { name: "균등 배분" }));
    expect(screen.queryByLabelText("월요일 배분율")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "요일별 배분" }));

    expect(screen.getByLabelText("월요일 배분율")).toHaveValue(20);
    expect(screen.getByLabelText("화요일 배분율")).toHaveValue(8.6);
    expect(screen.getByText("합계 100.0%")).toBeInTheDocument();
  });

  it("잘못된 요일별 초안은 균등 모드 전환 시 저장값으로 복원한다", async () => {
    await renderLoadedSettings();
    fireEvent.click(screen.getByRole("radio", { name: "요일별 배분" }));
    fireEvent.change(screen.getByLabelText("월요일 배분율"), {
      target: { value: "30" },
    });

    fireEvent.click(screen.getByRole("radio", { name: "균등 배분" }));

    expect(
      screen.getByText("잘못된 요일별 배분 초안을 유효한 값으로 되돌렸습니다."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: "요일별 배분" }));
    expect(screen.getByLabelText("월요일 배분율")).toHaveValue(14.3);
    expect(screen.getByText("합계 100.0%")).toBeInTheDocument();
  });

  it("저장된 요일값도 잘못된 경우 기본 균등값으로 복원한다", async () => {
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "begin_settings_session") {
        return Promise.resolve({
          sessionId: 1,
          settings: {
            ...savedSettings,
            paceSettings: {
              ...savedSettings.paceSettings,
              weekdayAllocations: [10, 10, 10, 10, 10, 10, 10],
            },
          },
        });
      }
      return Promise.resolve();
    });
    await renderLoadedSettings();
    fireEvent.click(screen.getByRole("radio", { name: "요일별 배분" }));

    fireEvent.click(screen.getByRole("radio", { name: "균등 배분" }));
    fireEvent.click(screen.getByRole("radio", { name: "요일별 배분" }));

    expect(screen.getByLabelText("월요일 배분율")).toHaveValue(14.3);
    expect(screen.getByLabelText("일요일 배분율")).toHaveValue(14.2);
    expect(screen.getByText("합계 100.0%")).toBeInTheDocument();
  });

  it("잘못된 요일 배분은 저장만 막고 외형 미리보기는 허용한다", async () => {
    const slider = await renderLoadedSettings();
    fireEvent.click(screen.getByRole("radio", { name: "요일별 배분" }));
    fireEvent.change(screen.getByLabelText("월요일 배분율"), {
      target: { value: "30" },
    });
    fireEvent.change(slider, { target: { value: "65" } });

    expect(screen.getByText(/100±0.1%로 맞춰주세요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("preview_overlay_opacity", {
        sessionId: 1,
        revision: 1,
        overlayOpacity: 65,
      }),
    );
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "save_editable_settings",
      expect.anything(),
    );
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

  it("알림 활성화와 투명도를 전역 저장으로 한 번에 확정한다", async () => {
    mocks.requestPermission.mockResolvedValue("granted");
    const slider = await renderLoadedSettings();

    fireEvent.click(screen.getByLabelText("OS 경고 알림 사용"));
    await waitFor(() => expect(mocks.requestPermission).toHaveBeenCalled());
    fireEvent.change(slider, { target: { value: "65" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("save_editable_settings", {
        sessionId: 1,
        settings: expect.objectContaining({
          overlayOpacity: 65,
          paceSettings: expect.objectContaining({
            osNotificationsEnabled: true,
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
});
