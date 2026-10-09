/**
 * Shared unofficial personal Zalo (zca-js) logic for the HTTP sidecar and
 * the shop-PC desktop app. Not an official Zalo API.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { imageSizeFromFile } from "image-size/fromFile";
import { LoginQRCallbackEventType, ThreadType, Zalo } from "zca-js";

/** @type {Map<string, any>} */
export const qrSessions = new Map();
/** @type {Map<string, { api: any, friendIds: Set<string>, webhookUrl: string, webhookSecret: string, externalAccountId: string, friendsTimer?: ReturnType<typeof setInterval> }>} */
export const accounts = new Map();

export function signBody(secret, bodyBuf) {
  return crypto.createHmac("sha256", secret).update(bodyBuf).digest("hex");
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * zca-js 2.x dropped its image reader. Photo and gif uploads by file path
 * need width, height, and byte size on the Zalo client.
 */
export async function imageMetadataGetter(filePath) {
  const [metadata, stat] = await Promise.all([
    imageSizeFromFile(filePath),
    fs.promises.stat(filePath),
  ]);
  if (!metadata?.width || !metadata?.height) {
    throw new Error(`could not read image dimensions: ${path.basename(filePath)}`);
  }
  return {
    width: metadata.width,
    height: metadata.height,
    size: stat.size,
  };
}

export function createZalo() {
  return new Zalo({ imageMetadataGetter });
}

function isPublicHttps(raw) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0"
  ) {
    return false;
  }
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|169\.254\.)/.test(host)) {
    return false;
  }
  return true;
}

/** Download a Zalo CDN photo on the shop PC, where the session can reach it. */
export async function downloadPublicImage(url, fetchImpl = fetch) {
  let current = String(url || "").trim();
  for (let hop = 0; hop < 3; hop += 1) {
    if (!isPublicHttps(current)) return null;
    const resp = await fetchImpl(current, { redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400) {
      const next = resp.headers.get("location");
      if (!next) return null;
      current = new URL(next, current).toString();
      continue;
    }
    if (!resp.ok) return null;
    const contentType = (resp.headers.get("content-type") || "image/jpeg")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (contentType && !contentType.startsWith("image/")) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    return {
      contentType: contentType || "image/jpeg",
      base64: buf.toString("base64"),
    };
  }
  return null;
}

/**
 * Turn a zca-js message body into the webhook payload the API stores.
 * `download` is injected so tests do not touch the network.
 */
export async function normalizeInboundContent(content, { msgType, download } = {}) {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? { text, images: [] } : null;
  }
  if (!content || typeof content !== "object") return null;
  const type = String(msgType || "").toLowerCase();
  const href = String(content.href || "").trim();
  if (href && (type === "chat.photo" || type.includes("photo"))) {
    const downloaded = download ? await download(href) : null;
    if (downloaded?.base64) {
      const caption = String(content.title || content.description || "").trim();
      return {
        text: caption || "[ảnh]",
        images: [
          {
            content_type: downloaded.contentType || "image/jpeg",
            data_base64: downloaded.base64,
          },
        ],
      };
    }
    return { text: "[ảnh]", images: [] };
  }
  if (type.includes("sticker")) return { text: "[nhãn dán]", images: [] };
  if (type.includes("video")) return { text: "[video]", images: [] };
  if (type.includes("voice") || type.includes("audio")) return { text: "[âm thanh]", images: [] };
  if (type.includes("file") || type.includes("doc")) return { text: "[tệp]", images: [] };
  return null;
}

export async function postWebhook(webhookUrl, webhookSecret, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = signBody(webhookSecret, body);
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Detoilo-Bridge-Signature": `sha256=${signature}`,
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`webhook ${resp.status}: ${text.slice(0, 200)}`);
  }
}

export async function refreshFriends(api) {
  const set = new Set();
  try {
    const friends = await api.getAllFriends();
    const list = Array.isArray(friends) ? friends : friends?.friends || friends?.data || [];
    for (const f of list) {
      const id = String(f?.userId ?? f?.uid ?? f?.id ?? "").trim();
      if (id) set.add(id);
    }
  } catch (err) {
    console.warn("getAllFriends failed:", err?.message || err);
  }
  return set;
}

export function extractCredentials(api) {
  const ctx = api.getContext();
  const cookieJar = ctx.cookie;
  let cookie = [];
  if (cookieJar && typeof cookieJar.toJSON === "function") {
    cookie = cookieJar.toJSON().cookies || [];
  } else if (Array.isArray(cookieJar)) {
    cookie = cookieJar;
  }
  return {
    cookie,
    imei: String(ctx.imei || ""),
    userAgent: String(ctx.userAgent || ""),
    user_id: String(ctx.uid || ""),
  };
}

