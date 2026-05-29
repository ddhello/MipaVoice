# MipaVoice

MipaVoice is a desktop voice-room MVP built with Tauri, React, Rust, SQLite, and LiveKit.

## What is included

- Discord-style voice channels with username-only entry.
- Optional channel passwords stored as Argon2 hashes.
- Rust `axum` backend with SQLite persistence.
- LiveKit token issuing for SFU-based WebRTC audio.
- React/Tauri desktop UI with channel list, members, join/leave, and mute controls.

## Local development

1. Install dependencies:

   ```powershell
   pnpm install
   ```

2. Download LiveKit Server for Windows:

   ```powershell
   pnpm livekit:download
   ```

3. Start LiveKit:

   ```powershell
   pnpm livekit:start
   ```

   This runs `livekit-server --dev` with the default local development credentials.

4. Start the Rust backend:

   ```powershell
   pnpm server:dev
   ```

5. Start the web UI:

   ```powershell
   pnpm dev
   ```

6. Start the desktop app:

   ```powershell
   pnpm tauri dev
   ```

The default LiveKit development credentials are `devkey` / `secret`.

## Guides

- [Windows 客户端打包指南](docs/windows-client-build.md)
- [Linux 远程服务器部署指南](docs/linux-server-deploy.md)（包含 WSL + zigbuild + glibc 2.17 编译流程）
- [Docker 服务端部署指南](docs/docker-server-deploy.md)

## Environment

The backend reads these variables:

- `MIPAVOICE_BIND_ADDR` defaults to `127.0.0.1:3901`
- `MIPAVOICE_DATABASE_URL` defaults to `sqlite://mipavoice.db`
- `LIVEKIT_URL` defaults to `ws://127.0.0.1:7880`
- `LIVEKIT_API_KEY` defaults to `devkey`
- `LIVEKIT_API_SECRET` defaults to `secret`
