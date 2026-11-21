import { createImagePicker } from "./images.js?v=2.3.0";
import { assistantDefault } from "./assistant-defaults.js?v=2.3.0";
// 시트·모달 화면 모음 (화면 6 참가자 넣기, 화면 7 참가자 상세·재발급, 답 옮기기, 새 방·방 수정)
// - 보안 수칙 4: 참가자 추가 창과 재발급 창을 열 때마다 전달 방식을 기본값 '헤더(header)'로 초기화
// - 보안 수칙 6: 연결 상태(created / connected / last_seen)는 추측하지 않고 서버가 준 status 값만 표시
// - 1회성 연결 문구는 시트가 열려 있는 동안 클로저에만 두고 닫는 즉시 메모리에서 파기

import {
  DEFAULT_INTERVAL_MINUTES,
  INTERVAL_PRESETS,
  PARTICIPANT_KINDS,
  READ_COOLDOWN_NOTE,
  SCHEDULE_HONESTY_NOTE,
  errorMessage,
  kindMeta,
  resolveIntervalMinutes,
  sortParticipantKindsByUsage,
  validateIntervalMinutesInput,
  validateMessageInput,
  validateNameInput,
} from "./constants.js?v=2.3.0";
import { AVATAR_PRESETS, PARTICIPANT_FILTERS, avatarThumbnail, participantNotes, participantRole, participantRoleLabel } from "./participant-avatar.js?v=2.3.0";
import {
  appendNodes,
  buildAvatar,
  buildLiveScheduleNode,
  buildSafeMessageNodes,
  buildSafeTranscript,
  clearNode,
  describeAssistantSchedule,
  el,
  formatAgo,
  icon,
  resolveLastCheckedSeconds,
} from "./dom.js?v=2.3.0";
import { getKindUsageCounts, recordKindUsage } from "./keystore.js?v=2.3.0";

/** 서버가 돌려준 status 값만으로 3단계 표시 정보를 만든다(클라이언트 추측 금지) */
export function serverParticipantStatus(p) {
  const meta = kindMeta(p);
  const lastSec = resolveLastCheckedSeconds(p);

  if (p?.revoked) {
    return {
      stage: 0,
      chipText: "폐기됨",
      chipClass: "chip chip-danger",
      detailText: "열쇠가 폐기되어 더 이상 이 방을 읽거나 쓸 수 없습니다.",
      lastSec: null,
    };
  }
  if (p?.is_owner) {
    return {
      stage: 2,
      chipText: "공간 주인",
      chipClass: "chip chip-connected",
      detailText: "내 공간 열쇠로 직접 읽고 쓰는 기본 자리입니다.",
      lastSec,
    };
  }
  if (p?.status === "connected") {
    return {
      stage: 2,
      chipText: "연결됨",
      chipClass: "chip chip-connected",
      detailText: "서버가 최근 읽기·쓰기 연결을 확인했습니다.",
      lastSec,
    };
  }
  if (p?.status === "last_seen") {
    const agoText = lastSec !== null
      ? `최근 확인 ${formatAgo(lastSec)}`
      : "최근 확인 기록 있음";
    return {
      stage: 3,
      chipText: agoText,
      chipClass: "chip",
      detailText: agoText,
      lastSec,
    };
  }
  if (meta?.manualRelayOnly) {
    return {
      stage: 1,
      chipText: "⇄ 답 옮기기",
      chipClass: "chip",
      detailText: "하크는 직접 붙여넣기로 답을 옮기며 자동 접속·최근 확인으로 기록되지 않습니다.",
      lastSec: null,
    };
  }
  return {
    stage: 1,
    chipText: "문구 만듦",
    chipClass: "chip",
    detailText: "연결 문구를 발급했으며 아직 서버에 첫 확인이 기록되지 않았습니다.",
    lastSec: null,
  };
}

export function createSheetManager(sheetRoot) {
  let activeCleanup = null;
  let lastTrigger = null;

  function closeSheet() {
    if (activeCleanup) {
      const fn = activeCleanup;
      activeCleanup = null;
      fn();
    }
    clearNode(sheetRoot);
    if (lastTrigger && typeof lastTrigger.focus === "function" && document.contains(lastTrigger)) {
      lastTrigger.focus();
    }
    lastTrigger = null;
  }

  function openSheet({ title, trigger = null, buildBody, onDispose = null }) {
    if (activeCleanup) {
      const prev = activeCleanup;
      activeCleanup = null;
      prev();
    }
    lastTrigger = trigger || document.activeElement;
    clearNode(sheetRoot);

    const titleId = "active-sheet-title";
    const closeBtn = el(
      "button",
      {
        type: "button",
        className: "icon-btn",
        "aria-label": "창 닫기",
        onClick: () => closeSheet(),
      },
      icon("close"),
    );

    const bodyBox = el("div", { className: "sheet-body" });
    const panel = el(
      "div",
      {
        className: "sheet-panel",
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
      },
      el("div", { className: "sheet-handle", "aria-hidden": "true" }),
      el(
        "div",
        { className: "sheet-header" },
        el("h2", { id: titleId, className: "pane-title", text: title }),
        closeBtn,
      ),
      bodyBox,
    );

    const backdrop = el(
      "div",
      {
        className: "sheet-backdrop",
        onClick: (e) => {
          if (e.target === backdrop) closeSheet();
        },
      },
      panel,
    );

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeSheet();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    activeCleanup = () => {
      document.removeEventListener("keydown", onKeyDown);
      if (typeof onDispose === "function") onDispose();
    };

    sheetRoot.appendChild(backdrop);
    buildBody(bodyBox, () => {
      if (backdrop.parentNode === sheetRoot) closeSheet();
    });

    const firstInput = bodyBox.querySelector("input:not([disabled]), textarea:not([disabled]), button:not([disabled])");
    // 포커스가 아래쪽 첫 컨트롤로 가면서 시트 내용이 위에서부터 잘려 스크롤되지 않게 한다.
    (firstInput || closeBtn).focus({ preventScroll: true });
  }

  return { openSheet, closeSheet };
}

/** 2단계 확인 버튼 도우미 (브라우저 기본 confirm 대신 안전한 5초 재확인) */
export function makeTwoStepButton(baseLabel, confirmLabel, className, onConfirm) {
  let armedTimer = null;
  const btn = el("button", { type: "button", className, text: baseLabel });
  btn.addEventListener("click", () => {
    if (armedTimer !== null) {
      clearTimeout(armedTimer);
      armedTimer = null;
      btn.textContent = baseLabel;
      onConfirm();
      return;
    }
    btn.textContent = confirmLabel;
    armedTimer = window.setTimeout(() => {
      armedTimer = null;
      btn.textContent = baseLabel;
    }, 5000);
  });
  return btn;
}

