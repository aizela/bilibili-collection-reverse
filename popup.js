"use strict";

(() => {
  const controls = [
    { key: "reverseEnabled", id: "reverse-enabled" },
    { key: "reverseSectionsEnabled", id: "reverse-sections-enabled" }
  ].map(control => ({ ...control, input: document.getElementById(control.id),
    saved: false, revision: 0, loaded: false, saving: false }));
  const defaults = Object.fromEntries(controls.map(control => [control.key, false]));
  const status = document.getElementById("status");
  let errorMessage = "";

  function render() {
    for (const control of controls) {
      control.input.checked = control.saved;
      control.input.disabled = !control.loaded || control.saving;
    }
    const videos = controls[0].saved;
    const sections = controls[1].saved;
    status.dataset.enabled = String(videos || sections);
    status.dataset.error = String(Boolean(errorMessage));
    status.textContent = errorMessage ||
      (controls.some(control => !control.loaded) ? "正在读取设置…" :
        controls.some(control => control.saving) ? "正在保存…" :
          videos && sections ? "已开启 · 小节与小节内视频均已反转" :
            videos ? "已开启 · 仅反转小节内视频" :
              sections ? "已开启 · 仅反转小节顺序" : "已关闭 · 使用B站原始顺序");
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    let changed = false;
    for (const control of controls) {
      if (!Object.hasOwn(changes, control.key)) continue;
      control.revision += 1;
      control.saved = changes[control.key].newValue === true;
      control.loaded = true;
      changed = true;
    }
    if (changed) {
      errorMessage = "";
      render();
    }
  });

  for (const control of controls) {
    control.input.addEventListener("change", async () => {
      const requestedValue = control.input.checked;
      control.saving = true;
      errorMessage = "";
      render();
      try {
        // Write only this switch, preserving concurrent changes to the other.
        await chrome.storage.local.set({ [control.key]: requestedValue });
        const startedAt = control.revision;
        const settings = await chrome.storage.local.get({ [control.key]: false });
        // Newer onChanged events take precedence over an earlier read snapshot.
        if (control.revision === startedAt) control.saved = settings[control.key] === true;
      } catch (error) {
        errorMessage = "设置保存失败，请关闭弹窗后重试。";
        console.error("B站合集反转：保存设置失败", error);
      } finally {
        control.saving = false;
        render();
      }
    });
  }

  (async () => {
    const revisions = controls.map(control => control.revision);
    try {
      const settings = await chrome.storage.local.get(defaults);
      controls.forEach((control, index) => {
        if (control.revision === revisions[index]) control.saved = settings[control.key] === true;
        control.loaded = true;
      });
    } catch (error) {
      errorMessage = "无法读取设置，请重新打开扩展弹窗。";
      console.error("B站合集反转：读取设置失败", error);
    }
    render();
  })();
})();
