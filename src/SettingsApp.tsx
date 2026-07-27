import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import type { PacePlanMode, PaceSettings } from "./types";
import "./SettingsApp.css";

const DAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];
const DEFAULT_SETTINGS: PaceSettings = {
  planMode: "even",
  weekdayAllocations: [14.3, 14.3, 14.3, 14.3, 14.3, 14.3, 14.2],
  osNotificationsEnabled: false,
};

type PermissionStatus = "checking" | "granted" | "denied";

function SettingsApp() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [permission, setPermission] =
    useState<PermissionStatus>("checking");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const total = useMemo(
    () => settings.weekdayAllocations.reduce((sum, value) => sum + value, 0),
    [settings.weekdayAllocations],
  );
  const allocationValid =
    settings.weekdayAllocations.every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 100,
    ) && Math.abs(total - 100) <= 0.1;

  useEffect(() => {
    void invoke<PaceSettings>("get_pace_settings").then(setSettings);
    void isPermissionGranted()
      .then((granted) => setPermission(granted ? "granted" : "denied"))
      .catch(() => setPermission("denied"));
  }, []);

  const setPlanMode = (planMode: PacePlanMode) => {
    setSettings((current) => ({ ...current, planMode }));
    setMessage("");
  };

  const setAllocation = (index: number, value: string) => {
    const parsed = Number(value);
    setSettings((current) => ({
      ...current,
      weekdayAllocations: current.weekdayAllocations.map((allocation, item) =>
        item === index ? parsed : allocation,
      ),
    }));
    setMessage("");
  };

  const toggleNotifications = async (enabled: boolean) => {
    if (!enabled) {
      setSettings((current) => ({
        ...current,
        osNotificationsEnabled: false,
      }));
      setMessage("");
      return;
    }

    setBusy(true);
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      setPermission(granted ? "granted" : "denied");
      setSettings((current) => ({
        ...current,
        osNotificationsEnabled: granted,
      }));
      if (!granted) {
        setMessage("알림 권한이 거부되었습니다. 인라인 경고는 계속 표시됩니다.");
      }
    } catch {
      setPermission("denied");
      setMessage("알림 권한을 확인할 수 없습니다. 인라인 경고는 계속 표시됩니다.");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!allocationValid) return;
    setBusy(true);
    setMessage("");
    try {
      const saved = await invoke<PaceSettings>("set_pace_settings", {
        paceSettings: settings,
      });
      setSettings(saved);
      setMessage("설정을 저장했습니다.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const clearHistory = async () => {
    setBusy(true);
    setMessage("");
    try {
      await invoke("clear_pace_history");
      setMessage("최근 페이스 이력을 삭제했습니다.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };

  const closeSettings = async () => {
    setMessage("");
    try {
      await getCurrentWindow().hide();
    } catch {
      setMessage("설정 창을 닫을 수 없습니다.");
    }
  };

  return (
    <main className="settings-page">
      <header data-tauri-drag-region>
        <div data-tauri-drag-region>
          <p data-tauri-drag-region>Codex Pace</p>
          <h1 data-tauri-drag-region>페이스 설정</h1>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="설정 닫기"
          onClick={() => void closeSettings()}
        >
          ×
        </button>
      </header>

      <section>
        <h2>주간 사용 계획</h2>
        <p className="section-help">
          정확히 7일인 제한 창의 현재 권장선을 정합니다.
        </p>
        <div className="segmented" role="radiogroup" aria-label="계획 모드">
          <button
            type="button"
            role="radio"
            aria-checked={settings.planMode === "even"}
            className={settings.planMode === "even" ? "selected" : ""}
            onClick={() => setPlanMode("even")}
          >
            균등 배분
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={settings.planMode === "weekday"}
            className={settings.planMode === "weekday" ? "selected" : ""}
            onClick={() => setPlanMode("weekday")}
          >
            요일별 배분
          </button>
        </div>
        <div
          className={`weekday-grid ${
            settings.planMode === "even" ? "is-disabled" : ""
          }`}
        >
          {DAY_LABELS.map((label, index) => (
            <label key={label}>
              <span>{label}</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                aria-label={`${label}요일 배분율`}
                disabled={settings.planMode === "even"}
                value={settings.weekdayAllocations[index]}
                onChange={(event) => setAllocation(index, event.target.value)}
              />
              <small>%</small>
            </label>
          ))}
        </div>
        <p
          className={`allocation-total ${allocationValid ? "" : "is-error"}`}
          role="status"
        >
          합계 {Number.isFinite(total) ? total.toFixed(1) : "—"}%
          {!allocationValid && " · 100±0.1%로 맞춰주세요"}
        </p>
      </section>

      <section>
        <div className="setting-row">
          <div>
            <h2>OS 경고 알림</h2>
            <p className="section-help">
              계획 초과나 초기화 전 소진 위험을 창 세대별로 한 번 알립니다.
            </p>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              aria-label="OS 경고 알림 사용"
              checked={settings.osNotificationsEnabled}
              disabled={busy}
              onChange={(event) =>
                void toggleNotifications(event.target.checked)
              }
            />
            <span />
          </label>
        </div>
        <p className="permission-state">
          권한:{" "}
          {permission === "checking"
            ? "확인 중"
            : permission === "granted"
              ? "허용됨"
              : "허용되지 않음"}
        </p>
      </section>

      <section>
        <div className="setting-row">
          <div>
            <h2>최근 이력</h2>
            <p className="section-help">
              사용률·시각·창 식별자만 최대 25시간 보존하며 계정 정보는 저장하지
              않습니다.
            </p>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => void clearHistory()}
          >
            이력 삭제
          </button>
        </div>
      </section>

      <footer>
        <span role="status">{message}</span>
        <button
          className="primary-button"
          type="button"
          disabled={busy || !allocationValid}
          onClick={() => void save()}
        >
          저장
        </button>
      </footer>
    </main>
  );
}

export default SettingsApp;