/** 확인 주기 프리셋과 양의 정수 직접 입력 */
function buildIntervalControl({ selectId, customInputId, initialMinutes = DEFAULT_INTERVAL_MINUTES, onChange = null }) {
  let currentMinutes = Number.isSafeInteger(initialMinutes) && initialMinutes >= 1
    ? initialMinutes
    : DEFAULT_INTERVAL_MINUTES;

  const presetBar = el("div", {
    className: "interval-presets",
    role: "group",
    "aria-label": "확인 주기 빠른 선택",
  });

  const selectEl = el("select", {
    id: selectId,
    className: "select",
  });

  const customInput = el("input", {
    id: customInputId,
    className: "input",
    type: "number",
    inputmode: "numeric",
    min: "1",
    max: "43200",
    step: "1",
    value: String(currentMinutes),
    "aria-label": "확인 주기 분 직접 입력",
    placeholder: "양의 정수 분 (예: 25)",
  });

  for (const mins of INTERVAL_PRESETS) {
    selectEl.appendChild(
      el("option", {
        value: String(mins),
        text: `${mins}분`,
      }),
    );
  }
  selectEl.appendChild(
    el("option", {
      value: "custom",
      text: "직접 입력 (양의 정수 분)",
    }),
  );

  const presetButtons = INTERVAL_PRESETS.map((mins) => {
    const btn = el(
      "button",
      {
        type: "button",
        className: "interval-preset-btn",
        "aria-pressed": String(currentMinutes === mins),
        onClick: () => {
          currentMinutes = mins;
          customInput.value = String(mins);
          syncUI();
        },
      },
      `${mins}분`,
    );
    btn.dataset.mins = String(mins);
    return btn;
  });
  presetBar.append(...presetButtons);

  function syncUI(notify = true) {
    const isPreset = INTERVAL_PRESETS.includes(currentMinutes);
    selectEl.value = isPreset ? String(currentMinutes) : "custom";
    for (const btn of presetButtons) {
      btn.setAttribute("aria-pressed", String(Number(btn.dataset.mins) === currentMinutes));
    }
    if (notify) onChange?.();
  }

  selectEl.addEventListener("change", () => {
    if (selectEl.value === "custom") {
      customInput.focus();
      customInput.select();
      return;
    }
    const chosen = Number(selectEl.value);
    if (Number.isSafeInteger(chosen) && chosen >= 1) {
      currentMinutes = chosen;
      customInput.value = String(chosen);
      syncUI();
    }
  });

  customInput.addEventListener("input", () => {
    const parsed = validateIntervalMinutesInput(customInput.value);
    if (!parsed.error && parsed.minutes !== null) {
      currentMinutes = parsed.minutes;
      syncUI();
    } else {
      selectEl.value = "custom";
      for (const btn of presetButtons) {
        btn.setAttribute("aria-pressed", "false");
      }
      onChange?.();
    }
  });

  syncUI(false);

  return {
    element: el(
      "div",
      { className: "doc-list" },
      presetBar,
      el("div", { className: "interval-custom-row" }, selectEl, customInput),
    ),
    selectEl,
    customInput,
    validate: () => validateIntervalMinutesInput(customInput.value),
    setMinutes: (mins) => {
      const safe = Number.isSafeInteger(mins) && mins >= 1 ? mins : DEFAULT_INTERVAL_MINUTES;
      currentMinutes = safe;
      customInput.value = String(safe);
      syncUI();
    },
  };
}

/** 1회성 연결 문구·초대 링크·하크 안내 표시 뷰 (닫으면 클로저 변수 즉시 null 처리) */
function renderOnceCredentialView(
  bodyBox,
  { participantId, participantName, kind, aiType, delivery, rawText, onOpenRelay, onDone },
) {
  let secretText = String(rawText || "");
  const isHark = aiType === "hark";
  clearNode(bodyBox);

  const statusLine = el("p", { className: "field-hint", role: "status", "aria-live": "polite" });
  const previewBox = el("div", { className: "key-box", text: secretText });

  const copyBtn = el(
    "button",
    {
      type: "button",
      className: isHark ? "btn btn-block" : "btn btn-primary btn-block",
      onClick: async () => {
        if (!secretText) return;
        try {
          await navigator.clipboard.writeText(secretText);
          statusLine.textContent = isHark
            ? "하크용 답 옮기기 안내를 복사했습니다."
            : "클립보드에 복사했습니다. 대상 대화창에 바로 붙여 넣으세요.";
        } catch {
          statusLine.textContent = "자동 복사가 제한되었습니다. 아래 상자의 문구를 길게 눌러 직접 복사하세요.";
        }
      },
    },
    icon("copy"),
    kind === "human"
      ? "초대 링크 복사"
      : isHark
        ? "하크 안내 문구 복사"
        : "연결 문구 복사",
  );

  const warnBanner = isHark
    ? el(
        "div",
        { className: "banner banner-accent" },
        el(
          "span",
          {
            text: "하크 자리가 준비되었습니다. 외부 주소 자동 접속 없이 대화창의 [AI 답 옮기기]로 최근 대화를 복사해 하크의 답을 직접 붙여 넣어 주세요.",
          },
        ),
      )
    : el(
        "div",
        { className: "banner banner-warn" },
        el(
          "span",
          {
            text: "이 창을 닫으면 다시 볼 수 없어요. 잃어버리면 재발급하세요.",
          },
        ),
      );

  const deliveryNote =
    kind === "assistant" && !isHark && delivery === "get"
      ? el(
          "div",
          { className: "banner banner-danger" },
          el(
            "span",
            {
              text: "주소(GET) 방식 문구라 주소 안에 열쇠가 들어 있습니다. 다른 방이나 공개 대화에 절대 공유하지 마세요.",
            },
          ),
        )
      : null;

  const openRelayBtn =
    isHark && typeof onOpenRelay === "function"
      ? el(
          "button",
          {
            type: "button",
            className: "btn btn-primary btn-block",
            onClick: () => {
              secretText = "";
              clearNode(previewBox);
              onOpenRelay(participantId);
            },
          },
          icon("relay", "icon-sm"),
          "⇄ 바로 하크 답 옮기기 열기",
        )
      : null;

  const doneBtn = el(
    "button",
    {
      type: "button",
      className: "btn btn-block",
      onClick: () => {
        secretText = "";
        clearNode(previewBox);
        onDone();
      },
    },
    `${participantName} 안내 닫기`,
  );

  appendNodes(
    bodyBox,
    warnBanner,
    deliveryNote,
    openRelayBtn,
    copyBtn,
    statusLine,
    previewBox,
    doneBtn,
  );

  return () => {
    secretText = "";
    clearNode(previewBox);
  };
}

