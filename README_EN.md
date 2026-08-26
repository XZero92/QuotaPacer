# QuotaPacer

[한국어](README.md) | [English](README_EN.md)

QuotaPacer is an unofficial cross-platform desktop app that displays the remaining usage and pace reported for the current account by Codex CLI in a compact overlay.

> This project is not an official OpenAI product. It does not read Codex credentials or tokens directly and only uses the app-server interface of a Codex CLI installation that the user has installed and signed in to.

Product principles and established technical and UX decisions are documented in the [project direction](docs/PROJECT_DIRECTION.md), which is maintained in Korean.

![Small, Middle, and Large overlay layouts](docs/assets/overlay-modes.svg)

## Key features

- An always-on-top overlay with three information densities: Small and Middle prioritize a 300-minute limit window, while Large shows every limit window actually returned
- Observation confidence and exhaustion risk for windows shorter than 24 hours, plus plan and exhaustion comparisons for longer windows
- Inline warnings and optional OS notifications for confirmed risks
- Periodic and event-driven refresh, retention of the last value during disconnection, and automatic reconnection
- Drag positioning and persistence of opacity, language, pace, and window settings
- Size, Settings, refresh, hide, and quit actions from the tray and overlay menus
- Automatic Codex CLI discovery with direct executable selection when discovery fails

## Runtime requirements

- Codex CLI 0.144.6 or later recommended
- Codex CLI signed in with an authentication method that supports account usage lookup (ChatGPT sign-in recommended)

If Codex CLI is missing, follow the [official Codex CLI guide](https://developers.openai.com/codex/cli) and then sign in. API-key and Amazon Bedrock authentication are not supported.

The CLI version is advisory. Earlier versions remain usable when app-server initialization and the required methods work correctly.

## Build from source

- Node.js 22.13 or later and npm
- Rust stable 1.77.2 or later
- Platform-specific [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

```sh
npm install
npm run tauri dev
```

Run `npm run tauri build` to create a distribution build. Linux additionally requires WebKitGTK and AppIndicator development packages.

## Checks

```sh
npm run typecheck
npm run lint
npm test
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

## Data and privacy

The app does not read or store Codex authentication tokens or account email addresses. It retains only the limit-window identifier, reset time, usage percentage, observation time, and notification state needed for forecasts in `pace-history.json` for up to 25 hours; Settings can delete this data. It also stores the CLI path and overlay display and pace settings.

## Platform notes

- The transparent macOS window uses Tauri's private API, so the current configuration is not eligible for Mac App Store distribution.
- Always-on-top, focus, transparency, and window positioning on Linux can vary between X11, Wayland, and desktop environments.
- OS notifications and multi-monitor and DPI behavior require manual verification on each platform.

## License

QuotaPacer is distributed under the [MIT License](LICENSE). The Pretendard font is covered by a separate [SIL Open Font License](src-tauri/resources/licenses/Pretendard-OFL.txt).
