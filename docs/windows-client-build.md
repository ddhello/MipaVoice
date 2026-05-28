# Windows 客户端打包指南

这份指南用于把 MipaVoice 打包成 Windows 可安装的 `.exe` 客户端。

## 1. 准备环境

在 Windows 上安装：

- Node.js
- pnpm
- Rust stable
- Visual Studio 2022 的 `Desktop development with C++`
- Microsoft WebView2 Runtime

在项目根目录安装依赖：

```powershell
pnpm install
```

检查 Tauri 环境：

```powershell
pnpm tauri -- info
```

如果环境项里有红叉，先按提示补齐依赖。

## 2. 配置客户端默认后端

客户端默认连接：

```text
http://127.0.0.1:3901
```

如果你希望打包后的客户端默认连接远程服务器，可以在打包前设置：

```powershell
$env:VITE_API_URL="https://your-domain.example"
pnpm tauri build
```

也可以不设置默认值，让用户在客户端“设置”里填写后端服务器地址。

## 3. 打包

运行：

```powershell
pnpm tauri build
```

构建完成后，安装包通常在：

```text
target\release\bundle\nsis\
target\release\bundle\msi\
```

其中 `nsis` 目录下的 `.exe` 是常用 Windows 安装包。

## 4. 分发注意事项

- 这个 `.exe` 是客户端，不包含后端服务器和 LiveKit。
- 真实语音需要后端服务和 LiveKit 已经部署好。
- 如果用户连接远程服务器，需要在客户端设置里填写后端地址，例如：

```text
https://voice.example.com
```

或局域网地址：

```text
http://192.168.1.20:3901
```

## 5. 常见问题

### 打包时找不到 Tauri 项目

请确认从项目根目录运行：

```powershell
pnpm tauri build
```

不要在 `web` 子目录里运行 Tauri 命令。

### 前端端口被占用

关闭已有的 `pnpm dev` 或 `pnpm tauri dev` 进程后重试。

### 客户端能打开但看不到频道

确认后端正在运行，并且客户端设置里的后端服务器地址正确。

