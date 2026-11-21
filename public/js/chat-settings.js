// 대화 설정 모달 · 5스킨 · 글자크기/줄간격/컴팩트 · 전송키(한글 IME 보호) · 비서 답변 알림 · 방장 닉네임 · 내보내기
// - 엄격 CSP(default-src 'self') 준수: 동적 HTML 문자열 주입 0건, 인라인 스타일 속성·직접 스타일 조작 0건
// - 비민감 표시·입력·알림 설정만 localStorage('arsen.mailbox.v2.chat_prefs')에 보관 (열쇠·토큰 저장 금지)
// - 브라우저 알림 권한(Notification.requestPermission)은 오직 사용자가 토글을 켤 때만 요청

import { errorMessage, validateNameInput } from "./constants.js?v=2.2.2";
import { appendNodes, buildAvatar, el, icon } from "./dom.js?v=2.2.2";
import { applyTheme, getThemeMode, onThemeChange } from "./theme.js?v=2.2.2";

const CHAT_PREFS_STORAGE_KEY = "arsen.mailbox.v2.chat_prefs";
const THEME_STORAGE_KEY = "arsen.mailbox.v2.theme";

export const CHAT_SKINS = Object.freeze([
  {
    id: "arsen",
    label: "아르센 서재",
    desc: "따뜻한 종이 질감과 청록 포인트 (기본)",
  },
  {
    id: "sunlit",
    label: "햇살 말풍선",
    desc: "모래빛 배경과 살구색 말풍선",
  },
  {
    id: "sky",
    label: "하늘 말풍선",
    desc: "차분한 청색과 둥근 직사각형 말풍선",
  },
  {
    id: "workspace",
    label: "작업실",
    desc: "왼쪽으로 정렬한 문서·코드 중심 보기",
  },
  {
    id: "forest",
    label: "포레스트 민트",
    desc: "눈의 피로를 줄이는 세이지 그린 톤",
  },
]);

const VALID_SKIN_IDS = new Set(CHAT_SKINS.map((s) => s.id));
const LEGACY_SKINS = new Map([["kakao", "sunlit"], ["imessage", "sky"]]);
const VALID_FONT_SIZES = new Set([13, 15, 17, 19]);
const VALID_LINE_HEIGHTS = new Set(["snug", "normal", "relaxed"]);
const VALID_SEND_KEYS = new Set(["enter", "ctrl_enter"]);
const EXPORT_FORMATS = Object.freeze([
  { id: "md", label: "MD", sub: "마크다운" },
  { id: "csv", label: "CSV", sub: "표 데이터" },
  { id: "txt", label: "TXT", sub: "텍스트" },
  { id: "json", label: "JSON", sub: "원본 구조" },
]);

const DEFAULT_CHAT_PREFS = Object.freeze({
  skin: "arsen",
  fontSize: 15,
  lineHeight: "normal",
  compact: false,
  sendKey: "enter",
  chime: true,
  browserNotify: false,
});

const MAX_SEEN_REPLIES = 500;
const seenReplyKeys = new Set();

let cachedPrefs = null;
let themeBootSynced = false;
let composerHintObserver = null;
let sharedAudioContext = null;

function normalizePrefs(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const requestedSkin = LEGACY_SKINS.get(src.skin) ?? src.skin;
  const skin = VALID_SKIN_IDS.has(requestedSkin) ? requestedSkin : DEFAULT_CHAT_PREFS.skin;
  const parsedFont = Number(src.fontSize);
  const fontSize = VALID_FONT_SIZES.has(parsedFont) ? parsedFont : DEFAULT_CHAT_PREFS.fontSize;
  const lineHeight = VALID_LINE_HEIGHTS.has(src.lineHeight)
    ? src.lineHeight
    : DEFAULT_CHAT_PREFS.lineHeight;
  const compact = typeof src.compact === "boolean" ? src.compact : DEFAULT_CHAT_PREFS.compact;
  const sendKey = VALID_SEND_KEYS.has(src.sendKey) ? src.sendKey : DEFAULT_CHAT_PREFS.sendKey;
  const chime = typeof src.chime === "boolean" ? src.chime : DEFAULT_CHAT_PREFS.chime;
  const browserNotify =
    typeof src.browserNotify === "boolean"
      ? src.browserNotify
      : DEFAULT_CHAT_PREFS.browserNotify;

  return {
    skin,
    fontSize,
    lineHeight,
    compact,
    sendKey,
    chime,
    browserNotify,
  };
}

function readStoredPrefs() {
  try {
    const raw = window.localStorage.getItem(CHAT_PREFS_STORAGE_KEY);
    if (!raw) return normalizePrefs(null);
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return normalizePrefs(null);
  }
}

