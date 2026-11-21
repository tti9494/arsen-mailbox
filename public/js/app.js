// 아르센 우편함 v2 메인 앱 컨트롤러 (화면 1~9 라우팅 · 폴링 · 보안 수칙 통합)

import { apiRequest, isAuthRefusal } from "./api.js?v=2.3.0";
import { applyChatPreferences, notifyAssistantReply, openChatSettings, shouldSubmitMessage } from "./chat-settings.js?v=2.3.0";
import {
  BRAND_NAME,
  HERO_TAGLINE,
  IDLE_THRESHOLD_MS,
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  POLL_OVERVIEW_ACTIVE_MS,
  POLL_OVERVIEW_IDLE_MS,
  SENSITIVE_PATTERN,
  SPACE_LIMITS,
  TRUST_NOTICE_SHORT,
  errorMessage,
  kindMeta,
  validateMessageInput,
} from "./constants.js?v=2.3.0";
import {
  buildAvatar,
  buildHeroIllustration,
  buildLiveScheduleNode,
  buildPwaIllustration,
  buildSafeMessageNodes,
  buildThemeSelector,
  clearNode,
  dateKeyOf,
  el,
  filterFreshMessages,
  formatDateLabel,
  formatTime,
  icon,
  isLongMessage,
  nowSeconds,
  refreshLiveCheckNodes,
} from "./dom.js?v=2.3.0";
import {
  clearRoomKey,
  clearSpaceKey,
  consumeUrlFragmentKey,
  getRoomKey,
  getSpaceKey,
  isRoomRemembered,
  isSpaceRemembered,
  parsePastedKeyInput,
  setRoomKey,
  setRoomRemember,
  setSpaceKey,
  setSpaceRemember,
} from "./keystore.js?v=2.3.0";
import {
  createSheetManager,
  makeTwoStepButton,
  openAddParticipantSheet,
  openMobileMembersSheet,
  openParticipantDetailSheet,
  openRelaySheet,
  openRoomCreateSheet,
  openRoomManageSheet,
  serverParticipantStatus,
} from "./sheets.js?v=2.3.0&history=2&maintenance=1";
import { PARTICIPANT_FILTERS, participantNotes, participantRole, participantRoleLabel } from "./participant-avatar.js?v=2.3.0";
import { initTheme } from "./theme.js?v=2.3.0";
import { createImagePicker, createImageViewer, formatImageBytes, postImage } from "./images.js?v=2.3.0";

initTheme();
applyChatPreferences();

const appRoot = document.getElementById("app-root");
const sheetRoot = document.getElementById("sheet-root");
const sheets = createSheetManager(sheetRoot);
const imageViewer = createImageViewer();
let composerPicker;

// PWA 설치 프롬프트 보관(지원 브라우저)
let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

// 전역 런타임 상태 (세대 번호로 거절 전/키 교체 전 시작된 읽기 결과 무효화)
const state = {
  route: "landing", // 'landing' | 'app' | 'guest'
  guestRoomId: null,
  landingStep: "home", // 'home' | 'create' | 'recover' | 'save_key'
  pendingEnrollment: null, // { key, recoveryCodes, isRecovery } (1회 표시 후 즉시 파기)

  sessionGen: 1,
  roomGen: 1,

  meInfo: null,
  rooms: [],
  currentRoomId: "",
  participantsByRoom: new Map(),
  messages: [],
  questions: new Map(),
  notificationsArmed: false,
  lastMessageId: 0,
  historyOpened: false,
  historyBefore: null,
  historyRequest: null,
  historyError: "",
  retentionDays: 30,
  retentionRevision: 0,
  avatarUrls: new Map(),
  avatarPending: new Map(),
  imageUploads: false,
  imageMaxBytes: undefined,
  imageMaxEdge: undefined,
  imageDraft: null,
  imageRevision: null,
  memberFilter: "all",
  guestMeta: { roomName: "", meName: "", meId: "" },
  expandedMsgIds: new Set(),
  replyTo: null,

  mobilePane: "rooms", // 'rooms' | 'chat' | 'settings'
  settingsOpen: false,
  rightPanelCollapsed: false,
  guestNoticeCollapsed: false,

  statusBanner: null, // { kind: 'warn'|'danger'|'accent', text: string }
  offline: typeof navigator !== "undefined" ? !navigator.onLine : false,

  lastInputAt: Date.now(),
  lastOverviewAt: 0,
  pollTimer: null,
  expirySweepTimer: null,
};

function bumpSessionGen() {
  state.sessionGen += 1;
  state.roomGen += 1;
  state.historyRequest = null;
}

function bumpRoomGen() {
  state.roomGen += 1;
  state.historyRequest = null;
}

function stopTimers() {
  if (state.pollTimer !== null) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
}

function resetHistory() {
  state.lastMessageId = 0;
  state.historyOpened = false;
  state.historyBefore = null;
  state.historyRequest = null;
  state.historyError = "";
}

function resetImages() {
  imageViewer.clear();
  if (state.imageDraft) URL.revokeObjectURL(state.imageDraft.url);
  state.imageDraft = null;
  state.imageRevision = null;
  state.imageUploads = false;
  state.imageMaxBytes = undefined;
  state.imageMaxEdge = undefined;
  composerPicker = undefined;
}

function resetSessionView() {
  bumpSessionGen();
  resetImages();
  state.pendingEnrollment = null;
  state.rooms = [];
  state.currentRoomId = "";
  state.participantsByRoom.clear();
  clearAvatarUrls();
  state.messages = [];
  state.questions.clear();
  state.notificationsArmed = false;
  resetHistory();
  state.retentionDays = 30;
  state.retentionRevision = 0;
  state.guestMeta = { roomName: "", meName: "", meId: "" };
  state.expandedMsgIds.clear();
  state.replyTo = null;
  state.meInfo = null;
  state.lastOverviewAt = 0;
  state.mobilePane = "rooms";
  state.settingsOpen = false;
  state.rightPanelCollapsed = false;
  state.guestNoticeCollapsed = false;
}

function closeSpace() {
  resetSessionView();
  clearSpaceKey();
  state.landingStep = "home";
  navigateTo("/");
}

/** 확정 거절(HTTP 401/403, key_epoch_invalid) 발생 시 메모리·복사 원본·화면 목록 즉시 파기 */
function handleDefinitiveAuthRefusal(err, isGuest = false) {
  resetSessionView();
  stopTimers();
  sheets.closeSheet();
  if (isGuest && state.guestRoomId) {
    clearRoomKey(state.guestRoomId);
  } else {
    clearSpaceKey();
  }
  state.statusBanner = {
    kind: "danger",
    text: errorMessage(err),
  };
  renderApp();
}

/** 방 단위 확정 거절(404 not_found 등) 시 해당 방 본문·참가자 캐시 즉시 파기 */
function wipeCurrentRoomCache(err) {
  bumpRoomGen();
  resetImages();
  state.messages = [];
  state.questions.clear();
  state.notificationsArmed = false;
  resetHistory();
  state.expandedMsgIds.clear();
  state.replyTo = null;
  if (state.currentRoomId) {
    state.participantsByRoom.delete(state.currentRoomId);
  }
  state.statusBanner = {
    kind: "danger",
    text: errorMessage(err),
  };
}

/** 보안 수칙 3: 폴링 성공 여부와 무관하게 30일 지난 글을 메모리와 화면에서 즉시 제거 */
function pruneExpiredMessagesNow() {
  const beforeLen = state.messages.length;
  if (!beforeLen) return false;
  state.messages = filterFreshMessages(state.messages, nowSeconds(), state.retentionDays);
  imageViewer.keep(state.messages.filter((message) => message.image).map(({ id }) => id));
  return state.messages.length !== beforeLen;
}

function downloadTextFile(filename, content) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: "text/plain;charset=utf-8" });
  const objUrl = URL.createObjectURL(blob);
  const a = el("a", { href: objUrl, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
}

let turnstileLoading;
let disposeTurnstile;

function createTurnstileControl(onTokenChange) {
  const sitekey = document.querySelector('meta[name="turnstile-sitekey"]')?.getAttribute("content")?.trim() || "";
  const isLocal = ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname);
  if (isLocal && sitekey === "1x00000000000000000000AA") {
    const check = el("input", { type: "checkbox" });
    const reset = () => {
      check.checked = false;
      onTokenChange("");
    };
    check.addEventListener("change", () => {
      onTokenChange(check.checked ? "XXXX.DUMMY.TOKEN.XXXX" : "");
    });
    return {
      element: el("label", { className: "check-row" }, check, "사람 확인 (로컬 테스트)"),
      reset,
    };
  }

  const slot = el("div", { className: "field" });
  let widget;
  const unavailable = () => {
    onTokenChange("");
    slot.textContent = "사람 확인을 불러올 수 없습니다. 잠시 뒤 다시 열어 주세요.";
  };
  if (!sitekey) {
    unavailable();
  } else {
    turnstileLoading ??= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.onload = () => typeof window.turnstile?.render === "function" ? resolve() : script.onerror();
      script.onerror = () => {
        script.remove();
        turnstileLoading = undefined;
        reject();
      };
      document.head.append(script);
    });
    turnstileLoading.then(() => {
      if (!slot.isConnected) return;
      widget = window.turnstile.render(slot, {
        sitekey,
        size: "flexible",
        callback: onTokenChange,
        "expired-callback": () => onTokenChange(""),
        "error-callback": () => onTokenChange(""),
      });
    }).catch(unavailable);
  }
  disposeTurnstile = () => {
    if (widget !== undefined) window.turnstile.remove(widget);
  };
  return {
    element: slot,
    reset: () => {
      onTokenChange("");
      if (widget !== undefined) window.turnstile.reset(widget);
    },
  };
}

/* =========================================================================
   라우트 판별 및 부트스트랩
   ========================================================================= */
function resolveRouteAndConsumeKey() {
  const { pathname } = window.location;
  const guestMatch = /^\/r\/([\w-]+)\/?$/.exec(pathname);

  if (guestMatch) {
    const roomId = guestMatch[1];
    consumeUrlFragmentKey(roomId);
    state.route = "guest";
    state.guestRoomId = roomId;
    return;
  }

  const consumed = consumeUrlFragmentKey(null);
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    state.route = "app";
    return;
  }

  // '/' 에서 #k=ams_... 열쇠 링크로 들어온 경우 즉시 /app 으로 전환
  if (consumed.type === "space" && consumed.captured) {
    window.history.replaceState(null, "", "/app");
    state.route = "app";
    return;
  }

  state.route = "landing";
}

function navigateTo(pathname) {
  stopTimers();
  sheets.closeSheet();
  state.statusBanner = null;
  if (pathname === "/app") {
    state.pendingEnrollment = null;
    state.landingStep = "home";
  }
  window.history.pushState(null, "", pathname);
  resolveRouteAndConsumeKey();
  bootCurrentRoute();
}

window.addEventListener("popstate", () => {
  resetRoomView("");
  state.participantsByRoom.clear();
  clearAvatarUrls();
  sheets.closeSheet();
  resolveRouteAndConsumeKey();
  bootCurrentRoute();
});

/* =========================================================================
   화면 1 & 2: 첫 화면 (/) · 공간 만들기 · 복구 · 열쇠 저장 화면
   ========================================================================= */
function renderLandingPage() {
  disposeTurnstile?.();
  disposeTurnstile = undefined;
  clearNode(appRoot);

  const header = el(
    "header",
    { className: "public-header" },
    el(
      "a",
      {
        className: "brand-lockup",
        href: "/",
        onClick: (e) => {
          e.preventDefault();
          state.pendingEnrollment = null;
          state.landingStep = "home";
          renderLandingPage();
        },
      },
      el("span", { className: "brand-mark-box", "aria-hidden": "true" }, icon("mail")),
      el("span", { text: BRAND_NAME }),
    ),
    el(
      "div",
      { className: "action-row" },
      buildThemeSelector("테마 모드"),
      el("a", { className: "btn", href: "/help.html", text: "도움말·안내" }),
    ),
  );

  const main = el("main", { id: "main-focus", tabindex: "-1" });

  if (state.landingStep === "home") {
    const hasSavedSpace = Boolean(getSpaceKey());
    const savedBanner = hasSavedSpace
      ? el(
          "div",
          { className: "banner banner-accent" },
          el("span", { text: "이 기기에 열려 있는 내 공간 열쇠가 있습니다." }),
          el(
            "button",
            {
              type: "button",
              className: "btn btn-primary",
              onClick: () => navigateTo("/app"),
            },
            "내 공간 바로 열기",
          ),
        )
      : null;

    main.appendChild(
      el(
        "section",
        { className: "hero-card", "aria-labelledby": "hero-heading" },
        savedBanner,
        el("h1", { id: "hero-heading", className: "hero-lead", text: HERO_TAGLINE }),
        el("p", {
          className: "hero-sub",
          text: "여러 AI 비서와 사람이 한 방에서 같은 글을 읽고 답합니다. AI 사용량은 각자 계정에서 나가며 글의 기본 보관 기간은 30일입니다.",
        }),
        el("div", { className: "hero-illustration" }, buildHeroIllustration()),
        el(
          "div",
          { className: "hero-actions" },
          el(
            "button",
            {
              type: "button",
              className: "btn btn-primary btn-block",
              onClick: () => {
                state.landingStep = "create";
                renderLandingPage();
              },
            },
            icon("plus", "icon-sm"),
            "내 공간 만들기",
          ),
          el(
            "button",
            {
              type: "button",
              className: "btn btn-block",
              onClick: () => {
                state.landingStep = "recover";
                renderLandingPage();
              },
            },
            "이미 있어요 (열쇠·복구)",
          ),
        ),
      ),
    );
  } else if (state.landingStep === "create") {
    main.appendChild(buildCreateSpaceView());
  } else if (state.landingStep === "recover") {
    main.appendChild(buildRecoverSpaceView());
  } else if (state.landingStep === "save_key" && state.pendingEnrollment) {
    main.appendChild(buildSaveKeyView(state.pendingEnrollment));
  }

  const footer = el(
    "footer",
    { className: "public-footer" },
    el("span", { text: "기본 30일 보관 · 열쇠 원문 및 IP 원문 미저장" }),
    el(
      "div",
      { className: "footer-links" },
      el("a", { className: "link-nav", href: "/help.html#guide", text: "이용 안내·도움말" }),
      el("a", { className: "link-nav", href: "/help.html#privacy", text: "개인정보·보관 안내" }),
    ),
  );

  appRoot.appendChild(el("div", { className: "public-page" }, header, main, footer));
}

