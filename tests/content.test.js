"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { STORAGE_KEY } = require("../session-store.js");

const source = ["session-store.js", "content.js"]
  .map(file => [file, fs.readFileSync(path.join(__dirname, "..", file), "utf8")]);
const CHANNEL = "bili-collection-reverse-v1";
const EXTENSION_ID = "reverse-test-extension";
const DEFAULTS = { reverseEnabled: false, reverseSectionsEnabled: false };
const plain = value => JSON.parse(JSON.stringify(value));

function storage() {
  const items = new Map();
  return {
    items, failRead: false, failWrite: false,
    getItem(key) {
      if (this.failRead) throw new Error("Session storage unavailable");
      return items.get(key) ?? null;
    },
    setItem(key, value) {
      if (this.failWrite) throw new Error("Session storage quota exceeded");
      items.set(key, String(value));
    }
  };
}

function harness(sessionStorage = storage(), { rejectNotifications = false, document = { querySelector() { return null; } } } = {}) {
  const runtimeListeners = [];
  const events = new Map();
  const bridge = [];
  const notifications = [];
  const intervals = [];
  const sandbox = {
    sessionStorage,
    location: { origin: "https://www.bilibili.com" },
    document,
    chrome: {
      // Deliberately omit chrome.storage. All preferences belong to the tab.
      runtime: {
        id: EXTENSION_ID,
        onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
        sendMessage(message) {
          notifications.push(plain(message));
          return rejectNotifications ? Promise.reject(new Error("No popup open")) : Promise.resolve();
        }
      }
    },
    addEventListener(type, listener) {
      if (!events.has(type)) events.set(type, []);
      events.get(type).push(listener);
    },
    postMessage(message, origin) { bridge.push({ message: plain(message), origin }); },
    setInterval(callback) { intervals.push(callback); return intervals.length; }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const [filename, script] of source) vm.runInContext(script, context, { filename });

  return {
    sessionStorage, bridge, notifications,
    request(type, extra = {}, sender = { id: EXTENSION_ID }) {
      let response;
      for (const listener of runtimeListeners) {
        listener({ channel: CHANNEL, type, ...extra }, sender, value => { response = plain(value); });
      }
      return response;
    },
    set(key, value) { return this.request("set-setting", { key, value }); },
    get() { return this.request("get-settings"); },
    tick() { for (const callback of intervals) callback(); },
    emit(type, data) {
      for (const listener of events.get(type) || []) listener(data);
    }
  };
}

test("a fresh tab publishes disabled defaults without chrome.storage or persistent writes", () => {
  const h = harness();
  assert.equal(h.sessionStorage.items.size, 0);
  assert.deepEqual(h.get().settings, DEFAULTS);
  assert.deepEqual(h.bridge[0], {
    origin: "https://www.bilibili.com",
    message: { channel: CHANNEL, from: "extension", type: "settings", enabled: false, reverseSectionsEnabled: false }
  });
});

test("popup requests independently save both switches and synchronize the MAIN world bridge", () => {
  const h = harness();
  const first = h.set("reverseEnabled", true);
  assert.equal(first.ok, true);
  assert.deepEqual(first.settings, { reverseEnabled: true, reverseSectionsEnabled: false });
  const second = h.set("reverseSectionsEnabled", true);
  assert.ok(second.revision > first.revision);
  assert.deepEqual(second.settings, { reverseEnabled: true, reverseSectionsEnabled: true });
  assert.deepEqual(JSON.parse(h.sessionStorage.getItem(STORAGE_KEY)), second.settings);
  assert.deepEqual(h.bridge.at(-1).message, {
    channel: CHANNEL, from: "extension", type: "settings", enabled: true, reverseSectionsEnabled: true
  });
  assert.deepEqual(h.notifications.at(-1).settings, second.settings);
  const third = h.set("reverseEnabled", false);
  assert.deepEqual(third.settings, { reverseEnabled: false, reverseSectionsEnabled: true });
});

test("reloading a tab reuses its session, while a new session starts disabled", () => {
  const sharedSession = storage();
  harness(sharedSession).set("reverseEnabled", true);
  const reloaded = harness(sharedSession);
  assert.deepEqual(reloaded.get().settings, { reverseEnabled: true, reverseSectionsEnabled: false });
  const newTab = harness();
  assert.deepEqual(newTab.get().settings, DEFAULTS);
  newTab.set("reverseSectionsEnabled", true);
  assert.deepEqual(reloaded.get().settings, { reverseEnabled: true, reverseSectionsEnabled: false });
  assert.deepEqual(newTab.get().settings, { reverseEnabled: false, reverseSectionsEnabled: true });
});

test("messages from another extension, unrelated channels and message types are ignored", () => {
  const h = harness();
  const before = h.bridge.length;
  assert.equal(h.request("set-setting", { key: "reverseEnabled", value: true }, { id: "other-extension" }), undefined);
  assert.equal(h.request("get-settings", { channel: "other-channel" }), undefined);
  assert.equal(h.request("clear-session"), undefined);
  assert.equal(h.bridge.length, before);
  assert.equal(h.sessionStorage.items.size, 0);
});

