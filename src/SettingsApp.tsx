import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import type { EditableSettings, PaceSettings, SettingsSession } from "./types";
import { DEFAULT_OVERLAY_OPACITY, MIN_OVERLAY_OPACITY } from "./types";
import "./SettingsApp.css";

const DAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];
const FULL_DAY_LABELS = [
  "월요일",
  "화요일",
  "수요일",
  "목요일",
  "금요일",
  "토요일",
  "일요일",
];
const DEFAULT_WEEKDAY_WEIGHTS = [5, 5, 5, 5, 5, 5, 5];
const WEEKDAY_WEIGHT_PRESETS = {
  even: DEFAULT_WEEKDAY_WEIGHTS,
  weekday: [8, 8, 8, 8, 8, 5, 5],
  weekend: [4, 4, 4, 4, 4, 10, 10],
} as const;

const DEFAULT_PACE_SETTINGS: PaceSettings = {
  weekdayWeights: DEFAULT_WEEKDAY_WEIGHTS,
  osNotificationsEnabled: false,
};
const DEFAULT_EDITABLE_SETTINGS: EditableSettings = {
  paceSettings: DEFAULT_PACE_SETTINGS,
  overlayOpacity: DEFAULT_OVERLAY_OPACITY,
};

type PermissionStatus = "checking" | "granted" | "denied";

function settingsEqual(left: EditableSettings, right: EditableSettings) {
  return (
    left.overlayOpacity === right.overlayOpacity &&
    left.paceSettings.osNotificationsEnabled ===
      right.paceSettings.osNotificationsEnabled &&
    left.paceSettings.weekdayWeights.length ===
      right.paceSettings.weekdayWeights.length &&
    left.paceSettings.weekdayWeights.every((value, index) =>
      Object.is(value, right.paceSettings.weekdayWeights[index]),
    )
  );
}

function weekdayWeightsValid(weights: number[]) {
  return (
    weights.length === 7 &&
    weights.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 10,
    ) &&
    weights.some((value) => value > 0)
  );
}

export function normalizeWeekdayWeights(weights: number[]) {
  const effectiveWeights = weekdayWeightsValid(weights)
    ? weights
    : DEFAULT_WEEKDAY_WEIGHTS;
  const total = effectiveWeights.reduce((sum, value) => sum + value, 0);
  const rawTenths = effectiveWeights.map((value) => (value / total) * 1000);
  const tenths = rawTenths.map(Math.floor);
  const remaining = 1000 - tenths.reduce((sum, value) => sum + value, 0);
  const order = rawTenths
    .map((value, index) => ({
      index,
      remainder: value - Math.floor(value),
    }))
    .sort(
      (left, right) =>
        right.remainder - left.remainder || left.index - right.index,
    );

  for (let index = 0; index < remaining; index += 1) {
    tenths[order[index].index] += 1;
  }

  return tenths.map((value) => value / 10);
}

function weekdayWeightLabel(weight: number) {
  if (weight === 0) return "사용 안 함";
  if (weight <= 2) return "매우 낮음";
  if (weight <= 4) return "낮음";
  if (weight === 5) return "보통";
  if (weight <= 8) return "높음";
  return "매우 높음";
}