const DEVICE_CHOICES = ["노트북", "데스크톱", "휴대폰", "태블릿"];
function profileFields(prefix, p = {}) {
  const device = el("input", { id: prefix + "-device", className: "input", maxlength: "64", value: p.device_label ?? "", autocomplete: "off" });
  const role = el("textarea", { id: prefix + "-role-note", className: "textarea", rows: 3, maxlength: "240" });
  role.value = p.role_note ?? "";
  return {
    element: el("div", { className: "field" },
      el("label", { for: prefix + "-device", text: "장비 (선택)" }),
      el("div", { className: "profile-device-options" },
        ...DEVICE_CHOICES.map((label) => el("button", {
          type: "button", className: "chip", onClick: () => { device.value = label; },
        }, label))),
      device,
      el("label", { for: prefix + "-role-note", text: "업무 메모 (선택)" }), role),
    values: () => ({ device_label: device.value.trim(), role_note: role.value.trim() }),
  };
}

/** 화면 6: 참가자 넣기와 공간별 기본값 */
export function openAddParticipantSheet(
  sheets,
  {
    roomName,
    trigger,
    participantsByRoom = null,
    messages = [],
    onSubmitParticipant,
    assistantDefaults = {},
    onRememberDefault = null,
    onOpenRelayFor = null,
    onAfterChange,
  },
) {
  let disposeSecret = null;

  sheets.openSheet({
    title: "참가자 넣기",
    trigger,
    onDispose: () => {
      if (disposeSecret) disposeSecret();
    },
    buildBody: (bodyBox, closeSheet) => {
      const { sortedKinds, scoreByKind } = sortParticipantKindsByUsage({
        usageCounts: getKindUsageCounts(),
        participantsByRoom,
        messages,
      });

      let selectedKind = PARTICIPANT_KINDS.find((k) => k.id === "claude") || sortedKinds[0];
      const remembered = { ...assistantDefaults };
      const initialSettings = (kind) => assistantDefault(kind.ai_type, remembered);
      let selectedDelivery = initialSettings(selectedKind).delivery;
      const badgeByKind = new Map();

      const nameInput = el("input", {
        id: "add-member-name",
        className: "input",
        type: "text",
        maxlength: "32",
        placeholder: "예: 클로드",
        value: selectedKind.label,
        autocomplete: "off",
      });

      const profiles = profileFields("add-member");

      const kindGrid = el("div", {
        className: "kind-grid",
        role: "group",
        "aria-label": "참가자 종류 (자주 쓰는 비서 우선)",
      });

      const deliverySection = el("div", { className: "field" });
      const harkManualBanner = el(
        "div",
        { className: "banner banner-accent", hidden: true },
        el("span", {
          text: "⇄ 답 옮기기(직접 붙여넣기) 기본·전용 · 하크는 외부 우편함 URL 자동 접속을 쓰지 않습니다. 자리를 만든 뒤 대화창의 [AI 답 옮기기]에서 최근 대화를 복사해 하크 답을 붙여 넣으세요.",
        }),
      );

      const intervalControl = buildIntervalControl({
        selectId: "add-member-interval",
        customInputId: "add-member-interval-custom",
        initialMinutes: initialSettings(selectedKind).interval_minutes,
        onChange: updateKindBadges,
      });
      const intervalHint = el("p", { className: "field-hint" });
      const cooldownHint = el("p", { className: "field-hint", text: READ_COOLDOWN_NOTE });
      const honestyHint = el("p", { className: "field-hint", text: SCHEDULE_HONESTY_NOTE });
      const intervalSection = el(
        "div",
        { className: "field" },
        el("label", {
          className: "field-label",
          for: "add-member-interval",
          text: `확인 주기 (${INTERVAL_PRESETS.join("·")}분 또는 직접 입력)`,
        }),
        intervalControl.element,
        intervalHint,
        cooldownHint,
        honestyHint,
      );

      const radioHeader = el("input", {
        type: "radio",
        name: "add-delivery-mode",
        value: "header",
      });
      const radioGet = el("input", {
        type: "radio",
        name: "add-delivery-mode",
        value: "get",
      });
      radioHeader.checked = true;
      radioGet.checked = false;

      const deliveryTitle = el("span", { className: "field-label", text: "열쇠 전달 방식" });
      const headerLabelText = el("span", {
        text: "헤더 방식 (권장 · 주소에 열쇠 남지 않음)",
      });
      const getLabelText = el("span", {
        text: "주소(GET) 방식 (헤더를 못 쓰는 외부 비서용)",
      });

      const getWarn = el(
        "div",
        { className: "banner banner-warn", hidden: true },
        el(
          "span",
          {
            text: "주소에 열쇠가 들어가 AI 대화 기록이나 링크 미리보기에 남을 수 있습니다. 헤더를 지원하는 환경이라면 위 '헤더 방식'으로 수동 전환할 수 있습니다.",
          },
        ),
      );

      function syncDeliveryUI() {
        const saved = initialSettings(selectedKind);
        deliveryTitle.textContent = remembered[selectedKind.ai_type]
          ? `열쇠 전달 방식 (이 공간에 기억됨 · ${saved.delivery === "get" ? "주소 GET" : "헤더"} · ${saved.interval_minutes}분)`
          : "열쇠 전달 방식";
        radioHeader.checked = selectedDelivery === "header";
        radioGet.checked = selectedDelivery === "get";
        getWarn.hidden = selectedDelivery !== "get";
        updateKindBadges();
      }

      function updateKindBadges() {
        for (const [kind, badge] of badgeByKind) {
          const active = selectedKind.id === kind.id;
          const defaults = initialSettings(kind);
          const delivery = active ? selectedDelivery : defaults.delivery;
          const minutes = active ? intervalControl.validate().minutes : defaults.interval_minutes;
          const manual = kind.manualRelayOnly;
          badge.className = manual ? "chip chip-relay" : delivery === "get" ? "chip chip-connected" : "chip";
          badge.textContent = kind.kind === "human" ? "전용 초대 링크" : manual ? "⇄ 답 옮기기"
            : `${delivery === "get" ? "주소 GET" : "헤더"} · ${minutes === null ? "주기 입력" : `${minutes}분${kind.id === "vooy" ? " 캘린더" : ""}`}`;
        }
      }

      radioHeader.addEventListener("change", () => {
        if (radioHeader.checked) {
          selectedDelivery = "header";
          syncDeliveryUI();
        }
      });
      radioGet.addEventListener("change", () => {
        if (radioGet.checked) {
          selectedDelivery = "get";
          syncDeliveryUI();
        }
      });

      deliverySection.append(
        deliveryTitle,
        el("label", { className: "check-row" }, radioHeader, headerLabelText),
        el("label", { className: "check-row" }, radioGet, getLabelText),
        getWarn,
      );

      function renderKindCards() {
        clearNode(kindGrid);
        badgeByKind.clear();
        for (const k of sortedKinds) {
          const active = selectedKind.id === k.id;
          const freqScore = scoreByKind.get(k.id) || 0;
          const prevDefaultFor = (meta) => (meta.id === "human" ? "초대 손님" : meta.label);

          const badge = el("span", { className: "chip" });
          badgeByKind.set(k, badge);

          const card = el(
            "button",
            {
              type: "button",
              className: "kind-card",
              "aria-pressed": String(active),
              dataset: { kindOption: k.id },
              onClick: () => {
                const prevDefault = prevDefaultFor(selectedKind);
                selectedKind = k;
                if (!nameInput.value.trim() || nameInput.value.trim() === prevDefault) {
                  nameInput.value = prevDefaultFor(k);
                }
                const next = initialSettings(k);
                selectedDelivery = next.delivery;
                intervalControl.setMinutes(next.interval_minutes);
                rememberStatus.textContent = "";
                syncFormByKind();
                renderKindCards();
              },
            },
            el(
              "span",
              { className: "kind-card-head" },
              buildAvatar(k.label, k.id, "avatar-card"),
              el(
                "span",
                { className: "kind-card-titles" },
                el("span", { className: "kind-card-name", text: k.label }),
                freqScore > 0 && k.kind === "assistant"
                  ? el("span", { className: "kind-card-freq", text: "자주 씀" })
                  : null,
              ),
            ),
            badge,
          );
          kindGrid.appendChild(card);
        }
        updateKindBadges();
      }

      const submitBtn = el(
        "button",
        { type: "submit", className: "btn btn-primary btn-block" },
        "연결 문구 만들기",
      );

      function syncFormByKind() {
        const isAssistant = selectedKind.kind === "assistant";
        const isHark = Boolean(selectedKind.manualRelayOnly);
        harkManualBanner.hidden = !isHark;
        deliverySection.hidden = !isAssistant || isHark;
        intervalSection.hidden = !isAssistant || isHark;
        rememberSection.hidden = !isAssistant || isHark || !onRememberDefault;
        syncDeliveryUI();

        if (isAssistant) {
          intervalHint.textContent = selectedKind.id === "vooy"
            ? "부이에서 Google 캘린더 감시를 설정했을 때 사용할 간격입니다." : selectedKind.usageHint;
          cooldownHint.hidden = isHark;
        }
      }

      const rememberStatus = el("p", { className: "field-hint", role: "status", "aria-live": "polite" });
      const rememberBtn = el("button", {
        type: "button", className: "btn", onClick: async () => {
          const chosen = selectedKind;
          const { minutes, error } = intervalControl.validate();
          if (error || minutes === null) {
            rememberStatus.textContent = error;
            return;
          }
          rememberBtn.disabled = true;
          try {
            const result = await onRememberDefault({ ai_type: chosen.ai_type, delivery: selectedDelivery, interval_minutes: minutes });
            remembered[chosen.ai_type] = result;
            syncDeliveryUI();
            rememberStatus.textContent = `이 공간의 ${chosen.label} 기본값을 저장했습니다.`;
          } catch (err) {
            rememberStatus.textContent = errorMessage(err);
          } finally {
            rememberBtn.disabled = false;
          }
        },
      }, "이 종류 기본값 기억");
      const rememberSection = el("div", { className: "field" }, rememberBtn, rememberStatus);

      const errLine = el("p", { className: "composer-feedback", role: "alert", hidden: true });

      const form = el(
        "form",
        {
          onSubmit: async (e) => {
            e.preventDefault();
            const nameErr = validateNameInput(nameInput.value);
            if (nameErr) {
              errLine.textContent = nameErr;
              errLine.hidden = false;
              return;
            }

            const picked = selectedKind;
            const name = nameInput.value.trim();
            let intervalMinutes;
            if (picked.kind === "assistant" && !picked.manualRelayOnly) {
              const ivCheck = intervalControl.validate();
              if (ivCheck.error || ivCheck.minutes === null) {
                errLine.textContent = ivCheck.error;
                errLine.hidden = false;
                return;
              }
              intervalMinutes = ivCheck.minutes;
            }

            errLine.hidden = true;
            submitBtn.disabled = true;
            try {
              const delivery =
                picked.kind === "assistant" && !picked.manualRelayOnly
                  ? selectedDelivery
                  : "header";
              const res = await onSubmitParticipant({
                name,
                kind: picked.kind,
                ai_type: picked.ai_type,
                delivery,
                ...(intervalMinutes === undefined ? {} : { interval_minutes: intervalMinutes }),
                ...profiles.values(),
              });
              if (picked.kind === "assistant") {
                recordKindUsage(picked.ai_type);
              }
              if (!bodyBox.isConnected) {
                onAfterChange?.();
                return;
              }
              const text = res?.connection_text || res?.assistant_text || res?.human_link || "";
              disposeSecret = renderOnceCredentialView(bodyBox, {
                participantId: res?.participant_id || null,
                participantName: name,
                kind: picked.kind,
                aiType: picked.ai_type,
                delivery,
                rawText: text,
                onOpenRelay: (createdPid) => {
                  closeSheet();
                  onOpenRelayFor?.(createdPid);
                },
                onDone: () => closeSheet(),
              });
              onAfterChange?.();
            } catch (err) {
              errLine.textContent = errorMessage(err);
              errLine.hidden = false;
              submitBtn.disabled = false;
            }
          },
        },
        el(
          "div",
          { className: "field" },
          el("label", { className: "field-label", for: "add-member-name", text: `참가자 이름 (${roomName})` }),
          nameInput,
        ),
        profiles.element,
        el(
          "div",
          { className: "field" },
          el("span", { className: "field-label", text: "종류 선택 (자주 쓰는 비서 우선)" }),
          kindGrid,
        ),
        harkManualBanner,
        deliverySection,
        intervalSection,
        rememberSection,
        errLine,
        el("div", { className: "field" }, submitBtn),
      );

      renderKindCards();
      syncFormByKind();
      bodyBox.appendChild(form);
    },
  });
}

