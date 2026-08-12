# QuotaPacer

[한국어](README.md) | [English](README_EN.md)

QuotaPacer is an unofficial cross-platform desktop app that displays the remaining usage reported for the current account by Codex CLI in a compact overlay. It targets Windows, macOS, and Linux. The current MVP focuses on usage visibility, pace forecasts and warnings, and automatic and manual refresh.

> This project is not an official OpenAI product. It does not read Codex credentials or tokens directly. It only uses the app-server interface of a Codex CLI installation that the user has installed and signed in to.

Product principles, established technical and UX decisions, and future plans are documented in the [project direction](docs/PROJECT_DIRECTION.md), which is currently maintained in Korean.

## Current features

- A `small` 152×56 capsule with a circular gauge, a `middle` 280×72 bar gauge, and a 360px-wide `large` card with plan comparison and exhaustion forecasting
- Overlay size switching from the `⋯` menu, right-click context menu, and tray menu
- Live overlay opacity preview from Settings, with explicit save or discard behavior, plus immediate switching and persistence of the 7-day plan visualization from the Large header
- Korean and English UI; changing the language previews it immediately in both Settings and the overlay, while save or discard commits or restores both surfaces together
- Displays every limit window returned by app-server without assuming a fixed number of windows or fixed slot meanings
- Labels 300 minutes as `5 hours`, 10,080 minutes as `Weekly`, and other durations dynamically
- Selects the window with the lowest remaining percentage as the featured window
- Groups observations with the same window ID and reset times within five minutes into one generation, then forecasts exhaustion using either the recent 6–24 hour pace or the period average since the limit began
- A continuously accumulated plan line for 7-day limits based on progress through each 24-hour allocation segment
- A conditional Large-header toggle between a plan-variance gauge and a weekly allocation map for eligible 7-day limits; other limit durations always use plan variance
- A forecast timeline showing the expected exhaustion position between now and reset
- Inline warnings for exceeding the plan or exhausting before reset; optional OS notifications fire only after the condition persists across two real observations at least 60 seconds apart
- Refresh every 60 seconds and a 500ms debounced refresh after `account/rateLimits/updated`
- Retains the last successful value during errors or disconnection, marks it as delayed, and reconnects
- Persists overlay size, position, opacity, language, pace settings, and Large plan visualization; also clamps saved positions to the current monitor work area
- Tray actions for show/hide, refresh, Settings, and quit
- Direct executable selection and a return to automatic detection only when CLI discovery or app-server compatibility checks fail
- Settings for opacity, weekly plan, notification permission, and deletion of recent history

The current scope does not include automatic startup, character animation, long-term usage history or charts, in-app sign-in, or bundling Codex CLI.

## Requirements

- Node.js 22.13 or later and npm
- Rust stable 1.77.2 or later
- Codex CLI 0.144.6 or later recommended
- Codex CLI signed in with an authentication method that supports account usage lookup (ChatGPT sign-in recommended)

If Codex CLI is missing, follow the [official Codex CLI guide](https://developers.openai.com/codex/cli) to install it. Then sign in with ChatGPT or another authentication method that supports account usage lookup. API-key and Amazon Bedrock authentication are not supported.

```sh
codex --version
codex login
```

Versions earlier than 0.144.6 remain usable when app-server initialization and the required methods work correctly. The version number is advisory; compatibility is determined from the results of `initialize`, `account/read`, and `account/rateLimits/read`.

## Development

```sh
npm install
npm run tauri dev
```

See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for platform-specific development dependencies. Linux additionally requires WebKitGTK and AppIndicator development packages.

## Checks and build

```sh
npm run typecheck
npm run lint
npm test
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run tauri build
```

Run the manual integration check against a locally installed and signed-in CLI with:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib connects_to_installed_codex_cli -- --ignored --nocapture --test-threads=1
```

## Structure

```text
src/                  React overlay UI, display rules, and frontend tests
src-tauri/src/lib.rs
                      Tauri initialization, windows, tray, menus, and frontend commands
src-tauri/src/codex.rs
                      CLI discovery, JSONL app-server client, and reconnection
src-tauri/src/usage.rs
                      Rate-limit response normalization and featured-window selection
src-tauri/src/pace.rs
                      Short-term history, exhaustion forecasts, plan lines, and alerts
src-tauri/src/settings.rs
                      CLI path, overlay display, language, and pace settings
src-tauri/fixtures/   Regression fixtures preserving real response shapes
```

The backend starts app-server in this order:

1. Send `initialize` with `clientInfo.name = quota_pacer`
2. Send the `initialized` notification
3. Call `account/read`
4. Call `account/rateLimits/read`

When `rateLimitsByLimitId` is not empty, it takes precedence; otherwise the single `rateLimits` object is used. Each bucket's `primary` and `secondary` values are treated as independent windows, and null values are omitted. If the response contains only a weekly window, the UI therefore shows only that row and does not create a nonexistent 5-hour placeholder.

## CLI discovery order

1. A user-selected and saved executable path
2. `CODEX_CLI_PATH`
3. The current process `PATH`
4. `where.exe` on Windows or `command -v` in a Unix login shell

On Windows, the app can run npm `.cmd` and `.bat` wrappers, PowerShell `.ps1` scripts, and native `.exe` files. It prefers an executable npm `.cmd` over restricted WindowsApps aliases or extensionless POSIX shims.

The path selection UI remains hidden when an automatically discovered CLI is compatible. It appears in the overlay error surface only when automatic discovery fails or the detected CLI does not support app-server. If a saved path later becomes invalid, the same surface can clear it and return to automatic detection. Extensionless executables can be selected on macOS and Linux. A selected file is saved only after its version and app-server support are verified.

## Data and privacy

The app does not read or store Codex authentication tokens or account email addresses. For exhaustion forecasting, it stores only the limit-window identifier, reset time, usage percentage, observation time, and notification deduplication state in `pace-history.json` for up to 25 hours. Settings can delete the recent usage history and notification state at any time.

The app also stores the user-selected CLI path, overlay size, position, opacity, display language, pace settings, and the Large-header plan visualization. API-key authentication and unsupported authentication methods are shown as distinct states; in-app sign-in is not provided.

## Platform notes

- Windows and macOS support transparent frameless windows and tray behavior. The macOS transparent window uses Tauri's private API option, so the current configuration is not eligible for Mac App Store distribution.
- On Linux, always-on-top, focus, transparency, and global positioning can vary between X11, Wayland, and desktop environments. Manual verification is required before distribution.
- When monitor or DPI configuration changes, the saved position is clamped to the current monitor work area.
- OS notification permission and presentation vary by platform. The current implementation targets Windows; permission prompts and notification deduplication must be manually verified on macOS and Linux before distribution.
