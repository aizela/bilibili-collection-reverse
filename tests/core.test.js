"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isCollection, reverseEpisodes, transformCollection, createOrderBook } = require("../core.js");

function episode(number) {
  return {
    bvid: `BV-test-${number}`,
    title: `第 ${number} 集`,
    pages: [
      { cid: number * 10 + 1, page: 1, part: "上半集" },
      { cid: number * 10 + 2, page: 2, part: "下半集" }
    ]
  };
}

function collection() {
  return {
    id: 795184,
    title: "测试合集",
    sections: [
      { id: "first", title: "第一小节", episodes: [episode(3), episode(2), episode(1)] },
      { id: "second", title: "第二小节", episodes: [episode(5), episode(4)] }
    ]
  };
}

function freezeRecursively(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeRecursively);
    Object.freeze(value);
  }
  return value;
}

function order(value) {
  return value.sections.map(section => section.episodes.map(item => item.bvid));
}

test("反转每个小节的视频，同时保持小节顺序和合集元数据", () => {
  const result = reverseEpisodes(collection());

  assert.deepEqual(result.sections.map(section => section.id), ["first", "second"]);
  assert.deepEqual(result.sections.map(section => section.title), ["第一小节", "第二小节"]);
  assert.deepEqual(order(result), [
    ["BV-test-1", "BV-test-2", "BV-test-3"],
    ["BV-test-4", "BV-test-5"]
  ]);
  assert.equal(result.id, 795184);
  assert.equal(result.title, "测试合集");
});

test("不修改原始数据，即使原数据和所有嵌套数组已冻结也可反转", () => {
  const source = collection();
  const snapshot = structuredClone(source);
  freezeRecursively(source);

  const result = reverseEpisodes(source);

  assert.deepEqual(source, snapshot);
  assert.notStrictEqual(result, source);
  assert.notStrictEqual(result.sections, source.sections);
  result.sections.forEach((section, index) => {
    assert.notStrictEqual(section, source.sections[index]);
    assert.notStrictEqual(section.episodes, source.sections[index].episodes);
  });
});

test("单个视频的分 P 顺序保持不变，不克隆或重写视频对象", () => {
  const source = freezeRecursively(collection());
  const result = reverseEpisodes(source);

  for (let sectionIndex = 0; sectionIndex < source.sections.length; sectionIndex += 1) {
    const before = source.sections[sectionIndex].episodes;
    const after = result.sections[sectionIndex].episodes;
    for (const item of before) {
      const moved = after.find(candidate => candidate.bvid === item.bvid);
      assert.strictEqual(moved, item);
      assert.strictEqual(moved.pages, item.pages);
      assert.deepEqual(moved.pages.map(page => page.page), [1, 2]);
      assert.deepEqual(moved.pages.map(page => page.part), ["上半集", "下半集"]);
    }
  }
});

test("空小节和仅一集的小节不会丢失，也不会改变小节位置", () => {
  const source = freezeRecursively({
    id: 42,
    sections: [
      { id: "empty", episodes: [] },
      { id: "one", episodes: [episode(1)] },
      { id: "many", episodes: [episode(3), episode(2)] }
    ]
  });

  assert.equal(isCollection(source), true);
  const result = reverseEpisodes(source);
  assert.deepEqual(result.sections.map(section => section.id), ["empty", "one", "many"]);
  assert.deepEqual(order(result), [[], ["BV-test-1"], ["BV-test-2", "BV-test-3"]]);
});

test("连续开启、关闭和重新开启都幂等，关闭返回原始对象", () => {
  const source = freezeRecursively(collection());
  const book = createOrderBook();
  const reversed = book.desired(source, true);

  assert.strictEqual(book.original(source), source);
  assert.strictEqual(book.original(reversed), source);
  assert.strictEqual(book.desired(source, false), source);
  assert.strictEqual(book.desired(source, true), reversed);
  assert.strictEqual(book.desired(reversed, true), reversed);

  let current = reversed;
  for (let cycle = 0; cycle < 10; cycle += 1) {
    current = book.desired(current, true);
    assert.strictEqual(current, reversed);
    current = book.desired(current, false);
    assert.strictEqual(current, source);
    assert.strictEqual(book.desired(current, false), source);
    current = book.desired(current, true);
    assert.strictEqual(current, reversed);
  }

  assert.deepEqual(order(current), [
    ["BV-test-1", "BV-test-2", "BV-test-3"],
    ["BV-test-4", "BV-test-5"]
  ]);
});

test("SPA 重新获取同一个合集 ID 的新数据时，独立反转并可恢复新数据", () => {
  const book = createOrderBook();
  const firstLoad = freezeRecursively(collection());
  const firstReversed = book.desired(firstLoad, true);
  const freshLoad = collection();
  freshLoad.sections[1].episodes.unshift(episode(6));
  freezeRecursively(freshLoad);

  const freshReversed = book.desired(freshLoad, true);

  assert.equal(firstLoad.id, freshLoad.id);
  assert.notStrictEqual(freshReversed, firstReversed);
  assert.strictEqual(book.original(freshLoad), freshLoad);
  assert.strictEqual(book.original(freshReversed), freshLoad);
  assert.strictEqual(book.desired(freshReversed, true), freshReversed);
  assert.strictEqual(book.desired(freshReversed, false), freshLoad);
  assert.strictEqual(book.desired(firstReversed, false), firstLoad);
  assert.deepEqual(order(freshReversed)[1], ["BV-test-4", "BV-test-5", "BV-test-6"]);
  assert.deepEqual(order(firstReversed)[1], ["BV-test-4", "BV-test-5"]);
});