/** 재발급 전용 창 (보안 수칙 4: 열 때마다 항상 전달 방식을 '헤더'로 초기화 · 기존 확인 주기 보존) */
export function openReissueSheet(sheets, { participant, trigger, onReissue, onAfterChange }) {
  let disposeSecret = null;
  const meta = kindMeta(participant);
  const preservedInterval = resolveIntervalMinutes(participant);

  sheets.openSheet({
    title: `${participant.name} 열쇠 재발급`,
    trigger,
    onDispose: () => {
      if (disposeSecret) disposeSecret();
    },
    buildBody: (bodyBox, closeSheet) => {
      let delivery = participant.delivery === "get" ? "get" : "header";

      const radioHeader = el("input", { type: "radio", name: "reissue-delivery", value: "header" });
      const radioGet = el("input", { type: "radio", name: "reissue-delivery", value: "get" });
      radioHeader.checked = delivery === "header";
      radioGet.checked = delivery === "get";

      const getWarn = el(
        "div",
        { className: "banner banner-warn", hidden: delivery !== "get" },
        el("span", { text: "주소 방식은 주소에 새 열쇠가 포함됩니다. 헤더를 쓸 수 없을 때만 선택하세요." }),
      );

      function sync() {
        radioHeader.checked = delivery === "header";
        radioGet.checked = delivery === "get";
        getWarn.hidden = delivery !== "get";
      }

      radioHeader.addEventListener("change", () => {
        if (radioHeader.checked) {
          delivery = "header";
          sync();
        }
      });
      radioGet.addEventListener("change", () => {
        if (radioGet.checked) {
          delivery = "get";
          sync();
        }
      });

      const errBox = el("p", { className: "composer-feedback", role: "alert", hidden: true });
      const submitBtn = el(
        "button",
        {
          type: "button",
          className: "btn btn-primary btn-block",
          onClick: async () => {
            submitBtn.disabled = true;
            errBox.hidden = true;
            try {
              const useDelivery =
                participant.kind === "assistant" && !meta.manualRelayOnly ? delivery : "header";
              const res = await onReissue(participant.participant_id, useDelivery);
              if (!bodyBox.isConnected) {
                onAfterChange?.();
                return;
              }
              const text = res?.connection_text || res?.assistant_text || res?.human_link || "";
              disposeSecret = renderOnceCredentialView(bodyBox, {
                participantId: participant.participant_id,
                participantName: participant.name,
                kind: participant.kind,
                aiType: meta.ai_type,
                delivery: useDelivery,
                rawText: text,
                onDone: () => closeSheet(),
              });
              onAfterChange?.();
            } catch (err) {
              errBox.textContent = errorMessage(err);
              errBox.hidden = false;
              submitBtn.disabled = false;
            }
          },
        },
        "옛 열쇠 끊고 새 문구 발급",
      );

      appendNodes(
        bodyBox,
        el(
          "p",
          {
            className: "field-hint",
            text:
              participant.kind === "assistant"
                ? `재발급하면 기존 열쇠와 대기 중인 보내기 확인값은 즉시 무효가 되며, 설정된 확인 주기(${preservedInterval}분)는 그대로 유지됩니다.`
                : "재발급하면 기존 초대 링크는 즉시 무효가 됩니다.",
          },
        ),
        participant.kind === "assistant" && !meta.manualRelayOnly
          ? el(
              "div",
              { className: "field" },
              el("span", { className: "field-label", text: "전달 방식 (열 때마다 기본 헤더로 초기화됨)" }),
              el("label", { className: "check-row" }, radioHeader, el("span", { text: "헤더 방식 (기본 권장)" })),
              el("label", { className: "check-row" }, radioGet, el("span", { text: "헤더를 못 쓰는 AI (주소 방식)" })),
              getWarn,
            )
          : null,
        errBox,
        submitBtn,
      );
    },
  });
}

