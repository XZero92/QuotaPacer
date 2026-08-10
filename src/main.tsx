import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "pretendard/dist/web/variable/pretendardvariable.css";
import App from "./App";
import SettingsApp from "./SettingsApp";

const isSettings = getCurrentWindow().label === "settings";
if (isSettings) document.documentElement.classList.add("settings-view");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isSettings ? <SettingsApp /> : <App />}
  </React.StrictMode>,
);
