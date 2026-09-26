/**
 * Shared unofficial personal Zalo (zca-js) logic for the HTTP sidecar and
 * the shop-PC desktop app. Not an official Zalo API.
 */

import crypto from "node:crypto";
import { LoginQRCallbackEventType, ThreadType, Zalo } from "zca-js";

/** @type {Map<string, any>} */
export const qrSessions = new Map();
/** @type {Map<string, { api: any, friendIds: Set<string>, webhookUrl: string, webhookSecret: string, externalAccountId: string, friendsTimer?: ReturnType<typeof setInterval> }>} */
export const accounts = new Map();

export function signBody(secret, bodyBuf) {
  return crypto.createHmac("sha256", secret).update(bodyBuf).digest("hex");
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

  const zalo = new Zalo();
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

  const zalo = new Zalo();
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
      const content = message.data?.content;
      if (typeof content !== "string" || !content.trim()) return;

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
          text: content,
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

export async function sendMessage(accountId, userId, text) {
  const entry = accounts.get(accountId);
  if (!entry) {
    const err = new Error("account not attached");
    err.status = 404;
    throw err;
  }
  const result = await entry.api.sendMessage(
    { msg: text },
    String(userId),
    ThreadType.User,
  );
  const messageId =
    result?.message?.msgId || result?.msgId || result?.messageId || null;
  return { ok: true, message_id: messageId ? String(messageId) : null };
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
      if (!userId || !text) {
        const err = new Error("user_id and text required");
        err.status = 400;
        throw err;
      }
      return sendMessage(accountId, userId, text);
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
