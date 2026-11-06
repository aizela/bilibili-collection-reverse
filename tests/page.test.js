"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../core.js");

const pageSource = fs.readFileSync(path.join(__dirname, "..", "page.js"), "utf8");
const ORIGIN = "https://www.bilibili.com";
const CHANNEL = "bili-collection-reverse-v1";

function collection(id = 44, prefix = "") {
  return {
    id,
    sections: [
      { id: 11, title: "First section", episodes: [3, 2, 1].map(n => ({ bvid: `${prefix}A${n}`, pages: [{ cid: n * 10 }, { cid: n * 10 + 1 }] })) },
      { id: 22, title: "Second section", episodes: [2, 1].map(n => ({ bvid: `${prefix}B${n}`, pages: [{ cid: 100 + n }] })) }
    ]
  };
}

function ids(info) {
  return Array.from(info.sections, section => Array.from(section.episodes, episode => episode.bvid));
}

function makePlayer() {
  return {
    calls: [],
    fail: false,
    queue: null,
    setState(value) {
      this.calls.push(value);
      if (this.fail) throw new Error("Simulated incompatible player API");
      this.queue = value.manuscript.ugcMultipEpisodeList;
    }
  };
}

function harness(initial = collection(), setup = () => {}) {
  const subscribers = new Set();
  const messageListeners = new Set();
  const timers = new Set();
  const messages = [];
  const commits = [];
  const warnings = [];
  const store = {
    state: { sectionsInfo: initial, videoData: { ugc_season: { id: initial.id } }, bvid: "A1", cid: 10 },
    subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); },
    notify() { for (const callback of [...subscribers]) callback(); },
    commit(type, value) {
      assert.equal(type, "setSectionsInfo");
      commits.push(value);
      this.state.sectionsInfo = value;
      this.notify();
    }
  };
  const root = {
    _isMounted: true,
    _isDestroyed: false,
    $options: { computed: { ugcMultipEpisodeList() {} } },
    $store: store,
    playerListType: 2,
    player: makePlayer(),
    get ugcMultipEpisodeList() {
      return store.state.sectionsInfo.sections.flatMap(section => section.episodes);
    }
  };
  const podVm = {
    _isMounted: true,
    $options: {},
    $parent: root,
    _isDestroyed: false,
    selectedSlide: initial.sections[1],
    get podSectionList() { return store.state.sectionsInfo.sections; }
  };
  const headerAttributes = new Map();
  const header = {
    getAttribute(name) { return headerAttributes.get(name) ?? null; },
    setAttribute(name, value) { headerAttributes.set(name, value); }
  };
  const pod = {
    __vue__: podVm, isConnected: true,
    querySelector(selector) { assert.equal(selector, ".video-pod__header"); return header; }
  };
  const window = {
    __BILI_REVERSE_CORE_V1__: core,
    nano: { InternalKind: { Manuscript: "manuscript" } },
    addEventListener(type, callback) { if (type === "message") messageListeners.add(callback); },
    removeEventListener(type, callback) { if (type === "message") messageListeners.delete(callback); },
    postMessage(message) { messages.push(message); },
    setInterval(callback) { timers.add(callback); return callback; },
    clearInterval(callback) { timers.delete(callback); }
  };
  setup({ store, root, podVm, pod, header });
  vm.runInNewContext(pageSource, {
    window,
    document: { querySelector(selector) { assert.equal(selector, ".video-pod"); return pod; } },
    location: { origin: ORIGIN },
    console: { warn(...args) { warnings.push(args); } }
  }, { filename: "page.js" });

  return {
    store, root, podVm, pod, header, window, commits, messages, subscribers, timers, warnings,
    toggle(enabled, reverseSectionsEnabled) {
      for (const listener of [...messageListeners]) listener({
        source: window, origin: ORIGIN,
        data: {
          channel: CHANNEL, from: "extension", type: "settings", enabled,
          ...(reverseSectionsEnabled === undefined ? {} : { reverseSectionsEnabled })
        }
      });
    },
    tick() { for (const callback of [...timers]) callback(); },
    status() { return messages.filter(message => message.type === "status").at(-1); }
  };
}

