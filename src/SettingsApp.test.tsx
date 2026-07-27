import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SettingsApp from "./SettingsApp";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  hide: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ hide: mocks.hide }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: mocks.isPermissionGranted,
  requestPermission: mocks.requestPermission,
}));

const savedSettings = {
  planMode: "even" as const,
  weekdayAllocations: [14.3, 14.3, 14.3, 14.3, 14.3, 14.3, 14.2],
  osNotificationsEnabled: false,
};

describe("페이스 설정 창", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.hide.mockReset();
    mocks.isPermissionGranted.mockReset();
    mocks.requestPermission.mockReset();
    mocks.isPermissionGranted.mockResolvedValue(false);
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "get_pace_settings") return Promise.resolve(savedSettings);
      if (command === "set_pace_settings")
        return Promise.resolve(savedSettings);
      return Promise.resolve();
    });
  });

  it("요일 배분 합계가 100%가 아니면 저장을 막는다", async () => {
    render(<SettingsApp />);
    fireEvent.click(
      await screen.findByRole("radio", { name: "요일별 배분" }),
    );
    fireEvent.change(screen.getByLabelText("월요일 배분율"), {
      target: { value: "30" },
    });

    expect(screen.getByText(/100±0.1%로 맞춰주세요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
  });

  it("허용된 알림 권한과 설정을 함께 저장한다", async () => {
    mocks.isPermissionGranted
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    mocks.requestPermission.mockResolvedValue("granted");
    render(<SettingsApp />);

    fireEvent.click(await screen.findByLabelText("OS 경고 알림 사용"));
    await waitFor(() => expect(mocks.requestPermission).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("set_pace_settings", {
        paceSettings: expect.objectContaining({
          osNotificationsEnabled: true,
        }),
      }),
    );
  });

  it("알림 권한 거부 시 인라인 경고를 유지한다고 안내한다", async () => {
    mocks.requestPermission.mockResolvedValue("denied");
    render(<SettingsApp />);
    fireEvent.click(await screen.findByLabelText("OS 경고 알림 사용"));

    expect(
      await screen.findByText(/인라인 경고는 계속 표시됩니다/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("OS 경고 알림 사용")).not.toBeChecked();
  });

  it("최근 이력을 삭제하고 설정 창을 숨긴다", async () => {
    render(<SettingsApp />);
    fireEvent.click(await screen.findByRole("button", { name: "이력 삭제" }));
    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("clear_pace_history"),
    );
    fireEvent.click(screen.getByRole("button", { name: "설정 닫기" }));
    expect(mocks.hide).toHaveBeenCalled();
  });
});