function SettingsApp() {
  const [persistedSettings, setPersistedSettings] = useState(
    DEFAULT_EDITABLE_SETTINGS,
  );
  const [draftSettings, setDraftSettings] = useState(DEFAULT_EDITABLE_SETTINGS);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [permission, setPermission] = useState<PermissionStatus>("checking");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [requestingPermission, setRequestingPermission] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [pendingClose, setPendingClose] = useState(false);
  const [opacityTooltipVisible, setOpacityTooltipVisible] = useState(false);
  const [weightMessage, setWeightMessage] = useState(
    "막대를 움직여 주간 사용 패턴을 만들어보세요.",
  );
  const sessionIdRef = useRef<number | null>(null);
  const sessionLoadRunningRef = useRef(false);
  const sessionReloadRequestedRef = useRef(false);
  const previewRevisionRef = useRef(0);
  const previewFrameRef = useRef<number | null>(null);
  const pendingOpacityRef = useRef(DEFAULT_OVERLAY_OPACITY);
  const requestCloseRef = useRef<() => void>(() => undefined);
  const opacityTooltipTimerRef = useRef<number | null>(null);
  const opacityPointerActiveRef = useRef(false);

  const paceSettings = draftSettings.paceSettings;
  const opacity = draftSettings.overlayOpacity;
  const weekdayAllocations = useMemo(
    () => normalizeWeekdayWeights(paceSettings.weekdayWeights),
    [paceSettings.weekdayWeights],
  );
  const weightsValid = weekdayWeightsValid(paceSettings.weekdayWeights);
  const activeWeightPreset = Object.entries(WEEKDAY_WEIGHT_PRESETS).find(
    ([, weights]) =>
      weights.every(
        (weight, index) => weight === paceSettings.weekdayWeights[index],
      ),
  )?.[0];
  const dirty = !settingsEqual(persistedSettings, draftSettings);
  const formBusy = saving || requestingPermission;
  const opacityTooltipPosition =
    ((opacity - MIN_OVERLAY_OPACITY) / (100 - MIN_OVERLAY_OPACITY)) * 100;
  const opacityTooltipOffset = 8 - opacityTooltipPosition * 0.16;

  const clearOpacityTooltipTimer = useCallback(() => {
    if (opacityTooltipTimerRef.current !== null) {
      window.clearTimeout(opacityTooltipTimerRef.current);
      opacityTooltipTimerRef.current = null;
    }
  }, []);

  const hideOpacityTooltip = useCallback(() => {
    clearOpacityTooltipTimer();
    opacityPointerActiveRef.current = false;
    setOpacityTooltipVisible(false);
  }, [clearOpacityTooltipTimer]);

  const showOpacityTooltip = useCallback(
    (autoHide: boolean) => {
      clearOpacityTooltipTimer();
      setOpacityTooltipVisible(true);
      if (autoHide) {
        opacityTooltipTimerRef.current = window.setTimeout(() => {
          opacityTooltipTimerRef.current = null;
          setOpacityTooltipVisible(false);
        }, 900);
      }
    },
    [clearOpacityTooltipTimer],
  );

  const cancelScheduledPreview = useCallback(() => {
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
  }, []);

  const applySession = useCallback(
    (session: SettingsSession) => {
      cancelScheduledPreview();
      hideOpacityTooltip();
      const recovered = !weekdayWeightsValid(
        session.settings.paceSettings.weekdayWeights,
      );
      const recoveredSettings = recovered
        ? {
            ...session.settings,
            paceSettings: {
              ...session.settings.paceSettings,
              weekdayWeights: [...DEFAULT_WEEKDAY_WEIGHTS],
            },
          }
        : session.settings;
      sessionIdRef.current = session.sessionId;
      previewRevisionRef.current = 0;
      pendingOpacityRef.current = session.settings.overlayOpacity;
      setSessionId(session.sessionId);
      setPersistedSettings(session.settings);
      setDraftSettings(recoveredSettings);
      setCloseDialogOpen(false);
      setWeightMessage(
        recovered
          ? "잘못된 요일별 강도 초안을 균등 배분으로 복구했습니다."
          : "막대를 움직여 주간 사용 패턴을 만들어보세요.",
      );
      return recovered;
    },
    [cancelScheduledPreview, hideOpacityTooltip],
  );

  const loadSession = useCallback(async () => {
    if (sessionLoadRunningRef.current) {
      sessionReloadRequestedRef.current = true;
      return;
    }
    sessionLoadRunningRef.current = true;
    do {
      sessionReloadRequestedRef.current = false;
      cancelScheduledPreview();
      try {
        const session = await invoke<SettingsSession>("begin_settings_session");
        const recovered = applySession(session);
        setMessage(
          recovered
            ? "잘못된 요일별 강도 초안을 균등 배분으로 복구했습니다."
            : "",
        );
      } catch (error) {
        setMessage(String(error));
      }
    } while (sessionReloadRequestedRef.current);
    sessionLoadRunningRef.current = false;
  }, [applySession, cancelScheduledPreview]);

  const refreshPermission = useCallback(() => {
    setPermission("checking");
    void isPermissionGranted()
      .then((granted) => setPermission(granted ? "granted" : "denied"))
      .catch(() => setPermission("denied"));
  }, []);

  const scheduleOpacityPreview = useCallback((overlayOpacity: number) => {
    pendingOpacityRef.current = overlayOpacity;
    if (previewFrameRef.current !== null) return;
    previewFrameRef.current = window.requestAnimationFrame(() => {
      previewFrameRef.current = null;
      const activeSessionId = sessionIdRef.current;
      if (activeSessionId === null) return;
      const revision = ++previewRevisionRef.current;
      void invoke("preview_overlay_opacity", {
        sessionId: activeSessionId,
        revision,
        overlayOpacity: pendingOpacityRef.current,
      }).catch((error) => {
        if (sessionIdRef.current === activeSessionId) {
          setMessage(String(error));
        }
      });
    });
  }, []);

  const cancelSessionAndHide = useCallback(async () => {
    cancelScheduledPreview();
    hideOpacityTooltip();
    const activeSessionId = sessionIdRef.current;
    try {
      if (activeSessionId !== null) {
        await invoke("cancel_settings_session", {
          sessionId: activeSessionId,
        });
      }
      sessionIdRef.current = null;
      setSessionId(null);
      setDraftSettings(persistedSettings);
      setCloseDialogOpen(false);
      setMessage("");
      await getCurrentWindow().hide();
    } catch (error) {
      setMessage(String(error));
    }
  }, [cancelScheduledPreview, hideOpacityTooltip, persistedSettings]);

  const requestClose = useCallback(() => {
    if (formBusy) {
      setPendingClose(true);
      return;
    }
    if (dirty) {
      setCloseDialogOpen(true);
      return;
    }
    void cancelSessionAndHide();
  }, [cancelSessionAndHide, dirty, formBusy]);

  useEffect(() => {
    requestCloseRef.current = requestClose;
  }, [requestClose]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void loadSession();
      refreshPermission();
    }, 0);
    const unlistenOpened = listen("ui://settings-opened", () => {
      void loadSession();
      refreshPermission();
    });
    return () => {
      window.clearTimeout(initialLoad);
      cancelScheduledPreview();
      clearOpacityTooltipTimer();
      void unlistenOpened.then((unlisten) => unlisten());
    };
  }, [
    cancelScheduledPreview,
    clearOpacityTooltipTimer,
    loadSession,
    refreshPermission,
  ]);

  useEffect(() => {
    const unlistenClose = listen("ui://settings-close-requested", () =>
      requestCloseRef.current(),
    );
    return () => {
      void unlistenClose.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (closeDialogOpen) {
        setCloseDialogOpen(false);
      } else {
        requestClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeDialogOpen, requestClose]);

  useEffect(() => {
    if (!pendingClose || formBusy) return;
    const deferredClose = window.setTimeout(() => {
      setPendingClose(false);
      requestClose();
    }, 0);
    return () => window.clearTimeout(deferredClose);
  }, [formBusy, pendingClose, requestClose]);

  const setWeekdayWeight = (index: number, weight: number) => {
    const nextWeights = paceSettings.weekdayWeights.map(
      (currentWeight, item) => (item === index ? weight : currentWeight),
    );
    if (nextWeights.every((currentWeight) => currentWeight === 0)) {
      setWeightMessage("최소 한 요일의 사용 강도는 1 이상이어야 합니다.");
      setMessage("");
      return;
    }
    setDraftSettings((current) => ({
      ...current,
      paceSettings: {
        ...current.paceSettings,
        weekdayWeights: nextWeights,
      },
    }));
    setWeightMessage(
      `${FULL_DAY_LABELS[index]} 강도를 ${weight}단계 · ${weekdayWeightLabel(weight)}으로 변경했습니다.`,
    );
    setMessage("");
  };

  const applyWeightPreset = (
    preset: keyof typeof WEEKDAY_WEIGHT_PRESETS,
    label: string,
  ) => {
    const weights = WEEKDAY_WEIGHT_PRESETS[preset];
    setDraftSettings((current) => ({
      ...current,
      paceSettings: {
        ...current.paceSettings,
        weekdayWeights: [...weights],
      },
    }));
    setWeightMessage(`${label} 강도 패턴을 적용했습니다.`);
    setMessage("");
  };

  const setOpacity = (opacityPercent: number) => {
    setDraftSettings((current) => ({
      ...current,
      overlayOpacity: opacityPercent,
    }));
    scheduleOpacityPreview(opacityPercent);
    setMessage("");
  };

  const toggleNotifications = async (enabled: boolean) => {
    if (!enabled) {
      setDraftSettings((current) => ({
        ...current,
        paceSettings: {
          ...current.paceSettings,
          osNotificationsEnabled: false,
        },
      }));
      setMessage("");
      return;
    }

    setRequestingPermission(true);
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      setPermission(granted ? "granted" : "denied");
      setDraftSettings((current) => ({
        ...current,
        paceSettings: {
          ...current.paceSettings,
          osNotificationsEnabled: granted,
        },
      }));
      if (!granted) {
        setMessage(
          "알림 권한이 거부되었습니다. 인라인 경고는 계속 표시됩니다.",
        );
      }
    } catch {
      setPermission("denied");
      setMessage(
        "알림 권한을 확인할 수 없습니다. 인라인 경고는 계속 표시됩니다.",
      );
    } finally {
      setRequestingPermission(false);
    }
  };

  const save = async (closeAfterSave = false) => {
    const activeSessionId = sessionIdRef.current;
    if (
      activeSessionId === null ||
      !weightsValid ||
      saving ||
      requestingPermission
    ) {
      return;
    }
    cancelScheduledPreview();
    setSaving(true);
    setMessage("");
    try {
      const session = await invoke<SettingsSession>("save_editable_settings", {
        sessionId: activeSessionId,
        settings: draftSettings,
      });
      applySession(session);
      setMessage("설정을 저장했습니다.");
      if (closeAfterSave) {
        await invoke("cancel_settings_session", {
          sessionId: session.sessionId,
        });
        sessionIdRef.current = null;
        setSessionId(null);
        await getCurrentWindow().hide();
      }
    } catch (error) {
      setMessage(String(error));
    } finally {
      setSaving(false);
    }
  };

  const clearHistory = async () => {
    setClearingHistory(true);
    setMessage("");
    try {
      await invoke("clear_pace_history");
      setMessage("최근 페이스 이력과 알림 상태를 삭제했습니다.");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setClearingHistory(false);
    }
  };

  return (
    <main className="settings-page">
      <header data-tauri-drag-region>
        <div data-tauri-drag-region>
          <p data-tauri-drag-region>Codex Pace</p>
          <h1 data-tauri-drag-region>설정</h1>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="설정 닫기"
          onClick={requestClose}
        >
          ×
        </button>
      </header>

      <div className="settings-content">
        <section>
          <div className="weekly-plan-heading">
            <div>
              <h2>주간 사용 계획</h2>
              <p className="section-help">
                요일별 상대 강도를 정하면 실제 배분을 100%로 계산합니다.
              </p>
            </div>
            <strong>합계 100.0%</strong>
          </div>

          <div
            className="weekday-distribution"
            role="img"
            aria-label={`요일별 계산 배분, ${FULL_DAY_LABELS.map(
              (label, index) =>
                `${label} ${weekdayAllocations[index].toFixed(1)}%`,
            ).join(", ")}`}
          >
            {weekdayAllocations.map((allocation, index) => (
              <span
                key={FULL_DAY_LABELS[index]}
                style={{ width: `${allocation}%` }}
              />
            ))}
          </div>

          <div
            className="weekday-presets"
            role="group"
            aria-label="빠른 강도 선택"
          >
            {(
              [
                ["even", "균등 배분"],
                ["weekday", "평일 중심"],
                ["weekend", "주말 중심"],
              ] as const
            ).map(([preset, label]) => (
              <button
                key={preset}
                type="button"
                aria-pressed={activeWeightPreset === preset}
                disabled={formBusy}
                onClick={() => applyWeightPreset(preset, label)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="weekday-editor">
            <div className="weekday-editor-heading">
              <h3>요일별 사용 강도</h3>
              <span>막대는 자동으로 움직이지 않습니다</span>
            </div>
            <div
              className="weekday-equalizer"
              aria-label="요일별 상대 사용 강도"
            >
              {DAY_LABELS.map((label, index) => {
                const inputId = `weekday-weight-${index}`;
                const weight = paceSettings.weekdayWeights[index];
                const allocation = weekdayAllocations[index];
                return (
                  <div className="weekday-weight" key={label}>
                    <span className="weekday-weight-level">
                      {weekdayWeightLabel(weight)}
                    </span>
                    <div className="weekday-weight-control">
                      <span
                        className="weekday-weight-guides"
                        aria-hidden="true"
                      >
                        {Array.from({ length: 11 }, (_, guideIndex) => (
                          <i key={guideIndex} />
                        ))}
                      </span>
                      <input
                        id={inputId}
                        type="range"
                        min="0"
                        max="10"
                        step="1"
                        aria-label={`${FULL_DAY_LABELS[index]} 상대 사용 강도`}
                        aria-valuetext={`${weekdayWeightLabel(weight)}, 실제 배분 ${allocation.toFixed(1)}%`}
                        disabled={formBusy}
                        value={weight}
                        onChange={(event) =>
                          setWeekdayWeight(index, Number(event.target.value))
                        }
                      />
                    </div>
                    <label htmlFor={inputId}>{label}</label>
                    <output htmlFor={inputId}>{allocation.toFixed(1)}%</output>
                  </div>
                );
              })}
            </div>
            <p className="weekday-weight-status" role="status">
              {weightMessage}
            </p>
          </div>

          <p className="weekday-boundary-help">
            각 요일은 주간 제한 창의 초기화 시각부터 시작되는 24시간 구간입니다.
          </p>
        </section>

        <section>
          <div className="setting-row opacity-setting">
            <div>
              <h2>오버레이 투명도</h2>
              <p className="section-help">
                낮을수록 배경이 더 많이 비칩니다. 최소 40%입니다.
              </p>
            </div>
          </div>
          <div
            className="opacity-slider-control"
            style={
              {
                "--opacity-tooltip-position": `${opacityTooltipPosition}%`,
                "--opacity-tooltip-offset": `${opacityTooltipOffset}px`,
              } as CSSProperties
            }
          >
            <input
              id="overlay-opacity"
              className="opacity-slider"
              type="range"
              min={MIN_OVERLAY_OPACITY}
              max="100"
              step="5"
              aria-label="오버레이 투명도"
              aria-valuetext={`${opacity}% · 낮을수록 더 투명함`}
              disabled={formBusy || sessionId === null}
              value={opacity}
              onPointerDown={() => {
                opacityPointerActiveRef.current = true;
                showOpacityTooltip(false);
              }}
              onPointerUp={hideOpacityTooltip}
              onPointerCancel={hideOpacityTooltip}
              onBlur={hideOpacityTooltip}
              onChange={(event) => {
                showOpacityTooltip(!opacityPointerActiveRef.current);
                setOpacity(Number(event.target.value));
              }}
            />
            {opacityTooltipVisible && (
              <output
                className="opacity-tooltip"
                htmlFor="overlay-opacity"
                aria-hidden="true"
                data-testid="opacity-tooltip"
              >
                {opacity}%
              </output>
            )}
          </div>
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
                checked={paceSettings.osNotificationsEnabled}
                disabled={formBusy}
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
                최근 사용률 이력과 알림 중복 방지 상태를 최대 25시간 보존합니다.
                계정 정보는 저장하지 않습니다.
              </p>
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={clearingHistory || saving}
              onClick={() => void clearHistory()}
            >
              이력 삭제
            </button>
          </div>
        </section>
      </div>

      <footer>
        <span role="status">{message}</span>
        <button
          className="primary-button"
          type="button"
          disabled={formBusy || !weightsValid || !dirty || sessionId === null}
          onClick={() => void save()}
        >
          저장
        </button>
      </footer>

      {closeDialogOpen && (
        <div className="confirm-backdrop">
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="unsaved-title"
            aria-describedby="unsaved-description"
          >
            <h2 id="unsaved-title">변경사항을 저장할까요?</h2>
            <p id="unsaved-description">
              저장하지 않으면 오버레이 미리보기를 포함한 변경사항이 사라집니다.
            </p>
            <div className="confirm-actions">
              <button
                className="primary-button"
                type="button"
                disabled={formBusy || !weightsValid}
                onClick={() => void save(true)}
              >
                저장
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={formBusy}
                onClick={() => void cancelSessionAndHide()}
              >
                변경사항 폐기
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={formBusy}
                autoFocus
                onClick={() => setCloseDialogOpen(false)}
              >
                계속 편집
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default SettingsApp;