export function healthSnapshot() {
  return {
    ok: true,
    service: "zalo-personal-bridge",
    accounts: accounts.size,
    account_ids: [...accounts.keys()],
    qr_sessions: qrSessions.size,
  };
}

export async function startQrLogin(sessionId, businessId) {
  const session = {
    session_id: sessionId,
    business_id: businessId,
    status: "pending",
    qr_base64: null,
    display_name: null,
    user_id: null,
    credentials: null,
    error: null,
    api: null,
  };
  qrSessions.set(sessionId, session);

  const zalo = createZalo();
  zalo
    .loginQR({}, (event) => {
      if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
        session.qr_base64 = event.data.image;
        session.status = "pending";
      } else if (event.type === LoginQRCallbackEventType.QRCodeScanned) {
        session.status = "scanned";
        session.display_name = event.data?.display_name || null;
      } else if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
        session.status = "expired";
        session.error = "Mã QR đã hết hạn";
      } else if (event.type === LoginQRCallbackEventType.QRCodeDeclined) {
        session.status = "error";
        session.error = "Bạn đã từ chối đăng nhập trên điện thoại";
      }
    })
    .then(async (api) => {
      session.api = api;
      const creds = extractCredentials(api);
      session.credentials = {
        cookie: creds.cookie,
        imei: creds.imei,
        userAgent: creds.userAgent,
        user_id: creds.user_id,
      };
      session.user_id = creds.user_id;
      try {
        const info = await api.fetchAccountInfo();
        const name =
          info?.profile?.displayName ||
          info?.profile?.zaloName ||
          info?.name ||
          session.display_name;
        if (name) session.display_name = String(name);
      } catch {
        /* optional */
      }
      session.status = "connected";
    })
    .catch((err) => {
      if (session.status === "expired") return;
      session.status = "error";
      session.error = err?.message || String(err);
      console.error("loginQR failed:", session.error);
    });

  for (let i = 0; i < 40; i++) {
    if (session.qr_base64) break;
    if (session.status === "error" || session.status === "expired") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return session;
}

export function getQrSession(sessionId) {
  return qrSessions.get(sessionId) || null;
}

function loginError(err) {
  const e = new Error(`login failed: ${err?.message || err}`);
  e.status = 401;
  e.permanent = true;
  return e;
}

export async function attachAccount({
  accountId,
  credentials,
  webhookUrl,
  webhookSecret,
}) {
  await detachAccount(accountId);

  const zalo = createZalo();
  let api;
  try {
    api = await zalo.login({
      cookie: credentials.cookie,
      imei: credentials.imei,
      userAgent: credentials.userAgent || credentials.user_agent,
    });
  } catch (err) {
    throw loginError(err);
  }

  const friendIds = await refreshFriends(api);
  const externalAccountId = String(api.getOwnId?.() || api.getContext()?.uid || "");

  const entry = {
    api,
    friendIds,
    webhookUrl,
    webhookSecret,
    externalAccountId,
  };
  accounts.set(accountId, entry);

  const friendsTimer = setInterval(() => {
    refreshFriends(api)
      .then((set) => {
        entry.friendIds = set;
      })
      .catch(() => {});
  }, 5 * 60 * 1000);
  entry.friendsTimer = friendsTimer;

  api.listener.on("message", async (message) => {
    try {
      if (message.isSelf) return;
      if (message.type !== ThreadType.User) return;
      const normalized = await normalizeInboundContent(message.data?.content, {
        msgType: message.data?.msgType,
        download: downloadPublicImage,
      });
      if (!normalized) return;

      const fromUserId = String(message.data?.uidFrom || message.threadId || "");
      if (!fromUserId) return;
      const msgId = String(
        message.data?.msgId || message.data?.messageId || `${fromUserId}-${Date.now()}`,
      );
      const isStranger = !entry.friendIds.has(fromUserId);
      const fromDisplayName =
        message.data?.dName || message.data?.displayName || message.data?.zaloName || null;

      await postWebhook(entry.webhookUrl, entry.webhookSecret, {
        event: "message",
        account_id: accountId,
        external_account_id: entry.externalAccountId,
        message: {
          msg_id: msgId,
          text: normalized.text,
          images: normalized.images,
          from_user_id: fromUserId,
          from_display_name: fromDisplayName,
          is_self: false,
          thread_type: "user",
          is_stranger: isStranger,
          timestamp: message.data?.ts || message.data?.timestamp || Date.now(),
        },
      });
    } catch (err) {
      console.error("forward inbound failed:", err?.message || err);
    }
  });

  api.listener.on("error", (err) => {
    console.error("listener error", accountId, err?.message || err);
  });

  api.listener.start();
  console.log(`listener started for account ${accountId} (uid=${externalAccountId})`);
  return { ok: true, external_account_id: externalAccountId };
}