test("SSR collection markup is untouched until its Vue component has mounted", () => {
  let stateReads = 0;
  const h = harness(collection(), ({ pod, store }) => {
    delete pod.__vue__;
    const state = store.state;
    Object.defineProperty(store, "state", { get() { stateReads += 1; return state; } });
  });
  h.toggle(true, true);
  h.tick();
  assert.equal(h.header.getAttribute("data-bili-reverse-ready"), null);
  assert.equal(h.subscribers.size, 0);
  assert.equal(stateReads, 0);
  assert.equal(h.commits.length, 0);
  assert.equal(h.root.player.calls.length, 0);

  h.pod.__vue__ = h.podVm;
  h.podVm._isMounted = false;
  h.tick();
  assert.equal(h.header.getAttribute("data-bili-reverse-ready"), null);
  assert.equal(h.subscribers.size, 0);
  assert.equal(stateReads, 0);

  h.podVm._isMounted = true;
  h.tick();
  assert.equal(h.header.getAttribute("data-bili-reverse-ready"), "true");
  assert.equal(h.subscribers.size, 1);
  assert.deepEqual(h.root.player.queue.map(episode => episode.bvid), ["B1", "B2", "A1", "A2", "A3"]);
});

test("a mounted collection waits for all ancestors before marking or accessing the site model", () => {
  let stateReads = 0;
  const app = { _isMounted: false, _isDestroyed: false };
  const h = harness(collection(), ({ root, store }) => {
    root.$parent = app;
    const state = store.state;
    Object.defineProperty(store, "state", { get() { stateReads += 1; return state; } });
  });
  h.toggle(true, true);
  h.tick();
  assert.equal(h.header.getAttribute("data-bili-reverse-ready"), null);
  assert.equal(h.subscribers.size, 0);
  assert.equal(stateReads, 0);
  assert.equal(h.commits.length, 0);
  assert.equal(h.root.player.calls.length, 0);

  app._isMounted = true;
  h.tick();
  assert.equal(h.header.getAttribute("data-bili-reverse-ready"), "true");
  assert.equal(h.subscribers.size, 1);
  assert.deepEqual(h.root.player.queue.map(episode => episode.bvid), ["B1", "B2", "A1", "A2", "A3"]);
});

test("destroyed ancestors and disconnected collection nodes are never marked ready", () => {
  for (const setup of [
    ({ root }) => { root._isDestroyed = true; },
    ({ pod }) => { pod.isConnected = false; }
  ]) {
    const h = harness(collection(), setup);
    h.toggle(true, true);
    h.tick();
    assert.equal(h.header.getAttribute("data-bili-reverse-ready"), null);
    assert.equal(h.subscribers.size, 0);
    assert.equal(h.commits.length, 0);
    assert.equal(h.root.player.calls.length, 0);
  }
});

test("enabling reverses each section and the native queue; disabling restores both", () => {
  const original = collection();
  const h = harness(original);
  assert.equal(h.commits.length, 0, "an untouched disabled page must not write the site model");
  assert.equal(h.root.player.calls.length, 0);

  h.toggle(true);
  assert.deepEqual(ids(h.store.state.sectionsInfo), [["A1", "A2", "A3"], ["B1", "B2"]]);
  assert.deepEqual(Array.from(h.store.state.sectionsInfo.sections, section => section.id), [11, 22]);
  assert.deepEqual(h.root.player.queue.map(episode => episode.bvid), ["A1", "A2", "A3", "B1", "B2"]);
  assert.equal(h.root.player.calls[0].manuscript.type, 2);
  assert.equal(h.podVm.selectedSlide, h.store.state.sectionsInfo.sections[1]);
  assert.equal(h.podVm.selectedSlide.id, 22, "the selected section stays selected");
  assert.deepEqual(h.root.player.queue[0].pages.map(page => page.cid), [10, 11], "video parts keep their original order");
  assert.deepEqual(ids(original), [["A3", "A2", "A1"], ["B2", "B1"]], "the original model is unmodified");

  h.toggle(false);
  assert.equal(h.store.state.sectionsInfo, original);
  assert.equal(h.podVm.selectedSlide, original.sections[1]);
  assert.deepEqual(h.root.player.queue.map(episode => episode.bvid), ["A3", "A2", "A1", "B2", "B1"]);
  assert.equal(h.status().state, "ready");
});

test("repeated settings, unrelated store updates and discovery ticks do not reverse again", () => {
  const h = harness();
  h.toggle(true);
  const reversed = h.store.state.sectionsInfo;
  h.toggle(true);
  h.store.notify();
  h.tick();
  assert.equal(h.store.state.sectionsInfo, reversed);
  assert.equal(h.commits.length, 1);
  assert.equal(h.root.player.calls.length, 1, "a stable queue is not reset on every poll");
});