test("切换到其它合集不会复用上一合集的顺序或原始数据", () => {
  const book = createOrderBook();
  const firstLoad = freezeRecursively(collection());
  const otherLoad = freezeRecursively({
    id: 99,
    sections: [{ id: "new", episodes: [episode(8), episode(7)] }]
  });
  const firstReversed = book.desired(firstLoad, true);
  const otherReversed = book.desired(otherLoad, true);

  assert.deepEqual(order(otherReversed), [["BV-test-7", "BV-test-8"]]);
  assert.strictEqual(book.original(otherReversed), otherLoad);
  assert.strictEqual(book.original(firstReversed), firstLoad);
  assert.strictEqual(book.desired(otherReversed, false), otherLoad);
});

test("isCollection 拒绝缺失合集 ID、小节或视频数组的无效数据", () => {
  const invalidValues = [
    undefined, null, false, 0, "collection", [], {},
    { sections: [{ episodes: [] }] },
    { id: null, sections: [{ episodes: [] }] },
    { id: 1 },
    { id: 1, sections: null },
    { id: 1, sections: {} },
    { id: 1, sections: [] },
    { id: 1, sections: [null] },
    { id: 1, sections: [{}] },
    { id: 1, sections: [{ episodes: null }] },
    { id: 1, sections: [{ episodes: {} }] },
    { id: 1, sections: [{ episodes: [] }, {}] }
  ];

  for (const value of invalidValues) {
    assert.equal(isCollection(value), false, `应拒绝 ${JSON.stringify(value)}`);
  }
  assert.equal(isCollection(collection()), true);
  assert.equal(isCollection({ id: 1, sections: [{ episodes: [] }] }), true);
});

test("两个开关的四种组合独立控制小节顺序和各小节内的视频", () => {
  const source = freezeRecursively(collection());
  const snapshot = structuredClone(source);
  const cases = [
    { episodes: false, sections: false, sectionIds: ["first", "second"], videos: [["BV-test-3", "BV-test-2", "BV-test-1"], ["BV-test-5", "BV-test-4"]] },
    { episodes: true, sections: false, sectionIds: ["first", "second"], videos: [["BV-test-1", "BV-test-2", "BV-test-3"], ["BV-test-4", "BV-test-5"]] },
    { episodes: false, sections: true, sectionIds: ["second", "first"], videos: [["BV-test-5", "BV-test-4"], ["BV-test-3", "BV-test-2", "BV-test-1"]] },
    { episodes: true, sections: true, sectionIds: ["second", "first"], videos: [["BV-test-4", "BV-test-5"], ["BV-test-1", "BV-test-2", "BV-test-3"]] }
  ];

  for (const scenario of cases) {
    const result = transformCollection(source, scenario.episodes, scenario.sections);
    assert.deepEqual(result.sections.map(section => section.id), scenario.sectionIds);
    assert.deepEqual(order(result), scenario.videos);
    for (const section of result.sections) {
      const originalSection = source.sections.find(item => item.id === section.id);
      assert.equal(section.title, originalSection.title);
      for (const item of section.episodes) {
        const originalEpisode = originalSection.episodes.find(candidate => candidate.bvid === item.bvid);
        assert.strictEqual(item, originalEpisode);
        assert.deepEqual(item.pages.map(page => page.page), [1, 2], "任何组合都不能反转视频分 P");
      }
    }
  }
  assert.deepEqual(source, snapshot, "所有组合均不改变冻结的原始数据");
});

test("四种顺序之间任意切换都基于同一原始数据，重复设置幂等且全部关闭恢复原对象", () => {
  const source = freezeRecursively(collection());
  const book = createOrderBook();
  const modes = [[false, false], [true, false], [false, true], [true, true]];
  const variants = modes.map(([episodes, sections]) => book.desired(source, episodes, sections));

  for (const from of variants) {
    for (let index = 0; index < modes.length; index += 1) {
      const [episodes, sections] = modes[index];
      const result = book.desired(from, episodes, sections);
      assert.strictEqual(result, variants[index], "同一模式必须复用对应快照，不能在当前变体上再次反转");
      assert.strictEqual(book.desired(result, episodes, sections), result);
      assert.strictEqual(book.original(result), source);
      assert.strictEqual(book.desired(result, false, false), source);
    }
  }
  assert.deepEqual(order(variants[2]), [["BV-test-5", "BV-test-4"], ["BV-test-3", "BV-test-2", "BV-test-1"]]);
  assert.deepEqual(order(variants[3]), [["BV-test-4", "BV-test-5"], ["BV-test-1", "BV-test-2", "BV-test-3"]]);
});

test("两种倒序开启时 SPA 同 ID 新数据仍独立处理并恢复新原始快照", () => {
  const book = createOrderBook();
  const oldSource = freezeRecursively(collection());
  const oldResult = book.desired(oldSource, true, true);
  const source = collection();
  source.sections[1].episodes.unshift(episode(6));
  freezeRecursively(source);

  const result = book.desired(source, true, true);
  assert.deepEqual(result.sections.map(section => section.id), ["second", "first"]);
  assert.deepEqual(order(result)[0], ["BV-test-4", "BV-test-5", "BV-test-6"]);
  assert.notStrictEqual(result, oldResult);
  assert.strictEqual(book.desired(result, false, false), source);
  assert.strictEqual(book.desired(oldResult, false, false), oldSource);
});
