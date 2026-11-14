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

const { WordStore, getHighlightName } = PluginClass.__test;
const HIGHLIGHT_NAME = "cet4-vocab-capture";

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
  view.file = { path: "原文/CET4-2024-06-S1-原文.md" };
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

test("插件: 动态注入 ::highlight 样式，名称与注册名一致", () => {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
  global.window = dom.window;
  global.document = dom.window.document;

  const plugin = Object.create(PluginClass.prototype);
  plugin.injectHighlightStyle();

  const style = document.getElementById("cet4-vocab-highlight-style");
  assert.ok(style);
  assert.ok(
    style.textContent.includes(`::highlight(${getHighlightName()})`),
  );

  plugin.removeHighlightStyle();
  assert.equal(document.getElementById("cet4-vocab-highlight-style"), null);
});

test("插件: appendUnknown 写入独立文件并去重", async () => {
  const files = new Map();
  const plugin = Object.create(PluginClass.prototype);
  plugin.settings = { unknownFilePath: "unknown.txt" };
  plugin.readTextFile = async (path) => files.get(path) || "";
  plugin.writeTextFile = async (path, text) => {
    files.set(path, text);
  };

  const first = await plugin.appendUnknown("hello\nworld");
  assert.equal(first.added, true);
  assert.equal(files.get("unknown.txt"), "hello world\n");

  const duplicate = await plugin.appendUnknown("hello world");
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.count, 1);
});

test("插件: 旧设置加载后补齐不理解词默认值", async () => {
  const plugin = Object.create(PluginClass.prototype);
  plugin.loadData = async () => ({
    wordFilePath: "words.txt",
    hotkey: { modifiers: ["Alt"], key: "W" },
  });
  await plugin.loadSettings();

  assert.equal(plugin.settings.unknownFilePath, "不理解的词.txt");
  assert.equal(plugin.settings.unknownHotkey.key, "Q");
  assert.deepEqual(plugin.settings.unknownHotkey.modifiers, ["Alt"]);
});
