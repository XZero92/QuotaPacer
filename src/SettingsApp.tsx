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
import { DEFAULT_LANGUAGE, text } from "./i18n";
import "./SettingsApp.css";

const KOREAN_DAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];
const KOREAN_FULL_DAY_LABELS = [
  "월요일",
  "화요일",
  "수요일",
  "목요일",
  "금요일",
  "토요일",
  "일요일",
];
const ENGLISH_DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ENGLISH_FULL_DAY_LABELS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
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
  language: DEFAULT_LANGUAGE,
};
const LANGUAGE_LISTBOX_ID = "display-language-listbox";
const LANGUAGE_OPTIONS: ReadonlyArray<{
  value: EditableSettings["language"];
  label: string;
}> = [
  { value: "ko", label: "한국어" },
  { value: "en", label: "English" },
];

type PermissionStatus = "checking" | "granted" | "denied";

function settingsEqual(left: EditableSettings, right: EditableSettings) {
  return (
    left.overlayOpacity === right.overlayOpacity &&
    left.language === right.language &&
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

function weekdayWeightLabel(
  language: EditableSettings["language"],
  weight: number,
) {
  if (weight === 0) return text(language, "사용 안 함", "Off");
  if (weight <= 2) return text(language, "매우 낮음", "Very low");
  if (weight <= 4) return text(language, "낮음", "Low");
  if (weight === 5) return text(language, "보통", "Medium");
  if (weight <= 8) return text(language, "높음", "High");
  return text(language, "매우 높음", "Very high");
}

function SettingsApp() {
  const [persistedSettings, setPersistedSettings] = useState(
    DEFAULT_EDITABLE_SETTINGS,
  );
  const [draftSettings, setDraftSettings] = useState(DEFAULT_EDITABLE_SETTINGS);
  const [persistedLaunchAtLogin, setPersistedLaunchAtLogin] = useState(false);
  const [draftLaunchAtLogin, setDraftLaunchAtLogin] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [permission, setPermission] = useState<PermissionStatus>("checking");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [requestingPermission, setRequestingPermission] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [pendingClose, setPendingClose] = useState(false);
  const [languageListboxOpen, setLanguageListboxOpen] = useState(false);
  const [activeLanguageIndex, setActiveLanguageIndex] = useState(0);
  const [opacityTooltipVisible, setOpacityTooltipVisible] = useState(false);
  const [weightMessage, setWeightMessage] = useState(
    "막대를 움직여 주간 사용 패턴을 만들어보세요.",
  );
  const sessionIdRef = useRef<number | null>(null);
  const sessionLoadRunningRef = useRef(false);
  const sessionReloadRequestedRef = useRef(false);
  const previewRevisionRef = useRef(0);
  const languagePreviewRevisionRef = useRef(0);
  const previewFrameRef = useRef<number | null>(null);
  const pendingOpacityRef = useRef(DEFAULT_OVERLAY_OPACITY);
  const requestCloseRef = useRef<() => void>(() => undefined);
  const languageListboxRef = useRef<HTMLDivElement | null>(null);
  const languageTriggerRef = useRef<HTMLButtonElement | null>(null);
  const opacityTooltipTimerRef = useRef<number | null>(null);
  const opacityPointerActiveRef = useRef(false);

  const paceSettings = draftSettings.paceSettings;
  const opacity = draftSettings.overlayOpacity;
  const language = draftSettings.language;
  const dayLabels = language === "en" ? ENGLISH_DAY_LABELS : KOREAN_DAY_LABELS;
  const fullDayLabels =
    language === "en" ? ENGLISH_FULL_DAY_LABELS : KOREAN_FULL_DAY_LABELS;
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
  const dirty =
    !settingsEqual(persistedSettings, draftSettings) ||
    persistedLaunchAtLogin !== draftLaunchAtLogin;
  const formBusy = saving || requestingPermission;
  const selectedLanguageIndex = Math.max(
    0,
    LANGUAGE_OPTIONS.findIndex((option) => option.value === language),
  );
  const selectedLanguageOption = LANGUAGE_OPTIONS[selectedLanguageIndex];
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
      const launchAtLogin = session.launchAtLogin ?? false;
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
      languagePreviewRevisionRef.current = 0;
      pendingOpacityRef.current = session.settings.overlayOpacity;
      setSessionId(session.sessionId);
      setPersistedSettings(session.settings);
      setDraftSettings(recoveredSettings);
      setPersistedLaunchAtLogin(launchAtLogin);
      setDraftLaunchAtLogin(launchAtLogin);
      setCloseDialogOpen(false);
      setLanguageListboxOpen(false);
      setActiveLanguageIndex(
        Math.max(
          0,
          LANGUAGE_OPTIONS.findIndex(
            (option) => option.value === recoveredSettings.language,
          ),
        ),
      );
      setWeightMessage(
        recovered
          ? text(
              recoveredSettings.language,
              "잘못된 요일별 강도 초안을 균등 배분으로 복구했습니다.",
              "Invalid daily intensity values were restored to an even distribution.",
            )
          : text(
              recoveredSettings.language,
              "막대를 움직여 주간 사용 패턴을 만들어보세요.",
              "Move the bars to shape your weekly usage pattern.",
            ),
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
            ? text(
                session.settings.language,
                "잘못된 요일별 강도 초안을 균등 배분으로 복구했습니다.",
                "Invalid daily intensity values were restored to an even distribution.",
              )
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

  const previewLanguage = (nextLanguage: EditableSettings["language"]) => {
    const activeSessionId = sessionIdRef.current;
    if (activeSessionId === null) return;
    const revision = ++languagePreviewRevisionRef.current;
    void invoke("preview_language", {
      sessionId: activeSessionId,
      revision,
      language: nextLanguage,
    }).catch((error) => {
      if (
        sessionIdRef.current === activeSessionId &&
        languagePreviewRevisionRef.current === revision
      ) {
        setMessage(String(error));
      }
    });
  };

  const openLanguageListbox = () => {
    if (formBusy) return;
    setActiveLanguageIndex(selectedLanguageIndex);
    setLanguageListboxOpen(true);
  };

  const closeLanguageListbox = () => {
    setLanguageListboxOpen(false);
  };

  const selectLanguage = (nextLanguage: EditableSettings["language"]) => {
    closeLanguageListbox();
    languageTriggerRef.current?.focus();
    if (nextLanguage === language) return;
    setDraftSettings((current) => ({
      ...current,
      language: nextLanguage,
    }));
    previewLanguage(nextLanguage);
    setWeightMessage(
      text(
        nextLanguage,
        "막대를 움직여 주간 사용 패턴을 만들어보세요.",
        "Move the bars to shape your weekly usage pattern.",
      ),
    );
    setMessage("");
  };

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
      setDraftLaunchAtLogin(persistedLaunchAtLogin);
      setCloseDialogOpen(false);
      setMessage("");
      await getCurrentWindow().hide();
    } catch (error) {
      setMessage(String(error));
    }
  }, [
    cancelScheduledPreview,
    hideOpacityTooltip,
    persistedLaunchAtLogin,
    persistedSettings,
  ]);

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
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    if (!languageListboxOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !languageListboxRef.current?.contains(event.target)
      ) {
        closeLanguageListbox();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [languageListboxOpen]);

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
      if (languageListboxOpen) {
        closeLanguageListbox();
      } else if (closeDialogOpen) {
        setCloseDialogOpen(false);
      } else {
        requestClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeDialogOpen, languageListboxOpen, requestClose]);

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
      setWeightMessage(
        text(
          language,
          "최소 한 요일의 사용 강도는 1 이상이어야 합니다.",
          "At least one day must have an intensity of 1 or higher.",
        ),
      );
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
      text(
        language,
        `${fullDayLabels[index]} 강도를 ${weight}단계 · ${weekdayWeightLabel(language, weight)}으로 변경했습니다.`,
        `${fullDayLabels[index]} intensity changed to level ${weight} · ${weekdayWeightLabel(language, weight)}.`,
      ),
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
    setWeightMessage(
      text(
        language,
        `${label} 강도 패턴을 적용했습니다.`,
        `${label} intensity pattern applied.`,
      ),
    );
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
          text(
            language,
            "알림 권한이 거부되었습니다. 인라인 경고는 계속 표시됩니다.",
            "Notification permission was denied. Inline warnings will remain visible.",
          ),
        );
      }
    } catch {
      setPermission("denied");
      setMessage(
        text(
          language,
          "알림 권한을 확인할 수 없습니다. 인라인 경고는 계속 표시됩니다.",
          "Notification permission could not be checked. Inline warnings will remain visible.",
        ),
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
        launchAtLogin: draftLaunchAtLogin,
      });
      applySession(session);
      setMessage(
        text(
          session.settings.language,
          "설정을 저장했습니다.",
          "Settings saved.",
        ),
      );
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
      setMessage(
        text(
          language,
          "최근 페이스 이력과 알림 상태를 삭제했습니다.",
          "Recent pace history and notification state were deleted.",
        ),
      );
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
          <h1 data-tauri-drag-region>{text(language, "설정", "Settings")}</h1>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label={text(language, "설정 닫기", "Close settings")}
          onClick={requestClose}
        >
          ×
        </button>
      </header>

      <div className="settings-content" onScroll={closeLanguageListbox}>
        <section>
          <div className="setting-row language-setting">
            <div>
              <h2>{text(language, "언어", "Language")}</h2>
              <p className="section-help">
                {text(
                  language,
                  "오버레이, 메뉴와 알림에 사용할 언어입니다.",
                  "Used for the overlay, menus, and notifications.",
                )}
              </p>
            </div>
            <div className="language-listbox" ref={languageListboxRef}>
              <button
                ref={languageTriggerRef}
                className="language-listbox-trigger"
                type="button"
                role="combobox"
                aria-label={text(language, "표시 언어", "Display language")}
                aria-haspopup="listbox"
                aria-expanded={languageListboxOpen}
                aria-controls={LANGUAGE_LISTBOX_ID}
                aria-activedescendant={
                  languageListboxOpen
                    ? `display-language-option-${LANGUAGE_OPTIONS[activeLanguageIndex].value}`
                    : undefined
                }
                disabled={formBusy}
                onClick={() => {
                  if (languageListboxOpen) {
                    closeLanguageListbox();
                  } else {
                    openLanguageListbox();
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Tab") {
                    closeLanguageListbox();
                    return;
                  }
                  if (event.key === "Escape" && languageListboxOpen) {
                    event.preventDefault();
                    event.stopPropagation();
                    closeLanguageListbox();
                    return;
                  }
                  if (
                    !languageListboxOpen &&
                    ["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)
                  ) {
                    event.preventDefault();
                    openLanguageListbox();
                    return;
                  }
                  if (!languageListboxOpen) return;
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const direction = event.key === "ArrowDown" ? 1 : -1;
                    setActiveLanguageIndex((current) =>
                      Math.min(
                        LANGUAGE_OPTIONS.length - 1,
                        Math.max(0, current + direction),
                      ),
                    );
                    return;
                  }
                  if (event.key === "Home" || event.key === "End") {
                    event.preventDefault();
                    setActiveLanguageIndex(
                      event.key === "Home" ? 0 : LANGUAGE_OPTIONS.length - 1,
                    );
                    return;
                  }
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectLanguage(LANGUAGE_OPTIONS[activeLanguageIndex].value);
                  }
                }}
              >
                <span>{selectedLanguageOption.label}</span>
                <svg viewBox="0 0 12 8" aria-hidden="true">
                  <path d="M1 1.5 6 6.5 11 1.5" />
                </svg>
              </button>
              {languageListboxOpen && (
                <div
                  className="language-listbox-options"
                  id={LANGUAGE_LISTBOX_ID}
                  role="listbox"
                  aria-label={text(
                    language,
                    "표시 언어 선택",
                    "Select display language",
                  )}
                >
                  {LANGUAGE_OPTIONS.map((option, index) => (
                    <button
                      className={`language-listbox-option ${
                        index === activeLanguageIndex ? "is-active" : ""
                      }`}
                      id={`display-language-option-${option.value}`}
                      key={option.value}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={option.value === language}
                      onPointerDown={(event) => event.preventDefault()}
                      onPointerMove={() => setActiveLanguageIndex(index)}
                      onClick={() => selectLanguage(option.value)}
                    >
                      <span>{option.label}</span>
                      <span
                        className="language-listbox-check"
                        aria-hidden="true"
                      >
                        {option.value === language ? "✓" : ""}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <section>
          <div className="setting-row">
            <div>
              <h2>
                {text(language, "로그인 시 자동 실행", "Launch at login")}
              </h2>
              <p className="section-help">
                {text(
                  language,
                  "시스템에 로그인하면 QuotaPacer와 오버레이를 자동으로 시작합니다.",
                  "Automatically starts QuotaPacer and its overlay when you sign in to the system.",
                )}
              </p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                aria-label={text(
                  language,
                  "로그인 시 자동 실행 사용",
                  "Launch QuotaPacer at login",
                )}
                checked={draftLaunchAtLogin}
                disabled={formBusy || sessionId === null}
                onChange={(event) => {
                  setDraftLaunchAtLogin(event.target.checked);
                  setMessage("");
                }}
              />
              <span />
            </label>
          </div>
        </section>

        <section>
          <div className="weekly-plan-heading">
            <h2>{text(language, "주간 사용 계획", "Weekly usage plan")}</h2>
            <strong>{text(language, "합계", "Total")} 100.0%</strong>
            <p className="section-help">
              {text(
                language,
                "요일별 상대 강도를 정하면 실제 배분을 100%로 계산합니다.",
                "Set a relative intensity for each day; allocation is normalized to 100%.",
              )}
            </p>
          </div>

          <div
            className="weekday-distribution"
            role="img"
            aria-label={`${text(language, "요일별 계산 배분", "Calculated daily allocation")}, ${fullDayLabels
              .map(
                (label, index) =>
                  `${label} ${weekdayAllocations[index].toFixed(1)}%`,
              )
              .join(", ")}`}
          >
            {weekdayAllocations.map((allocation, index) => (
              <span
                key={fullDayLabels[index]}
                style={{ width: `${allocation}%` }}
              />
            ))}
          </div>

          <div
            className="weekday-presets"
            role="group"
            aria-label={text(
              language,
              "빠른 강도 선택",
              "Quick intensity presets",
            )}
          >
            {(
              [
                ["even", text(language, "균등 배분", "Even")],
                ["weekday", text(language, "평일 중심", "Weekday focused")],
                ["weekend", text(language, "주말 중심", "Weekend focused")],
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
              <h3>
                {text(language, "요일별 사용 강도", "Daily usage intensity")}
              </h3>
              <span>
                {text(
                  language,
                  "막대는 자동으로 움직이지 않습니다",
                  "Bars do not move automatically",
                )}
              </span>
            </div>
            <div
              className="weekday-equalizer"
              aria-label={text(
                language,
                "요일별 상대 사용 강도",
                "Relative daily usage intensity",
              )}
            >
              {dayLabels.map((label, index) => {
                const inputId = `weekday-weight-${index}`;
                const weight = paceSettings.weekdayWeights[index];
                const allocation = weekdayAllocations[index];
                return (
                  <div className="weekday-weight" key={inputId}>
                    <span className="weekday-weight-level">
                      {weekdayWeightLabel(language, weight)}
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
                        aria-label={text(
                          language,
                          `${fullDayLabels[index]} 상대 사용 강도`,
                          `${fullDayLabels[index]} relative usage intensity`,
                        )}
                        aria-valuetext={text(
                          language,
                          `${weekdayWeightLabel(language, weight)}, 실제 배분 ${allocation.toFixed(1)}%`,
                          `${weekdayWeightLabel(language, weight)}, actual allocation ${allocation.toFixed(1)}%`,
                        )}
                        disabled={formBusy}
                        value={weight}
                        style={
                          {
                            "--range-progress": `${weight * 10}%`,
                          } as CSSProperties
                        }
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
            {text(
              language,
              "각 요일은 주간 제한 창의 초기화 시각부터 시작되는 24시간 구간입니다.",
              "Each day is a 24-hour segment beginning at the weekly limit's reset time.",
            )}
          </p>
        </section>

        <section>
          <div className="setting-row opacity-setting">
            <div>
              <h2>{text(language, "오버레이 투명도", "Overlay opacity")}</h2>
              <p className="section-help">
                {text(
                  language,
                  "낮을수록 배경이 더 많이 비칩니다. 최소 40%입니다.",
                  "Lower values reveal more of the background. The minimum is 40%.",
                )}
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
              step="1"
              aria-label={text(language, "오버레이 투명도", "Overlay opacity")}
              aria-valuetext={text(
                language,
                `${opacity}% · 낮을수록 더 투명함`,
                `${opacity}% · lower is more transparent`,
              )}
              disabled={formBusy || sessionId === null}
              value={opacity}
              style={
                {
                  "--range-progress": `${opacityTooltipPosition}%`,
                } as CSSProperties
              }
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
              <h2>
                {text(language, "OS 경고 알림", "OS warning notifications")}
              </h2>
              <p className="section-help">
                {text(
                  language,
                  "계획 초과나 초기화 전 소진 위험을 창 세대별로 한 번 알립니다.",
                  "Alerts once per limit window when usage exceeds the plan or may run out before reset.",
                )}
              </p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                aria-label={text(
                  language,
                  "OS 경고 알림 사용",
                  "Enable OS warning notifications",
                )}
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
            {text(language, "권한:", "Permission:")}{" "}
            {permission === "checking"
              ? text(language, "확인 중", "Checking")
              : permission === "granted"
                ? text(language, "허용됨", "Granted")
                : text(language, "허용되지 않음", "Not granted")}
          </p>
        </section>

        <section>
          <div className="setting-row">
            <div>
              <h2>{text(language, "최근 이력", "Recent history")}</h2>
              <p className="section-help">
                {text(
                  language,
                  "최근 사용률 이력과 알림 중복 방지 상태를 최대 25시간 보존합니다. 계정 정보는 저장하지 않습니다.",
                  "Usage history and notification deduplication state are kept for up to 25 hours. Account information is not stored.",
                )}
              </p>
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={clearingHistory || saving}
              onClick={() => void clearHistory()}
            >
              {text(language, "이력 삭제", "Delete history")}
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
          {text(language, "저장", "Save")}
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
            <h2 id="unsaved-title">
              {text(language, "변경사항을 저장할까요?", "Save your changes?")}
            </h2>
            <p id="unsaved-description">
              {text(
                language,
                "저장하지 않으면 오버레이 미리보기를 포함한 변경사항이 사라집니다.",
                "Unsaved changes, including the overlay preview, will be lost.",
              )}
            </p>
            <div className="confirm-actions">
              <button
                className="primary-button"
                type="button"
                disabled={formBusy || !weightsValid}
                onClick={() => void save(true)}
              >
                {text(language, "저장", "Save")}
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={formBusy}
                onClick={() => void cancelSessionAndHide()}
              >
                {text(language, "변경사항 폐기", "Discard changes")}
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={formBusy}
                autoFocus
                onClick={() => setCloseDialogOpen(false)}
              >
                {text(language, "계속 편집", "Keep editing")}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

export default SettingsApp;