function writeStoredPrefs(nextPrefs) {
  const normalized = normalizePrefs(nextPrefs);
  cachedPrefs = normalized;
  try {
    // Retain older saved IDs so the previous Worker still reads the same preference.
    const storedSkin = [...LEGACY_SKINS].find(([, current]) => current === normalized.skin)?.[0] ?? normalized.skin;
    window.localStorage.setItem(CHAT_PREFS_STORAGE_KEY, JSON.stringify({ ...normalized, skin: storedSkin }));
  } catch {
    /* 사생활 보호 모드·저장소 제한 무시 */
  }
  return normalized;
}

export function getChatPreferences() {
  if (!cachedPrefs) {
    cachedPrefs = readStoredPrefs();
  }
  return { ...cachedPrefs, theme: getThemeMode() };
}

function shortcutHintTextFor(sendKey) {
  return sendKey === "ctrl_enter"
    ? "Ctrl+Enter 전송 · Enter 줄바꿈"
    : "Enter 전송 · Shift+Enter 줄바꿈";
}

function syncComposerHintInDom(sendKey) {
  if (typeof document === "undefined") return;
  const hint = document.getElementById("composer-shortcut-hint");
  if (!hint) return;
  const expected = shortcutHintTextFor(sendKey);
  if (hint.textContent !== expected) {
    hint.textContent = expected;
  }
}

function ensureComposerHintObserver() {
  if (composerHintObserver || typeof MutationObserver === "undefined" || typeof document === "undefined") {
    return;
  }
  const target = document.getElementById("app-root") || document.body;
  if (!target) return;
  composerHintObserver = new MutationObserver(() => {
    const prefs = cachedPrefs || readStoredPrefs();
    syncComposerHintInDom(prefs.sendKey);
  });
  composerHintObserver.observe(target, { childList: true, subtree: true });
}

function ensureInitialThemeSync() {
  if (themeBootSynced || typeof document === "undefined") return;
  themeBootSynced = true;
  if (document.documentElement.hasAttribute("data-theme")) return;
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (storedTheme === "light" || storedTheme === "dark") {
      applyTheme(storedTheme, false);
    }
  } catch {
    /* ignore */
  }
}

/** 저장된 대화창 스킨·서체·밀도·전송키 설정을 루트 문서와 입력 힌트에 반영한다 */
export function applyChatPreferences() {
  ensureInitialThemeSync();
  const prefs = readStoredPrefs();
  cachedPrefs = prefs;

  if (typeof document !== "undefined" && document.documentElement) {
    const root = document.documentElement;
    root.dataset.chatSkin = prefs.skin;
    root.dataset.chatFont = String(prefs.fontSize);
    root.dataset.chatLeading = prefs.lineHeight;
    root.dataset.chatDensity = prefs.compact ? "compact" : "comfortable";
    root.dataset.chatSendKey = prefs.sendKey;
  }

  syncComposerHintInDom(prefs.sendKey);
  ensureComposerHintObserver();
  return { ...prefs, theme: getThemeMode() };
}

/**
 * 메시지 입력창 keydown 전송 판정기
 * - 한글/일본어/중국어 IME 조합 중(isComposing 또는 keyCode 229)에는 절대 전송하지 않음
 * - 'enter' 모드: 일반 Enter 전송, Shift+Enter 줄바꿈 (모바일 터치 화면은 Enter 줄바꿈 유지)
 * - 'ctrl_enter' 모드: Ctrl+Enter / ⌘+Enter 전송, 일반 Enter 줄바꿈
 */
export function shouldSubmitMessage(event) {
  if (!event || event.key !== "Enter" || event.defaultPrevented) {
    return false;
  }
  if (event.isComposing === true || event.keyCode === 229 || event.which === 229) {
    return false;
  }

  const prefs = cachedPrefs || readStoredPrefs();
  cachedPrefs = prefs;

  if (prefs.sendKey === "ctrl_enter") {
    return Boolean((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey);
  }

  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }

  const isCoarseMobile = Boolean(
    typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches,
  );
  return !isCoarseMobile;
}

/** Web Audio API 기반 부드러운 2음 차임 (외부 음원·data URL 없이 CSP 'self' 완전 호환) */
function playSoftChime() {
  if (typeof window === "undefined") return false;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (typeof AudioCtx !== "function") return false;

  try {
    if (!sharedAudioContext || sharedAudioContext.state === "closed") {
      sharedAudioContext = new AudioCtx();
    }
    const ctx = sharedAudioContext;
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    const notes = [
      { freq: 587.33, start: now, duration: 0.13 },
      { freq: 880.0, start: now + 0.09, duration: 0.18 },
    ];

    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(note.freq, note.start);

      gain.gain.setValueAtTime(0.0001, note.start);
      gain.gain.exponentialRampToValueAtTime(0.065, note.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, note.start + note.duration);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(note.start);
      osc.stop(note.start + note.duration + 0.01);
    }
    return true;
  } catch {
    return false;
  }
}

