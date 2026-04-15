const path = require("path");
const fs = require("fs");
const { spawnCaptureHelper, spawnFfmpegEncodeMp3 } = require("./helpers");

function nowMs() {
  // 单调时间，避免系统时间跳变影响
  return Number(process.hrtime.bigint() / 1000000n);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function makeFilename() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const MM = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `SystemAudio_${yyyy}${MM}${dd}_${hh}${mm}${ss}.mp3`;
}

function ensureUniquePath(dir, filename) {
  const base = filename.replace(/\.mp3$/i, "");
  let p = path.join(dir, filename);
  let i = 1;
  while (fs.existsSync(p)) {
    p = path.join(dir, `${base}_(${i}).mp3`);
    i += 1;
  }
  return p;
}

/**
 * @typedef {Object} RecorderState
 * @property {"IDLE"|"RECORDING_LOCKED"|"RECORDING_UNLOCKED"|"STOPPING"} phase
 * @property {number} elapsedSec
 * @property {boolean} canStopByUser
 */

class RecorderController {
  /**
   * @param {{
   *  onState: (state: RecorderState) => void,
   *  onSaved: (info: {filePath: string, tooShort: boolean}) => void,
   *  onError: (err: {kind: string, message: string, details?: any}) => void
   * }} deps
   */
  constructor({ onState, onSaved, onError }) {
    this._onState = onState;
    this._onSaved = onSaved;
    this._onError = onError;

    this._phase = "IDLE";
    this._t0 = 0;
    this._timer = null;

    this._capture = null;
    this._ffmpeg = null;
    this._outPath = "";

    this._captureStderr = "";
    this._ffmpegStderr = "";
    this._stopping = false;
  }

  isRecording() {
    return this._phase !== "IDLE";
  }

  _emitState() {
    const elapsedSec = this._phase === "IDLE" ? 0 : Math.min(15, Math.floor((nowMs() - this._t0) / 1000));
    const canStopByUser = this._phase === "RECORDING_UNLOCKED";
    this._onState({ phase: this._phase, elapsedSec, canStopByUser });
  }

  async start({ saveDir, bitrateKbps }) {
    if (this.isRecording()) return;
    this._outPath = ensureUniquePath(saveDir, makeFilename());

    try {
      this._capture = spawnCaptureHelper();
      this._ffmpeg = spawnFfmpegEncodeMp3({ outFilePath: this._outPath, bitrateKbps });

      // capture stdout -> ffmpeg stdin
      this._capture.stdout.pipe(this._ffmpeg.stdin);

      this._captureStderr = "";
      this._ffmpegStderr = "";
      this._stopping = false;

      // 捕获错误输出（限制长度，避免占用过大）
      this._capture.stderr.on("data", (d) => {
        this._captureStderr = (this._captureStderr + d.toString("utf8")).slice(-8000);
      });
      this._ffmpeg.stderr.on("data", (d) => {
        this._ffmpegStderr = (this._ffmpegStderr + d.toString("utf8")).slice(-8000);
      });

      // 任何一端异常退出都视为录制失败（非 stop 流程）
      this._capture.on("exit", (code, signal) => {
        if (this._stopping) return;
        if (this._phase === "IDLE" || this._phase === "STOPPING") return;
        this._failFromCaptureExit(code, signal);
      });
      this._ffmpeg.on("exit", (code, signal) => {
        if (this._stopping) return;
        if (this._phase === "IDLE" || this._phase === "STOPPING") return;
        this._failFromFfmpegExit(code, signal);
      });

      this._t0 = nowMs();
      this._phase = "RECORDING_LOCKED";
      this._emitState();

      this._timer = setInterval(() => this._tick(), 200);
    } catch (e) {
      this._cleanup();
      this._phase = "IDLE";
      this._emitState();
      this._onError({
        kind: e && e.code === "HELPER_NOT_FOUND" ? "HELPER_NOT_FOUND" : "START_FAILED",
        message: e && e.message ? e.message : "启动录制失败"
      });
    }
  }

  _detectMacPermissionError(text) {
    if (process.platform !== "darwin") return false;
    const t = (text || "").toLowerCase();
    return (
      t.includes("privacy_screencapture") ||
      t.includes("screencapture") ||
      t.includes("screen capture") ||
      t.includes("screen recording") ||
      t.includes("not permitted") ||
      t.includes("permission") ||
      t.includes("denied") ||
      t.includes("declined") ||
      t.includes("not authorized") ||
      t.includes("scstreamerrordomain")
    );
  }

