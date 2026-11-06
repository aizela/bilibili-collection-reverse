"use strict";

(() => {
  const CHANNEL = "bili-collection-reverse-v1";
  const controls = [
    { key: "reverseEnabled", id: "reverse-enabled" },
    { key: "reverseSectionsEnabled", id: "reverse-sections-enabled" }
  ].map(control => ({ ...control, input: document.getElementById(control.id), saved: false }));
  const status = document.getElementById("status");
  const unavailableMessage = "请打开B站视频页；若已打开请刷新后重试。";
  let targetTabId = null;
  let revision = -1;
  let loaded = false;
  let saving = false;
  let errorMessage = "";

  function render() {
    for (const control of controls) {
      control.input.checked = control.saved;
      control.input.disabled = !loaded || saving;
    }
    const videos = controls[0].saved;
    const sections = controls[1].saved;
    status.dataset.enabled = String(videos || sections);
    status.dataset.error = String(Boolean(errorMessage));
    status.textContent = errorMessage ||
      (!loaded ? "正在读取本标签页设置…" : saving ? "正在保存…" :
        videos && sections ? "本标签页 · 小节与视频均已反转" :
          videos ? "本标签页 · 仅反转小节内视频" :
            sections ? "本标签页 · 仅反转小节顺序" : "本标签页 · 使用B站原始顺序");
  }

  function acceptSnapshot(data) {
    if (!data || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
        !controls.every(control => typeof data.settings?.[control.key] === "boolean")) return false;
    if (data.revision < revision) return true;
    revision = data.revision;
    for (const control of controls) control.saved = data.settings[control.key];
    loaded = true;
    errorMessage = "";
    render();
    return true;
  }

  async function request(type, payload = {}) {
    // The popup has a different origin; only the content script can access the
    // Bilibili tab's sessionStorage. Never store settings in the popup itself.
    const response = await chrome.tabs.sendMessage(targetTabId, { channel: CHANNEL, type, ...payload });
    if (response?.ok === false) {
      errorMessage = typeof response.error === "string" ? response.error.slice(0, 160) : "无法保存本标签页设置。";
      render();
      return false;
    }
    if (response?.ok !== true || !acceptSnapshot(response)) throw new Error("Invalid tab settings response");
    return true;
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || !Number.isInteger(targetTabId) || sender.tab?.id !== targetTabId ||
        message?.channel !== CHANNEL || message.type !== "settings-changed") return;
    acceptSnapshot(message);
  });

  for (const control of controls) {
    control.input.addEventListener("change", async () => {
      if (!loaded || saving) return;
      const requestedValue = control.input.checked;
      saving = true;
      errorMessage = "";
      render();
      try {
        await request("set-setting", { key: control.key, value: requestedValue });
      } catch (error) {
        loaded = false;
        errorMessage = unavailableMessage;
        console.error("B站合集反转：无法连接当前标签页", error);
      } finally {
        saving = false;
        render();
      }
    });
  }

  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!Number.isInteger(tab?.id)) throw new Error("No active tab");
      targetTabId = tab.id;
      await request("get-settings");
    } catch (error) {
      // A live notification may already have supplied a newer valid snapshot.
      if (!loaded) errorMessage = unavailableMessage;
      console.error("B站合集反转：无法读取当前标签页设置", error);
    }
    render();
  })();
})();