function buildCreateSpaceView() {
  let turnstileToken = "";
  const inviteInput = el("input", {
    id: "signup-invite-code",
    className: "input",
    type: "text",
    maxlength: "128",
    autocomplete: "off",
    placeholder: "베타 초대 코드를 입력하세요",
  });
  const errBox = el("p", { className: "composer-feedback", role: "alert", hidden: true });
  const submitBtn = el(
    "button",
    { type: "submit", className: "btn btn-primary btn-block", disabled: true },
    "내 공간 만들기",
  );

  function syncBtn() {
    submitBtn.disabled = !inviteInput.value.trim() || !turnstileToken;
  }
  inviteInput.addEventListener("input", syncBtn);

  const turnstile = createTurnstileControl((tok) => {
    turnstileToken = tok;
    syncBtn();
  });

  const form = el(
    "form",
    {
      className: "flow-card",
      onSubmit: async (e) => {
        e.preventDefault();
        if (!inviteInput.value.trim() || !turnstileToken) return;
        submitBtn.disabled = true;
        errBox.hidden = true;
        try {
          const res = await apiRequest("/api/spaces", {
            method: "POST",
            body: { invite: inviteInput.value.trim(), turnstile: turnstileToken },
          });
          setSpaceKey(res.key, false);
          state.pendingEnrollment = {
            key: res.key,
            recoveryCodes: Array.isArray(res.recovery_codes) ? res.recovery_codes : [],
            isRecovery: false,
          };
          state.landingStep = "save_key";
          renderLandingPage();
        } catch (err) {
          errBox.textContent = errorMessage(err);
          errBox.hidden = false;
          turnstile.reset();
        }
      },
    },
    el(
      "div",
      { className: "action-row" },
      el(
        "button",
        {
          type: "button",
          className: "btn btn-ghost",
          onClick: () => {
            state.landingStep = "home";
            renderLandingPage();
          },
        },
        icon("arrowLeft", "icon-sm"),
        "첫 화면",
      ),
    ),
    el("h1", { text: "내 공간 만들기" }),
    el("p", {
      className: "field-hint",
      text: "초대 코드와 사람 확인을 거치면 나만의 공간 열쇠 링크와 복구 코드 10개가 발급됩니다.",
    }),
    el(
      "div",
      { className: "field" },
      el("label", { className: "field-label", for: "signup-invite-code", text: "초대 코드" }),
      inviteInput,
    ),
    turnstile.element,
    errBox,
    submitBtn,
  );

  return form;
}

function buildRecoverSpaceView() {
  // 1) 저장한 열쇠 링크로 바로 열기
  const pasteInput = el("input", {
    id: "paste-key-link",
    className: "input",
    type: "password",
    autocomplete: "off",
    placeholder: "저장해 둔 열쇠 링크(#k=ams_...) 또는 열쇠 붙여넣기",
  });
  const rememberCheck = el("input", { type: "checkbox", checked: isSpaceRemembered() });
  const pasteErr = el("p", { className: "composer-feedback", role: "alert", hidden: true });

  const openForm = el(
    "form",
    {
      className: "doc-list",
      onSubmit: (e) => {
        e.preventDefault();
        const parsed = parsePastedKeyInput(pasteInput.value);
        pasteInput.value = "";
        if (!parsed) {
          pasteErr.textContent = "올바른 공간 열쇠 링크(#k=ams_...) 또는 초대 링크를 입력해 주세요.";
          pasteErr.hidden = false;
          return;
        }
        if (parsed.type === "space") {
          setSpaceKey(parsed.key, rememberCheck.checked);
          navigateTo("/app");
          return;
        }
        if (parsed.type === "participant" && parsed.roomId) {
          setRoomKey(parsed.roomId, parsed.key, rememberCheck.checked);
          navigateTo(`/r/${encodeURIComponent(parsed.roomId)}/`);
          return;
        }
        pasteErr.textContent = "참가자 열쇠는 방 주소(/r/방번호/#k=...) 전체 링크로 입력해 주세요.";
        pasteErr.hidden = false;
      },
    },
    el("h2", { text: "열쇠 링크로 바로 열기" }),
    el(
      "div",
      { className: "field" },
      el("label", { className: "field-label", for: "paste-key-link", text: "내 열쇠 링크 또는 열쇠" }),
      pasteInput,
    ),
    el("label", { className: "check-row" }, rememberCheck, el("span", { text: "이 기기에 열쇠 기억하기 (선택)" })),
    pasteErr,
    el("button", { type: "submit", className: "btn btn-primary btn-block" }, "공간 열기"),
  );

  // 2) 복구 코드로 새 공간 키 받기
  let recoverTurnstile = "";
  const codeInput = el("input", {
    id: "recover-code-input",
    className: "input",
    type: "text",
    autocomplete: "off",
    placeholder: "복구 코드 1개 입력 (amr_...)",
  });
  const recErr = el("p", { className: "composer-feedback", role: "alert", hidden: true });
  const recBtn = el(
    "button",
    { type: "submit", className: "btn btn-block", disabled: true },
    "복구 코드로 새 열쇠 발급",
  );
  function syncRec() {
    recBtn.disabled = !codeInput.value.trim() || !recoverTurnstile;
  }
  codeInput.addEventListener("input", syncRec);

  const turnstile = createTurnstileControl((tok) => {
    recoverTurnstile = tok;
    syncRec();
  });

  const recoverForm = el(
    "form",
    {
      className: "doc-list",
      onSubmit: async (e) => {
        e.preventDefault();
        if (!codeInput.value.trim() || !recoverTurnstile) return;
        recBtn.disabled = true;
        recErr.hidden = true;
        try {
          const res = await apiRequest("/api/spaces/recover", {
            method: "POST",
            body: { code: codeInput.value.trim(), turnstile: recoverTurnstile },
          });
          codeInput.value = "";
          bumpSessionGen();
          setSpaceKey(res.key, false);
          state.pendingEnrollment = {
            key: res.key,
            recoveryCodes: [],
            isRecovery: true,
            activeParticipants: res.active_participants,
          };
          state.landingStep = "save_key";
          renderLandingPage();
        } catch (err) {
          recErr.textContent = errorMessage(err);
          recErr.hidden = false;
          turnstile.reset();
        }
      },
    },
    el("h2", { text: "열쇠를 잃어버렸나요? (복구 코드 사용)" }),
    el("p", {
      className: "field-hint",
      text: "보관해 둔 복구 코드 1개를 쓰면 새 공간 열쇠가 발급되고 이전 공간 열쇠는 즉시 무효가 됩니다.",
    }),
    el(
      "div",
      { className: "field" },
      el("label", { className: "field-label", for: "recover-code-input", text: "복구 코드" }),
      codeInput,
    ),
    turnstile.element,
    recErr,
    recBtn,
  );

  return el(
    "div",
    { className: "flow-card" },
    el(
      "div",
      { className: "action-row" },
      el(
        "button",
        {
          type: "button",
          className: "btn btn-ghost",
          onClick: () => {
            state.landingStep = "home";
            renderLandingPage();
          },
        },
        icon("arrowLeft", "icon-sm"),
        "첫 화면",
      ),
    ),
    openForm,
    el("hr", { className: "date-divider" }),
    recoverForm,
  );
}

/** 화면 2 후반: 열쇠 저장 화면 ('저장했어요' 체크 전에는 진행 불가) */
function buildSaveKeyView(enrollment) {
  const keyLink = `${window.location.origin}/app#k=${encodeURIComponent(enrollment.key)}`;
  const copyFeedback = el("p", { className: "field-hint", role: "status", "aria-live": "polite" });

  const rememberCheckbox = el("input", { type: "checkbox", checked: isSpaceRemembered() });
  rememberCheckbox.addEventListener("change", () => {
    setSpaceRemember(rememberCheckbox.checked);
  });

  const savedConfirmCheckbox = el("input", { type: "checkbox" });
  const proceedBtn = el(
    "button",
    {
      type: "button",
      className: "btn btn-primary btn-block",
      disabled: true,
      onClick: () => {
        if (!savedConfirmCheckbox.checked) return;
        navigateTo("/app");
      },
    },
    "내 공간으로 들어가기",
  );
  savedConfirmCheckbox.addEventListener("change", () => {
    proceedBtn.disabled = !savedConfirmCheckbox.checked;
  });

  const codesSection = enrollment.recoveryCodes.length
    ? el(
        "div",
        { className: "doc-list" },
        el("h2", { text: "복구 코드 10개 (1회만 표시)" }),
        el("p", {
          className: "field-hint",
          text: "열쇠 링크를 잃어버렸을 때 한 번씩 써서 새 열쇠를 받을 수 있습니다. 서버에는 해시만 남아 다시 보여 드릴 수 없습니다.",
        }),
        el(
          "ol",
          { className: "recovery-grid" },
          ...enrollment.recoveryCodes.map((c, idx) =>
            el(
              "li",
              { className: "recovery-item" },
              el("span", { className: "recovery-num", text: `${idx + 1}.` }),
              el("span", { text: c }),
            ),
          ),
        ),
        el(
          "div",
          { className: "action-row" },
          el(
            "button",
            {
              type: "button",
              className: "btn",
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(enrollment.recoveryCodes.join("\n"));
                  copyFeedback.textContent = "복구 코드 10개를 클립보드에 복사했습니다.";
                } catch {
                  copyFeedback.textContent = "자동 복사가 제한되었습니다. txt 저장을 이용해 주세요.";
                }
              },
            },
            icon("copy", "icon-sm"),
            "복구 코드 복사",
          ),
          el(
            "button",
            {
              type: "button",
              className: "btn",
              onClick: () => {
                const body = [
                  "아르센 우편함 복구 코드 (각 코드는 1회용, 타인 공유 금지)",
                  `발급 시각: ${new Date().toISOString()}`,
                  "",
                  ...enrollment.recoveryCodes.map((c, i) => `${String(i + 1).padStart(2, "0")}. ${c}`),
                  "",
                ].join("\n");
                downloadTextFile("arsen-mailbox-recovery-codes.txt", body);
                copyFeedback.textContent = "복구 코드 txt 파일을 저장했습니다.";
              },
            },
            icon("download", "icon-sm"),
            "txt 저장",
          ),
        ),
      )
    : null;

  const nativeInstallBtn = deferredInstallPrompt
    ? el(
        "button",
        {
          type: "button",
          className: "btn",
          onClick: async () => {
            if (!deferredInstallPrompt) return;
            deferredInstallPrompt.prompt();
            deferredInstallPrompt = null;
          },
        },
        "이 기기 홈 화면에 바로 설치",
      )
    : null;

  return el(
    "section",
    { className: "flow-card", "aria-labelledby": "save-key-heading" },
    el("h1", {
      id: "save-key-heading",
      text: enrollment.isRecovery ? "새 열쇠가 발급되었습니다" : "내 열쇠 링크와 복구 코드를 저장하세요",
    }),
    el(
      "div",
      { className: "banner banner-warn" },
      el("span", {
        text: "이 열쇠 링크가 곧 로그인 수단입니다. 서버는 열쇠 원문을 저장하지 않으므로 지금 복사해 안전한 메모장이나 비밀번호 관리자에 보관하세요.",
      }),
    ),
    el("div", { className: "key-box", text: keyLink }),
    enrollment.activeParticipants > 0
      ? el("p", { className: "banner banner-warn", text: `기존 참가자 열쇠 ${enrollment.activeParticipants}개는 계속 유효합니다. 접근 권한이 걱정된다면 방에서 해당 참가자를 끊어 주세요.` })
      : null,
    el(
      "div",
      { className: "action-row" },
      el(
        "button",
        {
          type: "button",
          className: "btn btn-primary",
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(keyLink);
              copyFeedback.textContent = "내 열쇠 링크를 복사했습니다.";
            } catch {
              copyFeedback.textContent = "자동 복사가 되지 않았습니다. 위 상자의 주소를 직접 선택해 복사하세요.";
            }
          },
        },
        icon("copy", "icon-sm"),
        "내 열쇠 링크 복사",
      ),
      nativeInstallBtn,
    ),
    copyFeedback,
    el(
      "label",
      { className: "check-row" },
      rememberCheckbox,
      el("span", { text: "이 기기 브라우저에 열쇠 기억하기 (공용 기기에서는 끄세요)" }),
    ),
    codesSection,
    el(
      "div",
      { className: "doc-list" },
      el("h3", { text: "홈 화면 추가 안내" }),
      el(
        "div",
        { className: "pwa-guide-grid" },
        el(
          "div",
          { className: "pwa-guide-card" },
          el("strong", { text: "iOS (Safari)" }),
          buildPwaIllustration("ios"),
          el("span", { className: "field-hint", text: "공유 버튼(□↑) → 홈 화면에 추가" }),
        ),
        el(
          "div",
          { className: "pwa-guide-card" },
          el("strong", { text: "Android (Chrome)" }),
          buildPwaIllustration("android"),
          el("span", { className: "field-hint", text: "우측 상단 메뉴(⋮) → 홈 화면에 추가" }),
        ),
      ),
    ),
    el(
      "label",
      { className: "check-row" },
      savedConfirmCheckbox,
      el("strong", { text: "열쇠 링크와 복구 코드를 안전한 곳에 저장했어요" }),
    ),
    proceedBtn,
  );
}

