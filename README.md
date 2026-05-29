# MipaVoice

MipaVoice is a desktop voice-room MVP built with Tauri, React, Rust, SQLite, and an embedded custom WebRTC SFU.

## What is included

- Discord-style voice channels with username-only entry.
- Optional channel passwords stored as Argon2 hashes.
- Rust `axum` backend with SQLite persistence.
- Embedded audio-only WebRTC SFU at `/sfu`.
- React/Tauri desktop UI with channel list, members, join/leave, mute, device, and noise-suppression controls.

## Local development

1. Install dependencies:

   ```powershell
   pnpm install
   ```

2. Start the Rust backend:

   ```powershell
   pnpm server:dev
   ```

3. Start the web UI:

   ```powershell
   pnpm dev
   ```

4. Start the desktop app:

   ```powershell
   pnpm tauri dev
   ```

The backend signs short-lived SFU room tokens with `MIPAVOICE_SFU_SECRET`. By default, clients connect back to the same backend at `/sfu`.

## Guides

- [Windows 客户端打包指南](docs/windows-client-build.md)
- [Linux 远程服务器部署指南](docs/linux-server-deploy.md)
- [Docker 服务端部署指南](docs/docker-server-deploy.md)

## Environment

The backend reads these variables:

- `MIPAVOICE_BIND_ADDR` defaults to `127.0.0.1:3901`
- `MIPAVOICE_DATABASE_URL` defaults to `sqlite://mipavoice.db`
- `MIPAVOICE_SFU_URL` defaults to `/sfu`
- `MIPAVOICE_SFU_SECRET` defaults to `dev-secret-change-me`
- `MIPAVOICE_SFU_PUBLIC_IP` should be set to the server public IP for internet deployment
- `MIPAVOICE_SFU_UDP_PORT` defaults to `50000`
