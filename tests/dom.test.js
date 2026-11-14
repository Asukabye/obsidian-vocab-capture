"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (error) {
  console.warn("jsdom 未安装，跳过 DOM 测试");
  process.exit(0);
}

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

const { collectRanges, buildWordRegex } = PluginClass.__test;

const html = `<!doctype html>
<html><body>
<div class="markdown-preview-view">
  <div class="markdown-preview-section">
    <h1>2024年6月 CET4 · 原卷文字版</h1>
    <p>It's well known that physical exercise is <strong>beneficial</strong> to mental health.</p>
    <p><strong>P1</strong> Six people had to move away after a fire broke out. This is a <strong>decline</strong>d trend.</p>
    <p>A <a href="#">linked</a> word and <em>moderate</em> exercise.</p>
    <table><tr><td>moderate</td><td>decline</td></tr></table>
    <p>Before <mark>26</mark> exercise, read the <mark>beneficial</mark> note.</p>
    <p><strong>fire</strong> <em>fighters</em> are not one word here.</p>
    <pre><code>const work = "beneficial";</code></pre>
  </div>
</div>
</body></html>`;

function makeEnv() {
  const dom = new JSDOM(html);
  global.window = dom.window;
  global.document = dom.window.document;
  global.NodeFilter = dom.window.NodeFilter;
  global.Element = dom.window.Element;
  return dom;
}

function collect(root, words, settings) {
  return collectRanges(root, buildWordRegex(words), settings).map((range) =>
    range.toString(),
  );
}

const defaultSettings = {
  includeTables: true,
  includeCode: false,
  skipExistingHighlights: true,
};

test("DOM: 跨节点单词（strong + 后缀）", () => {
  makeEnv();
  const root = document.querySelector(".markdown-preview-view");
  const hits = collect(root, new Set(["declined"]), defaultSettings);
  assert.ok(hits.includes("declined"));
});

test("DOM: 加粗标签后的正文、链接、表格、行内 em", () => {
  makeEnv();
  const root = document.querySelector(".markdown-preview-view");
  const words = new Set(["people", "linked", "moderate"]);
  const hits = collect(root, words, defaultSettings);
  assert.ok(hits.includes("people"));
  assert.ok(hits.includes("linked"));
  assert.equal(hits.filter((word) => word === "moderate").length, 2);
});

test("DOM: 跳过已有 mark 与数字", () => {
  makeEnv();
  const root = document.querySelector(".markdown-preview-view");
  const hits = collect(
    root,
    new Set(["beneficial", "exercise"]),
    defaultSettings,
  );
  assert.equal(hits.filter((word) => word === "beneficial").length, 1);
  assert.ok(hits.includes("exercise"));
  assert.ok(!hits.includes("26"));
});

test("DOM: 代码默认跳过，打开 includeCode 后包含", () => {
  makeEnv();
  const root = document.querySelector(".markdown-preview-view");
  const words = new Set(["const", "work"]);
  const withoutCode = collect(root, words, defaultSettings);
  assert.deepEqual(withoutCode, []);
  const withCode = collect(root, words, {
    ...defaultSettings,
    includeCode: true,
  });
  assert.ok(withCode.includes("const"));
  assert.ok(withCode.includes("work"));
});

test("DOM: includeTables=false 只保留正文中的 moderate", () => {
  makeEnv();
  const root = document.querySelector(".markdown-preview-view");
  const hits = collect(
    root,
    new Set(["moderate"]),
    { ...defaultSettings, includeTables: false },
  );
  assert.equal(hits.filter((word) => word === "moderate").length, 1);
});

test("DOM: skipExistingHighlights=false 会包含 mark 内的词", () => {
  makeEnv();
  const root = document.querySelector(".markdown-preview-view");
  const hits = collect(
    root,
    new Set(["beneficial"]),
    { ...defaultSettings, skipExistingHighlights: false },
  );
  assert.equal(hits.filter((word) => word === "beneficial").length, 2);
});

test("DOM: 中间有空格时不跨节点误拼", () => {
  makeEnv();
  const root = document.querySelector(".markdown-preview-view");
  const hits = collect(root, new Set(["firefighters"]), defaultSettings);
  assert.deepEqual(hits, []);
});

test("DOM: Range 非空且可 toString", () => {
  makeEnv();
  const root = document.querySelector(".markdown-preview-view");
  const ranges = collectRanges(
    root,
    buildWordRegex(new Set(["people", "linked"])),
    defaultSettings,
  );
  assert.ok(ranges.length >= 2);
  assert.ok(ranges.every((range) => range.toString().length > 0));
});

test("DOM: 英文短语跨 <br>、中文词语跨格式节点", () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div class="markdown-preview-view">
      <div class="markdown-preview-section">
        <p><strong>give</strong><br>up now</p>
        <p>人工<br><strong>智能</strong> 技术</p>
        <p>give</p><p>up</p>
      </div>
    </div>
  </body></html>`);
  global.window = dom.window;
  global.document = dom.window.document;
  global.NodeFilter = dom.window.NodeFilter;
  global.Element = dom.window.Element;

  const root = document.querySelector(".markdown-preview-view");
  const ranges = collectRanges(
    root,
    buildWordRegex(new Set(["give up", "人工智能"])),
    defaultSettings,
  );
  const texts = ranges.map((range) => range.toString());
  assert.ok(texts.includes("giveup"), JSON.stringify(texts));
  assert.ok(texts.includes("人工智能"), JSON.stringify(texts));
  assert.equal(
    texts.filter((text) => text === "giveup").length,
    1,
    "跨段落不应误匹配",
  );
});