/* =========================================================================
   화면 3 · 4 · 5 · 7 · 8: 공간 주인 앱 (/app)
   ========================================================================= */
function currentRoom() {
  return state.rooms.find((r) => r.room_id === state.currentRoomId) || null;
}

function currentParticipants() {
  const room = state.route === "guest" ? state.guestRoomId : state.currentRoomId;
  return state.participantsByRoom.get(room) || [];
}

function clearAvatarUrls() {
  for (const avatar of state.avatarUrls.values()) URL.revokeObjectURL(avatar);
  state.avatarUrls.clear();
  state.avatarPending.clear();
}

function storeRoster(roomId, members) {
  state.participantsByRoom.set(roomId, members);
  const live = new Set([...state.participantsByRoom.values()].flatMap((rows) => rows.map((p) => p.avatar_rev)));
  for (const [rev, src] of state.avatarUrls) {
    if (!live.has(rev)) {
      URL.revokeObjectURL(src);
      state.avatarUrls.delete(rev);
    }
  }
}

function profileWithAvatar(p) {
  return p ? { ...p, avatarUrl: state.avatarUrls.get(p.avatar_rev) } : null;
}

function loadRosterAvatars(roomId, members, spaceKey, participantKey = null) {
  const needed = [...new Set(members.map((p) => p.avatar_rev))].filter((rev) => rev && !state.avatarUrls.has(rev));
  const awaiting = needed.map((rev) => state.avatarPending.get(rev)).filter(Boolean);
  const revisions = needed.filter((rev) => !state.avatarPending.has(rev));
  if (!revisions.length) return Promise.all(awaiting);
  const gen = state.sessionGen;
  const view = state.roomGen;
  const request = apiRequest(`/api/rooms/${encodeURIComponent(roomId)}/avatars?versions=${revisions.join(",")}`, { spaceKey, participantKey })
    .then(({ avatars }) => {
      if (gen !== state.sessionGen || (participantKey && view !== state.roomGen)) return;
      const live = new Set([...state.participantsByRoom.values()].flatMap((rows) => rows.map((p) => p.avatar_rev)));
      for (const { revision, webp } of avatars) {
        if (!live.has(revision) || !revisions.includes(revision)) continue;
        const bytes = Uint8Array.from(atob(webp), (c) => c.charCodeAt(0));
        state.avatarUrls.set(revision, URL.createObjectURL(new Blob([bytes], { type: "image/webp" })));
      }
      syncDynamicConversationUI();
    }).catch((err) => {
      if (gen === state.sessionGen && (!participantKey || view === state.roomGen) && isAuthRefusal(err)) {
        handleDefinitiveAuthRefusal(err, Boolean(participantKey));
      }
    }).finally(() => {
      for (const rev of revisions) if (state.avatarPending.get(rev) === request) state.avatarPending.delete(rev);
    });
  revisions.forEach((rev) => state.avatarPending.set(rev, request));
  return Promise.all([...awaiting, request]);
}

async function loadSpaceBootstrap() {
  const spaceKey = getSpaceKey();
  if (!spaceKey) {
    renderApp();
    return;
  }
  const sGen = state.sessionGen;
  const routeGen = state.roomGen;
  const linkedRoom = /^\/app\/([\w-]+)\/?$/.exec(window.location.pathname)?.[1];
  try {
    const [meData, roomsData] = await Promise.all([
      apiRequest("/api/me", { spaceKey }),
      apiRequest("/api/rooms", { spaceKey }),
    ]);
    if (sGen !== state.sessionGen || routeGen !== state.roomGen) return;
    state.meInfo = meData;
    if (Object.hasOwn(meData, "retention_days")) {
      state.retentionDays = meData.retention_days;
      state.retentionRevision = meData.retention_revision;
    }
    state.rooms = Array.isArray(roomsData.rooms) ? roomsData.rooms : [];
    state.statusBanner = null;

    if (linkedRoom) {
      const accessible = state.rooms.some((r) => r.room_id === linkedRoom);
      state.currentRoomId = accessible ? linkedRoom : "";
      state.mobilePane = "chat";
      if (!accessible) state.statusBanner = { kind: "warn", text: "이 방에 접근할 수 없습니다." };
    } else if (!currentRoom() && state.rooms.length > 0) {
      state.currentRoomId = state.rooms[0].room_id;
    }

    for (const r of state.rooms) {
      if (!state.participantsByRoom.has(r.room_id) && Array.isArray(r.participants)) storeRoster(r.room_id, r.participants);
      loadRosterAvatars(r.room_id, (state.participantsByRoom.get(r.room_id) ?? []).slice(0, 5), spaceKey);
    }
    renderApp();
    if (state.currentRoomId) {
      await pollCurrentRoom(true);
    }
  } catch (err) {
    if (sGen !== state.sessionGen || routeGen !== state.roomGen) return;
    if (isAuthRefusal(err)) {
      handleDefinitiveAuthRefusal(err, false);
      return;
    }
    state.statusBanner = { kind: "warn", text: errorMessage(err) };
    renderApp();
  }
}

function resetRoomView(roomId) {
  bumpRoomGen();
  resetImages();
  stopTimers();
  state.currentRoomId = roomId;
  state.messages = [];
  state.questions.clear();
  state.notificationsArmed = false;
  resetHistory();
  state.guestMeta = { roomName: "", meName: "", meId: "" };
  state.memberFilter = "all";
  state.expandedMsgIds.clear();
  state.replyTo = null;
  state.settingsOpen = false;
}

async function selectRoom(roomId, switchMobileToChat = true) {
  if (!state.rooms.some((r) => r.room_id === roomId)) return;
  resetRoomView(roomId);
  window.history.replaceState(null, "", `/app/${encodeURIComponent(roomId)}/`);
  if (switchMobileToChat) state.mobilePane = "chat";
  state.statusBanner = null;
  renderApp();
  await pollCurrentRoom(true);
}

async function pollCurrentRoom(initial = false, refreshOverview = false) {
  stopTimers();
  const isGuest = state.route === "guest";
  const roomId = isGuest ? state.guestRoomId : state.currentRoomId;
  const spaceKey = isGuest ? null : getSpaceKey();
  const participantKey = isGuest ? getRoomKey(roomId) : null;

  if (!roomId || (!spaceKey && !participantKey)) return;
  if (document.hidden || state.settingsOpen) return;

  const sGen = state.sessionGen;
  const rGen = state.roomGen;
  const opening = initial || !state.historyOpened;
  let retryAfter = 0;

  try {
    const query = opening ? "latest=1" : `since=${state.lastMessageId}`;
    const msgPromise = apiRequest(
      `/api/rooms/${encodeURIComponent(roomId)}/messages?${query}`,
      { spaceKey, participantKey },
    );
    const idle = Date.now() - state.lastInputAt >= IDLE_THRESHOLD_MS;
    const overviewInterval = idle ? POLL_OVERVIEW_IDLE_MS : POLL_OVERVIEW_ACTIVE_MS;
    const loadOverview = opening || refreshOverview || Date.now() - state.lastOverviewAt >= overviewInterval;
    const extraPromises = loadOverview
      ? [
          apiRequest(`/api/rooms/${encodeURIComponent(roomId)}/participants`, { spaceKey, participantKey })
            .catch((err) => { if (!isGuest) throw err; return null; }),
          ...(!isGuest ? [apiRequest("/api/rooms", { spaceKey })] : []),
        ]
      : [];

    const [msgData, partData, roomsData] = await Promise.all([msgPromise, ...extraPromises]);
    // 보안 수칙 2: 거절·키 교체·방 변경 전에 시작된 늦은 응답은 즉시 폐기
    if (sGen !== state.sessionGen || rGen !== state.roomGen) return;
    state.imageUploads = msgData.image_uploads === true;
    state.imageMaxBytes = msgData.image_max_bytes;
    state.imageMaxEdge = msgData.image_max_edge;
    if (Number.isSafeInteger(msgData.room?.image_revision)) {
      const changed = state.imageRevision !== null && state.imageRevision !== msgData.room.image_revision;
      state.imageRevision = msgData.room.image_revision;
      if (changed) {
        imageViewer.clear();
        if (!initial) return pollCurrentRoom(true);
      }
    }
    if (Object.hasOwn(msgData, "retention_days") &&
        (msgData.retention_days !== state.retentionDays || msgData.retention_revision !== state.retentionRevision)) {
      state.retentionDays = msgData.retention_days;
      state.retentionRevision = msgData.retention_revision;
      pruneExpiredMessagesNow();
      if (!opening) return pollCurrentRoom(true);
    }

    if (isGuest) {
      state.guestMeta = {
        roomName: msgData?.room?.name || roomId,
        meName: msgData?.me?.name || "",
        meId: msgData?.me?.id || "",
      };
    }
    if (loadOverview) {
      state.lastOverviewAt = Date.now();
      if (Array.isArray(partData?.participants)) {
        storeRoster(roomId, partData.participants);
        loadRosterAvatars(roomId, partData.participants, spaceKey, participantKey);
      }
      if (Array.isArray(roomsData?.rooms)) {
        state.rooms = roomsData.rooms;
      }
    }

    const incoming = Array.isArray(msgData?.messages) ? msgData.messages : [];
    let newMessages = [];
    if (opening) {
      resetHistory();
      state.historyOpened = true;
      state.historyBefore = Number.isSafeInteger(msgData.previous) && msgData.previous > 0 ? msgData.previous : null;
      state.questions.clear();
      state.messages = filterFreshMessages(incoming, nowSeconds(), state.retentionDays);
      state.lastMessageId = state.messages.reduce((mx, m) => Math.max(mx, Number(m.id) || 0), 0);
    } else {
      const existingIds = new Set(state.messages.map((m) => m.id));
      for (const m of incoming) {
        if (Number.isFinite(m.id) && !existingIds.has(m.id)) {
          state.messages.push(m);
          newMessages.push(m);
          existingIds.add(m.id);
          if (m.id > state.lastMessageId) state.lastMessageId = m.id;
        }
      }
      pruneExpiredMessagesNow();
    }
    if (Number.isSafeInteger(msgData.next) && msgData.next > state.lastMessageId) state.lastMessageId = msgData.next;
    mergeQuestionStates(msgData.questions);
    if (state.retentionDays !== null) {
      const cutoff = nowSeconds() - state.retentionDays * 86400;
      for (const [id, rows] of state.questions) {
        if (rows.values().next().value.asked_at <= cutoff) state.questions.delete(id);
      }
    }
    if (!opening && state.notificationsArmed) {
      const tracked = new Set(state.questions.keys());
      for (const rows of state.questions.values()) {
        for (const target of rows.values()) if (target.reply_id !== null) tracked.add(target.reply_id);
      }
      const accepted = new Set((msgData.questions ?? []).map((q) => q.reply_id));
      const replies = newMessages.filter((m) => m.sender_kind === "assistant" && !m.relayed_for && m.reply_to &&
        (!tracked.has(m.reply_to) || accepted.has(m.id)));
      if (replies.length) notifyAssistantReply(roomId, replies.at(-1).id);
    }
    if (newMessages.length) state.lastInputAt = Date.now();
    if (!msgData.more) state.notificationsArmed = true;

    state.offline = false;
    state.statusBanner = null;
    syncDynamicConversationUI();
  } catch (err) {
    if (sGen !== state.sessionGen || rGen !== state.roomGen) return;

    // 보안 수칙 1: HTTP 401/403은 본문 형식과 무관하게 즉시 확정 거절·전체 파기
    if (isAuthRefusal(err)) {
      handleDefinitiveAuthRefusal(err, isGuest);
      return;
    }
    if (err?.code === "not_found") {
      wipeCurrentRoomCache(err);
      renderApp();
      return;
    }

    // 보안 수칙 3: 폴링이 실패해도 30일 지난 글은 즉시 비운다
    pruneExpiredMessagesNow();
    state.offline = err?.code === "offline";
    if (["rate_limited", "space_day_quota", "service_day_quota"].includes(err?.code)) retryAfter = err.retryAfter || 0;
    state.statusBanner = {
      kind: err?.code === "offline" ? "warn" : "danger",
      text: errorMessage(err),
    };
    syncDynamicConversationUI();
  }

  if (sGen === state.sessionGen && rGen === state.roomGen && !document.hidden) {
    scheduleNextPoll(retryAfter * 1000);
  }
}

