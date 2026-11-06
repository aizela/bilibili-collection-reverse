(function () {
  "use strict";
  const CHANNEL = "bili-collection-reverse-v1";
  const defaults = { reverseEnabled: false, reverseSectionsEnabled: false };
  const settings = { ...defaults };
  const revisions = { reverseEnabled: 0, reverseSectionsEnabled: 0 };
  const controls = new Map();
  let loaded = false;
  let status = { state: "waiting" };
  let host;
  let caption;
  let saving = false;

  function publish() {
    if (loaded) window.postMessage({
      channel: CHANNEL, from: "extension", type: "settings",
      enabled: settings.reverseEnabled,
      reverseSectionsEnabled: settings.reverseSectionsEnabled
    }, location.origin);
  }

  function paint() {
    if (!caption) return;
    for (const [key, toggle] of controls) {
      toggle.setAttribute("aria-checked", String(settings[key]));
      toggle.disabled = !loaded || saving;
    }
    if (status.state === "error" || status.state === "unsupported") caption.textContent = status.detail;
    else if (status.state === "ready") {
      const labels = [];
      if (settings.reverseEnabled) labels.push("视频已反转");
      if (settings.reverseSectionsEnabled) labels.push("小节已反转");
      caption.textContent = labels.length ? labels.join(" · ") : "原始顺序";
    } else caption.textContent = "等待合集加载…";
    caption.dataset.error = String(status.state === "unsupported" || status.state === "error");
  }

  async function readSettings() {
    const before = { ...revisions };
    const current = await chrome.storage.local.get(defaults);
    for (const key of Object.keys(defaults)) {
      if (revisions[key] === before[key]) settings[key] = current[key] === true;
    }
    loaded = true;
    publish();
    paint();
  }

  function mount() {
    const header = document.querySelector(".video-pod .video-pod__header");
    if (!header) return;
    if (host?.parentElement === header) return;
    if (!host) {
      host = document.createElement("div");
      host.id = "bili-reverse-toggle";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `<style>
        :host{display:block;margin-top:12px;font-family:inherit;color:var(--text1,#18191c)}
        .panel{padding:0 11px 8px;border:1px solid var(--line_regular,#e3e5e7);border-radius:8px;background:var(--bg1,#fff)}
        .row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 0}
        .row+.row{border-top:1px solid var(--line_regular,#e3e5e7)}
        strong{display:block;font-size:13px;font-weight:500;line-height:18px}small{display:block;font-size:11px;color:var(--text3,#9499a0);margin-top:2px;line-height:16px}small[data-error=true]{color:#b66312}
        button{flex:0 0 auto;width:36px;height:21px;border:0;border-radius:99px;background:#b8bdc5;padding:3px;cursor:pointer;transition:background .16s}
        button::before{content:"";display:block;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0002;transition:transform .16s}
        button[aria-checked=true]{background:#00aeec}button[aria-checked=true]::before{transform:translateX(15px)}
        button:focus-visible{outline:2px solid #00aeec;outline-offset:3px}button:disabled{opacity:.5;cursor:wait}
        @media(prefers-reduced-motion:reduce){button,button::before{transition:none}}
      </style><div class="panel">
        <div class="row"><strong>反转小节内视频</strong><button data-setting="reverseEnabled" type="button" role="switch" aria-label="反转小节内视频" aria-checked="false" title="反转各小节内的视频顺序，自动保存"></button></div>
        <div class="row"><strong>反转小节顺序</strong><button data-setting="reverseSectionsEnabled" type="button" role="switch" aria-label="反转小节顺序" aria-checked="false" title="反转上方小节标签及对应播放顺序，自动保存"></button></div>
        <small aria-live="polite"></small>
      </div>`;
      caption = shadow.querySelector("small");
      for (const toggle of shadow.querySelectorAll("button[data-setting]")) {
        const key = toggle.dataset.setting;
        controls.set(key, toggle);
        toggle.addEventListener("click", async () => {
          saving = true;
          paint();
          try {
            // Write only this toggle so another tab's independent setting survives.
            await chrome.storage.local.set({ [key]: !settings[key] });
            await readSettings();
          } catch (_) {
            status = { state: "error", detail: "设置保存失败，请刷新页面后重试" };
          } finally {
            saving = false;
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

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let changed = false;
    for (const key of Object.keys(defaults)) {
      if (!Object.hasOwn(changes, key)) continue;
      revisions[key] += 1;
      settings[key] = changes[key].newValue === true;
      changed = true;
    }
    if (changed) {
      publish();
      paint();
    }
  });
  readSettings().catch(() => {
    status = { state: "error", detail: "无法读取扩展设置，请刷新页面" };
    paint();
  });

  mount();
  window.setInterval(mount, 800);
})();