/** 화면 7: 참가자 상세 시트 (상태 3단계 · 확인 주기/최근 확인/다음 확인 · 주기 수정 · 이름 바꾸기 · 재발급 · 끊기) */
export function openParticipantDetailSheet(
  sheets,
  {
    participant,
    roomName,
    trigger,
    onUpdateParticipant,
    onReissue,
    onRevoke,
    onOpenRelayFor = null,
    onAfterChange,
  },
) {
  const meta = kindMeta(participant);
  const st = serverParticipantStatus(participant);
  const isAssistant = participant.kind === "assistant" && !participant.is_owner;

  sheets.openSheet({
    title: "참가자 상세",
    trigger,
    buildBody: (bodyBox, closeSheet) => {
      const statusNotice = el("p", { className: "field-hint", role: "status", "aria-live": "polite" });

      const statusChipNode =
        st.stage === 3 && st.lastSec !== null
          ? el("span", {
              className: st.chipClass,
              text: st.chipText,
              dataset: {
                liveSchedule: "chip",
                intervalMin: resolveIntervalMinutes(participant),
                lastSec: st.lastSec,
                manualRelay: meta.manualRelayOnly ? "1" : "0",
              },
            })
          : el("span", { className: st.chipClass, text: st.chipText });

      const headerCard = el(
        "div",
        { className: "action-row" },
        buildAvatar(participant.name, meta.id, "avatar-lg", participant),
        el(
          "div",
          null,
          el(
            "div",
            { className: "action-row" },
            el("h3", { text: participant.name }),
            el("span", { className: "chip", text: meta.label }),
            statusChipNode,
          ),
          el("p", { className: "field-hint", text: st.detailText }),
        ),
      );

      // 서버 제공 상태 3단계 표시 트랙 (추측 없음)
      const stageTrack = el(
        "div",
        { className: "stage-steps", "aria-label": "연결 단계" },
        el(
          "div",
          { className: `stage-step${st.stage === 1 ? " is-active" : ""}` },
          meta.manualRelayOnly ? "① 직접 답 옮기기" : "① 문구 만듦",
        ),
        el(
          "div",
          { className: `stage-step${st.stage === 2 ? " is-active" : ""}` },
          "② 연결됨",
        ),
        el(
          "div",
          {
            className: `stage-step${st.stage === 3 ? " is-active" : ""}`,
            text: st.stage === 3 ? `③ ${st.chipText}` : "③ 최근 확인",
          },
        ),
      );

      const summary = describeAssistantSchedule(participant);
      const interval = isAssistant ? buildIntervalControl({
        selectId: "detail-member-interval", customInputId: "detail-member-interval-custom",
        initialMinutes: summary.intervalMin,
      }) : null;
      const name = el("input", { id: "member-rename-input", className: "input", maxlength: "32",
        value: participant.name, autocomplete: "off" });
      const profiles = profileFields("detail-member", participant);
      const kindSelect = isAssistant ? el("select", { id: "member-ai-type", className: "select" },
        ...PARTICIPANT_KINDS.filter((k) => k.kind === "assistant")
          .map((k) => el("option", { value: k.ai_type, text: k.label }))) : null;
      if (kindSelect) kindSelect.value = participant.ai_type || "other";
      const harkNotice = el("p", { className: "field-hint",
        text: "하크에는 연결 주소 대신 답 옮기기로 받은 답을 직접 붙여넣으세요.",
        hidden: kindSelect?.value !== "hark" });
      kindSelect?.addEventListener("change", () => { harkNotice.hidden = kindSelect.value !== "hark"; });
      const preset = el("select", { id: "member-avatar-preset", className: "select" },
        el("option", { value: "keep", text: "현재 이미지 유지" }),
        el("option", { value: "default", text: "기본 이미지로 복귀" }),
        ...AVATAR_PRESETS.map((id) => el("option", { value: id, text: kindMeta({kind:"assistant",ai_type:id}).label })),
      );
      const file = el("input", { id: "member-avatar-file", type: "file", className: "input", accept: "image/png,image/jpeg,image/webp" });
      preset.addEventListener("change", () => { file.value = ""; });
      const save = el("button", { type: "submit", className: "btn btn-primary" }, "참가자 변경 저장");
      const editForm = el("form", { className: "field", onSubmit: async (event) => {
        event.preventDefault();
        if (save.disabled) return;
        const err = validateNameInput(name.value);
        const check = interval?.validate();
        if (err || check?.error) {
          statusNotice.textContent = err || check.error;
          return;
        }
        save.disabled = true;
        try {
          const changes = { name: name.value.trim(), ...profiles.values() };
          if (kindSelect) changes.ai_type = kindSelect.value;
          if (check) changes.interval_minutes = check.minutes;
          if (!participant.revoked && file.files?.length) changes.avatar_webp = await avatarThumbnail(file.files[0]);
          else if (!participant.revoked && preset.value !== "keep") changes.avatar_preset = preset.value === "default" ? null : preset.value;
          await onUpdateParticipant(participant.participant_id, changes);
          closeSheet();
          void onAfterChange?.();
        } catch (error) {
          statusNotice.textContent = error?.code ? errorMessage(error) : error.message;
        } finally { save.disabled = false; }
      } },
        el("label", { for: "member-rename-input", text: "표시 이름" }), name,
        kindSelect ? el("label", { for: "member-ai-type", text: "비서 종류" }) : null,
        kindSelect, harkNotice,
        interval ? el("label", { for: "detail-member-interval", text: "확인 주기" }) : null, interval?.element,
        !participant.revoked ? el("label", { for: "member-avatar-preset", text: "참가자 이미지" }) : null,
        !participant.revoked ? preset : null,
        !participant.revoked ? el("label", { for: "member-avatar-file", text: "사용자 이미지 (선택)" }) : null,
        !participant.revoked ? file : null, profiles.element, save,
      );
      const observed = isAssistant ? el("div", { className: "schedule-summary-grid" },
        el("div", { className: "schedule-stat" }, el("span", { className: "schedule-stat-label", text: "설정 주기" }),
          el("span", { className: "schedule-stat-val", text: summary.intervalLabel })),
        el("div", { className: "schedule-stat" }, el("span", { className: "schedule-stat-label", text: "최근 확인 (서버 관측)" }),
          buildLiveScheduleNode(participant, "last", "schedule-stat-val")),
        el("div", { className: "schedule-stat" }, el("span", { className: "schedule-stat-label", text: "다음 확인 예정" }),
          buildLiveScheduleNode(participant, "next", "schedule-stat-val")),
      ) : null;
      const wake = isAssistant && !participant.revoked && !meta.manualRelayOnly ? el("button", {
        type: "button", className: "btn",
        onClick: async () => {
          const notice = `[우편함 확인 요청] ${participant.name}님, 기존에 연결한 ‘${roomName}’ 방을 지금 확인해 주세요. since는 생략해 주세요.`;
          try {
            await navigator.clipboard.writeText(notice);
            statusNotice.textContent = "깨우기 문구를 복사했습니다.";
          } catch { statusNotice.textContent = "브라우저가 클립보드 접근을 허용하지 않았습니다."; }
        },
      }, "깨우기 문구 복사") : null;

      // 답 옮기기 · 재발급 · 끊기(폐기)
      const actionBox = el("div", { className: "field" });
      if (participant.is_owner) {
        actionBox.appendChild(
          el("p", {
            className: "field-hint",
            text: "공간 주인 기본 자리는 개별 폐기할 수 없습니다. 열쇠 교체는 [설정 → 공간 키 재발급]에서 진행하세요.",
          }),
        );
      } else {
        if (isAssistant && meta.manualRelayOnly && !participant.revoked && typeof onOpenRelayFor === "function") {
          actionBox.appendChild(
            el(
              "button",
              {
                type: "button",
                className: "btn btn-primary btn-block",
                onClick: () => {
                  closeSheet();
                  onOpenRelayFor(participant.participant_id);
                },
              },
              icon("relay", "icon-sm"),
              `⇄ ${participant.name} 답 옮기기 (직접 붙여넣기)`,
            ),
          );
        }

        const reissueOpenBtn = el(
          "button",
          {
            type: "button",
            className: "btn btn-block",
            onClick: () =>
              openReissueSheet(sheets, {
                participant,
                trigger,
                onReissue,
                onAfterChange,
              }),
          },
          icon("refresh", "icon-sm"),
          participant.revoked ? "다시 열기 (새 열쇠 재발급)" : "열쇠 재발급",
        );
        actionBox.appendChild(reissueOpenBtn);

        if (!participant.revoked) {
          const revokeBtn = makeTwoStepButton(
            "끊기 (열쇠 폐기)",
            "한 번 더 누르면 즉시 끊기",
            "btn btn-danger btn-block",
            async () => {
              try {
                await onRevoke(participant.participant_id);
                onAfterChange?.();
                closeSheet();
              } catch (err) {
                statusNotice.textContent = errorMessage(err);
              }
            },
          );
          actionBox.appendChild(revokeBtn);
        }
      }

      appendNodes(bodyBox, headerCard, stageTrack, observed,
        isAssistant ? el("p", { className: "field-hint", text: SCHEDULE_HONESTY_NOTE }) : null,
        wake, editForm, actionBox, statusNotice);
    },
  });
}

