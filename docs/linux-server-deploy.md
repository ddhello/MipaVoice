# Linux 远程服务器部署指南

这份指南用于在一台 Linux 服务器上部署 MipaVoice 后端和 LiveKit。推荐使用域名和 HTTPS/WSS。

## 1. 服务器准备

示例环境：

- Ubuntu 22.04 或 24.04
- 一个域名，例如 `voice.example.com`
- 防火墙开放：
  - `80/tcp`
  - `443/tcp`
  - `7881/tcp`
  - `7882/udp`

安装基础依赖：

```bash
sudo apt update
sudo apt install -y curl unzip nginx build-essential pkg-config libssl-dev
```

安装 Rust：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

## 2. 部署 MipaVoice 后端

把项目上传到服务器，然后在项目根目录构建：

```bash
cargo build --release -p mipavoice-server
```

创建部署目录：

```bash
sudo mkdir -p /opt/mipavoice
sudo cp target/release/mipavoice-server /opt/mipavoice/
sudo chown -R $USER:$USER /opt/mipavoice
```

创建环境文件：

```bash
sudo tee /opt/mipavoice/mipavoice.env >/dev/null <<'EOF'
MIPAVOICE_BIND_ADDR=127.0.0.1:3901
MIPAVOICE_DATABASE_URL=sqlite:///opt/mipavoice/mipavoice.db
LIVEKIT_URL=wss://voice.example.com
LIVEKIT_API_KEY=replace-with-a-long-random-key
LIVEKIT_API_SECRET=replace-with-a-long-random-secret
EOF
```

创建 systemd 服务：

```bash
sudo tee /etc/systemd/system/mipavoice.service >/dev/null <<'EOF'
[Unit]
Description=MipaVoice backend
After=network.target

[Service]
WorkingDirectory=/opt/mipavoice
EnvironmentFile=/opt/mipavoice/mipavoice.env
ExecStart=/opt/mipavoice/mipavoice-server
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
```

启动后端：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mipavoice
sudo systemctl status mipavoice
```

## 3. 安装 LiveKit Server

下载 Linux amd64 版本：

```bash
cd /tmp
curl -L https://github.com/livekit/livekit/releases/latest/download/livekit_$(uname -s | tr '[:upper:]' '[:lower:]')_amd64.tar.gz -o livekit.tar.gz
tar -xzf livekit.tar.gz
sudo install -m 755 livekit-server /usr/local/bin/livekit-server
```

创建 LiveKit 配置：

```bash
sudo mkdir -p /etc/livekit
sudo tee /etc/livekit/livekit.yaml >/dev/null <<'EOF'
port: 7880
bind_addresses:
  - "127.0.0.1"

rtc:
  tcp_port: 7881
  port_range_start: 7882
  port_range_end: 7882
  use_external_ip: true

keys:
  replace-with-a-long-random-key: replace-with-a-long-random-secret
EOF
```

这里的 key/secret 必须和 `/opt/mipavoice/mipavoice.env` 里的 `LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET` 一致。

创建 LiveKit systemd 服务：

```bash
sudo tee /etc/systemd/system/livekit.service >/dev/null <<'EOF'
[Unit]
Description=LiveKit Server
After=network.target

[Service]
ExecStart=/usr/local/bin/livekit-server --config /etc/livekit/livekit.yaml
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
```

启动 LiveKit：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now livekit
sudo systemctl status livekit
```

## 4. Nginx 反向代理

下面示例把后端 API 和 LiveKit WebSocket 都放在同一个域名 `voice.example.com` 上。

```bash
sudo tee /etc/nginx/sites-available/mipavoice >/dev/null <<'EOF'
server {
    listen 80;
    server_name voice.example.com;

    location / {
        proxy_pass http://127.0.0.1:3901;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    location /rtc {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
```

启用站点：

```bash
sudo ln -sf /etc/nginx/sites-available/mipavoice /etc/nginx/sites-enabled/mipavoice
sudo nginx -t
sudo systemctl reload nginx
```

建议使用 Certbot 配置 HTTPS：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d voice.example.com
```

HTTPS 生效后，把后端环境里的 `LIVEKIT_URL` 设置为：

```text
wss://voice.example.com
```

然后重启后端：

```bash
sudo systemctl restart mipavoice
```

## 5. 客户端连接远程服务器

在 MipaVoice 客户端里打开“设置”，后端服务器填写：

```text
https://voice.example.com
```

保存后频道列表会从远程服务器读取。

## 6. 验证

检查后端：

```bash
curl https://voice.example.com/health
```

应该返回：

```text
ok
```

检查服务日志：

```bash
sudo journalctl -u mipavoice -f
sudo journalctl -u livekit -f
```

两个客户端加入同一个频道后，应该能互相听到声音。

## 7. 更新服务

重新上传代码后：

```bash
cargo build --release -p mipavoice-server
sudo systemctl stop mipavoice
sudo cp target/release/mipavoice-server /opt/mipavoice/
sudo systemctl start mipavoice
```

SQLite 数据库在：

```text
/opt/mipavoice/mipavoice.db
```

更新服务时不要删除这个文件。