export async function detachAccount(accountId) {
  const entry = accounts.get(accountId);
  if (!entry) return { ok: true };
  try {
    if (entry.friendsTimer) clearInterval(entry.friendsTimer);
    entry.api?.listener?.stop?.();
  } catch (err) {
    console.warn("detach stop error:", err?.message || err);
  }
  accounts.delete(accountId);
  return { ok: true };
}

function imageExtension(contentType) {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  return ".jpg";
}

/** Download catalog photo URLs into temp files zca-js can attach. */
export async function catalogAttachmentPaths(urls, download = downloadPublicImage) {
  const files = [];
  for (const url of urls || []) {
    const downloaded = await download(url);
    if (!downloaded?.base64) continue;
    const file = path.join(
      os.tmpdir(),
      `detoilo-${crypto.randomBytes(8).toString("hex")}${imageExtension(downloaded.contentType || "")}`,
    );
    fs.writeFileSync(file, Buffer.from(downloaded.base64, "base64"));
    files.push(file);
  }
  return files;
}

export function removeTempFiles(files) {
  for (const file of files || []) {
    try {
      fs.unlinkSync(file);
    } catch {
      // The send already finished; a leftover temp file is harmless.
    }
  }
}

export async function sendMessage(accountId, userId, text, imageUrls = []) {
  const entry = accounts.get(accountId);
  if (!entry) {
    const err = new Error("account not attached");
    err.status = 404;
    throw err;
  }
  const attachments = await catalogAttachmentPaths(imageUrls);
  const payload = { msg: text || "" };
  if (attachments.length) payload.attachments = attachments;
  if (!payload.msg && !attachments.length) {
    const err = new Error("text or image_urls required");
    err.status = 400;
    throw err;
  }
  try {
    const result = await entry.api.sendMessage(
      payload,
      String(userId),
      ThreadType.User,
    );
    const messageId =
      result?.message?.msgId || result?.msgId || result?.messageId || null;
    return { ok: true, message_id: messageId ? String(messageId) : null };
  } finally {
    removeTempFiles(attachments);
  }
}

export function qrPublicView(session) {
  if (!session) return null;
  return {
    status: session.status,
    qr_base64: session.qr_base64,
    display_name: session.display_name,
    user_id: session.user_id,
    credentials: session.status === "connected" ? session.credentials : undefined,
    error: session.error,
  };
}

export async function handleRpc(method, payload = {}) {
  switch (method) {
    case "health":
      return healthSnapshot();
    case "qr.start": {
      const sessionId = String(payload.session_id || "").trim();
      const businessId = String(payload.business_id || "").trim();
      if (!sessionId || !businessId) {
        const err = new Error("session_id and business_id required");
        err.status = 400;
        throw err;
      }
      const session = await startQrLogin(sessionId, businessId);
      return {
        session_id: session.session_id,
        qr_base64: session.qr_base64,
        status: session.status,
        error: session.error,
      };
    }
    case "qr.status": {
      const sessionId = String(payload.session_id || "").trim();
      const session = getQrSession(sessionId);
      if (!session) {
        const err = new Error("session not found");
        err.status = 404;
        throw err;
      }
      return qrPublicView(session);
    }
    case "account.attach": {
      const accountId = String(payload.account_id || "").trim();
      const credentials = payload.credentials;
      const webhookUrl = String(payload.webhook_url || "").trim();
      const webhookSecret = String(payload.webhook_secret || "").trim();
      if (!accountId || !credentials || !webhookUrl) {
        const err = new Error("account_id, credentials, webhook_url required");
        err.status = 400;
        throw err;
      }
      return attachAccount({
        accountId,
        credentials,
        webhookUrl,
        webhookSecret,
      });
    }
    case "account.send": {
      const accountId = String(payload.account_id || "").trim();
      const userId = String(payload.user_id || "").trim();
      const text = String(payload.text || "");
      const imageUrls = Array.isArray(payload.image_urls)
        ? payload.image_urls.map((url) => String(url || "").trim()).filter(Boolean)
        : [];
      if (!userId || (!text && imageUrls.length === 0)) {
        const err = new Error("user_id and text or image_urls required");
        err.status = 400;
        throw err;
      }
      return sendMessage(accountId, userId, text, imageUrls);
    }
    case "account.detach": {
      const accountId = String(payload.account_id || "").trim();
      return detachAccount(accountId);
    }
    default: {
      const err = new Error(`unknown method ${method}`);
      err.status = 404;
      throw err;
    }
  }
}