/** 모바일(≤768px) 참가자 목록 시트 (아래에서 올라옴) */
export function openMobileMembersSheet(
  sheets,
  { roomName, participants, trigger, onPickParticipant, onOpenAdd },
) {
  sheets.openSheet({
    title: `${roomName} 참가자 (${participants.length})`,
    trigger,
    buildBody: (bodyBox) => {
      const addBtn = onOpenAdd ? el(
        "button",
        {
          type: "button",
          className: "btn btn-primary btn-block",
          onClick: () => onOpenAdd(trigger),
        },
        icon("plus", "icon-sm"),
        "참가자 넣기",
      ) : null;

      const list = el("div", { className: "doc-list" });
      const filter = el("select", { className: "select", "aria-label": "참가자 역할 필터" },
        ...PARTICIPANT_FILTERS.map(([value, text]) => el("option", { value, text })));
      function render() {
      clearNode(list);
      const visible = participants.filter((p) => filter.value === "all" || participantRole(p) === filter.value);
      for (const p of visible) {
        const meta = kindMeta(p);
        const st = serverParticipantStatus(p);
        const isAssistant = p.kind === "assistant" && !p.is_owner && !p.revoked;
        const row = el(
          onPickParticipant ? "button" : "div",
          onPickParticipant ? {
            type: "button",
            className: "member-row",
            onClick: () => onPickParticipant(p, trigger),
          } : { className: "member-row" },
          buildAvatar(p.name, meta.id, "", p),
          el(
            "div",
            { className: "member-row-info" },
            el(
              "div",
              { className: "member-row-title" },
              el("span", { text: p.name }),
              onPickParticipant ? el("span", { className: st.chipClass, text: st.chipText }) : null,
            ),
            el("span", { className: "member-row-sub", text: `${participantRoleLabel(p)} · ${meta.label}` }),
            participantNotes(p),
            onPickParticipant && isAssistant ? buildLiveScheduleNode(p, "inline", "member-schedule-line", "span") : null,
          ),
        );
        list.appendChild(row);
      }
      if (!visible.length) list.append(el("p", { className: "field-hint", text: "해당 역할의 참가자가 없습니다." }));
      }
      filter.addEventListener("change", render);
      render();
      appendNodes(bodyBox, addBtn, filter, list);
    },
  });
}