function getNotificationSupportState() {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return "unsupported";
  }
  const perm = window.Notification.permission;
  if (perm === "granted" || perm === "denied" || perm === "default") {
    return perm;
  }
  return "default";
}

async function requestBrowserNotificationPermission() {
  if (getNotificationSupportState() === "unsupported") {
    return "unsupported";
  }
  try {
    const maybePromise = window.Notification.requestPermission();
    if (maybePromise && typeof maybePromise.then === "function") {
      return await maybePromise;
    }
    return await new Promise((resolve) => {
      window.Notification.requestPermission((res) => resolve(res));
    });
  } catch {
    return getNotificationSupportState();
  }
}

function recordSeenReplyKey(dedupeKey) {
  if (seenReplyKeys.size >= MAX_SEEN_REPLIES) {
    const oldest = seenReplyKeys.values().next().value;
    if (oldest !== undefined) seenReplyKeys.delete(oldest);
  }
  seenReplyKeys.add(dedupeKey);
}

/**
 * 비서 새 답변 도착 알림 (차임 소리 및 허용된 브라우저 알림)
 * - 권한 요청(requestPermission)은 절대 여기서 호출하지 않음
 * - 동일 (roomId, messageId) 중복 호출 방어 포함
 * - 잠금화면 보호를 위해 열쇠·방 민감 본문을 알림 텍스트에 노출하지 않음
 */
export function notifyAssistantReply(roomId, messageId) {
  if (!roomId || messageId === null || messageId === undefined || messageId === "") {
    return { notified: false, chimePlayed: false, browserShown: false, reason: "invalid_target" };
  }

  const dedupeKey = `${String(roomId)}:${String(messageId)}`;
  if (seenReplyKeys.has(dedupeKey)) {
    return { notified: false, chimePlayed: false, browserShown: false, reason: "duplicate" };
  }
  recordSeenReplyKey(dedupeKey);

  const prefs = cachedPrefs || readStoredPrefs();
  cachedPrefs = prefs;

  let chimePlayed = false;
  if (prefs.chime) {
    chimePlayed = playSoftChime();
  }

  let browserShown = false;
  if (prefs.browserNotify && getNotificationSupportState() === "granted") {
    try {
      const notice = new window.Notification("ARSEN 우편함 · 새 비서 답변", {
        body: "열어 둔 대화방에 AI 비서의 새 답변이 도착했습니다.",
        tag: `arsen-mailbox-reply-${String(roomId)}`,
        silent: true,
      });
      notice.onclick = () => {
        try {
          window.focus();
          notice.close();
        } catch {
          /* ignore */
        }
      };
      browserShown = true;
    } catch {
      browserShown = false;
    }
  }

  return {
    notified: chimePlayed || browserShown,
    chimePlayed,
    browserShown,
  };
}

function describeBrightnessLabel(mode) {
  if (mode === "light") return "라이트";
  if (mode === "dark") return "다크";
  return "시스템";
}

function describeLeadingLabel(leading) {
  if (leading === "snug") return "조밀";
  if (leading === "relaxed") return "여유";
  return "기본";
}