function mergeQuestionStates(questions, keepKnown = false) {
  for (const q of questions ?? []) {
    const participants = state.questions.get(q.question_id) ?? new Map();
    if (!keepKnown || !participants.has(q.participant_id)) participants.set(q.participant_id, q);
    state.questions.set(q.question_id, participants);
  }
}

async function loadOlderMessages() {
  const before = state.historyBefore;
  if (before === null || state.historyRequest || state.settingsOpen || document.hidden) return;
  const isGuest = state.route === "guest";
  const roomId = isGuest ? state.guestRoomId : state.currentRoomId;
  const spaceKey = isGuest ? null : getSpaceKey();
  const participantKey = isGuest ? getRoomKey(roomId) : null;
  if (!roomId || (!spaceKey && !participantKey)) return;
  const request = {};
  state.historyRequest = request;
  state.historyError = "";
  const redraw = (prepend = false) => {
    const box = document.getElementById("messages-scroll-box");
    if (box) renderMessagesTimeline(box, prepend);
  };
  redraw();
  let prepended = false;
  try {
    const data = await apiRequest(`/api/rooms/${encodeURIComponent(roomId)}/messages?before=${before}`, { spaceKey, participantKey });
    if (state.historyRequest !== request) return;
    if (data.retention_revision !== undefined && data.retention_revision !== state.retentionRevision) {
      resetHistory();
      return pollCurrentRoom(true);
    }
    const cursor = data.previous ?? null;
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1 || cursor >= before)) throw new Error("invalid history cursor");
    const known = new Set(state.messages.map((m) => m.id));
    const older = (data.messages ?? []).filter((m) => m.id < before && !known.has(m.id));
    state.messages = filterFreshMessages([...older, ...state.messages], nowSeconds(), state.retentionDays);
    state.historyBefore = cursor;
    mergeQuestionStates(data.questions, true);
    prepended = older.length > 0;
  } catch (err) {
    if (state.historyRequest !== request) return;
    if (isAuthRefusal(err)) return handleDefinitiveAuthRefusal(err, isGuest);
    if (err?.code === "not_found") {
      wipeCurrentRoomCache(err);
      return renderApp();
    }
    state.historyError = errorMessage(err);
  } finally {
    if (state.historyRequest === request) {
      state.historyRequest = null;
      redraw(prepended);
    }
  }
}

function observeHistoryScroll(box) {
  let top = box.scrollTop;
  box.addEventListener("scroll", () => {
    const current = box.scrollTop;
    const reachedTop = current <= 48 && current < top;
    top = current;
    if (reachedTop && !state.historyError) void loadOlderMessages();
  }, { passive: true });
}

/** 보이는 동안 입력이나 새 글 후 5초, 30초 동안 조용하면 60초, 숨으면 멈춤. */
function scheduleNextPoll(minDelay = 0) {
  stopTimers();
  if (document.hidden || state.settingsOpen || state.offline) return;
  const idleMs = Date.now() - state.lastInputAt;
  const delay = idleMs >= IDLE_THRESHOLD_MS ? POLL_IDLE_MS : POLL_ACTIVE_MS;
  state.pollTimer = window.setTimeout(() => {
    state.pollTimer = null;
    pollCurrentRoom(false);
  }, Math.max(delay, minDelay));
}

// 입력 활동·가시성·온오프라인·30일 주기 청소 이벤트
for (const ev of ["keydown", "pointerdown", "input"]) {
  window.addEventListener(
    ev,
    () => {
      const wasIdle = Date.now() - state.lastInputAt >= IDLE_THRESHOLD_MS;
      state.lastInputAt = Date.now();
      if (wasIdle && (state.route === "app" || state.route === "guest") && !document.hidden) {
        scheduleNextPoll();
      }
    },
    { passive: true },
  );
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopTimers();
    return;
  }
  // 보안 수칙 3: 화면에 다시 돌아왔을 때 네트워크 응답 전이라도 30일 지난 글을 즉시 지운다
  if (pruneExpiredMessagesNow()) {
    syncDynamicConversationUI();
  }
  refreshLiveCheckNodes(document);
  if (state.route === "app" || state.route === "guest") {
    pollCurrentRoom(false);
  }
});

window.addEventListener("focus", () => {
  if (pruneExpiredMessagesNow()) {
    syncDynamicConversationUI();
  }
  refreshLiveCheckNodes(document);
});

window.addEventListener("online", () => {
  state.offline = false;
  state.statusBanner = null;
  if (state.route === "app" || state.route === "guest") {
    pollCurrentRoom(false);
  }
});

window.addEventListener("offline", () => {
  state.offline = true;
  stopTimers();
  pruneExpiredMessagesNow();
  state.statusBanner = { kind: "warn", text: errorMessage({ code: "offline" }) };
  syncDynamicConversationUI();
});

state.expirySweepTimer = window.setInterval(() => {
  if (!document.hidden && pruneExpiredMessagesNow()) {
    syncDynamicConversationUI();
  }
}, 60000);

// 네트워크 재조회 없이 참가자 최근 확인·다음 예정 경과 분만 클라이언트에서 15초마다 생생히 갱신
window.setInterval(() => {
  if (!document.hidden) {
    refreshLiveCheckNodes(document);
  }
}, 15000);

/* =========================================================================
   대화 목록·방 카드·참가자 패널 부분 갱신 (입력 포커스 보존)
   ========================================================================= */
function syncDynamicConversationUI() {
  const msgContainer = document.getElementById("messages-scroll-box");
  const statusContainer = document.getElementById("chat-status-slot");
  const roomsContainer = document.getElementById("rooms-list-box");
  const membersContainer = document.getElementById("desktop-members-box");
  const guestHeading = document.getElementById("guest-room-heading");
  const guestIdentity = document.getElementById("guest-room-identity");

  if (statusContainer) renderStatusSlot(statusContainer);
  if (msgContainer) renderMessagesTimeline(msgContainer);
  if (roomsContainer) renderRoomListItems(roomsContainer);
  if (membersContainer) renderDesktopMembersList(membersContainer);
  const relayButton = document.getElementById("manual-relay-action");
  composerPicker?.refresh();
  if (relayButton) relayButton.hidden = !currentParticipants().some((p) => canRelayFor(p) || canRelayImageFor(p));
  if (guestHeading) guestHeading.textContent = state.guestMeta.roomName || "초대받은 방";
  if (guestIdentity) {
    guestIdentity.hidden = !state.guestMeta.meName;
    guestIdentity.textContent = state.guestMeta.meName ? `참가자: ${state.guestMeta.meName}` : "";
  }
}

function renderStatusSlot(slot) {
  clearNode(slot);
  if (!state.statusBanner) return;
  const cls =
    state.statusBanner.kind === "danger"
      ? "banner banner-danger"
      : state.statusBanner.kind === "accent"
        ? "banner banner-accent"
        : "banner banner-warn";
  slot.appendChild(
    el(
      "div",
      { className: cls, role: "status", "aria-live": "polite" },
      el("span", { text: state.statusBanner.text }),
      el(
        "button",
        {
          type: "button",
          className: "btn",
          onClick: () => pollCurrentRoom(false),
        },
        icon("refresh", "icon-sm"),
        "다시 읽기",
      ),
    ),
  );
}

function renderRoomListItems(listBox) {
  clearNode(listBox);
  if (!state.rooms.length) {
    listBox.appendChild(
      el(
        "div",
        { className: "empty-state" },
        el("p", { text: "아직 만든 방이 없어요. 첫 방(예: 내 비서들)을 만들어 보세요." }),
        el(
          "button",
          {
            type: "button",
            className: "btn btn-primary",
            onClick: (e) => triggerRoomCreate(e.currentTarget),
          },
          icon("plus", "icon-sm"),
          "첫 방 만들기",
        ),
      ),
    );
    return;
  }

  for (const r of state.rooms) {
    const isCurrent = r.room_id === state.currentRoomId && !state.settingsOpen;
    const activeMembers = (state.participantsByRoom.get(r.room_id) || []).filter((p) => !p.revoked);
    const assistants = activeMembers.filter((p) => p.kind === "assistant");
    const invitedHumans = activeMembers.filter((p) => p.kind !== "assistant" && !p.is_owner);
    const nonOwners = [...assistants, ...invitedHumans];
    const avatarPool = nonOwners.length > 0 ? nonOwners : activeMembers;
    const shownAvatars = avatarPool.slice(0, 5);
    const extraCount = Math.max(0, avatarPool.length - 5);

    const avatarRow = el(
      "div",
      { className: "avatar-stack" },
      ...shownAvatars.map((p) => buildAvatar(p.name, kindMeta(p).id, "avatar-sm", profileWithAvatar(p))),
      extraCount > 0 ? el("span", { className: "avatar-more", text: `+${extraCount}` }) : null,
    );

    const unread = Number(r.unread_count) || 0;
    const card = el(
      "button",
      {
        type: "button",
        className: "room-card",
        "aria-current": isCurrent ? "true" : "false",
        onClick: () => selectRoom(r.room_id, true),
      },
      el(
        "div",
        { className: "room-card-top" },
        el("span", { className: "room-card-name", text: r.name }),
        el(
          "span",
          { className: "room-card-meta" },
          r.last_message_at
            ? el("span", { className: "room-card-time", text: formatTime(r.last_message_at) })
            : null,
          unread > 0 || r.unread_partial ? el("span", {
            className: "unread-badge",
            text: unread >= 100 ? "99+" : r.unread_partial ? "…" : String(unread),
            "aria-label": unread >= 100 ? "읽지 않은 글 100개 이상" : r.unread_partial
              ? (unread ? `읽지 않은 글 최소 ${unread}개` : "읽지 않은 글 확인이 필요합니다")
              : `읽지 않은 글 ${unread}개`,
          }) : null,
        ),
      ),
      el("span", {
        className: "room-card-preview",
        text: r.last_message_image
          ? ("(이미지) " + (r.last_message ?? "")).trimEnd().replace(/\s+/g, " ")
          : r.last_message ? String(r.last_message).replace(/\s+/g, " ") : r.preview_partial ? "방에서 대화를 확인하세요" : "아직 대화가 없어요",
      }),
      avatarRow,
    );
    listBox.appendChild(card);
  }
}

