# Docker 服务端部署指南

这份指南用于部署 MipaVoice 后端。后端已经内置音频 WebRTC SFU，频道、成员、聊天和语音转发都由同一个 `mipavoice-server` 镜像提供。

## 服务

- `mipavoice-server`：MipaVoice 后端和内置 SFU，监听 `3901/tcp`

## 环境变量

```env
MIPAVOICE_BIND_ADDR=0.0.0.0:3901
MIPAVOICE_DATABASE_URL=sqlite:///data/mipavoice.db
MIPAVOICE_SFU_URL=/sfu
MIPAVOICE_SFU_SECRET=replace-with-a-long-random-secret
MIPAVOICE_SFU_PUBLIC_IP=YOUR_SERVER_PUBLIC_IP
MIPAVOICE_SFU_UDP_PORT=50000
```

## 启动

```bash
docker compose up -d --build
docker compose logs -f mipavoice
```

确认 `/health` 返回 `ok` 后，客户端即可连接后端并使用内置 SFU 通话。公网部署时需要在云安全组和系统防火墙放行 `50000/udp`。