  _fail(kind, message, details) {
    // 进入失败态：停止计时、清理进程、回到 IDLE
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._stopping = true;
    this._cleanup();
    this._phase = "IDLE";
    this._emitState();
    this._onError({ kind, message, details });
  }

  _failFromCaptureExit(code, signal) {
    const stderr = this._captureStderr || "";
    if (this._detectMacPermissionError(stderr)) {
      this._fail(
        "MAC_SCREEN_CAPTURE_PERMISSION",
        "缺少“屏幕录制”权限（用于采集系统声音）。请在 系统设置 → 隐私与安全性 → 屏幕录制 中允许本应用，然后重试。",
        { code, signal, stderr }
      );
      return;
    }
    this._fail(
      "CAPTURE_HELPER_EXITED",
      `采集进程意外退出（code=${code ?? "null"}, signal=${signal ?? "null"}）。`,
      { code, signal, stderr }
    );
  }

  _failFromFfmpegExit(code, signal) {
    const stderr = this._ffmpegStderr || "";
    this._fail(
      "FFMPEG_EXITED",
      `编码进程意外退出（code=${code ?? "null"}, signal=${signal ?? "null"}）。`,
      { code, signal, stderr }
    );
  }

  async _tick() {
    if (this._phase === "IDLE") return;

    const elapsedMs = nowMs() - this._t0;
    const elapsedSec = Math.floor(elapsedMs / 1000);

    if (this._phase === "RECORDING_LOCKED" && elapsedSec >= 10) {
      this._phase = "RECORDING_UNLOCKED";
    }

    this._emitState();

    if (elapsedSec >= 15) {
      await this._stopInternal({ userInitiated: false });
    }
  }

  async requestStopByUser() {
    if (!this.isRecording()) return { ok: false, reason: "当前未在录制" };
    const elapsedSec = Math.floor((nowMs() - this._t0) / 1000);
    if (elapsedSec < 10) {
      return { ok: false, reason: "至少录满 10 秒才可停止" };
    }
    await this._stopInternal({ userInitiated: true });
    return { ok: true };
  }

  async _stopInternal({ userInitiated }) {
    if (this._phase === "STOPPING" || this._phase === "IDLE") return;

    const elapsedSec = Math.floor((nowMs() - this._t0) / 1000);
    const tooShort = elapsedSec < 10;

    this._phase = "STOPPING";
    this._emitState();

    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    try {
      this._stopping = true;
      // 通知 helper 停止：关闭 stdin + SIGINT（不同平台都尽量覆盖）
      if (this._capture && this._capture.stdin) {
        try {
          this._capture.stdin.end();
        } catch {}
      }
      if (this._capture) {
        try {
          this._capture.kill("SIGINT");
        } catch {}
      }

      // 等待一小段时间让管道 flush
      await sleep(250);

      // 关闭 ffmpeg 输入让其结束编码
      if (this._ffmpeg && this._ffmpeg.stdin) {
        try {
          this._ffmpeg.stdin.end();
        } catch {}
      }

      await this._waitProcessExit(this._ffmpeg, 5000);
      await this._waitProcessExit(this._capture, 2000);

      // 即使不足10秒，也按需求：仍保存+提醒
      this._onSaved({ filePath: this._outPath, tooShort });
    } catch (e) {
      this._onError({
        kind: "STOP_FAILED",
        message: e && e.message ? e.message : "停止录制失败"
      });
    } finally {
      this._cleanup();
      this._phase = "IDLE";
      this._emitState();
    }
  }

  async _waitProcessExit(proc, timeoutMs) {
    if (!proc) return;
    if (proc.exitCode !== null) return;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("进程退出超时")), timeoutMs);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      proc.once("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
  }

  _cleanup() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;

    if (this._capture) {
      try {
        this._capture.kill("SIGKILL");
      } catch {}
    }
    if (this._ffmpeg) {
      try {
        this._ffmpeg.kill("SIGKILL");
      } catch {}
    }
    this._capture = null;
    this._ffmpeg = null;
    this._outPath = "";
    this._captureStderr = "";
    this._ffmpegStderr = "";
    this._stopping = false;
  }
}

module.exports = { RecorderController };