function renderMessagesTimeline(scrollBox, prepended = false) {
  imageViewer.resetViewport();
  const oldTop = scrollBox.scrollTop;
  const oldHeight = scrollBox.scrollHeight;
  const wasNearBottom = oldHeight - oldTop - scrollBox.clientHeight < 64;
  const restoreHistoryFocus = scrollBox.contains(document.activeElement) && document.activeElement?.dataset.historyMore === "true";
  clearNode(scrollBox);

  const isGuest = state.route === "guest";
  const room = isGuest ? { room_id: state.guestRoomId, name: state.guestMeta.roomName } : currentRoom();

  if (!room) {
    scrollBox.appendChild(
      el(
        "div",
        { className: "empty-state" },
        el("p", { text: "왼쪽에서 방을 고르거나 새 방을 만들어 대화를 시작하세요." }),
      ),
    );
    return;
  }

  let historyButton;
  if (state.historyBefore !== null) {
    historyButton = el("button", {
      type: "button",
      className: "btn btn-sm",
      "data-history-more": "true",
      "aria-disabled": String(Boolean(state.historyRequest)),
      text: state.historyRequest ? "이전 글 불러오는 중…" : "이전 글 더 보기",
      onClick: () => void loadOlderMessages(),
    });
    scrollBox.appendChild(el("div", { className: "action-row" }, historyButton,
      state.historyError ? el("p", { className: "field-hint", role: "status", text: state.historyError }) : null));
  }
  if (restoreHistoryFocus) (historyButton ?? scrollBox).focus({ preventScroll: true });

  // 렌더링 직전에도 항상 30일 만료 필터 강제 적용
  const fresh = filterFreshMessages(state.messages, nowSeconds(), state.retentionDays);
  if (!fresh.length) {
    scrollBox.appendChild(
      el(
        "div",
        { className: "empty-state" },
        el("p", { text: "아직 글이 없어요. 참가자를 넣고 첫 글을 써 보세요" }),
        !isGuest
          ? el(
              "button",
              {
                type: "button",
                className: "btn btn-primary",
                onClick: (e) => triggerAddParticipant(e.currentTarget),
              },
              icon("plus", "icon-sm"),
              "참가자 넣기",
            )
          : null,
      ),
    );
    return;
  }

  const generation = state.sessionGen;
  const view = state.roomGen;
  const isCurrent = () => generation === state.sessionGen && view === state.roomGen;
  const auth = isGuest ? { participantKey: getRoomKey(room.room_id) } : { spaceKey: getSpaceKey() };
  const members = currentParticipants();
  const ownerSeat = members.find((p) => p.is_owner);
  let prevDateKey = "";

  for (const m of fresh) {
    const dk = dateKeyOf(m.created_at);
    if (dk && dk !== prevDateKey) {
      prevDateKey = dk;
      scrollBox.appendChild(
        el("div", { className: "date-divider", text: formatDateLabel(m.created_at) }),
      );
    }

    // 서버가 붙인 대신 올림 표시만 신뢰 (본문 텍스트 접두사로 위조 불가)
    const serverRelayed = Boolean(m.relay_label);

    const isMine = !serverRelayed && (
      isGuest
        ? (state.guestMeta.meId && m.participant_id === state.guestMeta.meId) ||
          (!m.participant_id && state.guestMeta.meName && m.sender === state.guestMeta.meName)
        : ownerSeat && m.participant_id === ownerSeat.participant_id
    );

    const matchedMember = members.find((p) => p.participant_id === (m.relayed_for || m.participant_id));
    const displaySender = matchedMember?.name ?? m.sender;
    const kMeta = kindMeta(
      matchedMember || {
        kind: m.sender_kind || "other",
        ai_type: m.ai_type || (m.sender_kind === "human" ? "human" : "other"),
      },
    );

    const bodyNode = buildSafeMessageNodes(m.text);
    const longMsg = isLongMessage(m.text);
    const expanded = state.expandedMsgIds.has(m.id);
    if (longMsg && !expanded) {
      bodyNode.classList.add("is-clamped");
    }

    let moreBtn = null;
    if (longMsg) {
      moreBtn = el(
        "button",
        {
          type: "button",
          className: "mini-action-btn",
          "aria-expanded": String(expanded),
          onClick: () => {
            if (state.expandedMsgIds.has(m.id)) state.expandedMsgIds.delete(m.id);
            else state.expandedMsgIds.add(m.id);
            renderMessagesTimeline(scrollBox);
          },
        },
        expanded ? "접기" : "더 보기",
      );
    }

    const replyBtn = el(
      "button",
      {
        type: "button",
        className: "mini-action-btn",
        onClick: () => {
          state.replyTo = { id: m.id, sender: m.sender };
          syncReplyBar();
          document.getElementById("composer-textarea")?.focus();
        },
      },
      "답장",
    );

    const bubble = el(
      "div",
      { className: "msg-bubble" },
      m.reply_to
        ? el("div", { className: "msg-reply-ref", text: `#${m.reply_to} 글에 답장` })
        : null,
      m.image ? imageViewer.render(m, {
        path: `/api/rooms/${encodeURIComponent(room.room_id)}/image/${m.id}`,
        auth,
        isCurrent,
        onError: (err) => { if (isCurrent() && isAuthRefusal(err)) handleDefinitiveAuthRefusal(err, isGuest); },
        onDelete: isGuest ? null : async () => {
          if (!isCurrent()) return;
          try {
            await apiRequest(`/api/rooms/${encodeURIComponent(room.room_id)}/image/${m.id}`, { ...auth, method: "DELETE" });
          } catch (err) {
            if (isCurrent() && isAuthRefusal(err)) handleDefinitiveAuthRefusal(err, false);
            throw err;
          }
          if (!isCurrent()) return;
          imageViewer.forget(m.id);
          delete m.image;
          renderMessagesTimeline(scrollBox);
          await pollCurrentRoom(true, true);
        },
      }) : null,
      m.text ? bodyNode : null,
      buildQuestionStatus(m, isGuest),
    );

    const metaRow = isMine
      ? el(
          "div",
          { className: "msg-meta" },
          el("span", { className: "workspace-author", text: displaySender }),
          el("span", { text: `내 글 · ${formatTime(m.created_at)}` }),
          participantNotes(matchedMember),
        )
      : el(
          "div",
          { className: "msg-meta" },
          el("span", {
            className: "sender-name",
            dataset: { kind: kMeta.id },
            text: displaySender,
          }),
          el("span", { className: "chip", text: kMeta.label }),
          serverRelayed
            ? el("span", { className: "chip chip-relay", text: "사용자가 대신 올림" })
            : null,
          el("span", { text: formatTime(m.created_at) }),
          participantNotes(matchedMember),
        );

    const row = el(
      "article",
      { className: `msg-row${isMine ? " is-mine" : ""}` },
      buildAvatar(displaySender, kMeta.id, isMine ? "workspace-own-avatar" : "", profileWithAvatar(matchedMember)),
      el(
        "div",
        { className: "msg-col" },
        metaRow,
        bubble,
        el("div", { className: "msg-footer-actions" }, moreBtn, replyBtn),
      ),
    );

    scrollBox.appendChild(row);
  }

  if (prepended) scrollBox.scrollTop = oldTop + scrollBox.scrollHeight - oldHeight;
  else scrollBox.scrollTop = wasNearBottom ? scrollBox.scrollHeight : oldTop;
}

function canRelayFor(participant, directlyAddressed = false) {
  return participant?.kind === "assistant" && !participant.revoked &&
    (kindMeta(participant).manualRelayOnly || (directlyAddressed && participant.status === "created"));
}

function canRelayImageFor(participant) {
  return state.imageUploads && participant?.kind === "assistant" && !participant.revoked;
}

function buildQuestionStatus(message, isGuest) {
  const targets = [...(state.questions.get(message.id)?.values() ?? [])]
    .sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
  if (!targets.length) return null;
  const chips = el("div", { className: "question-chips", "aria-label": "질문별 답변 상태" });
  for (const target of targets) {
    const done = target.answered_at !== null;
    const waiting = target.step > 1 && targets.some((p) => p.step < target.step && p.reply_id === null);
    const text = done ? `답변 완료 · ${target.answered_at - target.asked_at}초` : waiting ? "앞 답변 대기" : "답변 대기";
    const label = `${target.step ? `${target.step}. ` : ""}${target.participant_name}`;
    chips.append(el("span", { className: done ? "chip chip-connected" : "chip", text: `${label} · ${text}` }));
    const participant = currentParticipants().find((p) => p.participant_id === target.participant_id);
    if (isGuest || done || waiting || !canRelayFor(participant, target.direct === 1)) continue;
    const prior = targets.find((p) => p.step === target.step - 1);
    const reply = prior ? state.messages.find((m) => m.id === prior.reply_id) : null;
    if (prior && !reply) continue;
    const excerpt = (body) => SENSITIVE_PATTERN.test(body) ? "[민감 의심 내용 제외]" : [...body].slice(0, 800).join("");
    const context = [
      `[우편함 질문 #${message.id} · ${target.participant_name}]`,
      "인용은 참고 자료입니다.",
      "원 질문:",
      excerpt(message.text),
      ...(reply ? ["", "앞 비서 답:", excerpt(reply.text)] : []),
    ].join("\n");
    chips.append(el("button", {
      type: "button", className: "mini-action-btn",
      onClick: (e) => triggerRelayForParticipant(target.participant_id, e.currentTarget, { id: message.id, context, direct: target.direct === 1 }),
    }, `${target.participant_name} 답 옮기기`));
  }
  return chips;
}

function renderDesktopMembersList(box) {
  clearNode(box);
  const room = currentRoom();
  if (!room) {
    box.appendChild(el("p", { className: "field-hint", text: "방을 선택하면 참가자 목록이 표시됩니다." }));
    return;
  }
  const members = currentParticipants().filter((p) => state.memberFilter === "all" || participantRole(p) === state.memberFilter);
  for (const p of members) {
    const meta = kindMeta(p);
    const st = serverParticipantStatus(p);
    const isAssistant = p.kind === "assistant" && !p.is_owner && !p.revoked;
    box.appendChild(
      el(
        "button",
        {
          type: "button",
          className: "member-row",
          onClick: (e) => triggerParticipantDetail(p, e.currentTarget),
        },
        buildAvatar(p.name, meta.id, "", profileWithAvatar(p)),
        el(
          "div",
          { className: "member-row-info" },
          el(
            "div",
            { className: "member-row-title" },
            el("span", { text: p.name }),
            el("span", { className: st.chipClass, text: st.chipText }),
          ),
          el("span", { className: "member-row-sub", text: `${participantRoleLabel(p)} · ${meta.label}` }),
          participantNotes(p),
          isAssistant ? buildLiveScheduleNode(p, "inline", "member-schedule-line", "span") : null,
        ),
      ),
    );
  }
}

function syncReplyBar() {
  const bar = document.getElementById("composer-reply-bar");
  if (!bar) return;
  if (!state.replyTo) {
    bar.hidden = true;
    clearNode(bar);
    return;
  }
  bar.hidden = false;
  bar.replaceChildren(
    el("span", { text: `#${state.replyTo.id} (${state.replyTo.sender})에게 답장 중` }),
    el(
      "button",
      {
        type: "button",
        className: "mini-action-btn",
        onClick: () => {
          state.replyTo = null;
          syncReplyBar();
        },
      },
      "취소",
    ),
  );
}

/* =========================================================================
   시트 열기 액션 핸들러 (/app)
   ========================================================================= */
function triggerRoomCreate(trigger) {
  openRoomCreateSheet(sheets, {
    trigger,
    onCreateRoom: async (name) => {
      const generation = state.sessionGen;
      const spaceKey = getSpaceKey();
      const res = await apiRequest("/api/rooms", {
        method: "POST",
        spaceKey,
        body: { name },
      });
      if (generation !== state.sessionGen) return;
      await loadSpaceBootstrap();
      if (generation === state.sessionGen && res?.room_id) {
        await selectRoom(res.room_id, true);
      }
    },
  });
}

async function triggerRelayForParticipant(initialParticipantId = null, trigger = null, question = null) {
  const room = currentRoom();
  if (!room) return;
  const session = state.sessionGen;
  const view = state.roomGen;
  if (
    initialParticipantId &&
    !currentParticipants().some((p) => p.participant_id === initialParticipantId)
  ) {
    await pollCurrentRoom(false, true);
  }
  if (session !== state.sessionGen || view !== state.roomGen) return;
  const eligible = currentParticipants().filter((p) =>
    (canRelayFor(p, question?.direct) || canRelayImageFor(p)) &&
    (initialParticipantId === null || p.participant_id === initialParticipantId));
  if (!eligible.length) return;
  openRelaySheet(sheets, {
    roomName: room.name,
    participants: eligible.map(profileWithAvatar),
    messages: state.messages,
    initialParticipantId,
    question: question ? {
      ...question,
      context: () => session === state.sessionGen && view === state.roomGen &&
        filterFreshMessages(state.messages, nowSeconds(), state.retentionDays).some((m) => m.id === question.id)
        ? question.context : null,
    } : null,
    retentionDays: state.retentionDays,
    trigger,
    onOpenAdd: (trig) => triggerAddParticipant(trig),
    imageUploads: state.imageUploads,
    imageMaxBytes: state.imageMaxBytes,
    imageMaxEdge: state.imageMaxEdge,
    requiresImage: (pid) => !eligible.some((p) => p.participant_id === pid && canRelayFor(p, question?.direct)),
    onPostRelayed: async ({ relayedFor, text, image }) => {
      if (session !== state.sessionGen || view !== state.roomGen) return;
      const spaceKey = getSpaceKey();
      if (image) await postImage(room.room_id, { spaceKey }, image, text, question?.id, relayedFor);
      else await apiRequest(`/api/rooms/${encodeURIComponent(room.room_id)}/messages`, {
        method: "POST",
        spaceKey,
        body: { text, relayed_for: relayedFor, ...(question ? { reply_to: question.id } : {}) },
      });
      if (session === state.sessionGen && view === state.roomGen) await pollCurrentRoom(false);
    },
  });
}

function triggerAddParticipant(trigger) {
  const room = currentRoom();
  if (!room) return;
  const generation = state.sessionGen;
  const view = state.roomGen;
  const spaceKey = getSpaceKey();
  const valid = () => generation === state.sessionGen && view === state.roomGen && spaceKey === getSpaceKey();
  openAddParticipantSheet(sheets, {
    roomName: room.name,
    trigger,
    participantsByRoom: state.participantsByRoom,
    messages: state.messages,
    assistantDefaults: state.meInfo?.assistant_defaults ?? {},
    onRememberDefault: async (payload) => {
      if (!valid()) throw new Error("room changed");
      const value = await apiRequest("/api/me/assistant-defaults", { method: "PATCH", spaceKey, body: payload });
      if (valid()) {
        state.meInfo ??= {};
        state.meInfo.assistant_defaults ??= {};
        state.meInfo.assistant_defaults[value.ai_type] = value;
      }
      return value;
    },
    onSubmitParticipant: async (payload) => {
      if (!valid()) throw new Error("room changed");
      return apiRequest(`/api/rooms/${encodeURIComponent(room.room_id)}/participants`, {
        method: "POST",
        spaceKey,
        body: payload,
      });
    },
    onOpenRelayFor: (createdPid) => {
      if (generation === state.sessionGen) {
        triggerRelayForParticipant(createdPid, trigger);
      }
    },
    onAfterChange: () => {
      if (generation === state.sessionGen) return pollCurrentRoom(false, true);
    },
  });
}

function triggerParticipantDetail(participant, trigger) {
  const room = currentRoom();
  if (!room) return;
  const generation = state.sessionGen;
  const view = state.roomGen;
  openParticipantDetailSheet(sheets, {
    participant: profileWithAvatar(participant),
    roomName: room.name,
    trigger,
    onUpdateParticipant: async (pid, patchBody) => {
      if (generation !== state.sessionGen || view !== state.roomGen) throw new Error("참가자 화면을 다시 열어 주세요.");
      const spaceKey = getSpaceKey();
      return apiRequest(
        `/api/rooms/${encodeURIComponent(room.room_id)}/participants/${encodeURIComponent(pid)}`,
        {
          method: "PATCH",
          spaceKey,
          body: patchBody,
        },
      );
    },
    onReissue: async (pid, delivery) => {
      bumpRoomGen();
      const spaceKey = getSpaceKey();
      return apiRequest(
        `/api/rooms/${encodeURIComponent(room.room_id)}/participants/${encodeURIComponent(pid)}/reissue`,
        {
          method: "POST",
          spaceKey,
          body: { delivery },
        },
      );
    },
    onRevoke: async (pid) => {
      bumpRoomGen();
      const spaceKey = getSpaceKey();
      return apiRequest(
        `/api/rooms/${encodeURIComponent(room.room_id)}/participants/${encodeURIComponent(pid)}/revoke`,
        {
          method: "POST",
          spaceKey,
          body: {},
        },
      );
    },
    onOpenRelayFor: (pid) => {
      if (generation === state.sessionGen) {
        triggerRelayForParticipant(pid, trigger);
      }
    },
    onAfterChange: () => {
      if (generation === state.sessionGen) return pollCurrentRoom(false, true);
    },
  });
}

