// Run from mailbox-worker. All account data and the migration output live in a fresh private temp directory.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getPlatformProxy, unstable_splitSqlQuery } from "wrangler";

const dir = await mkdtemp(join(tmpdir(), "mailbox-local-e2e-"));
const state = join(dir, "state"),
  output = join(dir, "owner.json");
const config = "src/wrangler.local.jsonc";
const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG: "error" };
const secret = (prefix) => prefix + randomBytes(24).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const old = secret("amk_");
let server;
let trace = "";
const keys = [old];
function child(args) {
  const processHandle = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [processHandle.stdout, processHandle.stderr])
    stream.on("data", (chunk) => {
      trace += chunk.toString();
    });
  return processHandle;
}
try {
  const platform = await getPlatformProxy({
    configPath: config,
    envFiles: [],
    persist: { path: join(state, "v3") },
    remoteBindings: false,
  });
  try {
    const db = platform.env.DB;
    const files = (await readdir("migrations")).filter((p) => p.endsWith(".sql")).sort();
    for (const file of files) {
      if (file.startsWith("0004")) {
        await db.batch([
          db.prepare(
            "INSERT INTO rooms(id,owner_id,name,created_at) VALUES('legacy','o_default','이전 방',unixepoch())",
          ),
          db
            .prepare(
              "INSERT INTO participants(id,room_id,name,kind,key_hash,key_epoch,created_at) VALUES('person','legacy','사람','human',?,0,unixepoch())",
            )
            .bind(hash(old)),
          db
            .prepare(
              "INSERT INTO messages(room_id,participant_id,body,body_hash,created_at) VALUES('legacy','person','보존 글',?,unixepoch())",
            )
            .bind(hash("보존 글")),
        ]);
      }
      const statements = unstable_splitSqlQuery(await readFile(join("migrations", file), "utf8"));
      await db.batch(statements.map((sql) => db.prepare(sql)));
    }
  } finally {
    await platform.dispose();
  }
  const inviteFile = join(dir, "invite.json");
  const [inviteExit] = await once(child(["src/create-invite.mjs", inviteFile, state]), "exit");
  assert.equal(inviteExit, 0, "local invite creation");
  assert.equal((await stat(inviteFile)).mode & 0o777, 0o600);
  const { invite } = JSON.parse(await readFile(inviteFile, "utf8"));
  assert.equal(Buffer.from(invite.slice(4), "base64url").length, 24);
  keys.push(invite);
  const [exit] = await once(child(["src/migrate-owner.mjs", "o_default", output, state]), "exit");
  assert.equal(exit, 0, "local owner migration");
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const owner = JSON.parse(await readFile(output, "utf8"));
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  const base = "http://127.0.0.1:" + port;
  server = child([
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--local",
    "--config",
    config,
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    state,
    "--log-level",
    "error",
    "--var",
    "IMAGE_UPLOADS:on",
    "--show-interactive-dev-session",
    "false",
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 180 && server.exitCode === null; attempt++) {
    try {
      if ((await fetch(base + "/healthz")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(500);
  }
  assert.ok(ready, "local Wrangler ready");
  keys.push(owner.key, ...owner.recovery_codes);
  async function api(path, method, key, body, status = 200) {
    const headers = { "content-type": "application/json" };
    if (key?.startsWith("amk_")) headers["x-mailbox-key"] = key;
    else if (key) headers.authorization = "Bearer " + key;
    const response = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, status, method + " " + path);
    return response.json();
  }
  const release = "?v=2.3.0";
  const appEntry = "/js/app.js" + release + "&history=2&maintenance=1";
  for (const path of ["/", "/app", "/app/", "/app/legacy/", "/r/legacy/", "/r/legacy", "/help.html"]) {
    const r = await fetch(base + path, { redirect: "manual" });
    assert.equal(r.status, 200, "asset " + path);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.ok(r.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
    const html = await r.text();
    const help = path === "/help.html";
    const entry = help ? "/js/help-init.js" + release : appEntry.replaceAll("&", "&amp;");
    assert.ok(html.includes("아르센 우편함") && html.includes('src="' + entry + '"'));
    const styles = help ? ["tokens", "styles"] : ["tokens", "styles", "chat-skins"];
    for (const style of styles) assert.ok(html.includes('href="/css/' + style + '.css' + release + '"'));
    if (!help) assert.match(html, /name="turnstile-sitekey" content="1x00000000000000000000AA"/);
  }
  const modules = new Set([appEntry, "/js/help-init.js" + release]);
  for (const path of modules) {
    const r = await fetch(base + path);
    assert.equal(r.status, 200, path);
    for (const [, specifier] of (await r.text()).matchAll(/\bfrom\s+"(\.[^"]+)"/g)) {
      const target = new URL(specifier, base + path);
      assert.equal(target.search, release + (target.pathname === "/js/sheets.js" ? "&history=2&maintenance=1" : ""), path + " imports " + specifier);
      modules.add(target.pathname + target.search);
    }
  }
  for (const path of ["/manifest.webmanifest", "/css/styles.css" + release, "/css/chat-skins.css" + release,
    "/fonts/Pretendard-Regular.subset.woff2", "/icons/icon-192.png"]) {
    const r = await fetch(base + path, { method: "HEAD", redirect: "manual" });
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  }
  for (const path of ["/dev/server.mjs", "/dev/mock.js", "/app?k=ignored", "/sw.js", "/service-worker.js"]) {
    assert.equal((await fetch(base + path, { redirect: "manual" })).status, 404, path);
  }
  assert.equal((await api("/api/rooms", "GET", owner.key)).rooms[0].room_id, "legacy");
  assert.equal((await api("/api/rooms/legacy/messages?since=0", "GET", old)).messages[0].text, "보존 글");
  assert.equal((await api("/api/rooms/legacy/participants", "GET", owner.key)).participants.find((m) => m.participant_id === "person")?.interval_minutes, 10);
  const { room_id } = await api("/api/rooms", "POST", owner.key, { name: "대화" });
  const path = "/api/rooms/" + room_id;
  const p = await api(path + "/participants", "POST", owner.key, {
    name: "비서",
    kind: "assistant",
    delivery: "header",
  });
  assert.equal(p.interval_minutes, 10);
  keys.push(p.key);
  const assistRead = "/r/" + room_id + "/messages";
  assert.equal((await api(assistRead, "GET", p.key)).messages.length, 0);
  assert.equal((await api(path + "/messages", "GET", p.key)).messages.length, 0);
  const throttled = await api(path + "/messages", "GET", p.key, undefined, 429);
  assert.ok(throttled.retry_after >= 1 && throttled.retry_after <= 30, "30s repeat cooldown retry_after");
  await api(path + "/messages", "POST", owner.key, { text: "지금 읽을 새 글입니다." });
  assert.equal((await api(assistRead, "GET", p.key)).messages[0].text, "지금 읽을 새 글입니다.");
  const msg = await api(path + "/messages", "POST", owner.key, {
    text: "답을 옮깁니다",
    relayed_for: p.participant_id,
  });
  await api("/r/" + room_id + "/send", "POST", p.key, { text: "실제 답변", reply_to: msg.id });
  await api(path + "/messages", "GET", p.key, undefined, 429);
  const read = await api(path + "/messages", "GET", owner.key);
  assert.equal(read.messages.length, 3);
  assert.equal(read.messages[1].relay_label, "사용자가 대신 올림");
  await api(path + "/messages", "GET", p.key, undefined, 429);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAHElEQVR42mOUbGr6zwAFTAwMDAzP6+oYGRgYGAA+KgQEG4yYOQAAAABJRU5ErkJggg==", "base64");
  const uploaded = await fetch(base + "/r/" + room_id + "/image", {
    method: "POST",
    headers: { "x-mailbox-key": p.key, "content-type": "image/png", "x-mailbox-text": encodeURIComponent("이미지 확인") },
    body: png,
  });
  assert.equal(uploaded.status, 200, "local binary image upload");
  const imagePath = path + "/image/" + (await uploaded.json()).id;
  assert.equal((await fetch(base + imagePath)).status, 401, "image cannot be read without its room key");
  const image = await fetch(base + imagePath, { headers: { authorization: "Bearer " + owner.key } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const next = await api(path + "/participants/" + p.participant_id + "/reissue", "POST", owner.key);
  keys.push(next.key);
  await api(path + "/participants/" + p.participant_id + "/revoke", "POST", owner.key);
  await api(path + "/messages", "GET", next.key, undefined, 403);
  await api("/api/me", "DELETE", owner.key, { confirm: "삭제" });
  await api("/api/me", "GET", owner.key, undefined, 403);
  console.log(
    "PASS local Wrangler assets, v1-to-v2 migration, immediate assistant read, empty throttle, relay, private images, reissue, revoke and delete",
  );
  if (process.argv.includes("--siteverify")) {
    const s = await api("/api/spaces", "POST", undefined, { invite, turnstile: "XXXX.DUMMY.TOKEN.XXXX" });
    keys.push(s.key, ...s.recovery_codes);
    assert.equal(s.recovery_codes.length, 10);
    const rotate = await api("/api/spaces/recover", "POST", undefined, {
      code: s.recovery_codes[0],
      turnstile: "XXXX.DUMMY.TOKEN.XXXX",
    });
    keys.push(rotate.key);
    await api("/api/me", "GET", s.key, undefined, 403);
    await api("/api/me", "DELETE", rotate.key, { confirm: "삭제" });
    console.log("PASS local signup and recovery with official Turnstile test credentials");
  }
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const closed = once(server, "exit");
    server.kill("SIGTERM");
    await closed;
  }
  await rm(dir, { recursive: true, force: true });
}
assert.equal(
  keys.some((key) => trace.includes(key)),
  false,
  "credential-free runtime logs",
);
console.log("PASS captured runtime logs contain zero issued keys");
