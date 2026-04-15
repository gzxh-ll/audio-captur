const path = require("path");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  ipcMain,
  dialog,
  shell,
  Notification
} = require("electron");

const Store = require("electron-store");
const { RecorderController } = require("./recorder");

const DEFAULT_HOTKEY = "CommandOrControl+Shift+R";

/** @type {Tray | null} */
let tray = null;
/** @type {BrowserWindow | null} */
let overlayWin = null;
/** @type {RecorderController | null} */
let recorder = null;

const store = new Store({
  name: "config",
  defaults: {
    saveDir: "",
    hotkey: DEFAULT_HOTKEY,
    bitrateKbps: 192
  }
});

function isMac() {
  return process.platform === "darwin";
}

function createOverlayWindow() {
  overlayWin = new BrowserWindow({
    width: 260,
    height: 68,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js")
    }
  });

  // 右上角位置（简单策略；后续可按多屏幕优化）
  const { screen } = require("electron");
  const display = screen.getPrimaryDisplay();
  const margin = 16;
  const x = Math.round(display.workArea.x + display.workArea.width - 260 - margin);
  const y = Math.round(display.workArea.y + margin);
  overlayWin.setPosition(x, y, false);

  overlayWin.loadFile(path.join(__dirname, "../renderer/index.html"));
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.on("closed", () => {
    overlayWin = null;
  });
}

function showOverlay() {
  if (!overlayWin) return;
  overlayWin.showInactive();
  overlayWin.setAlwaysOnTop(true, "floating");
}

function hideOverlay() {
  if (!overlayWin) return;
  overlayWin.hide();
}

function showNotification(title, body) {
  try {
    new Notification({ title, body }).show();
  } catch {
    // ignore
  }
}

async function showMacScreenCapturePermissionDialog() {
  const url = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "需要权限",
    message: "需要开启“屏幕录制”权限才能采集系统声音。",
    detail:
      "请打开 系统设置 → 隐私与安全性 → 屏幕录制，允许本应用。\n修改权限后可能需要重新启动应用。",
    buttons: ["打开系统设置", "取消"],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (result.response === 0) {
    try {
      await shell.openExternal(url);
    } catch {
      // ignore
    }
  }
}

async function ensureSaveDir() {
  const current = store.get("saveDir");
  if (current && typeof current === "string" && current.length > 0) return current;

  const result = await dialog.showOpenDialog({
    title: "选择保存文件夹",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return "";
  const dir = result.filePaths[0];
  store.set("saveDir", dir);
  return dir;
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("SystemAudioCapture");

  const buildMenu = () =>
    Menu.buildFromTemplate([
      {
        label: "开始/停止录制（全局快捷键）",
        click: () => toggleRecording()
      },
      { type: "separator" },
      {
        label: "选择保存文件夹…",
        click: async () => {
          const result = await dialog.showOpenDialog({
            title: "选择保存文件夹",
            properties: ["openDirectory", "createDirectory"]
          });
          if (!result.canceled && result.filePaths[0]) {
            store.set("saveDir", result.filePaths[0]);
            showNotification("已更新保存目录", result.filePaths[0]);
          }
        }
      },
      {
        label: "打开保存文件夹",
        click: async () => {
          const dir = await ensureSaveDir();
          if (dir) shell.openPath(dir);
        }
      },
      { type: "separator" },
      { label: "退出", click: () => app.quit() }
    ]);

  tray.setContextMenu(buildMenu());
}

async function toggleRecording() {
  if (!recorder) return;
  if (recorder.isRecording()) {
    const { ok, reason } = await recorder.requestStopByUser();
    if (!ok && reason) showNotification("无法停止", reason);
    return;
  }

  const dir = await ensureSaveDir();
  if (!dir) {
    showNotification("未选择保存目录", "请选择一个保存文件夹后再开始录制");
    return;
  }
  const bitrateKbps = store.get("bitrateKbps");
  await recorder.start({
    saveDir: dir,
    bitrateKbps: typeof bitrateKbps === "number" ? bitrateKbps : 192
  });
}

function registerHotkey() {
  const hotkey = store.get("hotkey") || DEFAULT_HOTKEY;
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(hotkey, () => toggleRecording());
  if (!ok) {
    showNotification("快捷键注册失败", "请在设置中更换快捷键");
  }
}

app.on("ready", async () => {
  // macOS：不显示 Dock 图标，体验更像菜单栏工具
  if (isMac() && app.dock) app.dock.hide();

  createOverlayWindow();
  createTray();

  recorder = new RecorderController({
    onState: (state) => {
      if (!overlayWin) return;
      overlayWin.webContents.send("recorder:state", state);
      if (state.phase === "IDLE") hideOverlay();
      else showOverlay();
    },
    onSaved: ({ filePath, tooShort }) => {
      if (tooShort) showNotification("录制完成（时长不足10秒）", path.basename(filePath));
      else showNotification("录制完成", path.basename(filePath));
    },
    onError: async (err) => {
      const kind = err && err.kind ? err.kind : "UNKNOWN";
      const message = err && err.message ? err.message : "未知错误";

      showNotification("录制失败", message);

      // 更产品化的权限引导（macOS 13+ ScreenCaptureKit）
      if (process.platform === "darwin" && kind === "MAC_SCREEN_CAPTURE_PERMISSION") {
        await showMacScreenCapturePermissionDialog();
      }
    }
  });

  registerHotkey();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

ipcMain.handle("settings:get", () => ({
  saveDir: store.get("saveDir") || "",
  hotkey: store.get("hotkey") || DEFAULT_HOTKEY,
  bitrateKbps: store.get("bitrateKbps") || 192
}));

ipcMain.handle("settings:chooseSaveDir", async () => {
  const result = await dialog.showOpenDialog({
    title: "选择保存文件夹",
    properties: ["openDirectory", "createDirectory"]
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false };
  const dir = result.filePaths[0];
  store.set("saveDir", dir);
  return { ok: true, dir };
});

ipcMain.on("overlay:stopClicked", async () => {
  if (!recorder) return;
  if (!recorder.isRecording()) return;
  const { ok, reason } = await recorder.requestStopByUser();
  if (!ok && reason) showNotification("无法停止", reason);
});