async function exportCurrentRoom(format, roomId, isGuest, valid) {
  const args = isGuest ? { participantKey: getRoomKey(roomId) } : { spaceKey: getSpaceKey() };
  const chunks = [];
  let since = 0, until = null, policy = null;
  for (;;) {
    if (!valid()) throw new Error("room changed");
    const query = new URLSearchParams({ format, since });
    if (until !== null) {
      query.set("until", until);
      query.set("policy", policy);
    }
    const path = `/api/rooms/${encodeURIComponent(roomId)}/export?${query}`;
    let result;
    try {
      result = await apiRequest(path, args);
    } catch (err) {
      const retry = err.retryAfter || 60;
      if (err.status !== 429 || retry > 60) throw err;
      await new Promise((resolve) => setTimeout(resolve, retry * 1000));
      if (!valid()) throw new Error("room changed");
      result = await apiRequest(path, args);
    }
    if (!valid()) throw new Error("room changed");
    if (result.chunk) chunks.push(result.chunk);
    if (!result.more) break;
    if (result.next <= since) throw new Error("export cursor did not advance");
    since = result.next;
    until = result.until;
    policy = result.policy;
  }
  const mime = { md: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json" }[format];
  const parts = format === "json" ? ["[\n", ...chunks.flatMap((c, i) => i ? [",\n", c] : [c]), "\n]\n"] : chunks;
  downloadTextFile(`arsen-mailbox-${roomId}.${format}`, new Blob(parts, { type: mime + ";charset=utf-8" }));
}

async function openSpaceSettings(trigger) {
  const generation = state.sessionGen;
  const view = state.roomGen;
  const current = () => generation === state.sessionGen && view === state.roomGen &&
    state.route === "app";
  if (!current()) return;
  trigger.disabled = true;
  try {
    const overview = await apiRequest("/api/me", { spaceKey: getSpaceKey() });
    if (current()) state.meInfo = overview;
  } catch (err) {
    if (!current()) return;
    if (isAuthRefusal(err)) {
      handleDefinitiveAuthRefusal(err, false);
      return;
    }
    state.meInfo = null;
  } finally {
    trigger.disabled = false;
  }
  if (!current()) return;
  stopTimers();
  state.settingsOpen = true;
  state.mobilePane = "settings";
  renderApp();
}

function buildChatSettingsButton(isGuest, label = "채팅 설정") {
  return el("button", { type: "button", className: "icon-btn", "aria-label": label, title: label,
    onClick: (event) => {
      const trigger = event.currentTarget;
      const roomId = isGuest ? state.guestRoomId : state.currentRoomId;
      const session = state.sessionGen, view = state.roomGen;
      const valid = () => session === state.sessionGen && view === state.roomGen;
      const owner = isGuest ? null : currentParticipants().find((p) => p.is_owner);
      openChatSettings(sheets, {
        trigger,
        roomName: isGuest ? state.guestMeta.roomName : currentRoom()?.name,
        ownerName: owner?.name,
        // Polling can replace the opener while the same room's sheet is still active.
        onOpenSpaceSettings: isGuest ? null : () => {
          if (valid()) openSpaceSettings(trigger);
        },
        onRename: owner ? async (name) => {
          if (!valid()) throw new Error("room changed");
          await apiRequest(`/api/rooms/${encodeURIComponent(roomId)}/participants/${encodeURIComponent(owner.participant_id)}`,
            { method: "PATCH", spaceKey: getSpaceKey(), body: { name } });
          if (valid()) await pollCurrentRoom(false, true);
        } : null,
        onExport: roomId ? async (format) => {
          try { await exportCurrentRoom(format, roomId, isGuest, valid); }
          catch (err) {
            if (valid() && isAuthRefusal(err)) handleDefinitiveAuthRefusal(err, isGuest);
            throw err;
          }
        } : null,
      });
    },
  }, icon("settings"));
}

function buildComposer({ isGuest }) {
  const textarea = el("textarea", {
    id: "composer-textarea",
    className: "composer-input",
    rows: "1",
    maxlength: "2000",
    placeholder: "메시지 입력…",
    "aria-label": "메시지 입력",
    "aria-describedby": "composer-shortcut-hint",
  });

  const shortcutHint = el("p", {
    id: "composer-shortcut-hint",
    className: "composer-hint",
    text: "Enter 보내기 · Shift+Enter 줄바꿈 (모바일은 보내기 버튼)",
  });
  const feedback = el("p", { className: "composer-feedback", role: "alert", hidden: true });
  const sendBtn = el(
    "button",
    {
      type: "submit",
      className: "btn btn-primary",
      "aria-label": "보내기",
      disabled: true,
    },
    icon("send", "icon-sm"),
  );

  let sending = false, failed = false;
  const session = state.sessionGen;
  const roomView = state.roomGen;
  const imagePicker = createImagePicker(textarea, {
    available: () => state.imageUploads,
    maxBytes: () => state.imageMaxBytes,
    maxEdge: () => state.imageMaxEdge,
    active: () => session === state.sessionGen && roomView === state.roomGen && textarea.isConnected,
    getDraft: () => state.imageDraft,
    setDraft: (value) => { state.imageDraft = value; },
    changed: () => syncInputState(),
  });
  composerPicker = { refresh: () => { imagePicker.refresh(); syncSendButton(); } };
  function syncSendButton() {
    const hasImage = state.imageUploads && Boolean(state.imageDraft);
    sendBtn.disabled = sending || imagePicker.working || (!textarea.value.trim() && !hasImage) ||
      Boolean(validateMessageInput(textarea.value));
  }
  function syncInputState() {
    const val = textarea.value;
    textarea.rows = 1;
    if (val) {
      const newlineRows = val.split("\n").length;
      const wrapRows = Math.max(1, Math.round((textarea.scrollHeight - 20) / 23.25));
      textarea.rows = Math.min(6, Math.max(newlineRows, wrapRows));
    }
    const err = val.trim() ? validateMessageInput(val) : "";
    feedback.textContent = err;
    feedback.hidden = !err;
    syncSendButton();
  }

  textarea.addEventListener("input", syncInputState);
  textarea.addEventListener("keydown", (e) => {
    const submit = shouldSubmitMessage(e);
    if (submit) {
      e.preventDefault();
      if (!sendBtn.disabled) form.requestSubmit();
    }
  });

  const relayBtn = !isGuest
    ? el(
        "button",
        {
          type: "button",
          className: "btn",
          id: "manual-relay-action",
          hidden: !currentParticipants().some((p) => canRelayFor(p) || canRelayImageFor(p)),
          title: "답 옮기기 (AI 대신 올림)",
          "aria-label": "AI 답 옮기기",
          onClick: (e) => triggerRelayForParticipant(null, e.currentTarget),
        },
        icon("relay", "icon-sm"),
        el("span", { className: "desktop-only", text: "답 옮기기" }),
      )
    : null;

  const form = el(
    "form",
    {
      className: "composer-wrap",
      onSubmit: async (e) => {
        e.preventDefault();
        if (sending || imagePicker.working) return;
        const raw = textarea.value;
        const err = validateMessageInput(raw);
        const image = state.imageDraft?.blob;
        if (err || (!raw.trim() && !image)) return;
        if (image && !state.imageUploads) {
          feedback.textContent = errorMessage({ code: "image_disabled" });
          feedback.hidden = false;
          return;
        }

        const roomId = isGuest ? state.guestRoomId : state.currentRoomId;
        if (!roomId) return;
        const generation = state.sessionGen;
        const view = state.roomGen;
        sending = true;
        failed = false;
        sendBtn.disabled = true;
        imagePicker.lock(true);
        const auth = isGuest ? { participantKey: getRoomKey(roomId) } : { spaceKey: getSpaceKey() };
        if (image) {
          feedback.textContent = "올리는 중…";
          feedback.hidden = false;
        }
        try {
          if (image) await postImage(roomId, auth, image, raw.trim(), state.replyTo?.id);
          else await apiRequest(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
            method: "POST",
            ...auth,
            body: {
              text: raw.trim(),
              ...(state.replyTo ? { reply_to: state.replyTo.id } : {}),
            },
          });
          if (generation !== state.sessionGen || view !== state.roomGen) return;
          imagePicker.clear();
          textarea.value = "";
          textarea.rows = 1;
          state.replyTo = null;
          syncReplyBar();
          syncInputState();
          await pollCurrentRoom(false);
        } catch (ex) {
          if (generation !== state.sessionGen || view !== state.roomGen) return;
          failed = true;
          if (isAuthRefusal(ex)) {
            handleDefinitiveAuthRefusal(ex, isGuest);
            return;
          }
          feedback.textContent = errorMessage(ex);
          feedback.hidden = false;
        } finally {
          sending = false;
          if (generation === state.sessionGen && view === state.roomGen) {
            imagePicker.lock(false);
            syncSendButton();
            if (!failed) feedback.hidden = true;
          }
        }
      },
    },
    el("div", { id: "composer-reply-bar", className: "reply-bar", hidden: true }),
    imagePicker.bar,
    el("div", { className: "composer-row", role: "group", "aria-label": "메시지 작성" },
      ...imagePicker.buttons, relayBtn, textarea, sendBtn),
    shortcutHint,
    imagePicker.status,
    feedback,
  );

  syncSendButton();
  return form;
}

/** 화면 8: 설정 패널 */
function buildSpacePolicy(me, statusNote) {
  const rooms = el("input", { id: "space-room-limit", type: "number", className: "input", min: 1, max: 30, value: me?.room_limit ?? 5, required: true });
  const people = el("input", { id: "space-participant-limit", type: "number", className: "input", min: 1, max: 50, value: me?.participant_limit ?? 8, required: true });
  const retention = el("select", { id: "space-retention", className: "select" },
    ...[["permanent", "영구 (자동 만료 없음)"], ["90", "90일"], ["30", "30일"], ["7", "7일"]]
      .map(([value, text]) => el("option", { value, text })));
  const daysValue = (days) => days === null ? "permanent" : String(days ?? 30);
  retention.value = daysValue(me?.retention_days);
  const save = el("button", { type: "submit", className: "btn" }, "공간 정책 저장");
  return el("section", { className: "settings-card" },
    el("h2", { text: "공간 상한과 보관 기간" }),
    el("form", { className: "field", onSubmit: async (e) => {
      e.preventDefault();
      const before = state.meInfo?.retention_days;
      const after = retention.value === "permanent" ? null : Number(retention.value);
      const shorter = (after ?? Infinity) < (before === null ? Infinity : before ?? 30);
      if (shorter && !window.confirm("새 보관 기간보다 오래된 글은 즉시 조회와 내보내기에서 제외되고 정리 작업에서 삭제됩니다. 단축할까요?")) return;
      const session = state.sessionGen;
      save.disabled = true;
      try {
        const updated = await apiRequest("/api/me", { method: "PATCH", spaceKey: getSpaceKey(), body: {
          room_limit: rooms.valueAsNumber, participant_limit: people.valueAsNumber, retention_days: after,
          ...(shorter ? { confirm: "보관 기간 단축" } : {}),
        } });
        if (session !== state.sessionGen) return;
        state.meInfo = { ...state.meInfo, ...updated, limits: { ...state.meInfo?.limits,
          rooms: updated.room_limit, participants: updated.participant_limit, retention_days: updated.retention_days } };
        state.retentionDays = updated.retention_days;
        state.retentionRevision = updated.retention_revision;
        pruneExpiredMessagesNow();
        statusNote.textContent = "공간 정책을 저장했습니다.";
      } catch (err) {
        if (session !== state.sessionGen) return;
        if (isAuthRefusal(err)) handleDefinitiveAuthRefusal(err, false);
        else statusNote.textContent = errorMessage(err);
      } finally { save.disabled = false; }
    } },
      el("label", { for: "space-room-limit", text: "공간당 방 상한 (1–30)" }), rooms,
      el("label", { for: "space-participant-limit", text: "방당 인원 상한 (1–50)" }), people,
      el("p", { className: "field-hint", text: "방장과 폐기된 참가자 자리도 인원에 포함됩니다. 상한을 내려도 기존 방과 참가자는 유지됩니다." }),
      el("label", { for: "space-retention", text: "글 보관 기간" }), retention, save,
      statusNote,
    ));
}

