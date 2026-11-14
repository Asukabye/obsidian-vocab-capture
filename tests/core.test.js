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
  normalizeEntry,
  classifyEntry,
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
  getHighlightName,
  buildHighlightCss,
  WordStore,
} = PluginClass.__test;

test("normalizeEntry: 英文单词去标点、转小写，保留连字符/变音符号", () => {
  assert.equal(normalizeEntry("  Decline,  "), "decline");
  assert.equal(normalizeEntry("“people’s”"), "people's");
  assert.equal(normalizeEntry("(word)"), "word");
  assert.equal(normalizeEntry("（word）"), "word");
  assert.equal(normalizeEntry("「word」"), "word");
  assert.equal(normalizeEntry("word—"), "word");
  assert.equal(normalizeEntry("—word"), "word");
  assert.equal(normalizeEntry("students'"), "students");
  assert.equal(normalizeEntry("up-to-date"), "up-to-date");
  assert.equal(normalizeEntry("up‑to‑date"), "up-to-date");
  assert.equal(normalizeEntry("café"), "café");
  assert.equal(normalizeEntry("naïve"), "naïve");
});

test("normalizeEntry: 英文短语折叠空白、允许跨行", () => {
  assert.equal(normalizeEntry("Give   Up"), "give up");
  assert.equal(normalizeEntry("  in   the\nlong\trun  "), "in the long run");
  assert.equal(normalizeEntry("as a result"), "as a result");
  assert.equal(normalizeEntry("a lot of"), "a lot of");
});

test("normalizeEntry: 中文词语去首尾标点、去内部空白、允许跨行", () => {
  assert.equal(normalizeEntry("人工智能"), "人工智能");
  assert.equal(normalizeEntry("「经济」"), "经济");
  assert.equal(normalizeEntry("人工 智能"), "人工智能");
  assert.equal(normalizeEntry("人工\n智能"), "人工智能");
  assert.equal(normalizeEntry("可持续发展，"), "可持续发展");
});

test("normalizeEntry: 拒绝中文单字、混合脚本、内部标点、超长内容", () => {
  assert.equal(normalizeEntry("的"), null);
  assert.equal(normalizeEntry("经济，危机"), null);
  assert.equal(normalizeEntry("AI技术"), null);
  assert.equal(normalizeEntry("中文English"), null);
  assert.equal(normalizeEntry("give, up"), null);
  assert.equal(normalizeEntry("1970"), null);
  assert.equal(normalizeEntry("A)"), null);
  assert.equal(normalizeEntry("M.Friedman"), null);
  assert.equal(normalizeEntry("C++"), null);
  assert.equal(normalizeEntry(""), null);
  assert.equal(normalizeEntry("one two three four five six seven eight nine ten eleven twelve thirteen"), null);
  assert.equal(normalizeEntry("一二三四五六七八九十一二三四五六七八九十一"), null);
});

test("classifyEntry: 纯汉字为中文，其余为英文词条", () => {
  assert.equal(classifyEntry("人工智能"), "zh");
  assert.equal(classifyEntry("经济"), "zh");
  assert.equal(classifyEntry("beneficial"), "en");
  assert.equal(classifyEntry("give up"), "en");
});

test("parseWordSet: 中英混合词表、BOM、CRLF、去重、忽略非法行", () => {
  const set = parseWordSet(
    "\uFEFFApple\r\napple\r\ngive up\r\nGive   Up\r\n人工智能\r\n人工 智能\r\n36.\r\nAI技术\r\n",
  );
  assert.deepEqual(
    Array.from(set).sort(),
    ["apple", "give up", "人工智能"],
  );
});

test("serializeWordSet: 排序、结尾换行、空集合", () => {
  assert.equal(
    serializeWordSet(new Set(["b", "a", "c"]), true),
    "a\nb\nc\n",
  );
  assert.equal(serializeWordSet(new Set(["b", "a"]), false), "b\na\n");
  assert.equal(serializeWordSet(new Set(), true), "");
});

test("整词匹配: 英文不匹配更长单词的子串", () => {
  const words = new Set(["work"]);
  assert.deepEqual(findMatches("working", words), []);
  assert.deepEqual(findMatches("homework", words), []);
  assert.equal(findMatches("work", words).length, 1);
  assert.equal(findMatches("WORK", words).length, 1);
  assert.equal(findMatches("work, work's", words).length, 2);
});

test("整词匹配: 英文长词优先，不把 working 拆成 work", () => {
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

test("短语匹配: 大小写、多个空格、跨行、相邻中文", () => {
  const set = new Set(["give up"]);
  assert.equal(findMatches("give up", set).length, 1);
  assert.equal(findMatches("Give   Up", set).length, 1);
  assert.equal(findMatches("give\nup", set).length, 1);
  assert.equal(findMatches("使用 give up 方法", set).length, 1);
  assert.equal(findMatches("forgive up", set).length, 0);
  assert.equal(findMatches("give upper", set).length, 0);
});

test("短语匹配: 英文长短语优先", () => {
  const set = new Set(["give", "give up"]);
  const matches = findMatches("give up", set);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].text.toLowerCase(), "give up");
});

test("中文匹配: 子串匹配、允许内部空白/换行", () => {
  assert.equal(findMatches("人工智能技术", new Set(["人工智能"])).length, 1);
  assert.equal(findMatches("人工 智能", new Set(["人工智能"])).length, 1);
  assert.equal(findMatches("人工\n智能", new Set(["人工智能"])).length, 1);
  assert.equal(findMatches("这是人工智能", new Set(["人工智能"])).length, 1);
  assert.equal(findMatches("人工智能", new Set(["中国"])).length, 0);
});

test("中文匹配: 长词优先，避免同一位置双层高亮", () => {
  const set = new Set(["中国", "中国人"]);
  const matches = findMatches("中国人", set);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].text, "中国人");
});

test("混合词条: 英文短语与中文词条同时匹配", () => {
  const set = new Set(["give up", "人工智能"]);
  const matches = findMatches("使用 give up 方法，人工智能", set);
  assert.deepEqual(
    matches.map((match) => match.text),
    ["give up", "人工智能"],
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

test("高亮名称: 动态 CSS 与注册名保持一致", () => {
  const name = getHighlightName();
  assert.match(name, /^[A-Za-z_][A-Za-z0-9_-]*$/);
  const css = buildHighlightCss(name);
  assert.ok(css.includes(`::highlight(${name})`));
  assert.ok(css.includes("--cet4-vocab-bg"));
  assert.ok(buildHighlightCss("vocab-capture").includes("::highlight(vocab-capture)"));
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

test("编辑视图: 英文短语跨行、中文词语、行内代码跳过", () => {
  const text = [
    "Use give up now.",
    "人工智能",
    "`give up`",
    "give",
    "up",
  ].join("\n");

  class FakeBuilder {
    constructor() {
      this.ranges = [];
    }
    add(from, to, value) {
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
    store: { words: new Set(["give up", "人工智能"]) },
    isWordFile: () => false,
  };

  const ranges = buildEditorDecorations(
    view,
    plugin,
    Symbol("editorInfoField"),
    { class: "mark" },
    FakeBuilder,
  );

  assert.deepEqual(
    ranges.map((range) => text.slice(range.from, range.to)),
    ["give up", "人工智能", "give\nup"],
  );
});