test("a failing player update restores the model and the independently cached selected section", () => {
  const original = collection();
  const h = harness(original);
  const selectedBefore = h.podVm.selectedSlide;
  h.root.player.fail = true;
  h.toggle(true);
  assert.equal(h.store.state.sectionsInfo, original);
  assert.equal(h.podVm.selectedSlide, selectedBefore);
  assert.deepEqual(ids(h.store.state.sectionsInfo), [["A3", "A2", "A1"], ["B2", "B1"]]);
  assert.equal(h.status().state, "unsupported");
  assert.equal(h.warnings.length, 1);

  h.root.player.fail = false;
  h.tick();
  assert.deepEqual(h.root.player.queue.map(episode => episode.bvid), ["A1", "A2", "A3", "B1", "B2"]);
  assert.equal(h.status().state, "ready", "the page can recover when the player becomes usable");
});

test("a failed disable keeps the last working reversed model and selected section", () => {
  const h = harness();
  h.toggle(true);
  const reversed = h.store.state.sectionsInfo;
  const selectedBefore = h.podVm.selectedSlide;
  const queueBefore = h.root.player.queue;
  h.root.player.fail = true;
  h.toggle(false);
  assert.equal(h.store.state.sectionsInfo, reversed);
  assert.equal(h.podVm.selectedSlide, selectedBefore);
  assert.equal(h.root.player.queue, queueBefore);
  assert.equal(h.status().state, "unsupported");
});

test("SPA navigation reverses a newly loaded collection and later restores its own original", () => {
  const h = harness();
  h.toggle(true);
  const next = collection(55, "new-");
  h.store.state.sectionsInfo = next;
  h.store.state.videoData = { ugc_season: { id: next.id } };
  h.store.state.bvid = "new-A1";
  h.store.state.cid = 200;
  h.podVm.selectedSlide = next.sections[0];
  h.store.notify();
  assert.deepEqual(ids(h.store.state.sectionsInfo), [["new-A1", "new-A2", "new-A3"], ["new-B1", "new-B2"]]);
  assert.equal(h.podVm.selectedSlide, h.store.state.sectionsInfo.sections[0]);
  assert.deepEqual(h.root.player.queue.map(episode => episode.bvid), ["new-A1", "new-A2", "new-A3", "new-B1", "new-B2"]);

  h.toggle(false);
  assert.equal(h.store.state.sectionsInfo, next);
  assert.deepEqual(h.root.player.queue.map(episode => episode.bvid), ["new-A3", "new-A2", "new-A1", "new-B2", "new-B1"]);
});

test("a replacement player receives the reversed queue without another list reversal", () => {
  const h = harness();
  h.toggle(true);
  const reversed = h.store.state.sectionsInfo;
  const replacement = makePlayer();
  h.root.player = replacement;
  h.tick();
  assert.equal(h.store.state.sectionsInfo, reversed);
  assert.equal(h.commits.length, 1);
  assert.equal(replacement.calls.length, 1);
  assert.deepEqual(replacement.queue.map(episode => episode.bvid), ["A1", "A2", "A3", "B1", "B2"]);
});

test("a new video identity refreshes the native queue even with the same collection object", () => {
  const h = harness();
  h.toggle(true);
  h.store.state.bvid = "A2";
  h.store.state.cid = 20;
  h.store.notify();
  assert.equal(h.root.player.calls.length, 2);
  assert.equal(h.commits.length, 1);
});

test("incomplete navigation and unsupported players do not alter collection order", () => {
  const original = collection();
  const h = harness(original);
  h.store.state.videoData = { ugc_season: { id: 999 } };
  h.toggle(true);
  assert.equal(h.store.state.sectionsInfo, original);
  assert.equal(h.root.player.calls.length, 0);
  assert.equal(h.status().state, "none");

  h.store.state.videoData = { ugc_season: { id: original.id } };
  h.root.player = null;
  h.tick();
  assert.equal(h.store.state.sectionsInfo, original);
  assert.equal(h.commits.length, 0);
  assert.equal(h.status().state, "unsupported");
});

test("destroy restores original order and removes subscriptions and polling", () => {
  const original = collection();
  const h = harness(original);
  h.toggle(true, true);
  h.window.__BILI_REVERSE_PAGE_V1__.destroy();
  assert.equal(h.store.state.sectionsInfo, original);
  assert.equal(h.podVm.selectedSlide, original.sections[1]);
  assert.equal(h.subscribers.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.window.__BILI_REVERSE_PAGE_V1__, undefined);
});

