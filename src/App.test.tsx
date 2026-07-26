import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageViewState } from "./types";
import App from "./App";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
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
      resetsAt: 1_785_076_374,
    },
  ],
  featuredWindowId: "codex:primary",
  fetchedAt: 1,
  lastSuccessfulAt: 1,
  errorMessage: null,
};

describe("Codex 사용량 오버레이", () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.invoke.mockImplementation((command: string) =>
      command === "get_usage_state"
        ? Promise.resolve(weeklyOnly)
        : Promise.resolve(),
    );
  });

  it("주간 단독 응답에 존재하지 않는 5시간 행을 만들지 않는다", async () => {
    render(<App />);
    expect(await screen.findByText("주간")).toBeInTheDocument();
    expect(screen.queryByText("5시간")).not.toBeInTheDocument();
    expect(screen.getByText("74% 남음")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(
      await screen.findByRole("region", { name: "Codex 사용량 상세" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("주간")).toHaveLength(2);
    expect(screen.queryByText("5시간")).not.toBeInTheDocument();
  });

  it("클릭으로 확장하고 접는다", async () => {
    render(<App />);
    const toggle = await screen.findByRole("button", { expanded: false });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "접기" }));
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-expanded", "false"),
    );
  });

  it("포커스를 잃었다는 네이티브 이벤트가 오면 접는다", async () => {
    render(<App />);
    const toggle = await screen.findByRole("button", { expanded: false });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    mocks.listeners.get("ui://collapse")?.({ payload: undefined });
    await waitFor(() =>
      expect(toggle).toHaveAttribute("aria-expanded", "false"),
    );
  });

  it("인증됐지만 창이 없으면 퍼센티지를 만들지 않는다", async () => {
    mocks.invoke.mockImplementation((command: string) =>
      command === "get_usage_state"
        ? Promise.resolve({
            ...weeklyOnly,
            connection: "no_limits",
            windows: [],
            featuredWindowId: null,
          })
        : Promise.resolve(),
    );
    render(<App />);
    expect(await screen.findByText("사용량 한도 없음")).toBeInTheDocument();
    expect(screen.queryByText(/% 남음/)).not.toBeInTheDocument();
  });

  it("마지막 성공 값이 있으면 stale 상태를 지연 표시와 함께 유지한다", async () => {
    mocks.invoke.mockImplementation((command: string) =>
      command === "get_usage_state"
        ? Promise.resolve({
            ...weeklyOnly,
            connection: "stale",
            lastSuccessfulAt: Math.floor(Date.now() / 1_000) - 120,
            errorMessage: "연결이 끊겼습니다.",
          })
        : Promise.resolve(),
    );
    render(<App />);
    expect(
      await screen.findByText("업데이트 지연 · 2분 전"),
    ).toBeInTheDocument();
    expect(screen.getByText("주간")).toBeInTheDocument();
  });
});