test("invalid setting keys and values return errors and never publish or write", () => {
  const h = harness();
  const before = h.bridge.length;
  for (const [key, value] of [["unknown", true], ["__proto__", true], ["reverseEnabled", "true"], ["reverseSectionsEnabled", 1]]) {
    const response = h.set(key, value);
    assert.equal(response.ok, false);
    assert.equal(typeof response.error, "string");
  }
  assert.equal(h.bridge.length, before);
  assert.equal(h.sessionStorage.items.size, 0);
  assert.deepEqual(h.get().settings, DEFAULTS);
});

test("a failed session write keeps the last settings and bridge unchanged", () => {
  const h = harness();
  h.set("reverseEnabled", true);
  const before = h.bridge.length;
  const saved = h.sessionStorage.getItem(STORAGE_KEY);
  h.sessionStorage.failWrite = true;
  const result = h.set("reverseSectionsEnabled", true);
  assert.equal(result.ok, false);
  assert.equal(h.bridge.length, before);
  assert.equal(h.sessionStorage.getItem(STORAGE_KEY), saved);
  assert.deepEqual(h.get().settings, { reverseEnabled: true, reverseSectionsEnabled: false });
});

test("blocked sessionStorage returns an error without applying guessed settings", () => {
  const blocked = storage();
  blocked.failRead = true;
  const h = harness(blocked);
  assert.equal(h.bridge.length, 0);
  assert.equal(h.get().ok, false);
  assert.equal(h.set("reverseEnabled", true).ok, false);
  assert.equal(blocked.items.size, 0);
  assert.equal(h.bridge.length, 0);
});

test("same-session storage events refresh preferences but foreign storage events are ignored", () => {
  const h = harness();
  const saved = { reverseEnabled: true, reverseSectionsEnabled: true };
  h.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  const before = h.bridge.length;
  h.emit("storage", { key: STORAGE_KEY, storageArea: storage() });
  h.emit("storage", { key: "other-site-key", storageArea: h.sessionStorage });
  assert.equal(h.bridge.length, before);
  h.emit("storage", { key: STORAGE_KEY, storageArea: h.sessionStorage });
  assert.equal(h.bridge.length, before + 1);
  assert.deepEqual(h.notifications.at(-1).settings, saved);
});

test("settings work when no popup is open and runtime notifications reject", async () => {
  const h = harness(storage(), { rejectNotifications: true });
  assert.equal(h.set("reverseEnabled", true).ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.get().settings.reverseEnabled, true);
});

function pageFixture() {
  const navigation = { textContent: "首页 搜索 消息 投稿" };
  let created = 0;
  function header() {
    return {
      ready: false,
      children: [{ textContent: "合集标题" }, { textContent: "简介 订阅合集" }],
      getAttribute(name) {
        assert.equal(name, "data-bili-reverse-ready");
        return this.ready ? "true" : null;
      },
      appendChild(child) {
        if (child.parentElement) {
          const siblings = child.parentElement.children;
          siblings.splice(siblings.indexOf(child), 1);
        }
        this.children.push(child);
        child.parentElement = this;
      }
    };
  }
  const page = {
    navigation, header: header(),
    get created() { return created; },
    replaceHeader() { this.header = header(); },
    document: {
      querySelector(selector) {
        assert.equal(selector, ".video-pod .video-pod__header");
        return page.header;
      },
      createElement(tag) {
        assert.equal(tag, "div");
        created += 1;
        return {
          parentElement: null,
          attachShadow({ mode }) {
            assert.equal(mode, "open");
            const buttons = Object.keys(DEFAULTS).map(key => ({
              dataset: { setting: key }, title: "help", attributes: {},
              setAttribute(name, value) { this.attributes[name] = value; },
              addEventListener() {}
            }));
            this.shadowRoot = {
              innerHTML: "", buttons,
              querySelectorAll(selector) {
                assert.equal(selector, "button[data-setting]");
                return buttons;
              }
            };
            return this.shadowRoot;
          }
        };
      }
    }
  };
  return page;
}

test("server-rendered collection markup stays untouched until MAIN confirms Vue mounting", () => {
  const page = pageFixture();
  const originalChildren = [...page.header.children];
  const h = harness(storage(), { document: page.document });
  h.tick();
  h.set("reverseEnabled", true);
  h.tick();
  assert.equal(page.created, 0, "SSR markup must not receive extension nodes");
  assert.deepEqual(page.header.children, originalChildren);
  assert.equal(page.navigation.textContent, "首页 搜索 消息 投稿");

  page.header.ready = true;
  h.tick();
  h.tick();
  assert.equal(page.created, 1);
  assert.deepEqual(page.header.children.slice(0, 2), originalChildren);
  assert.equal(page.header.children.length, 3);
  const host = page.header.children[2];
  assert.equal(host.id, "bili-reverse-toggle");
  assert.equal(host.shadowRoot.buttons.length, 2);
  assert.equal(host.shadowRoot.buttons[0].attributes["aria-checked"], "true");
  assert.equal(page.navigation.textContent, "首页 搜索 消息 投稿");
});

test("a replacement collection waits for its own mount confirmation", () => {
  const page = pageFixture();
  page.header.ready = true;
  const h = harness(storage(), { document: page.document });
  const oldHeader = page.header;
  const host = oldHeader.children[2];
  page.replaceHeader();
  h.tick();
  assert.equal(page.header.children.length, 2);
  assert.equal(host.parentElement, oldHeader, "old ready state must not authorize a new SSR node");
  page.header.ready = true;
  h.tick();
  assert.equal(page.header.children[2], host);
  assert.equal(oldHeader.children.length, 2);
  assert.equal(page.created, 1);
});
