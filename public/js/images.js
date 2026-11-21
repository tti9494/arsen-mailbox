import { apiRequest } from "./api.js?v=2.3.0";
import { clearNode, el, icon } from "./dom.js?v=2.3.0";
import { errorMessage } from "./constants.js?v=2.3.0";

const ACCEPT = "image/png,image/jpeg,image/webp";
const DEFAULT_IMAGE_BYTES = 48_000;
const LEAD = "이미지 붙이기";

export function postImage(room, auth, image, caption, reply, relayedFor) {
  const path = `/api/rooms/${encodeURIComponent(room)}/image`;
  const query = reply == null ? "" : "?reply_to=" + encodeURIComponent(reply);
  return apiRequest(path + query, { method: "POST", ...auth, image, caption, relayedFor });
}

export const formatImageBytes = (bytes) => bytes < 1_000_000
  ? `${Math.ceil(bytes / 1000).toLocaleString("ko-KR")} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;

async function shrinkImage(file, maximum, maximumEdge) {
  if (file.size > 20_000_000) throw new Error("이미지가 너무 큽니다.");
  if (!ACCEPT.split(",").includes(file.type)) throw new Error("PNG·JPEG·WebP 이미지만 붙일 수 있습니다.");
  let bitmap;
  try { bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch { throw new Error("이 이미지 파일을 열 수 없습니다."); }
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("브라우저가 이미지 변환을 지원하지 않습니다.");
    const encode = (format, quality) => new Promise((resolve) => canvas.toBlob(resolve, format, quality));
    let format = "image/webp";
    let previousWidth = 0, previousHeight = 0;
    function fillBackground(width, height) {
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
    }
    for (const size of [1600, 1200, 960, 720, 540, 400, 320, 240]) {
      const edge = Math.min(size, maximumEdge);
      const ratio = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * ratio));
      const height = Math.max(1, Math.round(bitmap.height * ratio));
      if (width === previousWidth && height === previousHeight) continue;
      previousWidth = width;
      previousHeight = height;
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(bitmap, 0, 0, width, height);
      if (format === "image/jpeg") fillBackground(width, height);
      for (const quality of [0.85, 0.65, 0.44]) {
        let blob = await encode(format, quality);
        if (format === "image/webp" && blob?.type !== format) {
          format = "image/jpeg";
          fillBackground(width, height);
          blob = await encode(format, quality);
        }
        if (blob?.type === format && blob.size <= maximum) return blob;
      }
    }
    throw new Error(errorMessage({ code: "image_too_large", imageMaxBytes: maximum }));
  } finally {
    bitmap.close();
  }
}

export function createImagePicker(textarea, { available, active, getDraft, setDraft, changed, maxBytes = () => undefined, maxEdge = () => undefined }) {
  const input = el("input", { type: "file", accept: ACCEPT, hidden: true, tabindex: "-1" });
  const add = el("button", {
    type: "button", className: "btn composer-add-image", "aria-label": LEAD, title: LEAD,
    onClick: () => input.click(),
  }, icon("plus", "icon-sm"));
  const bar = el("div", { className: "image-draft", hidden: true });
  const status = el("p", { className: "composer-feedback", role: "status", hidden: true });
  let serial = 0;
  let working = false;
  let locked = false;
  let renderedItem, renderedLock;

  function show(message = "") {
    status.hidden = !message;
    status.textContent = message;
  }

  function refresh() {
    const enabled = available();
    add.hidden = !enabled;
    add.disabled = working || locked;
    const item = getDraft();
    bar.hidden = !item;
    if (item === renderedItem && locked === renderedLock) return;
    renderedItem = item;
    renderedLock = locked;
    clearNode(bar);
    if (item) bar.append(
      el("img", { src: item.url, alt: "붙인 이미지 미리 보기", width: 56, height: 56 }),
      el("span", { text: formatImageBytes(item.blob.size) }),
      el("button", { type: "button", className: "icon-btn", disabled: locked, "aria-label": "붙인 이미지 지우기",
        onClick: () => {
          clear();
          changed();
          textarea.focus();
        },
      }, icon("close", "icon-sm")),
    );
  }

  function clear() {
    serial++;
    working = false;
    const value = getDraft();
    if (value) URL.revokeObjectURL(value.url);
    setDraft(null);
    show();
    refresh();
  }

  async function select(file) {
    if (!file || !available() || locked) return;
    const job = ++serial;
    working = true;
    show("이미지를 줄이는 중…");
    refresh();
    changed();
    try {
      const blob = await shrinkImage(file, maxBytes() ?? DEFAULT_IMAGE_BYTES, maxEdge() ?? 1600);
      if (job !== serial || !active()) return;
      const old = getDraft();
      if (old) URL.revokeObjectURL(old.url);
      setDraft({ blob, url: URL.createObjectURL(blob) });
      show();
    } catch (err) {
      if (job === serial && active()) show(err.message);
    } finally {
      if (job === serial && active()) {
        working = false;
        refresh();
        changed();
      }
    }
  }

  input.addEventListener("change", () => {
    void select(input.files[0]);
    input.value = "";
  });
  textarea.addEventListener("paste", (event) => {
    const file = [...(event.clipboardData?.files ?? [])].find((item) => item.type.startsWith("image/"));
    if (!file || !available()) return;
    event.preventDefault();
    void select(file);
  });
  textarea.addEventListener("dragover", (event) => {
    if (available() && event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
  textarea.addEventListener("drop", (event) => {
    if (!available() || !event.dataTransfer.files.length) return;
    event.preventDefault();
    void select(event.dataTransfer.files[0]);
  });
  refresh();
  return {
    buttons: [input, add], bar, status, refresh, clear,
    get working() { return working; },
    lock(value) { locked = value; refresh(); },
  };
}

export function createImageViewer() {
  const urls = new Map();
  let dialog;
  const lazy = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) if (isIntersecting) {
      lazy.unobserve(target);
      target.dispatchEvent(new Event("load-preview"));
    }
  }) : null;

  function forget(id) {
    const item = urls.get(id);
    urls.delete(id);
    if (item?.url) URL.revokeObjectURL(item.url);
    if (dialog?.dataset.message === String(id)) dialog.close();
  }

  function clear() {
    lazy?.disconnect();
    for (const id of urls.keys()) forget(id);
  }

  function close() { dialog?.close(); }

  function openViewer(id, url, photoType, caption, trigger, onDelete) {
    close();
    const suffix = photoType === "image/jpeg" ? "jpg" : photoType.slice(6);
    const status = el("p", { className: "composer-feedback", role: "alert", hidden: true });
    const frame = el("dialog", { className: "image-dialog", "aria-label": "이미지 크게 보기", dataset: { message: id } },
      el("div", { className: "image-dialog-inner" },
        el("div", { className: "action-row image-dialog-actions" },
          onDelete ? el("button", { type: "button", className: "btn", onClick: async (event) => {
            if (!window.confirm("이 글의 이미지를 삭제할까요? 캡션은 남습니다.")) return;
            const button = event.currentTarget;
            button.disabled = true;
            try { await onDelete(); }
            catch (err) {
              status.textContent = errorMessage(err);
              status.hidden = false;
              button.disabled = false;
            }
          } }, "이미지 삭제") : null,
          el("a", { className: "btn", href: url, download: `image-${id}.${suffix}`, text: "저장" }),
          el("button", { type: "button", className: "icon-btn", "aria-label": "이미지 닫기",
            onClick: () => frame.close() }, icon("close")),
        ),
        status,
        el("img", { alt: caption, src: url }),
      ),
    );
    frame.addEventListener("click", (event) => {
      if (event.target !== frame) return;
      event.preventDefault();
      frame.close();
    });
    frame.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const controls = [...frame.querySelectorAll("button:not(:disabled), a[href]")];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    });
    frame.addEventListener("close", () => {
      frame.remove();
      if (dialog === frame) dialog = null;
      requestAnimationFrame(() => {
        if (dialog?.open) return;
        const target = trigger.isConnected ? trigger :
          document.querySelector('.message-image[data-image-id="' + CSS.escape(String(id)) + '"]');
        target?.focus({ preventScroll: true });
      });
    }, { once: true });
    dialog = frame;
    document.body.append(frame);
    frame.showModal();
    frame.querySelector(".icon-btn")?.focus();
  }

  function render(message, { path, auth, isCurrent, onDelete, onError }) {
    const { id, image } = message;
    const caption = message.text || "이미지";
    const ratio = Math.min(1, 280 / image.width, 320 / image.height);
    const picture = el("img", { alt: "", width: Math.max(1, Math.round(image.width * ratio)),
      height: Math.max(1, Math.round(image.height * ratio)), "aria-hidden": "true" });
    const box = el("button", { className: "message-image", type: "button", dataset: { imageId: id },
      "aria-label": caption + " 크게 보기" }, picture);
    const retry = el("button", { type: "button", className: "mini-action-btn", hidden: true,
      text: "이미지를 불러오지 못했습니다 · 다시 시도" });
    box.addEventListener("click", () => {
      const url = urls.get(id)?.url;
      if (url) openViewer(id, url, image.mime, caption, box, onDelete);
    });

    function display(url) {
      if (!isCurrent() || !box.isConnected) return;
      picture.alt = caption;
      picture.removeAttribute("aria-hidden");
      picture.src = url;
      retry.hidden = true;
      box.hidden = false;
    }

    async function load() {
      if (!isCurrent() || !box.isConnected) return;
      retry.hidden = true;
      box.hidden = false;
      let entry = urls.get(id);
      if (!entry?.pending && !entry?.url) {
        entry = {
          pending: apiRequest(path, { ...auth, asBlob: true }).then((blob) => {
            if (!isCurrent() || urls.get(id) !== entry) return null;
            entry.url = URL.createObjectURL(blob);
            return entry.url;
          }).finally(() => { entry.pending = null; }),
        };
        urls.set(id, entry);
      }
      try {
        const url = entry.url ?? await entry.pending;
        if (url) display(url);
      } catch (err) {
        if (!isCurrent() || !box.isConnected) return;
        entry.failed = true;
        box.hidden = true;
        retry.hidden = false;
        onError(err);
      }
    }
    picture.addEventListener("error", () => {
      if (!isCurrent() || !picture.hasAttribute("src")) return;
      forget(id);
      urls.set(id, { failed: true });
      box.hidden = true;
      retry.hidden = false;
    });
    retry.addEventListener("click", load);
    box.addEventListener("load-preview", load, { once: true });
    const item = urls.get(id);
    if (item?.failed && !item?.url) {
      box.hidden = true;
      retry.hidden = false;
    } else if (lazy) lazy.observe(box);
    else queueMicrotask(load);
    return el("div", { className: "message-image-frame" }, box, retry);
  }

  function keep(ids) {
    const live = new Set(ids);
    for (const id of urls.keys()) if (!live.has(id)) forget(id);
  }

  return { render, forget, keep, clear, resetViewport: () => lazy?.disconnect() };
}
