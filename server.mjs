/**
 * Unofficial personal Zalo bridge (zca-js).
 *
 * Experiment only — not an official Zalo API.
 * See https://zalo.vn/dieukhoan/ (third-party / unapproved clients).
 * Run: npm install && npm start  (default :8091)
 *
 * Auth: Authorization Bearer <DETOILO_ZALO_PERSONAL_BRIDGE_SECRET>
 * Forwards inbound DMs (incl. người lạ) to the detoilo webhook.
 *
 * Shop PCs should use the desktop app (npm run desktop) instead of opening
 * this HTTP port to the internet.
 */

import http from "node:http";
import {
  attachAccount,
  detachAccount,
  getQrSession,
  healthSnapshot,
  qrPublicView,
  sendMessage,
  startQrLogin,
} from "./core.mjs";

const PORT = Number(process.env.PORT || process.env.ZALO_PERSONAL_BRIDGE_PORT || 8091);
const SECRET =
  process.env.DETOILO_ZALO_PERSONAL_BRIDGE_SECRET ||
  process.env.BRIDGE_SECRET ||
  "detoilo_dev_zalo_personal_bridge";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function unauthorized(res) {
  json(res, 401, { error: "unauthorized" });
}

function requireAuth(req, res) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || token !== SECRET) {
    unauthorized(res);
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;
    const method = (req.method || "GET").toUpperCase();

    if (method === "GET" && path === "/health") {
      return json(res, 200, healthSnapshot());
    }

    if (!requireAuth(req, res)) return;

    if (method === "POST" && path === "/v1/login/qr") {
      const raw = await readBody(req);
      const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      const sessionId = String(body.session_id || "").trim();
      const businessId = String(body.business_id || "").trim();
      if (!sessionId || !businessId) {
        return json(res, 400, { error: "session_id and business_id required" });
      }
      const session = await startQrLogin(sessionId, businessId);
      return json(res, 200, {
        session_id: session.session_id,
        qr_base64: session.qr_base64,
        status: session.status,
        error: session.error,
      });
    }

    const qrMatch = path.match(/^\/v1\/login\/qr\/([^/]+)$/);
    if (method === "GET" && qrMatch) {
      const sessionId = decodeURIComponent(qrMatch[1]);
      const session = getQrSession(sessionId);
      if (!session) return json(res, 404, { error: "session not found" });
      return json(res, 200, qrPublicView(session));
    }

    if (method === "POST" && path === "/v1/accounts/attach") {
      const raw = await readBody(req);
      const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      const accountId = String(body.account_id || "").trim();
      const credentials = body.credentials;
      const webhookUrl = String(body.webhook_url || "").trim();
      const webhookSecret = String(body.webhook_secret || SECRET).trim();
      if (!accountId || !credentials || !webhookUrl) {
        return json(res, 400, {
          error: "account_id, credentials, webhook_url required",
        });
      }
      const result = await attachAccount({
        accountId,
        credentials,
        webhookUrl,
        webhookSecret,
      });
      return json(res, 200, result);
    }

    const sendMatch = path.match(/^\/v1\/accounts\/([^/]+)\/send$/);
    if (method === "POST" && sendMatch) {
      const accountId = decodeURIComponent(sendMatch[1]);
      const raw = await readBody(req);
      const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      const userId = String(body.user_id || "").trim();
      const text = String(body.text || "");
      if (!userId || !text) {
        return json(res, 400, { error: "user_id and text required" });
      }
      const result = await sendMessage(accountId, userId, text);
      return json(res, 200, result);
    }

    const acctMatch = path.match(/^\/v1\/accounts\/([^/]+)$/);
    if (method === "DELETE" && acctMatch) {
      const accountId = decodeURIComponent(acctMatch[1]);
      const result = await detachAccount(accountId);
      return json(res, 200, result);
    }

    return json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    const status = err?.status || 500;
    return json(res, status, {
      error: err?.message || "internal error",
      permanent: Boolean(err?.permanent),
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`zalo-personal-bridge listening on 0.0.0.0:${PORT}`);
  console.log("experiment: personal Zalo — see https://zalo.vn/dieukhoan/");
});
