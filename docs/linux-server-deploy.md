# Linux 远程服务器部署指南

这份指南用于把 MipaVoice 后端部署到 Linux 服务器。语音媒体服务已内置在后端进程中，对外暴露 `/sfu` WebSocket 信令入口。

## 后端环境变量

```env
MIPAVOICE_BIND_ADDR=0.0.0.0:3901
MIPAVOICE_DATABASE_URL=sqlite:///opt/mipavoice/mipavoice.db
MIPAVOICE_SFU_URL=/sfu
MIPAVOICE_SFU_SECRET=replace-with-a-long-random-secret
MIPAVOICE_SFU_PUBLIC_IP=YOUR_SERVER_PUBLIC_IP
MIPAVOICE_SFU_UDP_PORT=50000
MIPAVOICE_ICE_SERVERS=stun:stun.l.google.com:19302
```

`MIPAVOICE_SFU_SECRET` 用于签发和校验内置 SFU 的入会 JWT。后端签发的 JWT 包含 `sub`、`name`、`room` 和 `exp`。

## 运行

```bash
cargo build --release -p mipavoice-server
MIPAVOICE_SFU_SECRET=replace-with-a-long-random-secret \
MIPAVOICE_SFU_PUBLIC_IP=YOUR_SERVER_PUBLIC_IP \
MIPAVOICE_SFU_UDP_PORT=50000 \
MIPAVOICE_ICE_SERVERS=stun:stun.l.google.com:19302 \
./target/release/mipavoice-server
```

生产环境建议继续使用 systemd 或容器托管后端进程，并确保反向代理支持 WebSocket 升级到 `/sfu`。公网部署时需要在云安全组和系统防火墙放行 `50000/udp`。如果客户端在复杂 NAT 后面，建议配置 TURN，并通过 `MIPAVOICE_ICE_SERVERS`、`MIPAVOICE_ICE_USERNAME`、`MIPAVOICE_ICE_CREDENTIAL` 下发给客户端。
