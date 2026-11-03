import { app, BrowserWindow, Tray, Menu, nativeImage, NativeImage, Notification, session } from "electron";
import path from "path";

// Start the underlying JioVoiceGateway SIP & media engine
import "./index";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

function createWindow() {
  // Auto-grant microphone and media permissions for local VoIP
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === "media") {
      return callback(true);
    }
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === "media") return true;
    return false;
  });

  mainWindow = new BrowserWindow({
    width: 430,
    height: 740,
    resizable: true,
    minWidth: 380,
    minHeight: 600,
    title: "JioFiber Voice — Desktop",
    backgroundColor: "#0f172a",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Stream console logs from the desktop window to terminal
  mainWindow.webContents.on("console-message", (event, level, message, line, sourceId) => {
    console.log(`[UI] ${message}`);
  });

  // Give local gateway 500ms to bind, then load
  setTimeout(() => {
    mainWindow?.loadURL("http://localhost:8088");
  }, 600);

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      console.log("[Desktop App] Minimized to system tray.");
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  createTray();
}

function createTray() {
  if (tray) return;

  let trayIcon: NativeImage;
  try {
    // 16x16 transparent PNG buffer
    const pngBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVR42mNkYPj/n4EYwEQkGEVDBqBsGFrrYWDgZ2Bg+E/ABoxGDRg1YNSAwWwAIwMAm3kZ+tN97lEAAAAASUVORK5CYII=",
      "base64"
    );
    trayIcon = nativeImage.createFromBuffer(pngBuffer);
  } catch (e) {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip("JioFiber Voice (+91 81327 96216)");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open Softphone",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: "Jio Landline: +91 81327 96216",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });
}
