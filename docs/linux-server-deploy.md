# Linux 远程服务器部署指南

这份指南用于把 MipaVoice 后端和 LiveKit 部署到一台 Linux 服务器上。考虑到服务器 CPU 性能较低，推荐在本机 WSL 里用 `cargo-zigbuild` 编译 Linux 二进制，并指定 glibc 兼容版本为 **2.17**，然后把编译好的文件上传到服务器。

## 1. 在 WSL 里准备构建环境

以下命令在 WSL Ubuntu 中执行。

安装基础依赖：

```bash
sudo apt update
sudo apt install -y curl build-essential pkg-config
```

安装 Rust：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

安装 `cargo-zigbuild`：

```bash
cargo install cargo-zigbuild
```

安装 Zig。推荐使用包管理器或从 Zig 官网下载 Linux x86_64 版本，只要 `zig version` 能正常输出即可：

```bash
zig version
```

## 2. 编译 glibc 2.17 兼容后端

在 WSL 中进入项目目录。如果项目在 Windows 路径，例如：

```text
D:\Backup\Documents\MipaVoice
```

对应 WSL 路径通常是：

```bash
cd /mnt/d/Backup/Documents/MipaVoice
```

运行项目自带脚本：

```bash
bash scripts/build-server-linux-glibc217.sh
```

脚本内部使用的目标是：

```bash
x86_64-unknown-linux-gnu.2.17
```

等价手动命令：

```bash
cargo zigbuild --release -p mipavoice-server --target x86_64-unknown-linux-gnu.2.17
```

构建产物会复制到：

```text
dist/server-linux-glibc217/mipavoice-server
```

这个文件就是要上传到 Linux 服务器的后端可执行文件。

## 3. 上传后端到服务器

在 WSL 中执行：

```bash
scp dist/server-linux-glibc217/mipavoice-server user@your-server:/tmp/mipavoice-server
```

登录服务器：

```bash
ssh user@your-server
```

安装到 `/opt/mipavoice`：

```bash
sudo mkdir -p /opt/mipavoice
sudo mv /tmp/mipavoice-server /opt/mipavoice/mipavoice-server
sudo chmod +x /opt/mipavoice/mipavoice-server
sudo chown -R $USER:$USER /opt/mipavoice
```

## 4. 服务器准备

示例环境：

- Ubuntu、Debian、CentOS 7+ 等 x86_64 Linux
- glibc 版本至少 2.17
- 一个域名，例如 `voice.example.com`
- 防火墙开放：
  - `80/tcp`
  - `443/tcp`
  - `7881/tcp`
  - `7882/udp`

确认 glibc：

```bash
ldd --version
```

安装运行时工具：

```bash
sudo apt update
sudo apt install -y curl unzip nginx sqlite3
```

CentOS/RHEL 可用对应包管理器安装 `curl`、`unzip`、`nginx`、`sqlite`。

## 5. 配置 MipaVoice 后端

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

## 6. 安装 LiveKit Server

下载 Linux amd64 版本：

```bash
cd /tmp
curl -L https://github.com/livekit/livekit/releases/latest/download/livekit_linux_amd64.tar.gz -o livekit.tar.gz
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

## 7. Nginx 反向代理和 HTTPS

示例域名：`voice.example.com`。

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

建议用 Certbot 配置 HTTPS：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d voice.example.com
```

HTTPS 生效后，确认 `/opt/mipavoice/mipavoice.env`：

```text
LIVEKIT_URL=wss://voice.example.com
```

然后重启后端：

```bash
sudo systemctl restart mipavoice
```

## 8. 客户端连接远程服务器

在 MipaVoice 客户端里打开“设置”，后端服务器填写：

```text
https://voice.example.com
```

保存后频道列表会从远程服务器读取。

## 9. 验证

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

两个客户端加入同一个频道后，应该能互相听到声音，并能发送持久化文字消息。

## 10. 更新服务

本机 WSL 重新编译：

```bash
bash scripts/build-server-linux-glibc217.sh
scp dist/server-linux-glibc217/mipavoice-server user@your-server:/tmp/mipavoice-server
```

服务器上替换二进制：

```bash
sudo systemctl stop mipavoice
sudo mv /tmp/mipavoice-server /opt/mipavoice/mipavoice-server
sudo chmod +x /opt/mipavoice/mipavoice-server
sudo systemctl start mipavoice
```

SQLite 数据库在：

```text
/opt/mipavoice/mipavoice.db
```

更新服务时不要删除这个文件。

