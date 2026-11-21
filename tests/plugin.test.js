"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (error) {
  console.warn("jsdom 未安装，跳过插件集成测试");
  process.exit(0);
}

const obsidianStub = {
  Plugin: class {
    constructor(app) {
      this.app = app;
    }
  },
  PluginSettingTab: class {},
  Setting: class {},
  Notice: class {
    constructor(message) {
      this.message = message;
    }
  },
  MarkdownView: class {},
  editorInfoField: null,
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return obsidianStub;
  return originalLoad.call(this, request, parent, isMain);
};

const PluginClass = require("../main.js");
Module._load = originalLoad;

const {
  WordStore,
  getHighlightName,
  getUnknownHighlightName,
} = PluginClass.__test;
const HIGHLIGHT_NAME = getHighlightName();

function setup() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="workspace-leaf-content">
      <div class="markdown-preview-view">
        <div class="markdown-preview-section">
          <p>It is <strong>beneficial</strong> for people to exercise.</p>
          <p><strong>P1</strong> More people joined.</p>
          <table><tr><td>beneficial</td></tr></table>
        </div>
      </div>
    </div>
  </body></html>`);

  global.window = dom.window;
  global.document = dom.window.document;
  global.NodeFilter = dom.window.NodeFilter;
  global.Element = dom.window.Element;

  class HighlightStub {
    constructor() {
      this.ranges = [];
    }
    add(range) {
      this.ranges.push(range);
    }
  }

  dom.window.Highlight = HighlightStub;
  dom.window.CSS = { highlights: new Map() };

  const view = new obsidianStub.MarkdownView();
  view.containerEl = document.querySelector(".workspace-leaf-content");
  view.file = { path: "notes/article.md" };
  view.getMode = () => "preview";

  const plugin = Object.create(PluginClass.prototype);
  plugin.app = {
    workspace: {
      getLeavesOfType: () => [{ view }],
    },
  };
  plugin.settings = {
    wordFilePath: "生词本.txt",
    hotkey: { modifiers: ["Alt"], key: "W" },
    highlightColor: "rgba(64, 190, 160, 0.28)",
    includeTables: true,
    includeCode: false,
    skipExistingHighlights: true,
    sortAlphabetically: true,
  };
  plugin.store = { words: new Set(["beneficial", "people"]) };
  plugin.highlightSupported = true;
  plugin.HighlightCtor = HighlightStub;
  plugin.currentHighlight = null;

  return { dom, view, plugin };
}

test("插件: refreshHighlights 注册 CSS.highlights 并包含范围", () => {
  const { dom, plugin } = setup();
  plugin.refreshHighlights();

  const highlight = dom.window.CSS.highlights.get(HIGHLIGHT_NAME);
  assert.ok(highlight, "应当注册 highlight");
  assert.ok(highlight.ranges.length >= 2);
  const texts = highlight.ranges.map((range) => range.toString());
  assert.ok(texts.includes("people"));
  assert.ok(texts.filter((text) => text === "beneficial").length >= 2);
});

test("插件: 其他 Markdown 文件也会高亮（全局范围）", () => {
  const { dom, view, plugin } = setup();
  plugin.refreshHighlights();
  assert.ok(dom.window.CSS.highlights.has(HIGHLIGHT_NAME));

  view.file.path = "其他/note.md";
  plugin.refreshHighlights();
  assert.ok(dom.window.CSS.highlights.has(HIGHLIGHT_NAME));
  assert.ok(dom.window.CSS.highlights.get(HIGHLIGHT_NAME).ranges.length > 0);
});

test("插件: 生词本自身不会被高亮", () => {
  const { dom, view, plugin } = setup();
  view.file.path = "生词本.txt";
  plugin.refreshHighlights();
  assert.equal(dom.window.CSS.highlights.has(HIGHLIGHT_NAME), false);
});

test("插件: toggleEntry 同一入口完成中英词条添加与移除", async () => {
  const files = new Map();
  const storeOwner = {
    settings: { wordFilePath: "a.txt", sortAlphabetically: true },
    readTextFile: async (path) => files.get(path) || "",
    writeTextFile: async (path, text) => {
      files.set(path, text);
    },
  };

  const plugin = Object.create(PluginClass.prototype);
  plugin.store = new WordStore(storeOwner);
  plugin.wordsVersion = 0;
  plugin.bumpWordsVersion = () => {
    plugin.wordsVersion += 1;
  };
  plugin.scheduleRefresh = () => {};

  await plugin.toggleEntry("Give   Up");
  assert.equal(plugin.store.words.has("give up"), true);
  assert.equal(files.get("a.txt"), "give up\n");

  await plugin.toggleEntry("人工智能");
  assert.equal(plugin.store.words.has("人工智能"), true);

  await plugin.toggleEntry("give up");
  assert.equal(plugin.store.words.has("give up"), false);
});

test("插件: 不理解词使用独立高亮注册名", () => {
  const { dom, plugin } = setup();
  plugin.store.words = new Set();
  plugin.unknownStore = { entries: new Set(["beneficial"]) };
  plugin.refreshHighlights();

  assert.equal(dom.window.CSS.highlights.has(getHighlightName()), false);
  const highlight = dom.window.CSS.highlights.get(getUnknownHighlightName());
  assert.ok(highlight);
  assert.ok(
    highlight.ranges.some((range) => range.toString() === "beneficial"),
  );
  assert.ok(plugin.unknownLinkRanges.length >= 1);
  assert.equal(plugin.unknownLinkRanges[0].entry, "beneficial");
});

test("插件: 两种高亮颜色写入 CSS 变量", () => {
  const { dom, plugin } = setup();
  plugin.settings.highlightColor = "#123456";
  plugin.settings.unknownHighlightColor = "#abcdef";
  plugin.applyHighlightColor();

  assert.equal(
    dom.window.document.body.style.getPropertyValue(
      "--vocab-capture-highlight-color",
    ),
    "#123456",
  );
  assert.equal(
    dom.window.document.body.style.getPropertyValue(
      "--vocab-capture-unknown-highlight-color",
    ),
    "#abcdef",
  );
});

test("插件: 动态注入 ::highlight 样式，名称与注册名一致", () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
  global.window = dom.window;
  global.document = dom.window.document;

  const plugin = Object.create(PluginClass.prototype);
  plugin.injectHighlightStyle();

  const style = document.getElementById("vocab-capture-highlight-style");
  assert.ok(style);
  assert.ok(
    style.textContent.includes(`::highlight(${getHighlightName()})`),
  );
  assert.ok(
    style.textContent.includes(
      `::highlight(${getHighlightName()}-unknown)`,
    ),
  );

  plugin.removeHighlightStyle();
  assert.equal(
    document.getElementById("vocab-capture-highlight-style"),
    null,
  );
});

test("插件: appendUnknown 写入独立文件并去重", async () => {
  const files = new Map();
  const plugin = Object.create(PluginClass.prototype);
  plugin.settings = { unknownFilePath: "unknown.txt" };
  plugin.readTextFile = async (path) => files.get(path) || "";
  plugin.writeTextFile = async (path, text) => {
    files.set(path, text);
  };
  plugin.unknownStore = {
    entries: new Set(),
    saving: false,
    loadedPath: "unknown.txt",
    ensureLoaded: async () => {},
  };
  plugin.ensureUnknownHeadings = async () => {};
  plugin.bumpWordsVersion = () => {};
  plugin.scheduleRefresh = () => {};

  const first = await plugin.appendUnknown("hello\nworld");
  assert.equal(first.added, true);
  assert.equal(files.get("unknown.txt"), "hello world\n");

  const duplicate = await plugin.appendUnknown("hello world");
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.count, 1);
});

test("插件: toggleUnknown 同一入口收录与取消收录", async () => {
  const files = new Map();
  const plugin = Object.create(PluginClass.prototype);
  plugin.settings = { unknownFilePath: "unknown.txt" };
  plugin.readTextFile = async (path) => files.get(path) || "";
  plugin.writeTextFile = async (path, text) => {
    files.set(path, text);
  };
  plugin.unknownStore = {
    entries: new Set(),
    saving: false,
    loadedPath: "unknown.txt",
    ensureLoaded: async () => {},
  };
  plugin.ensureUnknownHeadings = async () => {};
  plugin.bumpWordsVersion = () => {};
  plugin.scheduleRefresh = () => {};

  const added = await plugin.toggleUnknown("Hello\nWorld");
  assert.equal(added.added, true);
  assert.equal(added.removed, false);
  assert.equal(files.get("unknown.txt"), "Hello World\n");

  const removed = await plugin.toggleUnknown("Hello World");
  assert.equal(removed.added, false);
  assert.equal(removed.removed, true);
  assert.equal(files.get("unknown.txt"), "");
  assert.equal(removed.count, 0);
});

test("插件: ensureUnknownHeadings 创建并复用笔记标题", async () => {
  const files = new Map();
  const plugin = Object.create(PluginClass.prototype);
  plugin.settings = { unknownNotePath: "notes/unknown.md" };
  plugin.readTextFile = async (path) => files.get(path) || "";
  plugin.writeTextFile = async (path, text) => {
    files.set(path, text);
  };

  const changed = await plugin.ensureUnknownHeadings(
    new Set(["hello", "world"]),
  );
  assert.equal(changed, true);
  assert.equal(
    files.get("notes/unknown.md"),
    "# 未分类\n\n## hello\n\n## world\n",
  );

  const unchanged = await plugin.ensureUnknownHeadings(
    new Set(["hello", "world"]),
  );
  assert.equal(unchanged, false);
});

test("插件: 点击阅读视图中的不理解词触发跳转", () => {
  const { dom, plugin } = setup();
  plugin.store.words = new Set();
  plugin.unknownStore = { entries: new Set(["beneficial"]) };
  plugin.refreshHighlights();

  const strong = dom.window.document.querySelector("p strong");
  const caret = dom.window.document.createRange();
  caret.setStart(strong.firstChild, 2);
  caret.collapse(true);
  dom.window.document.caretRangeFromPoint = () => caret;

  let opened = null;
  plugin.openUnknownEntry = async (entry) => {
    opened = entry;
  };

  let prevented = false;
  plugin.handleReadingUnknownClick({
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: strong,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {},
  });

  assert.equal(prevented, true);
  assert.equal(opened, "beneficial");
});

test("插件: 取消不理解词不删除笔记中的标题内容", async () => {
  const files = new Map();
  files.set("unknown.txt", "hello\n");
  files.set("note.md", "# 未分类\n\n## hello\n\n这里是用户写的解释。\n");
  const plugin = Object.create(PluginClass.prototype);
  plugin.settings = {
    unknownFilePath: "unknown.txt",
    unknownNotePath: "note.md",
  };
  plugin.readTextFile = async (path) => files.get(path) || "";
  plugin.writeTextFile = async (path, text) => {
    files.set(path, text);
  };
  plugin.unknownStore = {
    entries: new Set(["hello"]),
    saving: false,
    loadedPath: "unknown.txt",
    ensureLoaded: async () => {},
  };
  plugin.bumpWordsVersion = () => {};
  plugin.scheduleRefresh = () => {};

  const result = await plugin.toggleUnknown("hello");
  assert.equal(result.removed, true);
  assert.equal(files.get("unknown.txt"), "");
  assert.equal(
    files.get("note.md"),
    "# 未分类\n\n## hello\n\n这里是用户写的解释。\n",
  );
});

test("插件: openUnknownEntry 打开笔记并定位标题行", async () => {
  const files = new Map();
  const plugin = Object.create(PluginClass.prototype);
  plugin.settings = { unknownNotePath: "note.md" };
  plugin.unknownStore = { entries: new Set(["hello"]) };
  plugin.readTextFile = async (path) => files.get(path) || "";
  plugin.writeTextFile = async (path, text) => {
    files.set(path, text);
  };

  let opened = null;
  let state = null;
  plugin.app = {
    workspace: {
      openLinkText: async (path) => {
        opened = path;
      },
      getActiveViewOfType: () => ({
        setEphemeralState: (value) => {
          state = value;
        },
      }),
    },
  };

  await plugin.openUnknownEntry("hello");
  assert.equal(opened, "note.md");
  assert.equal(files.get("note.md"), "# 未分类\n\n## hello\n");
  assert.deepEqual(state, { line: 2 });
});

test("插件: 不理解词笔记前方渲染管理 UI", async () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="markdown-reading-view">
      <div class="markdown-preview-view">
        <div class="markdown-preview-section"></div>
      </div>
    </div>
  </body></html>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.Element = dom.window.Element;

  const view = Object.create(obsidianStub.MarkdownView.prototype);
  view.containerEl = dom.window.document.body;
  view.file = { path: "notes/unknown.md" };
  view.getMode = () => "preview";

  const plugin = Object.create(PluginClass.prototype);
  plugin.settings = { unknownNotePath: "notes/unknown.md" };
  plugin.app = {
    workspace: { getLeavesOfType: () => [{ view }] },
  };
  plugin.readTextFile = async () =>
    "# 技术\n\n## Vite\n\n- 释义：构建工具\n\n# 未分类\n\n## foo\n";
  plugin.unknownUiRefreshToken = 0;
  plugin.unknownUiState = {
    expanded: true,
    selectedCategory: "技术",
    search: "",
    confirmDelete: null,
    focusAdd: false,
  };

  await plugin.refreshUnknownNoteUi();

  const panel = dom.window.document.querySelector(
    ".vocab-capture-note-ui",
  );
  assert.ok(panel);
  assert.ok(panel.querySelector(".vocab-capture-ui__compact"));
  assert.ok(panel.querySelector(".vocab-capture-ui__manager"));
  assert.ok(panel.textContent.includes("分类与卡片管理"));
  assert.ok(panel.textContent.includes("技术"));
  assert.ok(
    panel.querySelectorAll(".vocab-capture-ui__category").length >= 2,
  );
  assert.ok(
    panel.querySelectorAll(".vocab-capture-ui__card").length >= 1,
  );
});

test("插件: 旧设置加载后补齐不理解词默认值", async () => {
  const plugin = Object.create(PluginClass.prototype);
  plugin.loadData = async () => ({
    wordFilePath: "words.txt",
    hotkey: { modifiers: ["Alt"], key: "W" },
  });
  await plugin.loadSettings();

  assert.equal(plugin.settings.unknownFilePath, "不理解的词.txt");
  assert.equal(plugin.settings.unknownNotePath, "不理解的词.md");
  assert.equal(plugin.settings.unknownHotkey.key, "Q");
  assert.deepEqual(plugin.settings.unknownHotkey.modifiers, ["Alt"]);
});