function buildSettingsPane() {
  const me = state.meInfo;
  const limits = me?.limits || SPACE_LIMITS;
  const usage = me?.usage ?? {};
  const capacity = usage.service_capacity;
  const capacityLabels = { normal: "정상", read_only: "쓰기 제한", slow_reads: "빈 조회 간격 연장", closed: "오늘 마감" };

  const statusNote = el("p", { className: "field-hint", role: "status", "aria-live": "polite" });
  const onceResultSlot = el("div", { className: "doc-list" });

  const rememberToggle = el("input", { type: "checkbox", checked: isSpaceRemembered() });
  rememberToggle.addEventListener("change", () => {
    setSpaceRemember(rememberToggle.checked);
    statusNote.textContent = rememberToggle.checked
      ? "이 기기 브라우저에 공간 열쇠를 저장했습니다."
      : "이 기기의 저장된 열쇠를 비웠습니다(현재 탭을 닫으면 다시 링크로 열어야 합니다).";
  });

  // 공간 키 재발급 (보안 수칙 2: 세대 증가 후 열쇠 교체)
  const rotateBtn = makeTwoStepButton(
    "공간 키 재발급",
    "한 번 더 누르면 이전 공간 열쇠 즉시 무효화 및 재발급",
    "btn",
    async () => {
      bumpSessionGen();
      const generation = state.sessionGen;
      try {
        const res = await apiRequest("/api/me/rotate", {
          method: "POST",
          spaceKey: getSpaceKey(),
          body: {},
        });
        if (generation === state.sessionGen && res?.key) {
          setSpaceKey(res.key);
          const nextLink = `${window.location.origin}/app#k=${encodeURIComponent(res.key)}`;
          onceResultSlot.replaceChildren(
            el(
              "div",
              { className: "banner banner-warn" },
              el("span", { text: "새 공간 열쇠 링크입니다(1회 표시). 반드시 지금 복사해 보관하세요." }),
            ),
            el("div", { className: "key-box", text: nextLink }),
            el(
              "button",
              {
                type: "button",
                className: "btn btn-primary",
                onClick: async () => {
                  await navigator.clipboard.writeText(nextLink).catch(() => {});
                  statusNote.textContent = "새 공간 열쇠 링크를 복사했습니다.";
                },
              },
              icon("copy", "icon-sm"),
              "새 열쇠 링크 복사",
            ),
          );
        }
      } catch (err) {
        if (generation !== state.sessionGen) return;
        if (isAuthRefusal(err)) return handleDefinitiveAuthRefusal(err, false);
        statusNote.textContent = errorMessage(err);
      }
    },
  );

  // 복구 코드 다시 만들기
  const regenRecoveryBtn = makeTwoStepButton(
    "복구 코드 다시 만들기",
    "한 번 더 누르면 기존 복구 코드 무효화 및 10개 재발급",
    "btn",
    async () => {
      const generation = state.sessionGen;
      try {
        const res = await apiRequest("/api/me/recovery-codes", {
          method: "POST",
          spaceKey: getSpaceKey(),
          body: {},
        });
        if (generation !== state.sessionGen) return;
        const codes = Array.isArray(res?.recovery_codes) ? res.recovery_codes : [];
        if (codes.length) {
          onceResultSlot.replaceChildren(
            el("p", { className: "field-label", text: "새 복구 코드 10개 (1회 표시)" }),
            el(
              "ol",
              { className: "recovery-grid" },
              ...codes.map((c, i) =>
                el(
                  "li",
                  { className: "recovery-item" },
                  el("span", { className: "recovery-num", text: `${i + 1}.` }),
                  el("span", { text: c }),
                ),
              ),
            ),
            el(
              "div",
              { className: "action-row" },
              el(
                "button",
                {
                  type: "button",
                  className: "btn",
                  onClick: async () => {
                    await navigator.clipboard.writeText(codes.join("\n")).catch(() => {});
                    statusNote.textContent = "새 복구 코드를 복사했습니다.";
                  },
                },
                icon("copy", "icon-sm"),
                "복구 코드 복사",
              ),
              el(
                "button",
                {
                  type: "button",
                  className: "btn",
                  onClick: () =>
                    downloadTextFile("arsen-mailbox-recovery-codes.txt", codes.join("\n") + "\n"),
                },
                icon("download", "icon-sm"),
                "txt 저장",
              ),
            ),
          );
        }
      } catch (err) {
        if (generation !== state.sessionGen) return;
        if (isAuthRefusal(err)) return handleDefinitiveAuthRefusal(err, false);
        statusNote.textContent = errorMessage(err);
      }
    },
  );

  // 공간 삭제 확인 입력
  const deleteConfirmInput = el("input", {
    id: "space-delete-confirm",
    className: "input",
    type: "text",
    autocomplete: "off",
    placeholder: "삭제하려면 '삭제' 두 글자를 입력하세요",
  });
  const deleteBtn = el(
    "button",
    { type: "submit", className: "btn btn-danger", disabled: true },
    icon("trash", "icon-sm"),
    "공간 영구 삭제",
  );
  deleteConfirmInput.addEventListener("input", () => {
    deleteBtn.disabled = deleteConfirmInput.value.trim() !== "삭제";
  });

  const deleteForm = el(
    "form",
    {
      className: "doc-list",
      onSubmit: async (e) => {
        e.preventDefault();
        if (deleteConfirmInput.value.trim() !== "삭제") return;
        const generation = state.sessionGen;
        deleteBtn.disabled = true;
        try {
          await apiRequest("/api/me", {
            method: "DELETE",
            spaceKey: getSpaceKey(),
            body: { confirm: "삭제" },
          });
          if (generation === state.sessionGen) closeSpace();
        } catch (err) {
          if (generation !== state.sessionGen) return;
          statusNote.textContent = errorMessage(err);
          deleteBtn.disabled = false;
        }
      },
    },
    el(
      "div",
      { className: "field" },
      el("label", {
        className: "field-label",
        for: "space-delete-confirm",
        text: "공간 삭제 확인 ('삭제' 입력)",
      }),
      deleteConfirmInput,
      el("span", {
        className: "field-hint",
        text: "삭제하면 모든 방과 참가자 열쇠가 즉시 폐기되고 복구할 수 없습니다.",
      }),
    ),
    deleteBtn,
  );

  return el(
    "section",
    { className: "settings-pane", "aria-labelledby": "settings-heading" },
    el(
      "header",
      { className: "pane-topbar" },
      el(
        "div",
        { className: "chat-header-left" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn-ghost",
            onClick: () => {
              state.settingsOpen = false;
              state.mobilePane = state.currentRoomId ? "chat" : "rooms";
              renderApp();
              if (state.currentRoomId) pollCurrentRoom(false);
            },
          },
          icon("arrowLeft", "icon-sm"),
          "돌아가기",
        ),
        el("h1", { id: "settings-heading", className: "pane-title", text: "설정" }),
      ),
    ),
    el(
      "div",
      { className: "settings-scroll" },
      el(
        "section",
        { className: "settings-card" },
        el("h2", { text: "화면 테마" }),
        buildThemeSelector("테마 선택"),
      ),
      el(
        "section",
        { className: "settings-card" },
        el("h2", { text: "사용량과 한도" }),
        el(
          "div",
          { className: "usage-grid" },
          el(
            "div",
            { className: "usage-stat" },
            el("div", { className: "usage-stat-label", text: "만든 방" }),
            el("div", { className: "usage-stat-val", text: `${usage.rooms ?? state.rooms.length} / ${limits.rooms}` }),
          ),
          el(
            "div",
            { className: "usage-stat" },
            el("div", { className: "usage-stat-label", text: "오늘 보낸 글" }),
            el("div", { id: "settings-messages-today", className: "usage-stat-val", text: `${usage.messages_today ?? "—"} / ${limits.messages_per_day}` }),
          ),
          el(
            "div",
            { className: "usage-stat" },
            el("div", { className: "usage-stat-label", text: "방당 참가자 한도" }),
            el("div", { className: "usage-stat-val", text: `최대 ${limits.participants}명` }),
          ),
          el(
            "div",
            { className: "usage-stat" },
            el("div", { className: "usage-stat-label", text: "대화 보관" }),
            el("div", { className: "usage-stat-val", text: limits.retention_days === null ? "영구" : `${limits.retention_days}일` }),
          ),
          Number.isFinite(usage?.image_storage_bytes) ? el("div", { className: "usage-stat" },
            el("div", { className: "usage-stat-label", text: "이미지 저장량" }),
            el("div", { className: "usage-stat-val", text: `${formatImageBytes(usage.image_storage_bytes)} / ${formatImageBytes(limits.image_storage_bytes)}` }),
            el("div", { className: "usage-stat-label", text: `오늘 ${usage.images_today} / ${limits.images_per_day}장 · 한 장 ${formatImageBytes(limits.image_max_bytes)}까지` }),
          ) : null,
          capacity ? el("div", { className: "usage-stat" },
            el("div", { className: "usage-stat-label", text: "오늘 우편함 서비스 사용량 (추정)" }),
            el("div", { className: "usage-stat-val", text: `${capacity.percent}% · ${capacityLabels[capacity.stage] ?? "상태 확인 중"}` }),
          ) : null,
        ),
      ),
      buildSpacePolicy(me, el("p", { className: "field-hint", role: "status", "aria-live": "polite" })),
      el(
        "section",
        { className: "settings-card" },
        el("h2", { text: "열쇠와 복구 관리" }),
        el(
          "label",
          { className: "check-row" },
          rememberToggle,
          el("span", { text: "이 기기에 공간 열쇠 기억하기" }),
        ),
        el(
          "div",
          { className: "action-row" },
          rotateBtn,
          regenRecoveryBtn,
          el(
            "button",
            {
              type: "button",
              className: "btn",
              onClick: closeSpace,
            },
            "이 탭에서 열쇠 닫기",
          ),
        ),
        onceResultSlot,
        statusNote,
      ),
      el(
        "section",
        { className: "settings-card" },
        el("h2", { text: "홈 화면 추가 · 도움말 · 개인정보" }),
        el(
          "div",
          { className: "pwa-guide-grid" },
          el(
            "div",
            { className: "pwa-guide-card" },
            el("strong", { text: "iOS (Safari)" }),
            buildPwaIllustration("ios"),
          ),
          el(
            "div",
            { className: "pwa-guide-card" },
            el("strong", { text: "Android (Chrome)" }),
            buildPwaIllustration("android"),
          ),
        ),
        el(
          "div",
          { className: "action-row" },
          el("a", { className: "btn", href: "/help.html#guide", text: "도움말 보기" }),
          el("a", { className: "btn", href: "/help.html#privacy", text: "개인정보·이용 안내" }),
        ),
      ),
      el(
        "section",
        { className: "settings-card" },
        el("h2", { text: "공간 삭제" }),
        deleteForm,
      ),
    ),
  );
}

