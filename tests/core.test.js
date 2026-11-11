"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Plugin: class {},
      PluginSettingTab: class {},
      Setting: class {},
      Notice: class {},
      MarkdownView: class {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const PluginClass = require("../main.js");
Module._load = originalLoad;

const {
  normalizeWord,
  parseWordSet,
  serializeWordSet,
  buildWordPatternSource,
  buildWordRegex,
  findMatches,
  normalizeHotkey,
  formatHotkey,
  eventToHotkey,
  matchesHotkey,
  normalizeVaultPath,
  isAbsolutePath,
  collectEditorSkipRanges,
  buildEditorDecorations,
  overlapsRanges,
  isEditableTarget,
  WordStore,
} = PluginClass.__test;

test("normalizeWord: 去除首尾标点、引号并转小写", () => {
  assert.equal(normalizeWord("  Decline,  "), "decline");
  assert.equal(normalizeWord("“people’s”"), "people's");
  assert.equal(normalizeWord("(word)"), "word");
  assert.equal(normalizeWord("（word）"), "word");
  assert.equal(normalizeWord("「word」"), "word");
  assert.equal(normalizeWord("word—"), "word");
  assert.equal(normalizeWord("—word"), "word");
  assert.equal(normalizeWord("students'"), "students");
});

test("normalizeWord: 连字符、省略号、Unicode 字母", () => {
  assert.equal(normalizeWord("up-to-date"), "up-to-date");
  assert.equal(normalizeWord("up‑to‑date"), "up-to-date");
  assert.equal(normalizeWord("café"), "café");
  assert.equal(normalizeWord("naïve"), "naïve");
});

test("normalizeWord: 拒绝多词、数字、选项字母、符号", () => {
  assert.equal(normalizeWord("apple juice"), null);
  assert.equal(normalizeWord("1970"), null);
  assert.equal(normalizeWord("A)"), null);
  assert.equal(normalizeWord("36."), null);
  assert.equal(normalizeWord("M.Friedman"), null);
  assert.equal(normalizeWord("C++"), null);
  assert.equal(normalizeWord(""), null);
});

test("parseWordSet: BOM、CRLF、去重、忽略非法行", () => {
  const set = parseWordSet(
    "\uFEFFApple\r\napple\r\n\r\nDécline\r\n36.\r\nA)\r\n",
  );
  assert.deepEqual(Array.from(set).sort(), ["apple", "décline"]);
});

test("serializeWordSet: 字母排序、结尾换行、空集合", () => {
  assert.equal(
    serializeWordSet(new Set(["b", "a", "c"]), true),
    "a\nb\nc\n",
  );
  assert.equal(serializeWordSet(new Set(["b", "a"]), false), "b\na\n");
  assert.equal(serializeWordSet(new Set(), true), "");
});

test("整词匹配: 不匹配更长单词的子串", () => {
  const words = new Set(["work"]);
  assert.deepEqual(findMatches("working", words), []);
  assert.deepEqual(findMatches("homework", words), []);
  assert.equal(findMatches("work", words).length, 1);
  assert.equal(findMatches("WORK", words).length, 1);
  assert.equal(findMatches("work, work's", words).length, 2);
});

test("整词匹配: 长词优先，不把 working 拆成 work", () => {
  const words = new Set(["work", "working"]);
  const matches = findMatches("working", words);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].text.toLowerCase(), "working");
});

test("整词匹配: 弯引号与连字符变体", () => {
  assert.equal(findMatches("people’s", new Set(["people's"])).length, 1);
  assert.equal(findMatches("peoples", new Set(["people's"])).length, 0);
  assert.equal(
    findMatches("up‑to‑date", new Set(["up-to-date"])).length,
    1,
  );
});

test("buildWordPatternSource: 空词集返回 null", () => {
  assert.equal(buildWordPatternSource(new Set()), null);
  assert.equal(buildWordRegex(new Set()), null);
  assert.deepEqual(findMatches("anything", new Set()), []);
});

test("快捷键: 解析、格式化、事件匹配", () => {
  assert.deepEqual(normalizeHotkey({ modifiers: ["Alt"], key: "w" }), {
    modifiers: ["Alt"],
    key: "W",
  });
  assert.equal(formatHotkey({ modifiers: ["Alt"], key: "W" }), "Alt+W");

  const event = {
    ctrlKey: false,
    altKey: true,
    shiftKey: false,
    metaKey: false,
    key: "w",
  };
  assert.deepEqual(eventToHotkey(event), {
    modifiers: ["Alt"],
    key: "W",
  });
  assert.equal(
    matchesHotkey(event, { modifiers: ["Alt"], key: "W" }),
    true,
  );
  assert.equal(
    matchesHotkey(event, { modifiers: ["Ctrl"], key: "W" }),
    false,
  );
  assert.equal(
    matchesHotkey(
      { ...event, shiftKey: true },
      { modifiers: ["Alt"], key: "W" },
    ),
    false,
  );
});

test("快捷键: Space 与功能键", () => {
  const spaceEvent = {
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    key: " ",
    code: "Space",
  };
  assert.deepEqual(eventToHotkey(spaceEvent), {
    modifiers: ["Ctrl"],
    key: "Space",
  });
  assert.equal(
    matchesHotkey(spaceEvent, { modifiers: ["Ctrl"], key: "Space" }),
    true,
  );

  const f2Event = {
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    key: "F2",
  };
  assert.equal(
    matchesHotkey(f2Event, { modifiers: [], key: "F2" }),
    true,
  );
});