/** 화면 5 보조: '답 옮기기' 시트 (AI 선택 → 최근 대화 복사 → 답 붙여넣기 → 그 AI 이름으로 올리기) */
export function openRelaySheet(
  sheets,
  {
    roomName,
    participants,
    messages,
    initialParticipantId = null,
    question = null,
    retentionDays,
    trigger,
    onPostRelayed,
    imageUploads = false,
    imageMaxBytes,
    imageMaxEdge,
    onOpenAdd,
  },
) {
  const aiMembers = participants.filter((p) =>
    p.kind === "assistant" && !p.revoked && (!question || p.participant_id === initialParticipantId));

  let imagePicker;
  sheets.openSheet({
    title: "AI 답 옮기기 (대신 올림)",
    trigger,
    onDispose: () => imagePicker?.clear(),
    buildBody: (bodyBox, closeSheet) => {
      if (!aiMembers.length) {
        bodyBox.append(
          el("p", {
            text: "이 방에 활성화된 AI 비서 참가자가 아직 없어요. 먼저 AI 참가자를 추가하면 그 AI 이름으로 답을 옮겨 올릴 수 있습니다.",
          }),
          el(
            "button",
            {
              type: "button",
              className: "btn btn-primary btn-block",
              onClick: () => onOpenAdd(trigger),
            },
            icon("plus", "icon-sm"),
            "AI 참가자 넣기",
          ),
        );
        return;
      }

      const preferred =
        (initialParticipantId && aiMembers.find((p) => p.participant_id === initialParticipantId)) ||
        aiMembers.find((p) => kindMeta(p).manualRelayOnly) ||
        aiMembers[0];

      const aiSelect = el(
        "select",
        { id: "relay-ai-select", className: "select" },
        ...aiMembers.map((p) => {
          const opt = el("option", {
            value: p.participant_id,
            text: `${p.name} (${kindMeta(p).label})`,
          });
          if (preferred && p.participant_id === preferred.participant_id) {
            opt.selected = true;
          }
          return opt;
        }),
      );

      const selectedPreview = el("div", { className: "action-row" });
      function syncSelectedPreview() {
        const chosen = aiMembers.find((p) => p.participant_id === aiSelect.value) || aiMembers[0];
        const cMeta = kindMeta(chosen);
        clearNode(selectedPreview);
        selectedPreview.append(
          buildAvatar(chosen.name, cMeta.id, "", chosen),
          el("strong", { text: chosen.name }),
          el("span", { className: "chip", text: cMeta.label }),
          el("span", { className: "chip chip-relay", text: "사용자가 대신 올림 표시됨" }),
        );
      }
      aiSelect.addEventListener("change", syncSelectedPreview);
      syncSelectedPreview();

      const copyStatus = el("p", { className: "field-hint", role: "status", "aria-live": "polite" });
      const copyBtn = el(
        "button",
        {
          type: "button",
          className: "btn btn-block",
          onClick: async () => {
            const text = question ? question.context() : buildSafeTranscript(roomName, messages, 8, 400, retentionDays);
            if (!text) {
              copyStatus.textContent = "현재 방에서 이 질문을 다시 확인해 주세요.";
              return;
            }
            try {
              await navigator.clipboard.writeText(text);
              copyStatus.textContent = question
                ? "질문 문맥을 복사했습니다. 받은 답을 아래에 붙여 넣으세요."
                : "보관 기간 내 최근 대화를 복사했습니다. AI 대화창에 붙여 넣고 받은 답을 아래에 적어 주세요.";
            } catch {
              copyStatus.textContent = "자동 복사가 되지 않았습니다. 브라우저 권한을 확인해 주세요.";
            }
          },
        },
        icon("copy", "icon-sm"),
        question ? "① 질문 문맥 복사하기" : "① 최근 대화 복사하기",
      );

      const answerArea = el("textarea", {
        id: "relay-answer-text",
        className: "textarea",
        rows: "5",
        maxlength: "2000",
        placeholder: "AI(예: 하크·챗GPT·제미나이)에게서 받은 답을 여기에 붙여 넣으세요",
      });

      const errLine = el("p", { className: "composer-feedback", role: "alert", hidden: true });
      const submitBtn = el(
        "button",
        { type: "submit", className: "btn btn-primary btn-block" },
        icon("relay", "icon-sm"),
        "③ 선택한 AI 이름으로 올리기",
      );

      let draft = null, sending = false;
      const form = el(
        "form",
        {
          className: "doc-list",
          onSubmit: async (e) => {
            e.preventDefault();
            if (sending || imagePicker?.working) return;
            const checkErr = validateMessageInput(answerArea.value);
            if (checkErr || !draft && !answerArea.value.trim()) {
              errLine.textContent = checkErr || "옮길 답을 쓰거나 이미지를 붙여 주세요.";
              errLine.hidden = false;
              return;
            }
            const original = submitBtn.textContent;
            errLine.hidden = true;
            sending = submitBtn.disabled = true;
            imagePicker?.lock(true);
            if (draft) submitBtn.textContent = "올리는 중…";
            try {
              const chosen = aiMembers.find((p) => p.participant_id === aiSelect.value);
              await onPostRelayed({
                relayedFor: aiSelect.value,
                text: answerArea.value.trim(),
                image: draft?.blob,
              });
              if (chosen) {
                recordKindUsage(kindMeta(chosen).ai_type);
              }
              closeSheet();
            } catch (err) {
              errLine.textContent = errorMessage(err);
              errLine.hidden = false;
            } finally {
              sending = submitBtn.disabled = false;
              submitBtn.textContent = original;
              imagePicker?.lock(false);
            }
          },
        },
        el(
          "div",
          { className: "field" },
          el("label", { className: "field-label", for: "relay-ai-select", text: "답한 AI 비서 선택" }),
          aiSelect,
          selectedPreview,
        ),
        copyBtn,
        copyStatus,
        el(
          "div",
          { className: "field" },
          el("label", { className: "field-label", for: "relay-answer-text", text: "② AI의 답 붙여넣기" }),
          answerArea,
          el("span", {
            className: "field-hint",
            text: "올린 글에는 선택한 비서 프로필과 '사용자가 대신 올림' 표시가 붙으며, 비서의 자동 접속·최근 확인 시각으로는 기록되지 않습니다.",
          }),
        ),
        errLine,
        submitBtn,
      );

      if (imageUploads) {
        imagePicker = createImagePicker(answerArea, {
          available: () => true,
          maxBytes: () => imageMaxBytes,
          maxEdge: () => imageMaxEdge,
          active: () => answerArea.isConnected,
          getDraft: () => draft,
          setDraft: (value) => { draft = value; },
          changed: () => { submitBtn.disabled = sending || imagePicker.working; },
        });
        form.insertBefore(el("div", { className: "action-row" }, ...imagePicker.buttons), errLine);
        form.insertBefore(imagePicker.bar, errLine);
        form.insertBefore(imagePicker.status, errLine);
      }
      bodyBox.appendChild(form);
    },
  });
}

