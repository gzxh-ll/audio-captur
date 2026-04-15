# 平台采集 helper（占位）

本项目将“系统音频采集”从 Electron 主进程中拆分为**平台 helper 可执行文件**：

- 运行后持续向 stdout 输出 PCM（约定：**s16le / 48kHz / 立体声**）
- 收到 SIGINT 或 stdin close 后停止并退出

打包时需要把 helper 放到：

`native/bin/capture-helper`（macOS）  
`native/bin/capture-helper.exe`（Windows）

> 提示：当前仓库提供 macOS/Swift 与 Windows/Rust 的工程骨架（并未在此环境编译）。你需要在对应系统上编译产物后放入 `native/bin/`。

## macOS 13+（Swift / ScreenCaptureKit）构建

前置：

- macOS 13+（Sonoma/Ventura）
- Xcode 15+（或 Swift 5.9+）

构建（在本项目目录内）：

```bash
cd native/macos/CaptureHelper
swift build -c release
cp -f .build/release/capture-helper ../bin/capture-helper
```

首次运行会触发系统权限弹窗（ScreenCaptureKit 相关）。若拒绝，需要到系统设置里开启采集权限。

## Windows（Rust / WASAPI loopback）构建

前置：

- Windows 10+
- Rust stable（建议 1.74+）
- Visual Studio Build Tools（MSVC toolchain）

构建（在本项目目录内）：

```powershell
cd native\windows\capture-helper
cargo build --release
copy /Y target\release\capture-helper.exe ..\..\bin\capture-helper.exe
```

说明：

- helper 使用 WASAPI loopback 抓取默认输出设备的系统声音
- 输出为裸 PCM：`s16le / 48kHz / 2ch`（若设备混音采样率不是 48k，会做简易线性重采样）
