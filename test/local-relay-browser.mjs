// Feed to ego-browser nodejs after declaring base for public/dev/server.mjs, and optionally spaceId and captureDir.
const assert = (await import("node:assert/strict")).default;
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const task = await taskSpace(typeof spaceId === "undefined" ? "Mailbox relay mock QA" : spaceId);
const page = task.page("p1");
console.log({ spaceId: task.spaceId });

async function post(path, body, key) {
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const response = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(response.status, 200, path);
  return response.json();
}
const { key } = await post("/api/spaces", { invite: "mock-test", turnstile: "mock-test" });
const roomName = "답 옮기기 검증방";
const { room_id: room } = await post("/api/rooms", { name: roomName }, key);
const { participant_id: manualId } = await post(`/api/rooms/${room}/participants`, { name: "수동 비서", kind: "assistant", ai_type: "hark" }, key);
const composer = "#manual-relay-action";
const picker = "#relay-ai-select";
const sheet = '[aria-modal="true"]';
const visible = (selector) => page.evaluate((s) => Boolean(document.querySelector(s)?.getClientRects().length), selector);
const options = () => page.evaluate((s) => [...document.querySelector(s).options].map((o) => o.value), picker);
const wait = (selector) => page.waitForSelector(selector, { state: "visible", timeout: 8000 });
const dismiss = () => page.click(`${sheet} button[aria-label="창 닫기"]`);

// Supply image and question fixtures where the mock API has no implementation.
await page.cdp("Network.enable");
await page.cdp("Network.setBlockedURLs", { urls: ["https://*"] });
const { identifier } = await page.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(${(manualId) => {
  const [images, mode] = new URLSearchParams(location.search).get("relay-fixture")?.split("/") ?? [];
  if (!mode) return;
  const seat = (id, name, ai_type, delivery, status = "connected") => ({
    participant_id: id, name, kind: "assistant", ai_type, delivery, status, revoked: status === "revoked",
  });
  const seats = {
    header: seat("header", "헤더 비서", "claude", "header"),
    address: seat("address", "주소 비서", "vooy", "get"),
    manual: seat(manualId, "수동 비서", "hark", "header", "created"),
    revoked: seat("revoked", "폐기 비서", "hark", "header", "revoked"),
    pendingHeader: seat("pendingHeader", "미연결 헤더", "gemini", "header", "created"),
    pendingAddress: seat("pendingAddress", "미연결 주소", "cue", "get", "created"),
  };
  const participants = mode === "mixed" ? Object.values(seats) : [seats[mode]];
  const target = participants[0];
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const path = new URL(input, location.origin).pathname;
    if (init?.method === "POST" && path.endsWith("/image")) {
      window.relayedImage = { target: new Headers(init.headers).get("x-mailbox-relayed-for"), size: init.body.size };
      return Response.json({ id: 3 });
    }
    const response = await realFetch(input, init);
    if (!response.ok || !path.startsWith("/api/rooms/") || (init?.method ?? "GET") !== "GET") return response;
    if (path.endsWith("/participants")) return Response.json({ participants });
    if (!path.endsWith("/messages")) return response;
    const data = await response.json();
    const created = Math.floor(Date.now() / 1000);
    const messages = [1, 2].map((id) => ({ id, text: `질문 ${id}`, sender: "방장", sender_kind: "human", created_at: created }));
    const questions = [1, 2].map((id) => ({ question_id: id, participant_id: target.participant_id,
      participant_name: target.name, direct: Number(id === 1), step: null, answered_at: null, awaiting_previous: 0 }));
    return Response.json({ ...data, image_uploads: images === "on", questions, messages: [...messages, ...data.messages], next: Math.max(2, data.next) });
  };
}})(${JSON.stringify(manualId)})` });

try {
  for (const width of [360, 1440]) {
    await page.cdp("Emulation.setDeviceMetricsOverride", { width, height: 850, deviceScaleFactor: 1, mobile: false });
    for (const images of ["on", "off"]) {
      for (const mode of ["header", "address", "manual", "revoked", "pendingHeader", "pendingAddress", "mixed"]) {
        const label = `${width}px ${images} ${mode}`;
        await page.goto(`${base}/app?relay-fixture=${images}/${mode}#k=${key}`);
        await wait(`loc=role:button[name*="${roomName}"]`);
        if (!await visible("#composer-textarea")) await page.click(`loc=role:button[name*="${roomName}"]`);
        await wait(".question-chips");
        const manual = mode === "manual" || mode === "mixed";
        const pending = mode.startsWith("pending");
        assert.equal(await visible(composer), manual, label);
        assert.equal(await visible(".composer-row .composer-add-image"), images === "on", label);
        const questionButtons = await page.evaluate(() => [...document.querySelectorAll(".question-chips")].map((el) => Boolean(el.querySelector("button"))));
        assert.deepEqual(questionButtons, [mode === "manual" || pending, mode === "manual"], label);
        if (manual || pending) {
          await page.click(manual ? composer : ".question-chips button");
          await wait(picker);
          assert.deepEqual(await options(), [manual ? manualId : mode], label);
          assert.equal(await visible(`${sheet} .composer-add-image`), images === "on", label);
          if (manual && mode === "mixed" && images === "off") {
            await page.fill("#relay-answer-text", "수동 비서의 답을 옮겼습니다.");
            await page.click('loc=role:button[name="③ 선택한 AI 이름으로 올리기"]');
            await wait(".msg-row .chip-relay");
          } else if (manual && mode === "mixed" && images === "on") {
            await page.evaluate(async () => {
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 3;
              canvas.getContext("2d").fillRect(0, 0, 3, 3);
              const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
              const transfer = new DataTransfer();
              transfer.items.add(new File([png], "test.png", { type: "image/png" }));
              document.querySelector("#relay-answer-text").dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, cancelable: true }));
            });
            await page.waitForFunction((s) => document.querySelector(s)?.naturalWidth > 0,
              `${sheet} .image-draft img`, { timeout: 8000 });
            if (typeof captureDir !== "undefined") await page.screenshot({ path: `${captureDir}/relay-manual-${width}.png` });
            await page.click('loc=role:button[name="③ 선택한 AI 이름으로 올리기"]');
            const uploaded = await page.evaluate(() => window.relayedImage);
            assert.equal(uploaded?.target, manualId, label);
            assert.ok(uploaded.size > 0, label);
          } else {
            await dismiss();
          }
          await page.waitForFunction((s) => !document.querySelector(s), picker, { timeout: 8000 });
        }
        assert.deepEqual(await page.evaluate(() => [innerWidth, document.documentElement.scrollWidth]), [width, width], label);
        if (mode === "address" && images === "on" && typeof captureDir !== "undefined") {
          await page.screenshot({ path: `${captureDir}/relay-address-${width}.png` });
        }
      }
    }
    console.log(`PASS ${width}px: image ON/OFF × 7 rosters, question exception, manual text and image`);
  }
} finally {
  await page.cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
}