test("路径: vault 相对路径规范化", () => {
  assert.equal(normalizeVaultPath("原文\\生词本.txt"), "原文/生词本.txt");
  assert.equal(normalizeVaultPath("./生词本.txt"), "生词本.txt");
  assert.equal(normalizeVaultPath("/生词本.txt"), "生词本.txt");
  assert.throws(() => normalizeVaultPath("../生词本.txt"));
});

test("路径: 绝对路径识别", () => {
  assert.equal(isAbsolutePath("D:\\study\\words.txt"), true);
  assert.equal(isAbsolutePath("D:/study/words.txt"), true);
  assert.equal(isAbsolutePath("\\\\server\\share\\words.txt"), true);
  assert.equal(isAbsolutePath("生词本.txt"), false);
  assert.equal(isAbsolutePath("原文/生词本.txt"), false);
});

test("按键: CM6 编辑器不当作普通输入框，设置输入框仍然跳过", () => {
  const cmContent = {
    classList: { contains: (name) => name === "cm-content" },
  };
  assert.equal(
    isEditableTarget({ closest: () => cmContent }),
    false,
  );

  const input = {
    classList: { contains: () => false },
  };
  assert.equal(
    isEditableTarget({ closest: () => input }),
    true,
  );
  assert.equal(isEditableTarget(null), false);
});

test("WordStore: 去重、排序、写入，以及切换路径前先加载", async () => {
  const files = new Map();
  const plugin = {
    settings: { wordFilePath: "a.txt", sortAlphabetically: true },
    readTextFile: async (path) => files.get(path) || "",
    writeTextFile: async (path, text) => {
      files.set(path, text);
    },
  };

  const store = new WordStore(plugin);
  await store.load();
  assert.equal(await store.add("banana"), true);
  assert.equal(await store.add("apple"), true);
  assert.equal(await store.add("APPLE"), false);
  assert.equal(files.get("a.txt"), "apple\nbanana\n");

  files.set("b.txt", "cherry\n");
  plugin.settings.wordFilePath = "b.txt";
  assert.equal(await store.add("date"), true);
  assert.equal(files.get("b.txt"), "cherry\ndate\n");
  assert.equal(files.get("a.txt"), "apple\nbanana\n");
});

test("WordStore: remove 删除并写回，未收录返回 false", async () => {
  const files = new Map([["a.txt", "apple\nbanana\n"]]);
  const plugin = {
    settings: { wordFilePath: "a.txt", sortAlphabetically: true },
    readTextFile: async (path) => files.get(path) || "",
    writeTextFile: async (path, text) => {
      files.set(path, text);
    },
  };

  const store = new WordStore(plugin);
  await store.load();
  assert.equal(await store.remove("banana"), true);
  assert.equal(files.get("a.txt"), "apple\n");
  assert.equal(await store.remove("banana"), false);
});

test("编辑视图: 跳过 frontmatter、代码、URL、表格、已有高亮", () => {
  const text = [
    "---",
    "tags: [CET4]",
    "---",
    "beneficial and `const work` and decline.",
    "```js",
    "const work = 'beneficial';",
    "```",
    "https://example.com/beneficial",
    "| moderate | decline |",
    "==beneficial== and people",
  ].join("\n");

  const settings = {
    includeCode: false,
    includeTables: false,
    skipExistingHighlights: true,
  };
  const ranges = collectEditorSkipRanges(text, settings);

  const isSkipped = (needle) => {
    const from = text.indexOf(needle);
    return overlapsRanges(from, from + needle.length, ranges);
  };

  assert.equal(isSkipped("tags"), true);
  assert.equal(isSkipped("const work"), true);
  assert.equal(isSkipped("https://example.com/beneficial"), true);
  assert.equal(isSkipped("| moderate | decline |"), true);
  assert.equal(isSkipped("==beneficial=="), true);
  assert.equal(isSkipped("people"), false);
  assert.equal(isSkipped("decline."), false);
});

test("编辑视图: includeCode/includeTables 可关闭跳过", () => {
  const text = "`work`\n| moderate |\n```js\nconst x = 1;\n```\n";
  const ranges = collectEditorSkipRanges(text, {
    includeCode: true,
    includeTables: true,
    skipExistingHighlights: true,
  });
  assert.equal(overlapsRanges(text.indexOf("work"), text.indexOf("work") + 4, ranges), false);
  assert.equal(overlapsRanges(text.indexOf("moderate"), text.indexOf("moderate") + 8, ranges), false);
});

test("编辑视图: buildEditorDecorations 只标记正文生词", () => {
  const text = [
    "---",
    "tags: beneficial",
    "---",
    "",
    "It is beneficial for people.",
    "`beneficial`",
    "```js",
    "const beneficial = 1;",
    "```",
    "https://example.com/beneficial",
  ].join("\n");

  class FakeBuilder {
    constructor() {
      this.ranges = [];
    }
    add(from, to, value) {
      if (from > to) throw new Error("bad range");
      this.ranges.push({ from, to, value });
    }
    finish() {
      return this.ranges;
    }
  }

  const view = {
    state: {
      doc: {
        toString: () => text,
        sliceString: (from, to) => text.slice(from, to),
      },
      field: () => ({
        file: { path: "notes/test.md", extension: "md" },
      }),
    },
    visibleRanges: [{ from: 0, to: text.length }],
  };

  const plugin = {
    settings: {
      includeCode: false,
      includeTables: true,
      skipExistingHighlights: true,
    },
    store: { words: new Set(["beneficial", "people"]) },
    isWordFile: () => false,
  };

  const ranges = buildEditorDecorations(
    view,
    plugin,
    Symbol("editorInfoField"),
    { class: "mark" },
    FakeBuilder,
  );

  assert.equal(ranges.length, 2);
  assert.deepEqual(
    ranges.map((range) => text.slice(range.from, range.to)),
    ["beneficial", "people"],
  );
});
