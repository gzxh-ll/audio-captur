# SystemAudioCapture（极简系统声音采集器）

目标：

- Windows + macOS（macOS 13+）
- 采集“系统内部播放的声音”
- 录制 10–15 秒：<10 秒尽量不可停止；>15 秒自动停止
- 输出：保存到本地指定文件夹，`.mp3`（48kHz 立体声）用于漫剧AI人声采样。可以将采样文件拖放至museAI中的人物音色库中使用。
- 交互：全局快捷键 `Ctrl/⌘ + Shift + R`，录制时右上角悬浮条带“停止”按钮

---

## 项目结构（关键目录）

- `src/`：Electron 主进程 + 悬浮条 UI
- `native/`：平台采集 helper（macOS/Windows）
  - macOS：`native/macos/CaptureHelper/`（Swift Package）
  - Windows：`native/windows/capture-helper/`（Rust）

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
  - 手动：GitHub → Actions → build → Run workflow / Re-run jobs
  - 或推送 tag：`v*`（例如 `v0.1.0`）
- 产物位置：
  - Actions 运行完成后，在对应 run 的 **Artifacts** 中下载：
    - `SystemAudioCapture-macOS`
    - `SystemAudioCapture-Windows`

## 系统音频采集 helper

Electron 主进程会启动 `native/bin/capture-helper(.exe)`，并将其 stdout 的 PCM 喂给 ffmpeg 编码为 MP3。

- PCM 约定：`s16le / 48000 Hz / stereo`
- helper 停止：收到 SIGINT 或 stdin 关闭

---

## macOS 13+（Swift / ScreenCaptureKit）

源码位置：

- ✅ **真实参与构建的文件**：`native/macos/CaptureHelper/Sources/main.swift`

⚠️ 避免改错文件：

- 如果存在 `native/macos/CaptureHelper/main.swift`（包根目录下），建议删除（它不参与 SwiftPM 构建，但会误导修改）。

本地构建：

```bash
cd native/macos/CaptureHelper
swift build -c release
mkdir -p ../bin
cp -f .build/release/capture-helper ../bin/capture-helper
```

权限说明：

- 首次运行会触发“屏幕录制/采集”权限弹窗
- 若拒绝，需要到：系统设置 → 隐私与安全性 → 屏幕录制 中允许本应用，然后重试

---

## Windows（Rust / WASAPI loopback）

源码位置：

- `native/windows/capture-helper/`

本地构建（PowerShell）：

```powershell
cd native\windows\capture-helper
cargo build --release
mkdir ..\..\bin -Force | Out-Null
copy /Y target\release\capture-helper.exe ..\..\bin\capture-helper.exe
```

说明：

- helper 使用 WASAPI loopback 抓取默认输出设备的系统声音
- 输出为裸 PCM：`s16le / 48kHz / 2ch`
- 若设备混音采样率不是 48k，会做简易线性重采样
- ⚠️ 本项目当前使用 `windows = 0.56`，该版本下 `IAudioCaptureClient::GetBuffer` 为 **out 参数**形式（不是 tuple 返回），代码已按此实现。

## 权限（macOS）

macOS 13+ 使用 ScreenCaptureKit 采集系统音频通常需要用户授权。若用户拒绝，应提示去系统设置开启权限。

本项目在 helper 检测到权限不足时，会弹出更明确的引导，并可一键跳转到：

系统设置 → 隐私与安全性 → 屏幕录制

---

## 常见构建问题排查

1) Actions 报 “Dependencies lock file is not found”

- 说明 workflow 里启用了 `cache: npm` 但仓库没提交 lock 文件
- 当前工作流默认已关闭 `cache: npm`，避免该问题

2) Windows 报 “unclosed delimiter”

- 说明 `native/windows/capture-helper/src/main.rs` 内容被截断/括号不配对
- 建议用“整份文件覆盖粘贴”的方式更新该文件，然后 Re-run jobs
