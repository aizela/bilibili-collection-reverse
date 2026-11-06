(function () {
  "use strict";
  const CHANNEL = "bili-collection-reverse-v1";
  const { DEFAULTS: defaults, STORAGE_KEY, createSessionStore } = window.__BILI_REVERSE_SESSION_V1__;
  const session = createSessionStore(() => window.sessionStorage);
  const settings = { ...defaults };
  let revision = 0;
  const controls = new Map();
  let loaded = false;
  let status = { state: "waiting" };
  let host;

  function publish() {
    if (loaded) window.postMessage({
      channel: CHANNEL, from: "extension", type: "settings",
      enabled: settings.reverseEnabled,
      reverseSectionsEnabled: settings.reverseSectionsEnabled
    }, location.origin);
  }

  function paint() {
    const error = status.state === "error" || status.state === "unsupported";
    for (const [key, toggle] of controls) {
      toggle.setAttribute("aria-checked", String(settings[key]));
      toggle.disabled = !loaded;
      toggle.title = error ? status.detail : toggle.dataset.help;
    }
  }

  function snapshot() {
    return { ok: true, settings: { ...settings }, revision };
  }

  function accept(current) {
    Object.assign(settings, current);
    revision += 1;
    loaded = true;
    publish();
    paint();
    // A popup belongs to the extension origin; it must use this content script
    // to read the active tab's session rather than its own sessionStorage.
    try {
      chrome.runtime.sendMessage({ channel: CHANNEL, type: "settings-changed", ...snapshot() }).catch(() => {});
    } catch (_) { /* A closed popup or a reloaded extension cannot undo a saved session. */ }
  }

  function readSettings() {
    accept(session.read());
    return snapshot();
  }

  function saveSetting(key, value) {
    accept(session.write(key, value));
    return snapshot();
  }

  function mount() {
    const header = document.querySelector(".video-pod .video-pod__header");
    // Server-rendered HTML exists before Vue has adopted it. Inserting a
    // child then can invalidate hydration and rebuild unrelated page UI.
    // The MAIN script marks this exact node only after Vue finishes mounting.
    if (header?.getAttribute("data-bili-reverse-ready") !== "true") return;
    if (host?.parentElement === header) return;
    if (!host) {
      host = document.createElement("div");
      host.id = "bili-reverse-toggle";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `<style>
        :host{display:block;margin-top:12px;font-family:inherit;color:var(--text1,#18191c)}
        .panel{padding:0 11px;border:1px solid var(--line_regular,#e3e5e7);border-radius:8px;background:var(--bg1,#fff)}
        .row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 0}
        .row+.row{border-top:1px solid var(--line_regular,#e3e5e7)}
        strong{display:block;font-size:13px;font-weight:500;line-height:18px}
        button{flex:0 0 auto;width:36px;height:21px;border:0;border-radius:99px;background:#b8bdc5;padding:3px;cursor:pointer;transition:background .16s}
        button::before{content:"";display:block;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0002;transition:transform .16s}
        button[aria-checked=true]{background:#00aeec}button[aria-checked=true]::before{transform:translateX(15px)}
        button:focus-visible{outline:2px solid #00aeec;outline-offset:3px}button:disabled{opacity:.5;cursor:wait}
        @media(prefers-reduced-motion:reduce){button,button::before{transition:none}}
      </style><div class="panel">
        <div class="row"><strong>反转小节内视频</strong><button data-setting="reverseEnabled" type="button" role="switch" aria-label="反转小节内视频" aria-checked="false" title="反转各小节内的视频，仅在当前标签页会话保存"></button></div>
        <div class="row"><strong>反转小节顺序</strong><button data-setting="reverseSectionsEnabled" type="button" role="switch" aria-label="反转小节顺序" aria-checked="false" title="反转上方小节及播放顺序，仅在当前标签页会话保存"></button></div>
      </div>`;
      for (const toggle of shadow.querySelectorAll("button[data-setting]")) {
        const key = toggle.dataset.setting;
        toggle.dataset.help = toggle.title;
        controls.set(key, toggle);
        toggle.addEventListener("click", () => {
          try {
            saveSetting(key, !settings[key]);
          } catch (_) {
            status = { state: "error", detail: "设置保存失败，请刷新页面后重试" };
            paint();
          }
        });
      }
    }
    header.appendChild(host);
    paint();
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.channel !== CHANNEL || data.from !== "page") return;
    if (data.type === "ready") publish();
    if (data.type === "status" && ["ready", "none", "waiting", "unsupported"].includes(data.state)) {
      status = { state: data.state, detail: typeof data.detail === "string" ? data.detail.slice(0, 120) : "" };
      paint();
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== CHANNEL) return;
    if (!["get-settings", "set-setting"].includes(message.type)) return;
    try {
      const result = message.type === "get-settings"
        ? readSettings()
        : saveSetting(message.key, message.value);
      sendResponse(result);
    } catch (_) {
      sendResponse({ ok: false, error: "无法访问本标签页的会话设置，请刷新页面后重试。" });
    }
  });

  // sessionStorage storage events only concern the same top-level session.
  // Ordinary separate tabs cannot overwrite one another's preferences.
  window.addEventListener("storage", event => {
    try {
      if ((event.key === STORAGE_KEY || event.key === null) && event.storageArea === window.sessionStorage) readSettings();
    } catch (_) { /* A later popup read or click will report the access failure. */ }
  });
  try {
    readSettings();
  } catch (_) {
    status = { state: "error", detail: "无法读取扩展设置，请刷新页面" };
    paint();
  }

  mount();
  window.setInterval(mount, 800);
})();
