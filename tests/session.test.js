"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSessionStore, DEFAULTS, STORAGE_KEY } = require("../session-store.js");

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      writes.push([key, value]);
      values.set(key, String(value));
    }
  };
}

test("新标签页会话默认关闭两个开关，不产生持久化写入", () => {
  const storage = memoryStorage();
  const store = createSessionStore(() => storage);
  assert.deepEqual(DEFAULTS, { reverseEnabled: false, reverseSectionsEnabled: false });
  assert.deepEqual(store.read(), DEFAULTS);
  assert.equal(storage.writes.length, 0);
});

test("刷新后重新创建 store，仍读取同一标签页的两个设置", () => {
  const storage = memoryStorage();
  const beforeRefresh = createSessionStore(() => storage);
  beforeRefresh.write("reverseEnabled", true);
  beforeRefresh.write("reverseSectionsEnabled", true);

  const afterRefresh = createSessionStore(() => storage);
  assert.deepEqual(afterRefresh.read(), { reverseEnabled: true, reverseSectionsEnabled: true });
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), afterRefresh.read());
});

test("不同标签页 storage 独立，重新开始的新会话不继承旧设置", () => {
  const firstStorage = memoryStorage();
  const secondStorage = memoryStorage();
  const first = createSessionStore(() => firstStorage);
  const second = createSessionStore(() => secondStorage);
  first.write("reverseEnabled", true);
  second.write("reverseSectionsEnabled", true);
  assert.deepEqual(first.read(), { reverseEnabled: true, reverseSectionsEnabled: false });
  assert.deepEqual(second.read(), { reverseEnabled: false, reverseSectionsEnabled: true });
  assert.deepEqual(createSessionStore(() => memoryStorage()).read(), DEFAULTS);
});

test("写入单个开关会读取最新值，保留另一开关的变化", () => {
  const storage = memoryStorage();
  const page = createSessionStore(() => storage);
  const popupBridge = createSessionStore(() => storage);
  page.write("reverseEnabled", true);
  assert.deepEqual(popupBridge.write("reverseSectionsEnabled", true), {
    reverseEnabled: true, reverseSectionsEnabled: true
  });
  assert.deepEqual(page.write("reverseEnabled", false), {
    reverseEnabled: false, reverseSectionsEnabled: true
  });
});

test("损坏 JSON、null、数组和标量回退默认值，下一次写入可恢复", () => {
  for (const corrupt of ["{broken", "null", "[]", '["reverseEnabled"]', "true", "42", '"text"']) {
    const storage = memoryStorage({ [STORAGE_KEY]: corrupt });
    const store = createSessionStore(() => storage);
    assert.deepEqual(store.read(), DEFAULTS, corrupt);
    assert.equal(storage.writes.length, 0, "读取损坏设置不会擅自覆盖");
    assert.deepEqual(store.write("reverseSectionsEnabled", true), {
      reverseEnabled: false, reverseSectionsEnabled: true
    });
    assert.deepEqual(store.read(), { reverseEnabled: false, reverseSectionsEnabled: true });
  }
});

test("只接受字面 true，不信任字符串、数字或未知设置字段", () => {
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify({
    reverseEnabled: "true", reverseSectionsEnabled: 1, unrelated: true
  }) });
  const store = createSessionStore(() => storage);
  assert.deepEqual(store.read(), DEFAULTS);
  storage.setItem(STORAGE_KEY, JSON.stringify({ reverseEnabled: true, unrelated: true }));
  assert.deepEqual(store.read(), { reverseEnabled: true, reverseSectionsEnabled: false });
});

test("不改动站点的其它 sessionStorage 键", () => {
  const storage = memoryStorage({ "bilibili-player": "original-player-state", untouched: "keep" });
  const store = createSessionStore(() => storage);
  store.write("reverseEnabled", true);
  store.write("reverseSectionsEnabled", true);
  assert.equal(storage.getItem("bilibili-player"), "original-player-state");
  assert.equal(storage.getItem("untouched"), "keep");
  assert.ok(storage.writes.every(([key]) => key === STORAGE_KEY));
  assert.equal(storage.values.size, 3);
});

test("未知键和非布尔值被拒绝，不向 sessionStorage 写入", () => {
  const storage = memoryStorage();
  const store = createSessionStore(() => storage);
  for (const key of ["unknown", "__proto__", "constructor", "toString", "", null]) {
    assert.throws(() => store.write(key, true), TypeError);
  }
  for (const value of ["true", "false", 0, 1, null, undefined, {}, []]) {
    assert.throws(() => store.write("reverseEnabled", value), TypeError);
  }
  assert.equal(storage.writes.length, 0);
  assert.deepEqual(store.read(), DEFAULTS);
});

test("浏览器禁止访问或读取 sessionStorage 时向调用者报告错误", () => {
  const blocked = new Error("Session storage blocked");
  const unavailable = createSessionStore(() => { throw blocked; });
  assert.throws(() => unavailable.read(), error => error === blocked);
  assert.throws(() => unavailable.write("reverseEnabled", true), error => error === blocked);

  let writes = 0;
  const failingRead = createSessionStore(() => ({
    getItem() { throw blocked; },
    setItem() { writes += 1; }
  }));
  assert.throws(() => failingRead.read(), error => error === blocked);
  assert.throws(() => failingRead.write("reverseSectionsEnabled", true), error => error === blocked);
  assert.equal(writes, 0);
});

test("保存失败会抛出错误，重新读取仍为最后成功保存的值", () => {
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify({
    reverseEnabled: true, reverseSectionsEnabled: false
  }) });
  const quotaError = new Error("Quota exceeded");
  storage.setItem = () => { throw quotaError; };
  const store = createSessionStore(() => storage);
  assert.throws(() => store.write("reverseSectionsEnabled", true), error => error === quotaError);
  assert.deepEqual(store.read(), { reverseEnabled: true, reverseSectionsEnabled: false });
});
