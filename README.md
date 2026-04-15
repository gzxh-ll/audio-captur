# SystemAudioCapture（极简系统声音采集器）

目标：

- Windows + macOS（macOS 13+）
- 采集“系统内部播放的声音”
- 录制 10–15 秒：<10 秒尽量不可停止；>15 秒自动停止
- 输出：保存到本地指定文件夹，`.mp3`（48kHz 立体声）
- 交互：全局快捷键 `Ctrl/⌘ + Shift + R`，录制时右上角悬浮条带“停止”按钮

## 运行（开发态）

1) 安装依赖

```bash
npm install
```

2) 启动

```bash
npm run dev
```

> 注意：如果你还未放置平台 `capture-helper` 到 `native/bin/`，启动录制会提示找不到 helper。

## 打包

```bash
npm run dist
```

## GitHub Actions 自动出包（macOS + Windows）

仓库已内置工作流：`.github/workflows/build.yml`

- 触发方式：
  - 手动：GitHub → Actions → build → Run workflow
  - 或推送 tag：`v*`（例如 `v0.1.0`）
- 产物位置：
  - Actions 运行完成后，在对应 run 的 **Artifacts** 中下载

## 系统音频采集 helper

Electron 主进程会启动 `native/bin/capture-helper(.exe)`，并将其 stdout 的 PCM 喂给 ffmpeg 编码为 MP3。

- PCM 约定：`s16le / 48000 Hz / stereo`
- helper 停止：收到 SIGINT 或 stdin 关闭

请看：`native/README.md`（包含 macOS/Swift 与 Windows/Rust 的工程骨架占位）

## 权限（macOS）

macOS 13+ 使用 ScreenCaptureKit 采集系统音频通常需要用户授权。若用户拒绝，应提示去系统设置开启权限。

本项目在 helper 检测到权限不足时，会弹出更明确的引导，并可一键跳转到：

系统设置 → 隐私与安全性 → 屏幕录制
