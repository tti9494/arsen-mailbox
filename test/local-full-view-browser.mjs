// Start node test/local-ui-server.mjs <fixture> --images, then feed this file
// to ego-browser nodejs after declaring fixtureFile, captureDir and optionally spaceId.
const assert = (await import("node:assert/strict")).default;
const { readFile } = await import("node:fs/promises");
const { base, invite } = JSON.parse(await readFile(fixtureFile, "utf8"));
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);

async function post(path, key, body, headers = { "content-type": "application/json" }) {
  const response = await fetch(base + path, {
    method: "POST", redirect: "error",
    headers: { ...headers, ...(key ? { authorization: "Bearer " + key } : {}) },
    body: headers["content-type"] === "application/json" ? JSON.stringify(body) : body,
  });
  assert.equal(response.status, 200, path);
  return response.json();
}

const { key } = await post("/api/spaces", null, { invite, turnstile: "XXXX.DUMMY.TOKEN.XXXX" });
const { room_id: room } = await post("/api/rooms", key, { name: "전체보기 검수 방" });
const path = "/api/rooms/" + room;
const { participant_id: relay } = await post(path + "/participants", key, {
  name: "검수 비서", kind: "assistant", ai_type: "hark",
});
await post(path + "/messages", key, { text: "짧은 메시지" });

const caption = [
  "첨부 자료와 함께 읽는 프로젝트 정리",
  "아래는 오늘 정리한 항목입니다.",
  "", "1. 작업 범위와 완료 조건 확인",
  "2. 모바일에서 줄바꿈 확인",
  "3. 작은 화면에서 닫기 버튼 확인",
  "4. 복사 후 원문 순서 확인",
  "5. 첨부 이미지는 대화에서 확인",
  "",
  '링크 표시 예시 https://example.test/guide',
  'HTML은 문자로 표시: <script>예시</script>',
  "전체보기 본문의 마지막 줄.",
].join("\n");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAHElEQVR42mOUbGr6zwAFTAwMDAzP6+oYGRgYGAA+KgQEG4yYOQAAAABJRU5ErkJggg==", "base64");
const { id: imageId } = await post(path + "/image", key, png, {
  "content-type": "image/png", "x-mailbox-text": encodeURIComponent(caption), "x-mailbox-relayed-for": relay,
});
const longLine = "가나다라마바사".repeat(125) + "끝표식";
await post(path + "/messages", key, { text: longLine });

const task = await taskSpace(typeof spaceId === "undefined" ? "Mailbox full message view QA" : spaceId);
const page = task.page("p1");
console.log({ spaceId: task.spaceId });
await page.cdp("Network.enable");
await page.cdp("Network.setBlockedURLs", { urls: ["https://*"] });

const selector = '.msg-row button[aria-haspopup="dialog"]';
const sheet = '[role="dialog"][aria-modal="true"]';
const message = sheet + " .message-full-text";
const wait = (target) => page.waitForSelector(target, { state: "visible", timeout: 10000 });

for (const width of [360, 1440]) {
  await page.cdp("Emulation.setDeviceMetricsOverride", { width, height: 850, deviceScaleFactor: 1, mobile: false });
  await page.goto(base + "/app/" + room + "/#k=" + key);
  await wait(selector);
  assert.equal(await page.evaluate((selector) => document.querySelectorAll(selector).length, selector), 2);
  assert.equal(await page.evaluate(() => document.querySelector("#composer-textarea").maxLength), 2000);
  assert.equal(await page.evaluate(() => document.querySelectorAll(".msg-body.is-clamped").length), 2);

  for (const [text, image] of [[caption, true], [longLine, false]]) {
    const button = await page.evaluate(({ selector, text }) => {
      const buttons = [...document.querySelectorAll(selector)];
      const trigger = buttons.find((node) => node.closest(".msg-row").querySelector(".msg-body").textContent === text);
      trigger.id = "full-view-test-trigger";
      trigger.scrollIntoView({ block: "center" });
      return "#" + trigger.id;
    }, { selector, text });

    const imageButton = '.message-image[data-image-id="' + imageId + '"]';
    if (image) {
      await page.waitForFunction((s) => document.querySelector(s)?.querySelector("img")?.naturalWidth > 0, imageButton, { timeout: 10000 });
    }

    await page.click(button);
    await wait(message);
    assert.deepEqual(await page.evaluate(({ sheet, message }) => {
      const panel = document.querySelector(sheet);
      const body = panel.querySelector(".sheet-body");
      const content = document.querySelector(message);
      return {
        text: content.textContent,
        heading: panel.querySelector("h2").textContent,
        clamped: content.classList.contains("is-clamped"),
        scripts: content.querySelectorAll("script").length,
        relay: body.textContent.includes("검수 비서 · 사용자가 대신 올림"),
        imageHint: body.textContent.includes("첨부 이미지는 대화에서 볼 수 있습니다."),
        imageInSheet: Boolean(content.querySelector("img")),
        viewport: innerWidth,
        pageFits: document.documentElement.scrollWidth <= innerWidth,
        sheetFits: body.scrollWidth <= body.clientWidth,
        contentFits: content.scrollWidth <= content.clientWidth,
        startsAtTop: body.scrollTop === 0,
        focus: document.activeElement.textContent.trim(),
      };
    }, { sheet, message }), {
      text, heading: "전체 보기", clamped: false, scripts: 0,
      relay: image, imageHint: image, imageInSheet: false,
      viewport: width, pageFits: true, sheetFits: true, contentFits: true, startsAtTop: true, focus: "전체 복사",
    });
    if (image) {
      await page.evaluate(() => document.fonts.ready.then(() => true));
      await page.screenshot({ path: captureDir + "/full-view-" + width + ".png" });
      assert.equal(await page.evaluate((s) => document.querySelector(s + " a").getAttribute("rel"), message), "noopener noreferrer");
    }
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "창 닫기");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), image ? "https://example.test/guide" : "전체 복사");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "창 닫기");

    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "writeText", {
        configurable: true,
        value: async (body) => { window.fullViewCopied = body; },
      });
    });
    await page.click('loc=role:button[name="전체 복사"]');
    await page.waitForFunction((s) => document.querySelector(s)?.textContent === "글 전체를 복사했습니다.",
      sheet + ' [role="status"]', { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.fullViewCopied), text);
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate((s) => document.activeElement.matches(s), button), true);
    await page.evaluate((s) => document.querySelector(s).removeAttribute("id"), button);

    if (image) {
      await page.click(imageButton);
      await wait('dialog.image-dialog[open] img');
      await page.click('dialog.image-dialog button[aria-label="이미지 닫기"]');
    }
  }
  console.log("PASS " + width + "px: long relayed image caption, full copy, keyboard, unbroken text and wrapping");
}
