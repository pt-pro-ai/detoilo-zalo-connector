import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  catalogAttachmentPaths,
  createZalo,
  downloadPublicImage,
  handleRpc,
  healthSnapshot,
  imageMetadataGetter,
  normalizeInboundContent,
  removeTempFiles,
  signBody,
} from "../core.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("health RPC reports no attached accounts", async () => {
  const data = await handleRpc("health", {});
  assert.equal(data.ok, true);
  assert.equal(data.service, "zalo-personal-bridge");
  assert.deepEqual(data.account_ids, []);
  assert.equal(data.accounts, 0);
});

test("healthSnapshot matches health RPC", () => {
  const snap = healthSnapshot();
  assert.equal(snap.ok, true);
  assert.ok(Array.isArray(snap.account_ids));
});

test("unknown RPC method is 404", async () => {
  await assert.rejects(() => handleRpc("nope", {}), (err) => {
    assert.match(err.message, /unknown method/);
    assert.equal(err.status, 404);
    return true;
  });
});

test("qr.start requires session and business ids", async () => {
  await assert.rejects(() => handleRpc("qr.start", {}), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

test("qr.status misses unknown sessions", async () => {
  await assert.rejects(
    () => handleRpc("qr.status", { session_id: "missing" }),
    (err) => {
      assert.equal(err.status, 404);
      return true;
    },
  );
});

test("account.attach validates required fields", async () => {
  await assert.rejects(() => handleRpc("account.attach", {}), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

test("zalo client reports photo dimensions for uploads", async () => {
  const zalo = createZalo();
  assert.equal(zalo.options.imageMetadataGetter, imageMetadataGetter);

  const expected = {
    "photo.jpg": { width: 8, height: 4 },
    "photo.png": { width: 4, height: 2 },
    "photo.webp": { width: 6, height: 2 },
    "photo.gif": { width: 8, height: 2 },
  };
  for (const [name, dimensions] of Object.entries(expected)) {
    const file = path.join(FIXTURES, name);
    const meta = await imageMetadataGetter(file);
    assert.equal(meta.width, dimensions.width, name);
    assert.equal(meta.height, dimensions.height, name);
    assert.equal(meta.size, fs.statSync(file).size, name);
  }

  const broken = path.join(os.tmpdir(), `detoilo-broken-${process.pid}.jpg`);
  fs.writeFileSync(broken, Buffer.from("not-an-image"));
  try {
    await assert.rejects(() => imageMetadataGetter(broken));
  } finally {
    fs.rmSync(broken, { force: true });
  }
});

test("catalog photos become temp files and are removed after", async () => {
  const files = await catalogAttachmentPaths(["https://cdn.example/shirt.png"], async () => ({
    contentType: "image/png",
    base64: Buffer.from("png-bytes").toString("base64"),
  }));
  assert.equal(files.length, 1);
  assert.match(files[0], /\.png$/);
  removeTempFiles(files);
});

test("account.send validates required fields", async () => {
  await assert.rejects(() => handleRpc("account.send", {}), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

test("account.send misses detached accounts", async () => {
  await assert.rejects(
    () =>
      handleRpc("account.send", {
        account_id: "acct_missing",
        user_id: "u1",
        text: "hi",
      }),
    (err) => {
      assert.equal(err.status, 404);
      assert.match(err.message, /not attached/);
      return true;
    },
  );
});

test("account.detach is idempotent", async () => {
  const result = await handleRpc("account.detach", { account_id: "acct_missing" });
  assert.deepEqual(result, { ok: true });
});

test("signBody is stable HMAC hex", () => {
  const body = Buffer.from('{"ok":true}', "utf8");
  const first = signBody("secret", body);
  const second = signBody("secret", body);
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.notEqual(signBody("other", body), first);
});

test("text messages stay text", async () => {
  const parsed = await normalizeInboundContent("  chào shop  ");
  assert.deepEqual(parsed, { text: "chào shop", images: [] });
});

test("photo messages download on the shop PC and forward bytes", async () => {
  const parsed = await normalizeInboundContent(
    { href: "https://f25-zpc.zdn.vn/jpg/photo.jpg", title: "" },
    {
      msgType: "chat.photo",
      download: async () => ({ contentType: "image/jpeg", base64: "aGVsbG8=" }),
    },
  );
  assert.equal(parsed.text, "[ảnh]");
  assert.equal(parsed.images[0].content_type, "image/jpeg");
  assert.equal(parsed.images[0].data_base64, "aGVsbG8=");
});

test("downloadPublicImage refuses private hosts", async () => {
  assert.equal(await downloadPublicImage("http://127.0.0.1/a.jpg"), null);
  assert.equal(await downloadPublicImage("https://192.168.1.5/a.jpg"), null);
  let called = false;
  const result = await downloadPublicImage("https://cdn.example/a.jpg", async () => {
    called = true;
    return { ok: true, status: 200, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => new Uint8Array([1]).buffer };
  });
  assert.equal(called, true);
  assert.equal(result.contentType, "image/jpeg");
  assert.equal(result.base64, Buffer.from([1]).toString("base64"));
});