function renderOwnerApp() {
  clearNode(appRoot);
  const spaceKey = getSpaceKey();

  if (!spaceKey) {
    // 열쇠 없이 /app 에 접근한 경우 깔끔한 안내·복구 화면 제공
    const input = el("input", {
      id: "app-unlock-input",
      className: "input",
      type: "password",
      autocomplete: "off",
      placeholder: "내 열쇠 링크(#k=ams_...) 또는 공간 열쇠 입력",
    });
    const rememberBox = el("input", { type: "checkbox" });
    const errText = el("p", { className: "composer-feedback", role: "alert", hidden: !state.statusBanner });
    if (state.statusBanner) errText.textContent = state.statusBanner.text;

    appRoot.appendChild(
      el(
        "div",
        { className: "public-page" },
        el(
          "header",
          { className: "public-header" },
          el("a", { className: "brand-lockup", href: "/" }, el("span", { className: "brand-mark-box" }, icon("mail")), el("span", { text: BRAND_NAME })),
          buildThemeSelector("테마"),
        ),
        el(
          "main",
          { id: "main-focus", tabindex: "-1" },
          el(
            "form",
            {
              className: "flow-card",
              onSubmit: (e) => {
                e.preventDefault();
                const parsed = parsePastedKeyInput(input.value);
                input.value = "";
                if (!parsed || parsed.type !== "space") {
                  errText.textContent = "올바른 공간 열쇠 링크(#k=ams_...)를 붙여 넣어 주세요.";
                  errText.hidden = false;
                  return;
                }
                setSpaceKey(parsed.key, rememberBox.checked);
                state.statusBanner = null;
                loadSpaceBootstrap();
              },
            },
            el("h1", { text: "공간 열쇠가 필요해요" }),
            el("p", {
              className: "field-hint",
              text: "보안을 위해 열쇠는 주소창에 남지 않으며 기본값으로 기기에 저장되지 않습니다. 저장해 둔 내 열쇠 링크로 열거나 아래에 붙여 넣으세요.",
            }),
            errText,
            el(
              "div",
              { className: "field" },
              el("label", { className: "field-label", for: "app-unlock-input", text: "공간 열쇠 링크" }),
              input,
            ),
            el("label", { className: "check-row" }, rememberBox, el("span", { text: "이 기기에 열쇠 기억하기" })),
            el("button", { type: "submit", className: "btn btn-primary btn-block" }, "내 공간 열기"),
            el(
              "div",
              { className: "action-row" },
              el(
                "button",
                {
                  type: "button",
                  className: "btn",
                  onClick: () => {
                    state.landingStep = "create";
                    navigateTo("/");
                  },
                },
                "새 공간 만들기",
              ),
              el(
                "button",
                {
                  type: "button",
                  className: "btn",
                  onClick: () => {
                    state.landingStep = "recover";
                    navigateTo("/");
                  },
                },
                "복구 코드 사용",
              ),
            ),
          ),
        ),
      ),
    );
    return;
  }

  const shellClasses = ["app-shell"];
  if (state.rightPanelCollapsed) shellClasses.push("is-panel-collapsed");
  if (state.settingsOpen) shellClasses.push("is-settings-open");

  const shell = el("div", {
    className: shellClasses.join(" "),
    dataset: { mobilePane: state.settingsOpen ? "settings" : state.mobilePane },
  });

  // 1) 좌측 방 목록 (화면 4)
  const roomsListBox = el("div", { id: "rooms-list-box", className: "rooms-list" });
  renderRoomListItems(roomsListBox);

  const roomsPane = el(
    "aside",
    { className: "rooms-pane", "aria-label": "방 목록" },
    el(
      "div",
      { className: "pane-topbar" },
      el("span", { className: "pane-title", text: BRAND_NAME }),
      buildChatSettingsButton(false, "설정 열기"),
    ),
    el(
      "div",
      { className: "rooms-toolbar" },
      el(
        "button",
        {
          type: "button",
          className: "btn btn-primary btn-block",
          onClick: (e) => triggerRoomCreate(e.currentTarget),
        },
        icon("plus", "icon-sm"),
        "새 방",
      ),
    ),
    roomsListBox,
  );

  shell.appendChild(roomsPane);

  if (state.settingsOpen) {
    shell.appendChild(buildSettingsPane());
    appRoot.appendChild(shell);
    return;
  }

  // 2) 중앙 방 대화 (화면 5)
  const room = currentRoom();
  const statusSlot = el("div", { id: "chat-status-slot", className: "status-slot" });
  renderStatusSlot(statusSlot);

  const msgScrollBox = el("div", {
    id: "messages-scroll-box",
    className: "messages-scroll",
    role: "log",
    tabindex: "0",
    "aria-live": "polite",
    "aria-label": "방 대화 목록",
  });
  renderMessagesTimeline(msgScrollBox);
  observeHistoryScroll(msgScrollBox);

  const chatPane = el(
    "main",
    { id: "main-focus", tabindex: "-1", className: "chat-pane" },
    el(
      "header",
      { className: "pane-topbar" },
      el(
        "div",
        { className: "chat-header-left" },
        el(
          "button",
          {
            type: "button",
            className: "icon-btn mobile-only",
            "aria-label": "방 목록으로",
            onClick: () => {
              state.mobilePane = "rooms";
              renderApp();
            },
          },
          icon("arrowLeft"),
        ),
        el("h1", { className: "pane-title", text: room ? room.name : "방을 선택하세요" }),
        room
          ? el(
              "button",
              {
                type: "button",
                className: "icon-btn",
                "aria-label": "방 이름 변경 및 삭제",
                title: "방 설정",
                onClick: (e) =>
                  openRoomManageSheet(sheets, {
                    room,
                    trigger: e.currentTarget,
                    onRenameRoom: async (rid, nextName) => {
                      const generation = state.sessionGen;
                      await apiRequest(`/api/rooms/${encodeURIComponent(rid)}`, {
                        method: "PATCH",
                        spaceKey: getSpaceKey(),
                        body: { name: nextName },
                      });
                      if (generation === state.sessionGen) await loadSpaceBootstrap();
                    },
                    onDeleteRoom: async (rid) => {
                      const generation = state.sessionGen;
                      bumpRoomGen();
                      const result = await apiRequest(`/api/rooms/${encodeURIComponent(rid)}`, {
                        method: "DELETE",
                        spaceKey: getSpaceKey(),
                      });
                      if (generation !== state.sessionGen) return;
                      state.participantsByRoom.delete(rid);
                      resetRoomView("");
                      window.history.replaceState(null, "", "/app");
                      state.mobilePane = "rooms";
                      await loadSpaceBootstrap();
                      if (result.cleanup_pending && generation === state.sessionGen) {
                        state.statusBanner = { kind: "accent", text: "방을 닫았습니다. 기록과 이미지는 정기 작업에서 나누어 지웁니다." };
                        renderApp();
                      }
                    },
                  }),
              },
              icon("edit", "icon-sm"),
            )
          : null,
      ),
      room
        ? el(
            "div",
            { className: "chat-header-right" },
            buildChatSettingsButton(false),
            el(
              "button",
              {
                type: "button",
                className: "btn mobile-only",
                "aria-label": "참가자 시트 열기",
                onClick: async (e) => {
                  const trigger = e.currentTarget;
                  const generation = state.roomGen;
                  try {
                    const { participants } = await apiRequest(`/api/rooms/${encodeURIComponent(room.room_id)}/participants`, {
                      spaceKey: getSpaceKey(),
                    });
                    if (generation === state.roomGen && Array.isArray(participants)) {
                      storeRoster(room.room_id, participants);
                      await loadRosterAvatars(room.room_id, participants, getSpaceKey());
                    }
                  } catch (err) {
                    if (generation === state.roomGen && isAuthRefusal(err)) {
                      handleDefinitiveAuthRefusal(err, false);
                      return;
                    }
                  }
                  if (generation !== state.roomGen || !trigger.isConnected) return;
                  openMobileMembersSheet(sheets, {
                    roomName: room.name,
                    participants: currentParticipants().map(profileWithAvatar),
                    trigger,
                    onPickParticipant: (p, trig) => triggerParticipantDetail(p, trig),
                    onOpenAdd: (trig) => triggerAddParticipant(trig),
                  });
                },
              },
              icon("users", "icon-sm"),
              "참가자",
            ),
            el(
              "button",
              {
                type: "button",
                className: "icon-btn desktop-only",
                "aria-label": state.rightPanelCollapsed ? "참가자 패널 펼치기" : "참가자 패널 접기",
                title: state.rightPanelCollapsed ? "참가자 패널 펼치기" : "참가자 패널 접기",
                onClick: () => {
                  state.rightPanelCollapsed = !state.rightPanelCollapsed;
                  renderApp();
                },
              },
              icon("panel"),
            ),
          )
        : null,
    ),
    el("div", { className: "trust-strip" }, el("span", { text: TRUST_NOTICE_SHORT })),
    statusSlot,
    msgScrollBox,
    room ? buildComposer({ isGuest: false }) : null,
  );
  shell.appendChild(chatPane);

  // 3) 우측 참가자 패널 (데스크톱 320px, 접힘 가능)
  if (!state.rightPanelCollapsed) {
    const membersBox = el("div", { id: "desktop-members-box", className: "members-body" });
    renderDesktopMembersList(membersBox);

    const membersPane = el(
      "aside",
      { className: "members-pane desktop-only", "aria-label": "참가자 패널" },
      el(
        "div",
        { className: "pane-topbar members-topbar" },
        el("h2", { className: "pane-title", text: "참가자" }),
        room
          ? el(
              "button",
              {
                type: "button",
                className: "btn",
                onClick: (e) => triggerAddParticipant(e.currentTarget),
              },
              icon("plus", "icon-sm"),
              "참가자 넣기",
            )
          : null,
        el("select", { className: "select", "aria-label": "참가자 역할 필터",
          onChange: (e) => {
            state.memberFilter = e.target.value;
            renderDesktopMembersList(membersBox);
          },
        }, ...PARTICIPANT_FILTERS.map(([value, text]) => {
          const option = el("option", { value, text });
          option.selected = state.memberFilter === value;
          return option;
        })),
      ),
      membersBox,
    );
    shell.appendChild(membersPane);
  }

  appRoot.appendChild(shell);
  syncReplyBar();
}

/* =========================================================================
   화면 9: 초대받은 사람 화면 (/r/{room}/#k=)
   ========================================================================= */
function renderGuestRoomApp() {
  clearNode(appRoot);
  const roomId = state.guestRoomId;
  const pKey = getRoomKey(roomId);

  if (!pKey) {
    const input = el("input", {
      id: "guest-key-input",
      className: "input",
      type: "password",
      autocomplete: "off",
      placeholder: "초대 링크(#k=amk_...) 또는 참가자 열쇠 입력",
    });
    const rememberBox = el("input", { type: "checkbox" });
    const errLine = el("p", { className: "composer-feedback", role: "alert", hidden: !state.statusBanner });
    if (state.statusBanner) errLine.textContent = state.statusBanner.text;

    appRoot.appendChild(
      el(
        "div",
        { className: "public-page" },
        el(
          "header",
          { className: "public-header" },
          el("a", { className: "brand-lockup", href: "/" }, el("span", { className: "brand-mark-box" }, icon("mail")), el("span", { text: BRAND_NAME })),
          buildThemeSelector("테마"),
        ),
        el(
          "main",
          { id: "main-focus", tabindex: "-1" },
          el(
            "form",
            {
              className: "flow-card",
              onSubmit: (e) => {
                e.preventDefault();
                const parsed = parsePastedKeyInput(input.value);
                input.value = "";
                if (!parsed || parsed.type !== "participant") {
                  errLine.textContent = "초대받은 전체 링크(#k=amk_...)를 붙여 넣어 주세요.";
                  errLine.hidden = false;
                  return;
                }
                setRoomKey(roomId, parsed.key, rememberBox.checked);
                state.statusBanner = null;
                renderGuestRoomApp();
                pollCurrentRoom(true);
              },
            },
            el("h1", { text: "초대 열쇠 링크가 필요해요" }),
            el("p", {
              className: "field-hint",
              text: "초대받은 전체 링크를 다시 열거나 아래에 붙여 넣으면 이 방 대화가 열립니다.",
            }),
            errLine,
            el(
              "div",
              { className: "field" },
              el("label", { className: "field-label", for: "guest-key-input", text: "초대 링크" }),
              input,
            ),
            el("label", { className: "check-row" }, rememberBox, el("span", { text: "이 기기에 이 방 열쇠 기억하기" })),
            el("button", { type: "submit", className: "btn btn-primary btn-block" }, "방 들어가기"),
          ),
        ),
      ),
    );
    return;
  }

  // 접을 수 있는 상단 열쇠 주의 안내 (3.2 #9 정본 문구)
  const keyNoticeBar = state.guestNoticeCollapsed
    ? el(
        "div",
        { className: "trust-strip" },
        el("span", { text: "열쇠 보안 안내 접힘" }),
        el(
          "button",
          {
            type: "button",
            className: "mini-action-btn",
            onClick: () => {
              state.guestNoticeCollapsed = false;
              renderGuestRoomApp();
            },
          },
          icon("chevronDown", "icon-sm"),
          "안내 펼치기",
        ),
      )
    : el(
        "div",
        { className: "guest-key-notice" },
        el("span", { text: "이 링크가 열쇠예요. 다른 사람에게 보내지 마세요" }),
        el(
          "button",
          {
            type: "button",
            className: "mini-action-btn",
            onClick: () => {
              state.guestNoticeCollapsed = true;
              renderGuestRoomApp();
            },
          },
          icon("chevronUp", "icon-sm"),
          "접기",
        ),
      );

  const rememberGuest = el("input", {
    type: "checkbox",
    checked: isRoomRemembered(roomId),
    "aria-label": "이 기기 기억",
  });
  rememberGuest.addEventListener("change", () => {
    setRoomRemember(roomId, rememberGuest.checked);
  });

  const statusSlot = el("div", { id: "chat-status-slot", className: "status-slot" });
  renderStatusSlot(statusSlot);

  const msgScrollBox = el("div", {
    id: "messages-scroll-box",
    className: "messages-scroll",
    role: "log",
    tabindex: "0",
    "aria-live": "polite",
    "aria-label": "초대된 방 대화",
  });
  renderMessagesTimeline(msgScrollBox);
  observeHistoryScroll(msgScrollBox);

  const shell = el(
    "div",
    { className: "guest-shell" },
    keyNoticeBar,
    el(
      "header",
      { className: "pane-topbar" },
      el(
        "div",
        { className: "chat-header-left" },
        el("h1", {
          id: "guest-room-heading",
          className: "pane-title",
          text: state.guestMeta.roomName || "초대받은 방",
        }),
        el("span", {
          id: "guest-room-identity",
          className: "chip",
          hidden: !state.guestMeta.meName,
          text: state.guestMeta.meName ? `참가자: ${state.guestMeta.meName}` : "",
        }),
      ),
      el(
        "div",
        { className: "chat-header-right" },
        el("button", { type: "button", className: "icon-btn", "aria-label": "참가자 시트 열기",
          onClick: async (e) => {
            const trigger = e.currentTarget;
            const view = state.roomGen;
            await loadRosterAvatars(roomId, currentParticipants(), null, pKey);
            if (view !== state.roomGen || !trigger.isConnected) return;
            openMobileMembersSheet(sheets, {
              roomName: state.guestMeta.roomName || "초대받은 방",
              participants: currentParticipants().map(profileWithAvatar),
              trigger,
            });
          },
        }, icon("users")),
        buildChatSettingsButton(true),
        el(
          "label",
          { className: "check-row" },
          rememberGuest,
          el("span", { text: "기기 기억" }),
        ),
        el("a", { className: "link-nav", href: "/help.html", text: "안내" }),
      ),
    ),
    el("div", { className: "trust-strip" }, el("span", { text: TRUST_NOTICE_SHORT })),
    statusSlot,
    el("main", { id: "main-focus", tabindex: "-1", className: "chat-pane" }, msgScrollBox),
    buildComposer({ isGuest: true }),
  );

  appRoot.appendChild(shell);
  syncReplyBar();
}

function renderApp() {
  if (state.route === "landing") {
    renderLandingPage();
  } else if (state.route === "guest") {
    renderGuestRoomApp();
  } else {
    renderOwnerApp();
  }
}

function bootCurrentRoute() {
  renderApp();
  if (state.route === "app" && getSpaceKey()) {
    loadSpaceBootstrap();
  } else if (state.route === "guest" && getRoomKey(state.guestRoomId)) {
    pollCurrentRoom(true);
  }
}

resolveRouteAndConsumeKey();
bootCurrentRoute();