export function openMessageSheet(sheets, { messageId, sender, when, text, relayed, hasImage, trigger }) {
  sheets.openSheet({
    title: "전체 보기",
    trigger,
    buildBody: (bodyBox) => {
      const content = buildSafeMessageNodes(text);
      content.classList.add("message-full-text");
      content.dataset.messageId = String(messageId);
      const status = el("div", { className: "field-hint", role: "status" });
      const copyBtn = el("button", {
        type: "button",
        className: "btn btn-block",
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(text);
            status.textContent = "글 전체를 복사했습니다.";
          } catch {
            status.textContent = "복사할 수 없습니다. 본문을 선택해 복사해 주세요.";
          }
        },
      }, icon("copy", "icon-sm"), "전체 복사");

      bodyBox.append(
        el("p", {
          className: "field-hint message-full-meta",
          text: [sender, relayed ? "사용자가 대신 올림" : "", when].filter(Boolean).join(" · "),
        }),
        ...(hasImage ? [el("p", { className: "field-hint message-full-meta", text: "첨부 이미지는 대화에서 볼 수 있습니다." })] : []),
        el("div", {}, copyBtn, status),
        content,
      );

      const panel = bodyBox.closest("[role=dialog]");
      panel.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        const controls = [...panel.querySelectorAll("button:not(:disabled), a[href]")];
        const first = controls[0];
        const last = controls.at(-1);
        if (document.activeElement === (event.shiftKey ? first : last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      });
    },
  });
}

/** 새 방 만들기 / 방 이름 바꾸기·삭제 시트 */
export function openRoomCreateSheet(sheets, { trigger, onCreateRoom }) {
  sheets.openSheet({
    title: "새 방 만들기",
    trigger,
    buildBody: (bodyBox, closeSheet) => {
      const input = el("input", {
        id: "new-room-name",
        className: "input",
        type: "text",
        maxlength: "32",
        placeholder: "예: 내 비서들",
        value: "내 비서들",
      });
      const errLine = el("p", { className: "composer-feedback", role: "alert", hidden: true });
      const submitBtn = el("button", { type: "submit", className: "btn btn-primary btn-block" }, "방 만들기");

      const form = el(
        "form",
        {
          className: "doc-list",
          onSubmit: async (e) => {
            e.preventDefault();
            const err = validateNameInput(input.value);
            if (err) {
              errLine.textContent = err;
              errLine.hidden = false;
              return;
            }
            submitBtn.disabled = true;
            errLine.hidden = true;
            try {
              await onCreateRoom(input.value.trim());
              closeSheet();
            } catch (ex) {
              errLine.textContent = errorMessage(ex);
              errLine.hidden = false;
              submitBtn.disabled = false;
            }
          },
        },
        el(
          "div",
          { className: "field" },
          el("label", { className: "field-label", for: "new-room-name", text: "방 이름" }),
          input,
        ),
        errLine,
        submitBtn,
      );
      bodyBox.appendChild(form);
    },
  });
}

export function openRoomManageSheet(sheets, { room, trigger, onRenameRoom, onDeleteRoom }) {
  sheets.openSheet({
    title: "방 설정",
    trigger,
    buildBody: (bodyBox, closeSheet) => {
      const input = el("input", {
        id: "edit-room-name",
        className: "input",
        type: "text",
        maxlength: "32",
        value: room.name,
      });
      const errLine = el("p", { className: "composer-feedback", role: "alert", hidden: true });
      const saveBtn = el("button", { type: "submit", className: "btn btn-primary btn-block" }, "방 이름 저장");

      const renameForm = el(
        "form",
        {
          className: "doc-list",
          onSubmit: async (e) => {
            e.preventDefault();
            const err = validateNameInput(input.value);
            if (err) {
              errLine.textContent = err;
              errLine.hidden = false;
              return;
            }
            saveBtn.disabled = true;
            try {
              await onRenameRoom(room.room_id, input.value.trim());
              closeSheet();
            } catch (ex) {
              errLine.textContent = errorMessage(ex);
              errLine.hidden = false;
              saveBtn.disabled = false;
            }
          },
        },
        el(
          "div",
          { className: "field" },
          el("label", { className: "field-label", for: "edit-room-name", text: "방 이름 변경" }),
          input,
        ),
        saveBtn,
      );

      const delBtn = makeTwoStepButton(
        "이 방 삭제하기",
        "한 번 더 누르면 방을 바로 닫고 대화를 삭제합니다",
        "btn btn-danger btn-block",
        async () => {
          try {
            await onDeleteRoom(room.room_id);
            closeSheet();
          } catch (ex) {
            errLine.textContent = errorMessage(ex);
            errLine.hidden = false;
          }
        },
      );

      bodyBox.append(renameForm, delBtn, el("p", { className: "field-hint",
        text: "삭제하면 참가자 접근이 바로 끊깁니다. 대화가 많은 방의 기록과 이미지는 정기 작업에서 나누어 지웁니다." }), errLine);
    },
  });
}