test("section-only reversal updates the tab order and native queue without reversing episodes", () => {
  const original = collection();
  const h = harness(original);
  h.toggle(false, true);
  assert.deepEqual(Array.from(h.store.state.sectionsInfo.sections, section => section.id), [22, 11]);
  assert.deepEqual(ids(h.store.state.sectionsInfo), [["B2", "B1"], ["A3", "A2", "A1"]]);
  assert.deepEqual(h.root.player.queue.map(episode => episode.bvid), ["B2", "B1", "A3", "A2", "A1"]);
  assert.equal(h.podVm.selectedSlide.id, 22);
  assert.equal(h.podVm.selectedSlide, h.store.state.sectionsInfo.sections[0], "selected section follows its ID after moving");
  assert.equal(h.status().state, "ready");

  h.toggle(false, false);
  assert.equal(h.store.state.sectionsInfo, original);
  assert.equal(h.podVm.selectedSlide, original.sections[1]);
  assert.deepEqual(h.root.player.queue.map(episode => episode.bvid), ["A3", "A2", "A1", "B2", "B1"]);
});

test("the two switches can be changed independently through all modes without losing the selected section", () => {
  const original = collection();
  const h = harness(original);
  const cases = [
    [true, false, [11, 22], ["A1", "A2", "A3", "B1", "B2"]],
    [true, true, [22, 11], ["B1", "B2", "A1", "A2", "A3"]],
    [false, true, [22, 11], ["B2", "B1", "A3", "A2", "A1"]],
    [false, false, [11, 22], ["A3", "A2", "A1", "B2", "B1"]],
    [true, true, [22, 11], ["B1", "B2", "A1", "A2", "A3"]]
  ];
  for (const [episodes, sections, sectionIds, queue] of cases) {
    h.toggle(episodes, sections);
    assert.deepEqual(Array.from(h.store.state.sectionsInfo.sections, section => section.id), sectionIds);
    assert.deepEqual(h.root.player.queue.map(episode => episode.bvid), queue);
    assert.equal(h.podVm.selectedSlide.id, 22);
    assert.equal(h.podVm.selectedSlide, h.store.state.sectionsInfo.sections.find(section => section.id === 22));
    const applied = h.store.state.sectionsInfo;
    const writes = h.root.player.calls.length;
    h.toggle(episodes, sections);
    h.tick();
    assert.equal(h.store.state.sectionsInfo, applied);
    assert.equal(h.root.player.calls.length, writes, "unchanged settings must not reset playback");
  }
  assert.deepEqual(ids(original), [["A3", "A2", "A1"], ["B2", "B1"]]);
});

test("a failed section reversal restores the previous episode-only model and its selected section", () => {
  const h = harness();
  h.toggle(true, false);
  const previous = h.store.state.sectionsInfo;
  const selected = h.podVm.selectedSlide;
  const queue = h.root.player.queue;
  h.root.player.fail = true;
  h.toggle(true, true);
  assert.equal(h.store.state.sectionsInfo, previous);
  assert.equal(h.podVm.selectedSlide, selected);
  assert.equal(h.root.player.queue, queue);
  assert.equal(h.status().state, "unsupported");

  h.root.player.fail = false;
  h.tick();
  assert.deepEqual(Array.from(h.store.state.sectionsInfo.sections, section => section.id), [22, 11]);
  assert.deepEqual(h.root.player.queue.map(episode => episode.bvid), ["B1", "B2", "A1", "A2", "A3"]);
  assert.equal(h.podVm.selectedSlide, h.store.state.sectionsInfo.sections[0]);
});

test("SPA and player replacement preserve both reversal preferences and recover the new original", () => {
  const h = harness();
  h.toggle(true, true);
  const next = collection(88, "new-");
  h.store.state.sectionsInfo = next;
  h.store.state.videoData = { ugc_season: { id: next.id } };
  h.store.state.bvid = "new-B1";
  h.store.state.cid = 501;
  h.podVm.selectedSlide = next.sections[0];
  h.store.notify();
  assert.deepEqual(Array.from(h.store.state.sectionsInfo.sections, section => section.id), [22, 11]);
  assert.deepEqual(h.root.player.queue.map(episode => episode.bvid), ["new-B1", "new-B2", "new-A1", "new-A2", "new-A3"]);
  assert.equal(h.podVm.selectedSlide, h.store.state.sectionsInfo.sections[1]);
  const transformed = h.store.state.sectionsInfo;
  h.root.player = makePlayer();
  h.tick();
  assert.equal(h.store.state.sectionsInfo, transformed);
  assert.deepEqual(h.root.player.queue.map(episode => episode.bvid), ["new-B1", "new-B2", "new-A1", "new-A2", "new-A3"]);

  h.toggle(false, false);
  assert.equal(h.store.state.sectionsInfo, next);
  assert.equal(h.podVm.selectedSlide, next.sections[0]);
});
