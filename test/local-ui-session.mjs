// Feed to ego-browser nodejs after declaring fixtureFile and optionally spaceId.
const assert = (await import("node:assert/strict")).default;
const { readFile } = await import("node:fs/promises");
const { base, invite } = JSON.parse(await readFile(fixtureFile, "utf8"));
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const task = await taskSpace(typeof spaceId === "undefined" ? "Mailbox C session reset" : spaceId);
const page = task.page("p1");
console.log({ spaceId: task.spaceId });

async function api(path, method, key, body, status = 200) {
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = "Bearer " + key;
  const response = await fetch(base + path, { method, headers, redirect: "error", body: JSON.stringify(body) });
  assert.equal(response.status, status, method + " " + path);
  return response.json();
}

const signup = () => api("/api/spaces", "POST", null, { invite, turnstile: "XXXX.DUMMY.TOKEN.XXXX" });
const click = (name) => page.click(`loc=role:button[name='${name}']`);
const wait = (selector) => page.waitForSelector(selector, { state: "visible", timeout: 8000 });
const waitText = (text) => page.waitForFunction((value) => document.body.innerText.includes(value), text, { timeout: 8000 });
const hasKey = (expected) => page.evaluate(
  async (key) => (await import("/js/keystore.js?v=2.3.0")).getSpaceKey() === key, expected,
);
const openFirstRoom = async () => {
  await wait(".room-card");
  await page.evaluate(() => { document.querySelector(".room-card").click(); });
};
const openSettings = async (replaceOpener = false) => {
  await click("방 목록으로");
  await click("설정 열기");
  if (replaceOpener) {
    await page.evaluate(() => {
      const opener = document.querySelector('.rooms-pane [aria-label="설정 열기"]');
      opener.replaceWith(opener.cloneNode(true));
    });
  }
  await click("공간 열쇠·복구 설정 화면으로 이동");
  await wait("#settings-heading");
};
const pasteKey = async (key) => {
  await click("이미 있어요 (열쇠·복구)");
  await page.fill("#paste-key-link", key);
  await click("공간 열기");
};
const assertHome = async () => {
  await wait("#hero-heading");
  assert.ok(await hasKey(null), "no owner key after leaving");
};
const assertSecondSpace = async (key) => {
  await page.waitForFunction(
    () => document.querySelector(".room-card-name")?.textContent === "다음 공간 방",
    undefined,
    { timeout: 8000 },
  );
  assert.ok(await hasKey(key), "the new space still owns the tab");
  const view = await page.evaluate(() => ({
    pane: document.querySelector(".app-shell")?.dataset.mobilePane,
    rooms: [...document.querySelectorAll(".room-card-name")].map((room) => room.textContent),
    oldContent: document.getElementById("app-root").textContent.includes("이전 공간"),
  }));
  assert.equal(view.pane, "rooms", "no settings or chat pane carried into the new space");
  assert.deepEqual(view.rooms, ["다음 공간 방"]);
  assert.equal(view.oldContent, false, "no old text in the rendered app, including hidden panes");
};

// The real Worker must answer first. Release only the browser's receipt after switching spaces.
const holdResponse = (method, path) => page.evaluate(({ method, path }) => {
  const nativeFetch = window.fetch;
  const hold = window.localSessionHold = {};
  window.fetch = async (url, options) => {
    if (options.method !== method || new URL(url, location.href).pathname !== path)
      return nativeFetch(url, options);
    window.fetch = nativeFetch;
    const response = await nativeFetch(url, options);
    hold.status = response.status;
    hold.body = await response.clone().json();
    await new Promise((resolve) => { hold.release = resolve; });
    response.json = async () => {
      hold.delivered = true;
      return hold.body;
    };
    return response;
  };
}, { method, path });
const waitHold = () => page.waitForFunction(() => Boolean(window.localSessionHold.release), undefined, { timeout: 8000 });
const releaseResponse = async () => {
  await page.evaluate(() => { window.localSessionHold.release(); });
  await page.waitForFunction(() => window.localSessionHold.delivered, undefined, { timeout: 8000 });
  await page.evaluate(() => { delete window.localSessionHold; });
};

const a = await signup();
const b = await signup();
const firstRoom = await api("/api/rooms", "POST", a.key, { name: "이전 공간 방" });
await api("/api/rooms", "POST", b.key, { name: "다음 공간 방" });
const messages = `/api/rooms/${firstRoom.room_id}/messages`;
await api(messages, "POST", a.key, { text: "이전 공간 첫 글입니다." });
await page.cdp("Network.enable");
await page.cdp("Network.setBlockedURLs", { urls: ["https://*"] });
await page.cdp("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
await page.goto(`${base}/app#k=${a.key}`);
await openFirstRoom();
await waitText("이전 공간 첫 글입니다.");
await openSettings(true);
await holdResponse("POST", "/api/me/rotate");
await click("공간 키 재발급");
await click("한 번 더 누르면 이전 공간 열쇠 즉시 무효화 및 재발급");
await waitHold();
const rotated = await page.evaluate(() => window.localSessionHold.status === 200 && window.localSessionHold.body.key);
assert.ok(rotated && rotated !== a.key, "the old space really rotated its key");
await click("이 탭에서 열쇠 닫기");
await assertHome();
await pasteKey(b.key);
await releaseResponse();
await assertSecondSpace(b.key);
await api("/api/me", "GET", rotated);
console.log("PASS close in this tab and discard the old space's delayed key");

await click("설정 열기");
await click("공간 열쇠·복구 설정 화면으로 이동");
await wait("#settings-heading");
await click("이 탭에서 열쇠 닫기");
await pasteKey(rotated);
await openFirstRoom();
await waitText("이전 공간 첫 글입니다.");
await openSettings();
await page.evaluate(() => {
  const nativeFetch = window.fetch;
  window.fetch = (url, options) => {
    if (options.method !== "DELETE" || new URL(url, location.href).pathname !== "/api/me")
      return nativeFetch(url, options);
    window.fetch = nativeFetch;
    return Promise.resolve(Response.json({ error: "invalid" }, { status: 500 }));
  };
});
await page.fill("#space-delete-confirm", "삭제");
await click("공간 영구 삭제");
await waitText("입력 형식을 확인해 주세요");
assert.ok(await hasKey(rotated), "failed delete preserved the current key");
await click("돌아가기");
await waitText("이전 공간 첫 글입니다.");

await api(messages, "POST", rotated, { text: "이전 공간 지연 글입니다." });
await holdResponse("GET", messages);
await page.evaluate(() => { window.dispatchEvent(new Event("online")); });
await waitHold();
assert.ok(await page.evaluate(() => window.localSessionHold.status === 200 &&
  window.localSessionHold.body.messages.some(({ text }) => text === "이전 공간 지연 글입니다.")));
await openSettings();
await page.fill("#space-delete-confirm", "삭제");
await click("공간 영구 삭제");
await assertHome();
await api("/api/me", "GET", rotated, undefined, 403);
await pasteKey(b.key);
await releaseResponse();
await assertSecondSpace(b.key);
console.log("PASS failed delete keeps the space, successful delete clears it and discards its delayed read");
