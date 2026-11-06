(function () {
  "use strict";
  if (window.__BILI_REVERSE_PAGE_V1__) return;
  const core = window.__BILI_REVERSE_CORE_V1__;
  if (!core) return;
  const CHANNEL = "bili-collection-reverse-v1";
  const orderBook = core.createOrderBook();
  let enabled = false;
  let reverseSectionsEnabled = false;
  let context = null;
  let unsubscribe = null;
  let applying = false;
  let lastApplied = null;
  let lastStatus = "";

  function sendStatus(state, detail = "") {
    const data = { channel: CHANNEL, from: "page", type: "status", state, detail, enabled, reverseSectionsEnabled };
    const signature = JSON.stringify(data);
    if (signature === lastStatus) return;
    lastStatus = signature;
    window.postMessage(data, location.origin);
  }

  function discover() {
    const pod = document.querySelector(".video-pod");
    const vm = pod && pod.__vue__;
    if (!vm || !pod.isConnected) return null;
    let root = null;
    // SSR already contains the collection DOM before Vue has hydrated it.
    // Wait for every ancestor so inserting our controls cannot invalidate
    // hydration and cause unrelated components, including navigation, to remount.
    for (let current = vm; current; current = current.$parent) {
      if (current._isMounted !== true || current._isDestroyed) return null;
      if (!root && current.$options?.computed?.ugcMultipEpisodeList && current.$store) root = current;
    }
    if (!root || typeof root.$store.commit !== "function") return null;
    return { pod, vm, root, store: root.$store };
  }

  function bind(next) {
    if (next?.vm === context?.vm && next?.store === context?.store) return;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    context = next;
    lastApplied = null;
    if (next && typeof next.store.subscribe === "function") {
      // Vuex subscribers run before Vue's render/watch queue, so SPA changes
      // see the corrected model before the site's videoData watcher runs.
      unsubscribe = next.store.subscribe(() => reconcile());
    }
  }

  function reconcile() {
    if (applying) return;
    if (!context || !context.pod.isConnected || context.vm._isDestroyed) {
      sendStatus("waiting");
      return;
    }
    const { vm, root, store } = context;
    const info = store.state.sectionsInfo;
    const video = store.state.videoData;
    const seasonId = video?.ugc_season?.id ?? video?.season_id;
    if (!core.isCollection(info) || String(info.id) !== String(seasonId)) {
      sendStatus("none");
      return;
    }
    const player = root.player;
    const kind = window.nano?.InternalKind?.Manuscript;
    if (!player || typeof player.setState !== "function" || kind == null ||
        !Number.isInteger(root.playerListType) || !Array.isArray(root.ugcMultipEpisodeList)) {
      sendStatus("unsupported", "未识别到兼容的播放器，暂未改变顺序");
      return;
    }
    const desired = orderBook.desired(info, enabled, reverseSectionsEnabled);
    const identity = `${store.state.bvid}:${store.state.cid}`;
    if (lastApplied?.info === desired && lastApplied?.player === player &&
        lastApplied?.identity === identity && info === desired) {
      sendStatus("ready");
      return;
    }
    // Disabled and untouched pages need no writes at all.
    if (!enabled && !reverseSectionsEnabled && desired === info && !lastApplied) {
      sendStatus("ready");
      return;
    }
    applying = true;
    const previousSlide = vm.selectedSlide;
    try {
      const selectedId = vm.selectedSlide?.id;
      if (info !== desired) {
        store.commit("setSectionsInfo", desired);
        // Bilibili caches the selected section object independently of the store.
        if (selectedId != null) {
          vm.selectedSlide = vm.podSectionList.find(section => String(section.id) === String(selectedId)) || null;
        }
      }
      // Use the same native queue API as Bilibili's own videoData watcher.
      // This updates next/previous and natural-ended playback together, keeping
      // Bilibili's autoplay, loop, multipart and access-control behavior intact.
      player.setState({
        [kind]: { type: root.playerListType, ugcMultipEpisodeList: root.ugcMultipEpisodeList }
      });
      if (info !== desired && typeof vm.$nextTick === "function") {
        vm.$nextTick(() => {
          if (context?.vm === vm && !vm._isDestroyed && store.state.sectionsInfo === desired) {
            const body = vm.$refs?.podBody;
            if (!body) return;
            const active = Array.from(body.querySelectorAll("[data-key]")).find(item =>
              item.getAttribute("data-key") === String(store.state.bvid));
            // The site's helper skips items marked data-scrolled, even after
            // they move. Reposition only this list, without scrolling the page.
            body.scrollTop = active ? Math.max(0, active.offsetTop - 30) : 0;
          }
        });
      }
      lastApplied = { info: desired, player, identity };
      sendStatus("ready");
    } catch (error) {
      // A changed site API should not leave a reversed list and an old queue.
      if (store.state.sectionsInfo === desired && desired !== info) {
        try {
          store.commit("setSectionsInfo", info);
          vm.selectedSlide = previousSlide?.id != null
            ? vm.podSectionList.find(section => String(section.id) === String(previousSlide.id)) || previousSlide
            : previousSlide;
        } catch (_) { /* site unavailable */ }
      }
      lastApplied = null;
      sendStatus("unsupported", "播放器更新失败，请刷新页面后重试");
      console.warn("[B站合集反转]", error);
    } finally {
      applying = false;
    }
  }

  function refresh() {
    const next = discover();
    if (next) {
      const header = next.pod.querySelector(".video-pod__header");
      if (header && header.getAttribute("data-bili-reverse-ready") !== "true") {
        header.setAttribute("data-bili-reverse-ready", "true");
      }
    }
    bind(next);
    reconcile();
  }

  function onMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.channel !== CHANNEL || data.from !== "extension" || data.type !== "settings" ||
        typeof data.enabled !== "boolean" ||
        (data.reverseSectionsEnabled !== undefined && typeof data.reverseSectionsEnabled !== "boolean")) return;
    enabled = data.enabled;
    reverseSectionsEnabled = data.reverseSectionsEnabled === true;
    lastStatus = "";
    refresh();
  }

  window.addEventListener("message", onMessage);
  // The interval discovers late mounting/replacement without observing every
  // danmaku/comment mutation. Queue updates themselves are identity guarded.
  const timer = window.setInterval(refresh, 800);
  Object.defineProperty(window, "__BILI_REVERSE_PAGE_V1__", {
    configurable: true,
    value: {
      destroy() {
        enabled = false;
        reverseSectionsEnabled = false;
        reconcile();
        if (unsubscribe) unsubscribe();
        window.clearInterval(timer);
        window.removeEventListener("message", onMessage);
        delete window.__BILI_REVERSE_PAGE_V1__;
      }
    }
  });
  refresh();
  window.postMessage({ channel: CHANNEL, from: "page", type: "ready" }, location.origin);
})();
