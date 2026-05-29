# Docker 服务端部署指南

这份指南用于把 MipaVoice 后端和 LiveKit 用 Docker 部署到任意 x86_64 Linux 服务器上。服务器只需要安装 Docker 和 Docker Compose 插件，不需要安装 Rust、Node.js 或手动编译二进制。

## 1. 一键启动

在服务器上进入项目目录后执行：

```bash
docker compose up -d --build
```

这会启动两个服务：

- `mipavoice-server`：MipaVoice 后端 API，监听 `3901/tcp`
- `mipavoice-livekit`：LiveKit 语音服务，监听 `7880/tcp`、`7881/tcp`、`7882/udp`

SQLite 数据库保存在 Docker volume `mipavoice_mipavoice-data` 中，容器重启和镜像升级不会删除数据。

## 2. 单独构建后端镜像

如果只想构建后端镜像：

```bash
docker build -t mipavoice-server:latest .
```

把镜像发到另一台 Linux 服务器：

```bash
docker save mipavoice-server:latest -o mipavoice-server.tar
scp mipavoice-server.tar user@your-server:/tmp/
ssh user@your-server
docker load -i /tmp/mipavoice-server.tar
```

单独运行后端容器：

```bash
docker run -d \
  --name mipavoice-server \
  --restart unless-stopped \
  -p 3901:3901 \
  -v mipavoice-data:/data \
  -e MIPAVOICE_BIND_ADDR=0.0.0.0:3901 \
  -e MIPAVOICE_DATABASE_URL=sqlite:///data/mipavoice.db \
  -e LIVEKIT_URL=ws://YOUR_LIVEKIT_HOST:7880 \
  -e LIVEKIT_API_KEY=devkey \
  -e LIVEKIT_API_SECRET=secret \
  mipavoice-server:latest
```

## 3. 生产环境配置

默认配置使用 `devkey` / `secret`，只适合内网测试。公开部署前请改成随机长字符串。

1. 复制环境示例：

   ```bash
   cp docker/.env.example .env
   ```

2. 编辑 `.env`：

   ```text
   LIVEKIT_URL=wss://voice.example.com
   LIVEKIT_API_KEY=replace-with-a-long-random-key
   LIVEKIT_API_SECRET=replace-with-a-long-random-secret
   ```

3. 同步编辑 `docker/livekit.yaml` 里的 `keys`：

   ```yaml
   keys:
     replace-with-a-long-random-key: replace-with-a-long-random-secret
   ```

4. 重启：

   ```bash
   docker compose up -d --build
   ```

## 4. 防火墙端口

如果直接暴露 Docker 服务，需要放行：

```text
3901/tcp
7880/tcp
7881/tcp
7882/udp
```

如果前面还有 Nginx 和 HTTPS，通常额外放行：

```text
80/tcp
443/tcp
```

客户端的“后端服务器”填写后端地址，例如：

```text
http://your-server-ip:3901
```

或经过 HTTPS 反向代理后的地址：

```text
https://voice.example.com
```

## 5. 验证和维护

检查后端健康状态：

```bash
curl http://127.0.0.1:3901/health
```

应该返回：

```text
ok
```

查看日志：

```bash
docker compose logs -f mipavoice
docker compose logs -f livekit
```

更新服务：

```bash
docker compose pull
docker compose up -d --build
```

停止服务：

```bash
docker compose down
```

如果需要连数据库一起删除，再执行：

```bash
docker compose down -v
```
