import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRpc, healthSnapshot, signBody } from "../core.mjs";

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
