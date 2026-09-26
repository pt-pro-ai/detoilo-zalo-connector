/**
 * Shop-PC desktop host for the unofficial personal Zalo bridge.
 * Dials out to the detoilo API (no inbound port on the shop network).
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { handleRpc } from "../core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_NAME = "desktop-config.json";
const API_BASE_URL = process.env.DETOILO_PUBLIC_BASE_URL || "https://api.detoilo.com";

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
/** @type {WebSocket | null} */
let socket = null;
let reconnectTimer = null;
let pingTimer = null;
let quitting = false;

function configPath() {
  return path.join(app.getPath("userData"), CONFIG_NAME);
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* first run */
  }
  return {
    pairingCode: "",
    deviceToken: "",
    deviceName: "",
    businessId: "",
  };
}

function saveConfig(next) {
  const current = { ...loadConfig(), ...next };
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(current, null, 2), "utf8");
  return current;
}

function wsUrl({ code, token }) {
  const base = String(API_BASE_URL).trim().replace(/\/$/, "");
  const wsBase = base.replace(/^http/i, "ws");
  const url = new URL(`${wsBase}/api/v1/bridges/zalo_personal/ws`);
  if (token) url.searchParams.set("token", token);
  else if (code) url.searchParams.set("code", String(code).replace(/\s+/g, ""));
  return url.toString();
}

function pushStatus(partial) {
  const cfg = loadConfig();
  const payload = {
    pairingCode: cfg.pairingCode,
    paired: Boolean(cfg.deviceToken),
    businessId: cfg.businessId || "",
    online: socket?.readyState === WebSocket.OPEN,
    ...partial,
  };
  mainWindow?.webContents.send("status", payload);
  if (tray) {
    const title = payload.online ? "detoilo Zalo · đã kết nối" : "detoilo Zalo · chưa kết nối";
    tray.setToolTip(title);
  }
}

function clearTimers() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function scheduleReconnect() {
  if (quitting || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, 4000);
}

function connectSocket() {
  const cfg = loadConfig();
  const code = String(cfg.pairingCode || "").replace(/\s+/g, "");
  const token = String(cfg.deviceToken || "").trim();
  if (!code && !token) {
    pushStatus({ online: false, message: "Nhập mã kết nối." });
    return;
  }

  if (socket) {
    try {
      socket.removeAllListeners();
      socket.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }
  clearTimers();

  const url = wsUrl({ code, token });
  pushStatus({ online: false, message: "Đang kết nối máy chủ…" });
  const next = new WebSocket(url);

  next.on("open", () => {
    socket = next;
    next.send(
      JSON.stringify({
        type: "hello",
        code: token ? undefined : code,
        token: token || undefined,
        device_name: cfg.deviceName || `${process.platform} ${app.getName()}`,
      }),
    );
    pingTimer = setInterval(() => {
      if (next.readyState === WebSocket.OPEN) {
        next.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 20000);
  });

  next.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg?.type === "welcome") {
      saveConfig({
        deviceToken: msg.device_token || token,
        businessId: msg.business_id || "",
        pairingCode: "",
      });
      pushStatus({
        online: true,
        paired: true,
        message: "Kết nối thành công. Để app mở trong giờ tiệm hoạt động.",
      });
      return;
    }
    if (msg?.type === "rpc") {
      try {
        const data = await handleRpc(String(msg.method || ""), msg.payload || {});
        next.send(JSON.stringify({ id: msg.id, type: "rpc_ok", data }));
      } catch (err) {
        next.send(
          JSON.stringify({
            id: msg.id,
            type: "rpc_err",
            error: err?.message || String(err),
            status: err?.status || 500,
            permanent: Boolean(err?.permanent),
          }),
        );
      }
    }
  });

  next.on("close", () => {
    if (socket === next) socket = null;
    clearTimers();
    pushStatus({ online: false, message: "Mất kết nối, đang tự kết nối lại…" });
    scheduleReconnect();
  });

  next.on("error", (err) => {
    pushStatus({ online: false, message: err?.message || "Không kết nối được máy chủ" });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 620,
    minWidth: 400,
    minHeight: 520,
    title: "detoilo Zalo",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.webContents.on("did-finish-load", () => pushStatus({}));
}

function createTray() {
  const image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip("detoilo Zalo");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Hiện cửa sổ",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      {
        label: "Kết nối lại",
        click: () => connectSocket(),
      },
      { type: "separator" },
      {
        label: "Thoát",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

ipcMain.handle("get-status", () => {
  const cfg = loadConfig();
  return {
    pairingCode: cfg.pairingCode,
    paired: Boolean(cfg.deviceToken),
    businessId: cfg.businessId || "",
    online: socket?.readyState === WebSocket.OPEN,
  };
});

ipcMain.handle("pair", (_event, payload) => {
  const pairingCode = String(payload?.pairingCode || "").replace(/\s+/g, "");
  if (!pairingCode) {
    return { ok: false, error: "Vui lòng nhập mã kết nối." };
  }
  saveConfig({ pairingCode, deviceToken: "", businessId: "" });
  connectSocket();
  return { ok: true };
});

ipcMain.handle("unpair", () => {
  saveConfig({ pairingCode: "", deviceToken: "", businessId: "" });
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
  pushStatus({ paired: false, online: false, message: "Đã ngắt kết nối." });
  return { ok: true };
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.whenReady().then(() => {
    app.setLoginItemSettings({ openAtLogin: true, enabled: true });
    createWindow();
    createTray();
    const cfg = loadConfig();
    if (cfg.deviceToken || cfg.pairingCode) connectSocket();
  });
}

app.on("before-quit", () => {
  quitting = true;
  clearTimers();
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    /* stay in tray */
  }
});

app.on("activate", () => {
  mainWindow?.show();
});