function installModalFocusTrap(panel) {
  if (!panel || typeof document === "undefined") return () => {};
  const selector = [
    "button:not([disabled]):not([hidden])",
    "input:not([disabled]):not([hidden])",
    "select:not([disabled]):not([hidden])",
    "textarea:not([disabled]):not([hidden])",
    "a[href]:not([hidden])",
    '[tabindex]:not([tabindex="-1"]):not([hidden])',
  ].join(", ");

  const onKeyDown = (e) => {
    if (e.key !== "Tab") return;
    const focusables = [...panel.querySelectorAll(selector)].filter(
      (node) => node.offsetParent !== null || node === document.activeElement,
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  panel.addEventListener("keydown", onKeyDown);
  return () => panel.removeEventListener("keydown", onKeyDown);
}

/**
 * 대화 설정 모달 열기
 * - 게스트 화면은 표시·알림·내보내기를 제공
 * - 모달을 닫으면 원래 방·작성 중인 입력창 초안이 그대로 유지되며 trigger 버튼으로 포커스 복귀
 */
export function openChatSettings(
  sheets,
  {
    trigger = null,
    ownerName = "",
    onRename = null,
    onExport = null,
    onOpenSpaceSettings = null,
    roomName = "",
  } = {},
) {
  if (!sheets || typeof sheets.openSheet !== "function") return;

  applyChatPreferences();
  let prefs = readStoredPrefs();
  let unsubscribeTheme = null;
  let removeFocusTrap = null;

  const canManageOwnerName = typeof onRename === "function";
  const canExport = typeof onExport === "function";
  const canJumpSpaceSettings = typeof onOpenSpaceSettings === "function";

  sheets.openSheet({
    title: "대화 설정",
    trigger,
    onDispose: () => {
      if (unsubscribeTheme) {
        unsubscribeTheme();
        unsubscribeTheme = null;
      }
      if (removeFocusTrap) {
        removeFocusTrap();
        removeFocusTrap = null;
      }
    },
    buildBody: (bodyBox, closeSheet) => {
      const panel = bodyBox.closest(".sheet-panel");
      removeFocusTrap = installModalFocusTrap(panel);

      let activeOwnerLabel = String(ownerName || "").trim() || "내 글";

      // 1) 상단 실시간 미리보기
      const previewMetaLabel = el("span", { className: "chat-skin-preview-meta" });
      const previewWorkspaceAuthor = el("span", {
        className: "workspace-author",
        text: activeOwnerLabel,
      });
      const previewMineMeta = el("span", { text: `내 글 · 오후 2:16` });
      let previewOwnAvatar = buildAvatar(activeOwnerLabel, "human", "workspace-own-avatar");
      const previewMineRow = el(
        "article",
        { className: "msg-row is-mine" },
        previewOwnAvatar,
        el(
          "div",
          { className: "msg-col" },
          el("div", { className: "msg-meta" }, previewWorkspaceAuthor, previewMineMeta),
          el(
            "div",
            { className: "msg-bubble" },
            el("div", {
              className: "msg-body",
              text: "좋아요! 밝기와 스킨을 따로 맞출 수 있어 편하네요.",
            }),
          ),
        ),
      );
      const previewBox = el(
        "div",
        {
          className: "chat-skin-preview",
          "aria-label": "선택한 스킨과 글자 크기 미리보기",
          dataset: {
            previewSkin: prefs.skin,
            previewFont: String(prefs.fontSize),
            previewLeading: prefs.lineHeight,
            previewDensity: prefs.compact ? "compact" : "comfortable",
          },
        },
        el(
          "div",
          { className: "chat-skin-preview-bar" },
          el("span", { text: roomName ? `미리보기 · ${roomName}` : "실시간 대화창 미리보기" }),
          previewMetaLabel,
        ),
        el(
          "div",
          { className: "preview-messages" },
          el("div", { className: "date-divider", text: "오늘" }),
          el(
            "article",
            { className: "msg-row" },
            buildAvatar("클로드", "claude"),
            el(
              "div",
              { className: "msg-col" },
              el(
                "div",
                { className: "msg-meta" },
                el("span", { className: "sender-name", dataset: { kind: "claude" }, text: "클로드" }),
                el("span", { className: "chip", text: "클로드" }),
                el("span", { text: "오후 2:15" }),
              ),
              el(
                "div",
                { className: "msg-bubble" },
                el("div", { className: "msg-reply-ref", text: "#12 글에 답장" }),
                el("div", {
                  className: "msg-body",
                  text: "스킨과 글자 크기가 대화창에 즉시 반영됩니다.",
                }),
                el("pre", { className: "msg-code", text: "summary: 검증 통과 (0건 오류)" }),
              ),
            ),
          ),
          previewMineRow,
        ),
      );

      // 2) 5종 스킨 선택 카드
      const skinCards = new Map();
      const skinGrid = el("div", {
        className: "chat-skin-grid",
        role: "group",
        "aria-label": "대화창 스킨 선택",
      });

      for (const skin of CHAT_SKINS) {
        const card = el(
          "button",
          {
            type: "button",
            className: "chat-skin-card",
            "aria-pressed": String(prefs.skin === skin.id),
            dataset: { skinOption: skin.id },
            onClick: () => {
              prefs = writeStoredPrefs({ ...prefs, skin: skin.id });
              applyChatPreferences();
              syncAllControls();
            },
          },
          el(
            "span",
            { className: "skin-swatch", "aria-hidden": "true" },
            el("span", { className: "skin-swatch-other" }),
            el("span", { className: "skin-swatch-mine" }),
          ),
          el(
            "span",
            { className: "chat-skin-card-text" },
            el("span", { className: "chat-skin-card-title", text: skin.label }),
            el("span", { className: "chat-skin-card-desc", text: skin.desc }),
          ),
        );
        skinCards.set(skin.id, card);
        skinGrid.appendChild(card);
      }

      // 3) 화면 밝기 (스킨과 독립 · theme.js 양방향 동기화)
      const themeButtons = new Map();
      const themeOptions = [
        { id: "system", label: "시스템", sub: "기기 설정 따름" },
        { id: "light", label: "라이트", sub: "밝은 화면" },
        { id: "dark", label: "다크", sub: "어두운 화면" },
      ];
      const themeGrid = el("div", {
        className: "prefs-seg-grid",
        role: "group",
        "aria-label": "화면 밝기 선택",
      });
      for (const opt of themeOptions) {
        const btn = el(
          "button",
          {
            type: "button",
            className: "prefs-option-btn",
            "aria-pressed": String(getThemeMode() === opt.id),
            dataset: { brightnessOption: opt.id },
            onClick: () => {
              applyTheme(opt.id, true);
              syncAllControls();
            },
          },
          el("span", { text: opt.label }),
          el("span", { className: "prefs-option-sub", text: opt.sub }),
        );
        themeButtons.set(opt.id, btn);
        themeGrid.appendChild(btn);
      }

      unsubscribeTheme = onThemeChange(() => {
        syncAllControls();
      });

      // 4) 글자 크기 (13 / 15 / 17 / 19px) · 줄간격 · 컴팩트
      const fontButtons = new Map();
      const fontGrid = el("div", {
        className: "prefs-seg-grid",
        role: "group",
        "aria-label": "대화 글자 크기",
      });
      for (const size of [13, 15, 17, 19]) {
        const btn = el(
          "button",
          {
            type: "button",
            className: "prefs-option-btn",
            "aria-pressed": String(prefs.fontSize === size),
            dataset: { fontOption: String(size) },
            onClick: () => {
              prefs = writeStoredPrefs({ ...prefs, fontSize: size });
              applyChatPreferences();
              syncAllControls();
            },
          },
          el("span", { text: `${size}px` }),
          el("span", { className: "prefs-option-sub", text: size === 15 ? "기본" : size === 13 ? "작게" : size === 17 ? "크게" : "아주 크게" }),
        );
        fontButtons.set(size, btn);
        fontGrid.appendChild(btn);
      }

      const leadingButtons = new Map();
      const leadingGrid = el("div", {
        className: "prefs-seg-grid",
        role: "group",
        "aria-label": "대화 줄간격",
      });
      const leadingOptions = [
        { id: "snug", label: "조밀", sub: "1.42" },
        { id: "normal", label: "기본", sub: "1.58" },
        { id: "relaxed", label: "여유", sub: "1.76" },
      ];
      for (const ld of leadingOptions) {
        const btn = el(
          "button",
          {
            type: "button",
            className: "prefs-option-btn",
            "aria-pressed": String(prefs.lineHeight === ld.id),
            dataset: { leadingOption: ld.id },
            onClick: () => {
              prefs = writeStoredPrefs({ ...prefs, lineHeight: ld.id });
              applyChatPreferences();
              syncAllControls();
            },
          },
          el("span", { text: ld.label }),
          el("span", { className: "prefs-option-sub", text: ld.sub }),
        );
        leadingButtons.set(ld.id, btn);
        leadingGrid.appendChild(btn);
      }

      const compactToggle = el("input", {
        id: "chat-pref-compact",
        type: "checkbox",
        checked: prefs.compact,
      });
      compactToggle.addEventListener("change", () => {
        prefs = writeStoredPrefs({ ...prefs, compact: compactToggle.checked });
        applyChatPreferences();
        syncAllControls();
      });

      // 5) 전송 키 방식 (Enter vs Ctrl+Enter · 한글 IME 조합 보호 안내)
      const sendKeyButtons = new Map();
      const sendKeyGrid = el("div", {
        className: "prefs-seg-grid-2",
        role: "group",
        "aria-label": "메시지 전송 단축키",
      });
      const sendKeyOptions = [
        {
          id: "enter",
          label: "Enter로 바로 보내기",
          sub: "Shift+Enter 줄바꿈 (기본)",
        },
        {
          id: "ctrl_enter",
          label: "Ctrl+Enter (⌘+Enter) 보내기",
          sub: "Enter 줄바꿈 · 긴 글 작성에 적합",
        },
      ];
      for (const sk of sendKeyOptions) {
        const btn = el(
          "button",
          {
            type: "button",
            className: "prefs-option-btn",
            "aria-pressed": String(prefs.sendKey === sk.id),
            dataset: { sendkeyOption: sk.id },
            onClick: () => {
              prefs = writeStoredPrefs({ ...prefs, sendKey: sk.id });
              applyChatPreferences();
              syncAllControls();
            },
          },
          el("span", { text: sk.label }),
          el("span", { className: "prefs-option-sub", text: sk.sub }),
        );
        sendKeyButtons.set(sk.id, btn);
        sendKeyGrid.appendChild(btn);
      }

      // 6) 비서 답변 알림 (차임 소리 · 브라우저 알림 — 켤 때만 권한 요청)
      const notifyStatus = el("p", {
        id: "chat-notify-status",
        className: "field-hint",
        role: "status",
        "aria-live": "polite",
      });

      const chimeToggle = el("input", {
        id: "chat-pref-chime",
        type: "checkbox",
        checked: prefs.chime,
      });
      chimeToggle.addEventListener("change", () => {
        prefs = writeStoredPrefs({ ...prefs, chime: chimeToggle.checked });
        if (chimeToggle.checked) {
          playSoftChime();
          notifyStatus.textContent = "비서 답변 차임 소리를 켰습니다.";
        } else {
          notifyStatus.textContent = "비서 답변 차임 소리를 껐습니다.";
        }
      });

      const testChimeBtn = el(
        "button",
        {
          type: "button",
          className: "btn",
          onClick: () => {
            const ok = playSoftChime();
            notifyStatus.textContent = ok
              ? "차임 소리를 재생했습니다."
              : "이 기기에서 오디오 장치를 열 수 없습니다.";
          },
        },
        "차임 미리 듣기",
      );

      const initialPerm = getNotificationSupportState();
      const effectiveBrowserNotify = prefs.browserNotify && initialPerm === "granted";
      if (prefs.browserNotify && initialPerm !== "granted") {
        prefs = writeStoredPrefs({ ...prefs, browserNotify: false });
      }

      const browserNotifyToggle = el("input", {
        id: "chat-pref-browser-notify",
        type: "checkbox",
        checked: effectiveBrowserNotify,
        disabled: initialPerm === "unsupported",
      });

      function refreshPermissionMessage(customMessage = "") {
        const perm = getNotificationSupportState();
        browserNotifyToggle.disabled = perm === "unsupported";
        if (customMessage) {
          notifyStatus.textContent = customMessage;
          return;
        }
        if (perm === "unsupported") {
          notifyStatus.textContent =
            "현재 브라우저는 웹 시스템 알림을 지원하지 않습니다. 차임 소리는 그대로 사용할 수 있습니다.";
        } else if (perm === "denied") {
          notifyStatus.textContent =
            "브라우저 알림 권한이 거부되어 있습니다. 주소창의 사이트 권한 설정에서 알림을 '허용'으로 바꾼 뒤 다시 켜 주세요.";
        } else if (prefs.browserNotify && perm === "granted") {
          notifyStatus.textContent =
            "브라우저 알림이 켜져 있습니다. 비서 답변 도착 시 열쇠·본문 노출 없이 알려 드립니다.";
        } else {
          notifyStatus.textContent =
            "브라우저 알림은 토글을 켤 때만 권한을 요청하며, 처음 열었을 때는 자동으로 묻지 않습니다.";
        }
      }

      browserNotifyToggle.addEventListener("change", async () => {
        if (!browserNotifyToggle.checked) {
          prefs = writeStoredPrefs({ ...prefs, browserNotify: false });
          refreshPermissionMessage("브라우저 알림을 껐습니다.");
          return;
        }

        const currentPerm = getNotificationSupportState();
        if (currentPerm === "unsupported") {
          browserNotifyToggle.checked = false;
          prefs = writeStoredPrefs({ ...prefs, browserNotify: false });
          refreshPermissionMessage();
          return;
        }

        if (currentPerm === "denied") {
          browserNotifyToggle.checked = false;
          prefs = writeStoredPrefs({ ...prefs, browserNotify: false });
          refreshPermissionMessage();
          return;
        }

        browserNotifyToggle.disabled = true;
        const resultPerm =
          currentPerm === "granted"
            ? "granted"
            : await requestBrowserNotificationPermission();
        browserNotifyToggle.disabled = getNotificationSupportState() === "unsupported";

        if (resultPerm === "granted") {
          browserNotifyToggle.checked = true;
          prefs = writeStoredPrefs({ ...prefs, browserNotify: true });
          refreshPermissionMessage(
            "브라우저 알림이 켜졌습니다. 새 비서 답변이 오면 안전하게 알려 드립니다.",
          );
        } else if (resultPerm === "denied") {
          browserNotifyToggle.checked = false;
          prefs = writeStoredPrefs({ ...prefs, browserNotify: false });
          refreshPermissionMessage(
            "알림 권한이 거부되어 브라우저 알림을 켜지 않았습니다. 차임 소리는 계속 사용할 수 있습니다.",
          );
        } else {
          browserNotifyToggle.checked = false;
          prefs = writeStoredPrefs({ ...prefs, browserNotify: false });
          refreshPermissionMessage("알림 권한 요청이 완료되지 않아 브라우저 알림을 켜지 않았습니다.");
        }
      });

      refreshPermissionMessage();

      // 7) 방장 닉네임 관리
      let ownerRenameSection = null;
      if (canJumpSpaceSettings || canManageOwnerName) {
        const renameInput = el("input", {
          id: "chat-owner-name-input",
          className: "input",
          type: "text",
          maxlength: "32",
          autocomplete: "off",
          value: String(ownerName || "공간 주인"),
          placeholder: "예: 김 작가, 공간 주인",
          disabled: !canManageOwnerName,
        });
        const renameStatus = el("p", {
          id: "chat-owner-name-status",
          className: "field-hint",
          role: "status",
          "aria-live": "polite",
        });
        const renameBtn = el(
          "button",
          { type: "submit", className: "btn btn-primary", disabled: !canManageOwnerName },
          icon("edit", "icon-sm"),
          "닉네임 저장",
        );

        const renameForm = el(
          "form",
          {
            className: "doc-list",
            onSubmit: async (e) => {
              e.preventDefault();
              if (!canManageOwnerName) return;
              const validationErr = validateNameInput(renameInput.value);
              if (validationErr) {
                renameStatus.textContent = validationErr;
                return;
              }
              const nextName = renameInput.value.normalize("NFC").trim();
              renameBtn.disabled = true;
              try {
                await onRename(nextName);
                activeOwnerLabel = nextName;
                previewWorkspaceAuthor.textContent = activeOwnerLabel;
                const nextAvatar = buildAvatar(activeOwnerLabel, "human", "workspace-own-avatar");
                previewOwnAvatar.replaceWith(nextAvatar);
                previewOwnAvatar = nextAvatar;
                renameStatus.textContent = `내 표시 이름을 '${nextName}'(으)로 저장했습니다.`;
              } catch (err) {
                renameStatus.textContent = errorMessage(err);
              } finally {
                renameBtn.disabled = false;
              }
            },
          },
          el(
            "label",
            {
              className: "field-label",
              for: "chat-owner-name-input",
              text: "내 표시 이름 (방장 닉네임)",
            },
          ),
          el("div", { className: "chat-rename-row" }, renameInput, renameBtn),
          renameStatus,
        );

        ownerRenameSection = el("section", { className: "chat-settings-section" }, renameForm);
      }

      // 8) 대화 내보내기 (MD / CSV / TXT / JSON — 방장 및 허용된 게스트 공통)
      let exportSection = null;
      if (canExport) {
        const exportStatus = el("p", {
          id: "chat-export-status",
          className: "field-hint",
          role: "status",
          "aria-live": "polite",
        });
        const exportButtons = [];
        const exportGrid = el("div", {
          className: "export-btn-grid",
          role: "group",
          "aria-label": "대화 내보내기 형식",
        });

        for (const fmt of EXPORT_FORMATS) {
          const btn = el(
            "button",
            {
              type: "button",
              className: "prefs-option-btn",
              dataset: { exportFormat: fmt.id },
              onClick: async () => {
                for (const b of exportButtons) b.disabled = true;
                exportStatus.textContent = `${fmt.label} 파일을 준비하고 있습니다…`;
                try {
                  await onExport(fmt.id);
                  exportStatus.textContent = `${fmt.label} 형식으로 대화를 내보냈습니다.`;
                } catch (err) {
                  exportStatus.textContent = errorMessage(err);
                } finally {
                  for (const b of exportButtons) b.disabled = false;
                }
              },
            },
            el("span", { className: "action-row" }, icon("download", "icon-sm"), el("span", { text: fmt.label })),
            el("span", { className: "prefs-option-sub", text: fmt.sub }),
          );
          exportButtons.push(btn);
          exportGrid.appendChild(btn);
        }

        exportSection = el(
          "section",
          { className: "chat-settings-section" },
          el(
            "div",
            { className: "chat-settings-section-head" },
            el("h3", { className: "chat-settings-section-title", text: "대화 내보내기" }),
          ),
          exportGrid,
          exportStatus,
        );
      }

      // 9) 공간 열쇠·복구·한도 설정 (방장 화면 전용)
      let spaceKeyBridgeSection = null;
      if (canJumpSpaceSettings) {
        spaceKeyBridgeSection = el(
          "section",
          { className: "chat-settings-section" },
          el(
            "div",
            { className: "chat-settings-section-head" },
            el("h3", { className: "chat-settings-section-title", text: "공간 열쇠 · 복구 코드 · 한도 관리" }),
          ),
          el(
            "button",
            {
              type: "button",
              className: "btn",
              onClick: () => {
                closeSheet();
                onOpenSpaceSettings();
              },
            },
            icon("shield", "icon-sm"),
            "공간 열쇠·복구 설정 화면으로 이동",
          ),
        );
      }

      // 10) 표시 설정 기본값 복원 및 완료 버튼
      const resetPrefsBtn = el(
        "button",
        {
          type: "button",
          className: "btn",
          onClick: () => {
            prefs = writeStoredPrefs({
              ...DEFAULT_CHAT_PREFS,
              browserNotify: false,
            });
            applyTheme("system", true);
            applyChatPreferences();
            compactToggle.checked = prefs.compact;
            chimeToggle.checked = prefs.chime;
            browserNotifyToggle.checked = false;
            refreshPermissionMessage("대화 표시·알림 설정을 기본값으로 되돌렸습니다.");
            syncAllControls();
          },
        },
        icon("refresh", "icon-sm"),
        "기본값으로 복원",
      );

      const doneBtn = el(
        "button",
        {
          type: "button",
          className: "btn btn-primary",
          onClick: () => closeSheet(),
        },
        icon("check", "icon-sm"),
        "완료",
      );

      function syncAllControls() {
        const skinMeta = CHAT_SKINS.find((s) => s.id === prefs.skin) || CHAT_SKINS[0];
        const themeMode = getThemeMode();

        previewBox.dataset.previewSkin = prefs.skin;
        previewBox.dataset.previewFont = String(prefs.fontSize);
        previewBox.dataset.previewLeading = prefs.lineHeight;
        previewBox.dataset.previewDensity = prefs.compact ? "compact" : "comfortable";
        previewMetaLabel.textContent = `${skinMeta.label} · ${describeBrightnessLabel(themeMode)} · ${prefs.fontSize}px · ${describeLeadingLabel(prefs.lineHeight)}${prefs.compact ? " · 컴팩트" : ""}`;

        for (const [id, card] of skinCards) {
          card.setAttribute("aria-pressed", String(id === prefs.skin));
        }
        for (const [id, btn] of themeButtons) {
          btn.setAttribute("aria-pressed", String(id === themeMode));
        }
        for (const [size, btn] of fontButtons) {
          btn.setAttribute("aria-pressed", String(size === prefs.fontSize));
        }
        for (const [ld, btn] of leadingButtons) {
          btn.setAttribute("aria-pressed", String(ld === prefs.lineHeight));
        }
        for (const [sk, btn] of sendKeyButtons) {
          btn.setAttribute("aria-pressed", String(sk === prefs.sendKey));
        }
      }

      syncAllControls();

      const rootContainer = el(
        "div",
        { className: "chat-settings-root" },
        previewBox,
        el(
          "section",
          { className: "chat-settings-section" },
          el(
            "div",
            { className: "chat-settings-section-head" },
            el("h3", { className: "chat-settings-section-title", text: "대화창 스킨 (5종)" }),
          ),
          skinGrid,
        ),
        el(
          "section",
          { className: "chat-settings-section" },
          el(
            "div",
            { className: "chat-settings-section-head" },
            el("h3", { className: "chat-settings-section-title", text: "화면 밝기" }),
          ),
          themeGrid,
        ),
        el(
          "section",
          { className: "chat-settings-section" },
          el(
            "div",
            { className: "chat-settings-section-head" },
            el("h3", { className: "chat-settings-section-title", text: "글자 크기 · 줄간격 · 밀도" }),
          ),
          el("span", { className: "field-hint", text: "글자 크기" }),
          fontGrid,
          el("span", { className: "field-hint", text: "줄간격" }),
          leadingGrid,
          el(
            "label",
            { className: "check-row" },
            compactToggle,
            el("span", { text: "컴팩트 모드 (말풍선·아바타 간격을 촘촘하게 표시)" }),
          ),
        ),
        el(
          "section",
          { className: "chat-settings-section" },
          el(
            "div",
            { className: "chat-settings-section-head" },
            el("h3", { className: "chat-settings-section-title", text: "메시지 전송 키" }),
          ),
          sendKeyGrid,
        ),
        el(
          "section",
          { className: "chat-settings-section" },
          el(
            "div",
            { className: "chat-settings-section-head" },
            el("h3", { className: "chat-settings-section-title", text: "새 비서 답변 알림" }),
            testChimeBtn,
          ),
          el(
            "label",
            { className: "check-row" },
            chimeToggle,
            el("span", { text: "비서 답변 도착 시 부드러운 차임 소리 울리기" }),
          ),
          el(
            "label",
            { className: "check-row" },
            browserNotifyToggle,
            el("span", { text: "브라우저 알림" }),
          ),
          notifyStatus,
        ),
        ownerRenameSection,
        exportSection,
        spaceKeyBridgeSection,
        el("div", { className: "chat-settings-footer" }, resetPrefsBtn, doneBtn),
      );

      appendNodes(bodyBox, rootContainer);
    },
  });
}
