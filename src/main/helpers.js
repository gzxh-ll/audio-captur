const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

function platformBinName(base) {
  if (process.platform === "win32") return `${base}.exe`;
  return base;
}

function resolveCaptureHelperPath() {
  // 打包后：resources/native/bin/...
  // 开发态：项目内 native/bin/...
  const candidates = [];

  // electron-builder：process.resourcesPath 存在
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "native", "bin", platformBinName("capture-helper")));
  }
  candidates.push(path.join(__dirname, "../../native/bin", platformBinName("capture-helper")));

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "";
}

function spawnFfmpegEncodeMp3({ outFilePath, bitrateKbps }) {
  if (!ffmpegPath) throw new Error("未找到 ffmpeg 可执行文件（ffmpeg-static）");

  // 约定：capture-helper 输出 PCM s16le, 48kHz, stereo 到 stdout
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-i",
    "pipe:0",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    `${bitrateKbps}k`,
    "-y",
    outFilePath
  ];

  const proc = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  return proc;
}

function spawnCaptureHelper() {
  const helperPath = resolveCaptureHelperPath();
  if (!helperPath) {
    const hint =
      "未找到 capture-helper。请先在 native/macos 或 native/windows 构建 helper，并将产物放入 native/bin/。";
    const err = new Error(hint);
    err.code = "HELPER_NOT_FOUND";
    throw err;
  }

  // helper 约定：
  // - 启动后持续向 stdout 输出 PCM
  // - 收到 SIGINT（或 stdin close）后停止并退出
  const proc = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
  return proc;
}

module.exports = {
  spawnCaptureHelper,
  spawnFfmpegEncodeMp3
};
