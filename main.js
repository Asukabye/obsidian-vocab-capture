"use strict";

const {
  Plugin,
  PluginSettingTab,
  Setting,
  Notice,
  MarkdownView,
  editorInfoField,
} = require("obsidian");

const PLUGIN_ID = "vocab-capture";
const HIGHLIGHT_NAME = "vocab-capture";
const HIGHLIGHT_STYLE_ID = "vocab-capture-highlight-style";

const DEFAULT_SETTINGS = {
  wordFilePath: "生词本.txt",
  hotkey: { modifiers: ["Alt"], key: "W" },
  unknownFilePath: "不理解的词.txt",
  unknownHotkey: { modifiers: ["Alt"], key: "Q" },
  highlightColor: "rgba(64, 190, 160, 0.28)",
  unknownHighlightColor: "rgba(236, 144, 56, 0.36)",
  includeTables: true,
  includeCode: false,
  skipExistingHighlights: true,
  sortAlphabetically: true,
};

const MODIFIER_KEYS = new Set([
  "Control",
  "Alt",
  "Shift",
  "Meta",
  "OS",
  "AltGraph",
]);

const BLOCK_SELECTOR = [
  "p",
  "li",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "figcaption",
  "dt",
  "dd",
  ".callout-title-inner",
].join(",");

/* --------------------------------------------------------------------------
 * 纯函数：词条规范化、词集读写、中英匹配、快捷键解析
 * ------------------------------------------------------------------------ */

const ENTRY_LIMITS = {
  chineseMin: 2,
  chineseMax: 20,
  englishMaxWords: 12,
  englishMaxChars: 80,
};

function normalizeEntry(raw) {
  if (typeof raw !== "string") return null;

  let s = raw
    .replace(/\r\n?|\n/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .trim();

  if (!s) return null;

  s = s.replace(
    /^[\s"'“”‘’`´(\[{<«「」『』《》【】（［｛*_~—–，。！？；：、]+/u,
    "",
  );
  s = s.replace(
    /[\s"'“”‘’`´)\]}>,.;:!?—–…·*_~，。！？；：、）］｝」』》】]+$/u,
    "",
  );
  s = s.replace(/[’‘`´]/g, "'").replace(/[‐‑–]/g, "-");
  s = s.replace(/^['-]+/u, "").replace(/['-]+$/u, "");

  if (!s) return null;

  const hasHan = /\p{Script=Han}/u.test(s);
  const hasLatin = /\p{Script=Latin}/u.test(s);

  if (hasHan && hasLatin) return null;
  if (!hasHan && !hasLatin) return null;

  if (hasHan) {
    if (!/^[\p{Script=Han}\s]+$/u.test(s)) return null;
    s = s.replace(/\s+/g, "");
    const length = Array.from(s).length;
    if (length < ENTRY_LIMITS.chineseMin) return null;
    if (length > ENTRY_LIMITS.chineseMax) return null;
    return s;
  }

  s = s.replace(/\s+/g, " ").toLowerCase();
  if (s.length > ENTRY_LIMITS.englishMaxChars) return null;

  const tokens = s.split(" ");
  if (tokens.length > ENTRY_LIMITS.englishMaxWords) return null;
  if (
    !tokens.every((token) =>
      /^[\p{Script=Latin}\p{M}'-]+$/u.test(token),
    )
  ) {
    return null;
  }

  return s.length >= 2 ? s : null;
}

function classifyEntry(entry) {
  return /^\p{Script=Han}+$/u.test(String(entry || "")) ? "zh" : "en";
}

function normalizeUnknownSelection(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n?|\n/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function countUnknownLines(text) {
  return String(text == null ? "" : text)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .length;
}

function parseUnknownSet(text) {
  const entries = new Set();
  for (const line of String(text == null ? "" : text).split(
    /\r\n|\n|\r/,
  )) {
    const entry = normalizeUnknownSelection(line);
    if (entry) entries.add(entry);
  }
  return entries;
}

function appendUnknownRecord(existing, entry) {
  const current = String(existing == null ? "" : existing);
  const normalized = normalizeUnknownSelection(entry);
  if (!normalized) return { text: current, added: false };

  const lines = current
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.includes(normalized)) {
    return { text: current, added: false };
  }

  const separator = current && !current.endsWith("\n") ? "\n" : "";
  return {
    text: `${current}${separator}${normalized}\n`,
    added: true,
  };
}

function parseWordSet(text) {
  const entries = new Set();
  const clean = String(text == null ? "" : text).replace(/^\uFEFF/, "");
  for (const line of clean.split(/\r\n|\n|\r/)) {
    const entry = normalizeEntry(line);
    if (entry) entries.add(entry);
  }
  return entries;
}

function serializeWordSet(entries, sortAlphabetically = true) {
  const list = Array.from(entries);
  if (sortAlphabetically) {
    list.sort(
      (a, b) =>
        a.localeCompare(b, "zh-Hans", { sensitivity: "base" }) ||
        a.localeCompare(b),
    );
  }
  return list.length ? `${list.join("\n")}\n` : "";
}

function escapeWordChar(ch) {
  if (ch === "'") return "['’]";
  if (ch === "-") return "[-‐‑]";
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildEntryPatternSource(entries) {
  const unique = Array.from(
    new Set(
      Array.from(entries || [], (entry) => String(entry)).filter(Boolean),
    ),
  );

  const chinese = unique
    .filter((entry) => classifyEntry(entry) === "zh")
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  const english = unique
    .filter((entry) => classifyEntry(entry) === "en")
    .sort((a, b) => b.length - a.length || a.localeCompare(b));

  const chineseAlternatives = chinese
    .map((entry) =>
      Array.from(entry).map(escapeWordChar).join("\\s*"),
    )
    .join("|");
  const englishAlternatives = english
    .map((entry) =>
      entry
        .split(" ")
        .map((token) =>
          Array.from(token).map(escapeWordChar).join(""),
        )
        .join("\\s+"),
    )
    .join("|");

  const parts = [];
  if (chineseAlternatives) {
    parts.push(chineseAlternatives);
  }
  if (englishAlternatives) {
    parts.push(
      `(?<![\\p{Script=Latin}\\p{N}_])(?:${englishAlternatives})(?![\\p{Script=Latin}\\p{N}_])`,
    );
  }

  return parts.length ? `(?:${parts.join("|")})` : null;
}

function buildWordPatternSource(entries) {
  return buildEntryPatternSource(entries);
}

function buildWordRegex(entries) {
  const source = buildEntryPatternSource(entries);
  return source ? new RegExp(source, "giu") : null;
}

function buildUnknownPatternSource(entries) {
  const unique = Array.from(
    new Set(
      Array.from(entries || [], (entry) =>
        normalizeUnknownSelection(String(entry)),
      ).filter(Boolean),
    ),
  ).sort((a, b) => b.length - a.length || a.localeCompare(b));

  if (!unique.length) return null;

  const alternatives = unique
    .map((entry) =>
      entry
        .split(" ")
        .map((token) => Array.from(token).map(escapeWordChar).join(""))
        .join("\\s+"),
    )
    .join("|");

  return `(?:${alternatives})`;
}

function buildUnknownRegex(entries) {
  const source = buildUnknownPatternSource(entries);
  return source ? new RegExp(source, "giu") : null;
}

function findMatches(text, words) {
  const regex = buildWordRegex(words);
  if (!regex || !text) return [];

  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (!match[0]) {
      regex.lastIndex += 1;
      continue;
    }
    matches.push({
      text: match[0],
      index: match.index,
      end: match.index + match[0].length,
    });
  }
  return matches;
}

function normalizeHotkey(hotkey) {
  const src = hotkey && typeof hotkey === "object" ? hotkey : {};
  const rawModifiers = Array.isArray(src.modifiers) ? src.modifiers : [];
  const order = ["Ctrl", "Alt", "Shift", "Meta"];
  const modifiers = order.filter((modifier) =>
    rawModifiers.includes(modifier),
  );

  let key = src.key == null ? "" : String(src.key);
  if (key === " " || key === "Spacebar") key = "Space";
  if (key.length === 1) key = key.toUpperCase();

  return { modifiers, key };
}

function formatHotkey(hotkey) {
  const normalized = normalizeHotkey(hotkey);
  return [...normalized.modifiers, normalized.key || "未设置"].join("+");
}

function eventToHotkey(event) {
  const modifiers = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Meta");

  let key = event.key == null ? "" : String(event.key);
  if (key === " " || event.code === "Space") key = "Space";
  if (key.length === 1) key = key.toUpperCase();

  return { modifiers, key };
}

function matchesHotkey(event, hotkey) {
  const target = normalizeHotkey(hotkey);
  if (!target.key) return false;

  const actual = eventToHotkey(event);
  if (target.modifiers.length !== actual.modifiers.length) return false;
  for (const modifier of target.modifiers) {
    if (!actual.modifiers.includes(modifier)) return false;
  }

  if (target.key.length === 1) {
    return target.key.toUpperCase() === actual.key.toUpperCase();
  }
  return target.key === actual.key;
}

function normalizeVaultPath(input) {
  let s = String(input == null ? "" : input)
    .trim()
    .replace(/\\/g, "/");
  s = s.replace(/^\/+/, "");

  const parts = [];
  for (const part of s.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error("路径不能包含 “..”");
    parts.push(part);
  }
  return parts.join("/");
}

function isAbsolutePath(input) {
  const s = String(input == null ? "" : input).trim();
  if (!s) return false;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
  if (/^\\\\/.test(s)) return true;
  if (
    typeof process !== "undefined" &&
    process.platform !== "win32" &&
    s.startsWith("/")
  ) {
    return true;
  }
  return false;
}

function isEditableTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  const editable = target.closest(
    "input, textarea, select, [contenteditable='true'], [contenteditable='']",
  );
  if (!editable) return false;
  // CodeMirror's contenteditable is the editor we want to support.
  if (
    editable.classList &&
    editable.classList.contains("cm-content")
  ) {
    return false;
  }
  return true;
}

function getHighlightName() {
  const name = String(HIGHLIGHT_NAME || "").trim();
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)
    ? name
    : "vocab-highlight";
}

function getUnknownHighlightName() {
  return `${getHighlightName()}-unknown`;
}

function buildHighlightCss(name, unknownName = `${name}-unknown`) {
  return `::highlight(${name}) {
  background-color: var(--vocab-capture-highlight-color, rgba(64, 190, 160, 0.28));
  color: inherit;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}

::highlight(${unknownName}) {
  background-color: var(--vocab-capture-unknown-highlight-color, rgba(236, 144, 56, 0.36));
  color: inherit;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}`;
}

function getPreviewElement(view) {
  if (!view || !view.containerEl) return null;
  return (
    view.containerEl.querySelector(".markdown-preview-view") ||
    view.containerEl.querySelector(
      ".markdown-reading-view .markdown-rendered",
    ) ||
    null
  );
}

/* --------------------------------------------------------------------------
 * DOM 高亮：按块拼接文本节点，处理加粗/链接/表格等跨节点情况
 * ------------------------------------------------------------------------ */

function locateGroupOffset(group, offset, isEnd = false) {
  if (!group.nodes.length) return null;

  const last = group.nodes.length - 1;
  for (let i = 0; i <= last; i += 1) {
    const start = group.offsets[i];
    const length = group.nodes[i].nodeValue.length;
    const end = start + length;

    if (offset < start) {
      if (isEnd && i > 0) {
        return {
          node: group.nodes[i - 1],
          offset: group.nodes[i - 1].nodeValue.length,
        };
      }
      return { node: group.nodes[i], offset: 0 };
    }
    if (offset <= end) {
      return { node: group.nodes[i], offset: offset - start };
    }
  }

  return {
    node: group.nodes[last],
    offset: group.nodes[last].nodeValue.length,
  };
}

function createRangeForSpan(group, start, end) {
  const startPosition = locateGroupOffset(group, start, false);
  const endPosition = locateGroupOffset(group, end, true);
  if (!startPosition || !endPosition) return null;

  try {
    const range = document.createRange();
    range.setStart(startPosition.node, startPosition.offset);
    range.setEnd(endPosition.node, endPosition.offset);
    return range;
  } catch (error) {
    return null;
  }
}

function collectRanges(root, regex, settings) {
  const ranges = [];
  if (!root || !regex) return ranges;

  const options = settings || {};
  const includeCode = options.includeCode === true;
  const includeTables = options.includeTables !== false;
  const skipExistingHighlights =
    options.skipExistingHighlights !== false;

  const groups = new Map();

  const getBlock = (element) =>
    element.closest(BLOCK_SELECTOR) ||
    element.closest(
      ".markdown-preview-section, .callout-content, .markdown-embed-content",
    ) ||
    element;

  const getGroup = (block) => {
    let group = groups.get(block);
    if (!group) {
      group = { nodes: [], offsets: [], text: "" };
      groups.set(block, group);
    }
    return group;
  };

  const isSkippedElement = (element) => {
    if (!includeCode && element.matches("code, pre")) return true;
    if (
      element.matches(
        "script, style, textarea, .math, .katex, .mjx-container",
      )
    ) {
      return true;
    }
    if (!includeTables && element.matches("table")) return true;
    if (skipExistingHighlights && element.matches("mark")) return true;
    if (element.matches(".metadata-container, .frontmatter, .tag")) {
      return true;
    }
    return false;
  };

  const addText = (node) => {
    if (!node.nodeValue) return;

    const parent = node.parentElement;
    if (!parent) return;

    if (!includeCode && parent.closest("code, pre")) return;
    if (
      parent.closest(
        "script, style, textarea, .math, .katex, .mjx-container",
      )
    ) {
      return;
    }
    if (!includeTables && parent.closest("table")) return;
    if (skipExistingHighlights && parent.closest("mark")) return;
    if (parent.closest(".metadata-container, .frontmatter, .tag")) {
      return;
    }

    const group = getGroup(getBlock(parent));
    group.offsets.push(group.text.length);
    group.nodes.push(node);
    group.text += node.nodeValue;
  };

  const addBreak = (element) => {
    const parent = element.parentElement;
    if (!parent) return;
    const group = getGroup(getBlock(parent));
    group.text += "\n";
  };

  const walk = (node) => {
    for (const child of Array.from(node.childNodes || [])) {
      if (child.nodeType === 3) {
        addText(child);
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (child.tagName === "BR") {
        addBreak(child);
        continue;
      }
      if (isSkippedElement(child)) continue;
      walk(child);
    }
  };

  walk(root);

  for (const group of groups.values()) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(group.text)) !== null) {
      if (!match[0]) {
        regex.lastIndex += 1;
        continue;
      }
      const range = createRangeForSpan(
        group,
        match.index,
        match.index + match[0].length,
      );
      if (range) ranges.push(range);
    }
  }

  return ranges;
}

function mergeRanges(ranges) {
  if (!ranges.length) return [];
  const sorted = ranges
    .map((range) => ({ from: range.from, to: range.to }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.from <= last.to) {
      last.to = Math.max(last.to, current.to);
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function overlapsRanges(from, to, ranges) {
  if (!ranges.length) return false;
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (range.to <= from) {
      low = middle + 1;
    } else if (range.from >= to) {
      high = middle - 1;
    } else {
      return true;
    }
  }
  return false;
}

function collectEditorSkipRanges(text, settings) {
  const ranges = [];
  const options = settings || {};

  const add = (from, to) => {
    if (to > from) ranges.push({ from, to });
  };

  // YAML frontmatter is not rendered in reading view either.
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (frontmatter) add(0, frontmatter[0].length);

  const lines = text.split("\n");
  let offset = 0;
  let fence = null;
  let fenceStart = 0;

  for (const line of lines) {
    const lineStart = offset;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);

    if (!fence) {
      if (fenceMatch) {
        fence = {
          char: fenceMatch[1][0],
          length: fenceMatch[1].length,
        };
        fenceStart = lineStart;
      }
    } else if (
      fenceMatch &&
      fenceMatch[1][0] === fence.char &&
      fenceMatch[1].length >= fence.length
    ) {
      if (!options.includeCode) {
        add(fenceStart, lineStart + line.length);
      }
      fence = null;
    }

    if (
      !options.includeTables &&
      /^\s*\|.*\|\s*$/.test(line)
    ) {
      add(lineStart, lineStart + line.length);
    }

    offset += line.length + 1;
  }

  if (fence && !options.includeCode) {
    add(fenceStart, text.length);
  }

  if (!options.includeCode) {
    const inlineCode = /`{1,3}[^`\n]*`{1,3}/g;
    let match;
    while ((match = inlineCode.exec(text)) !== null) {
      add(match.index, match.index + match[0].length);
    }
  }

  const url = /https?:\/\/[^\s<>"')\]]+/g;
  let urlMatch;
  while ((urlMatch = url.exec(text)) !== null) {
    add(urlMatch.index, urlMatch.index + urlMatch[0].length);
  }

  if (options.skipExistingHighlights) {
    const existing = /==[^=\n]+==/g;
    let markMatch;
    while ((markMatch = existing.exec(text)) !== null) {
      add(markMatch.index, markMatch.index + markMatch[0].length);
    }
  }

  return mergeRanges(ranges);
}

function buildEditorDecorations(
  view,
  plugin,
  infoField,
  markDecoration,
  unknownMarkDecoration,
  RangeSetBuilder,
) {
  const builder = new RangeSetBuilder();
  const mainEntries = plugin.store ? plugin.store.words : new Set();
  const unknownEntries = plugin.unknownStore
    ? plugin.unknownStore.entries
    : new Set();
  if (mainEntries.size === 0 && unknownEntries.size === 0) {
    return builder.finish();
  }

  const info = infoField ? view.state.field(infoField, false) : null;
  const file = info && info.file ? info.file : null;
  if (
    !file ||
    String(file.extension || "").toLowerCase() !== "md" ||
    plugin.isWordFile(file) ||
    (plugin.isUnknownFile ? plugin.isUnknownFile(file) : false)
  ) {
    return builder.finish();
  }

  const mainRegex = buildWordRegex(mainEntries);
  const unknownRegex = buildUnknownRegex(unknownEntries);
  if (!mainRegex && !unknownRegex) return builder.finish();

  const text = view.state.doc.toString();
  const skipRanges = collectEditorSkipRanges(text, plugin.settings);
  const mainRanges = [];
  const unknownRanges = [];

  const collect = (regex, target) => {
    if (!regex) return;
    for (const visible of view.visibleRanges) {
      const slice = view.state.doc.sliceString(visible.from, visible.to);
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(slice)) !== null) {
        if (!match[0]) {
          regex.lastIndex += 1;
          continue;
        }
        const from = visible.from + match.index;
        const to = from + match[0].length;
        if (overlapsRanges(from, to, skipRanges)) continue;
        target.push({ from, to });
      }
    }
  };

  collect(mainRegex, mainRanges);
  collect(unknownRegex, unknownRanges);
  unknownRanges.sort((a, b) => a.from - b.from || a.to - b.to);

  const decorations = [];
  for (const range of mainRanges) {
    if (overlapsRanges(range.from, range.to, unknownRanges)) continue;
    decorations.push({ ...range, decoration: markDecoration });
  }
  for (const range of unknownRanges) {
    decorations.push({ ...range, decoration: unknownMarkDecoration });
  }

  decorations.sort((a, b) => a.from - b.from || a.to - b.to);
  for (const item of decorations) {
    builder.add(item.from, item.to, item.decoration);
  }

  return builder.finish();
}

function createEditorHighlightExtension(plugin, editorApi) {
  const { Decoration, ViewPlugin } = editorApi.view;
  const { RangeSetBuilder } = editorApi.state;
  const markDecoration = Decoration.mark({
    class: "vocab-capture-highlight",
  });
  const unknownMarkDecoration = Decoration.mark({
    class: "vocab-capture-unknown-highlight",
  });

  const safeBuild = (view) => {
    try {
      return buildEditorDecorations(
        view,
        plugin,
        editorInfoField,
        markDecoration,
        unknownMarkDecoration,
        RangeSetBuilder,
      );
    } catch (error) {
      console.warn("[vocab-capture] build editor decorations failed", error);
      return new RangeSetBuilder().finish();
    }
  };

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.version = plugin.wordsVersion;
        this.editorView = view;
        this.decorations = safeBuild(view);
        if (plugin.editorViews) {
          plugin.editorViews.add(view);
        }
      }

      update(update) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          this.version !== plugin.wordsVersion
        ) {
          this.version = plugin.wordsVersion;
          this.decorations = safeBuild(update.view);
        }
      }

      destroy() {
        if (plugin.editorViews) {
          plugin.editorViews.delete(this.editorView);
        }
      }
    },
    {
      decorations: (value) => value.decorations,
    },
  );
}

/* --------------------------------------------------------------------------
 * 词集存储
 * ------------------------------------------------------------------------ */

class WordStore {
  constructor(plugin) {
    this.plugin = plugin;
    this.words = new Set();
    this.saving = false;
    this.loadedPath = null;
  }

  async load() {
    const raw = await this.plugin.readTextFile(
      this.plugin.settings.wordFilePath,
    );
    this.words = parseWordSet(raw);
    this.loadedPath = this.plugin.settings.wordFilePath;
  }

  async ensureLoaded() {
    if (this.loadedPath !== this.plugin.settings.wordFilePath) {
      await this.load();
    }
  }

  async add(word) {
    await this.ensureLoaded();

    const normalized = normalizeEntry(word);
    if (!normalized) return false;
    if (this.words.has(normalized)) return false;

    const previous = new Set(this.words);
    this.words.add(normalized);

    try {
      await this.save();
      return true;
    } catch (error) {
      this.words = previous;
      throw error;
    }
  }

  async remove(word) {
    await this.ensureLoaded();

    const normalized = normalizeEntry(word);
    if (!normalized || !this.words.has(normalized)) return false;

    const previous = new Set(this.words);
    this.words.delete(normalized);

    try {
      await this.save();
      return true;
    } catch (error) {
      this.words = previous;
      throw error;
    }
  }

  async save() {
    this.saving = true;
    try {
      const text = serializeWordSet(
        this.words,
        Boolean(this.plugin.settings.sortAlphabetically),
      );
      await this.plugin.writeTextFile(
        this.plugin.settings.wordFilePath,
        text,
      );
    } finally {
      this.saving = false;
    }
  }
}

class UnknownStore {
  constructor(plugin) {
    this.plugin = plugin;
    this.entries = new Set();
    this.saving = false;
    this.loadedPath = null;
  }

  async load() {
    const raw = await this.plugin.readTextFile(
      this.plugin.settings.unknownFilePath,
    );
    this.entries = parseUnknownSet(raw);
    this.loadedPath = this.plugin.settings.unknownFilePath;
  }

  async ensureLoaded() {
    if (this.loadedPath !== this.plugin.settings.unknownFilePath) {
      await this.load();
    }
  }
}

/* --------------------------------------------------------------------------
 * 插件本体
 * ------------------------------------------------------------------------ */

class VocabCapturePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.observers = new Map();
    this.refreshTimer = null;
    this.recording = false;
    this.recordingCleanup = null;
    this.currentHighlight = null;
    this.currentUnknownHighlight = null;
    this.wordsVersion = 0;
    this.editorApi = null;
    this.editorRefreshEffect = null;
    this.editorViews = new Set();

    const HighlightCtor =
      typeof window !== "undefined"
        ? window.Highlight ||
          (typeof Highlight !== "undefined" ? Highlight : null)
        : null;
    this.HighlightCtor = HighlightCtor;
    this.highlightSupported = Boolean(
      HighlightCtor &&
        typeof window !== "undefined" &&
        window.CSS &&
        window.CSS.highlights,
    );

    this.store = new WordStore(this);
    try {
      await this.store.load();
    } catch (error) {
      console.error("[vocab-capture] load word list failed", error);
      new Notice(`读取生词本失败：${String(error.message || error)}`);
    }

    this.unknownStore = new UnknownStore(this);
    try {
      await this.unknownStore.load();
    } catch (error) {
      console.error("[vocab-capture] load unknown list failed", error);
      new Notice(`读取不理解词文件失败：${String(error.message || error)}`);
    }

    this.applyHighlightColor();
    this.injectHighlightStyle();

    this.registerEditorHighlighting();

    if (!this.highlightSupported) {
      new Notice(
        "当前 Obsidian 内核不支持 CSS Highlight API，生词仍可收录，但阅读视图不会高亮。",
      );
    }

    this.addSettingTab(new VocabCaptureSettingTab(this.app, this));

    this.addCommand({
      id: "toggle-selected-word",
      name: "收录/移除选中的词条",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const mode = view ? view.getMode() : null;
        const available = mode === "preview" || mode === "source";
        if (!checking && available) {
          this.captureFromView(view, true);
        }
        return available;
      },
    });

    this.addCommand({
      id: "record-unknown-selection",
      name: "记录不理解的词/内容",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const mode = view ? view.getMode() : null;
        const available = mode === "preview" || mode === "source";
        if (!checking && available) {
          this.captureUnknownFromView(view, true);
        }
        return available;
      },
    });

    this.addCommand({
      id: "open-unknown-list",
      name: "打开不理解词文件",
      callback: () => {
        void this.openUnknownFile();
      },
    });

    this.addCommand({
      id: "open-word-list",
      name: "打开生词本",
      callback: () => {
        void this.openWordFile();
      },
    });

    this.addCommand({
      id: "reload-word-list",
      name: "重新加载生词本",
      callback: async () => {
        if (await this.reloadWordStore()) {
          new Notice(`生词本已加载：${this.store.words.size} 个词条`);
        }
      },
    });

    this.addCommand({
      id: "refresh-highlights",
      name: "刷新词条高亮",
      callback: () => this.scheduleRefresh(0),
    });

    const onKeyDown = (event) => this.handleKeyDown(event);
    document.addEventListener("keydown", onKeyDown, true);
    this.register(() =>
      document.removeEventListener("keydown", onKeyDown, true),
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.ensureObservers();
        this.scheduleRefresh(30);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.ensureObservers();
        this.scheduleRefresh(30);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.scheduleRefresh(30);
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        const wordPath = this.getVaultWordPath();
        if (
          wordPath &&
          file.path === wordPath &&
          this.store &&
          !this.store.saving
        ) {
          void this.reloadWordStore(false);
          return;
        }

        const unknownPath = this.getVaultUnknownPath();
        if (
          unknownPath &&
          file.path === unknownPath &&
          this.unknownStore &&
          !this.unknownStore.saving
        ) {
          void this.reloadUnknownStore(false);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        const wordPath = this.getVaultWordPath();
        if (
          wordPath &&
          file.path === wordPath &&
          this.store &&
          !this.store.saving
        ) {
          void this.reloadWordStore(false);
          return;
        }

        const unknownPath = this.getVaultUnknownPath();
        if (
          unknownPath &&
          file.path === unknownPath &&
          this.unknownStore &&
          !this.unknownStore.saving
        ) {
          void this.reloadUnknownStore(false);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        const wordPath = this.getVaultWordPath();
        if (wordPath && file.path === wordPath) {
          this.store.words = new Set();
          this.bumpWordsVersion();
          this.scheduleRefresh(0);
          return;
        }

        const unknownPath = this.getVaultUnknownPath();
        if (unknownPath && file.path === unknownPath) {
          this.unknownStore.entries = new Set();
          this.bumpWordsVersion();
          this.scheduleRefresh(0);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const wordPath = this.getVaultWordPath();
        if (wordPath && oldPath === wordPath) {
          this.settings.wordFilePath = file.path;
          void this.saveSettings();
          void this.reloadWordStore(false);
          return;
        }

        const unknownPath = this.getVaultUnknownPath();
        if (unknownPath && oldPath === unknownPath) {
          this.settings.unknownFilePath = file.path;
          void this.saveSettings();
          void this.reloadUnknownStore(false);
        }
      }),
    );

    this.registerMarkdownPostProcessor(() => {
      this.scheduleRefresh(40);
    });

    this.app.workspace.onLayoutReady(() => {
      this.ensureObservers();
      this.scheduleRefresh(0);
    });
    this.scheduleRefresh(0);
  }

  registerEditorHighlighting() {
    try {
      const viewApi = require("@codemirror/view");
      const stateApi = require("@codemirror/state");
      if (
        !viewApi ||
        !viewApi.ViewPlugin ||
        !viewApi.Decoration ||
        !stateApi ||
        !stateApi.RangeSetBuilder ||
        !stateApi.StateEffect
      ) {
        return;
      }
      this.editorApi = { view: viewApi, state: stateApi };
      this.editorRefreshEffect = stateApi.StateEffect.define();
      this.registerEditorExtension(
        createEditorHighlightExtension(this, this.editorApi),
      );
    } catch (error) {
      console.warn(
        "[vocab-capture] editor highlighting unavailable",
        error,
      );
      this.editorApi = null;
    }
  }

  bumpWordsVersion() {
    this.wordsVersion += 1;
  }

  refreshEditorHighlights() {
    if (!this.editorApi || !this.editorRefreshEffect) return;
    if (!this.editorViews) return;

    for (const editorView of this.editorViews) {
      try {
        editorView.dispatch({
          effects: this.editorRefreshEffect.of(null),
        });
      } catch (error) {
        // Editor is closing; skip.
      }
    }
  }

  onunload() {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.observers) {
      for (const observer of this.observers.values()) {
        observer.disconnect();
      }
      this.observers.clear();
    }

    if (typeof this.recordingCleanup === "function") {
      this.recordingCleanup();
    }

    if (this.editorViews) this.editorViews.clear();

    this.removeHighlightStyle();
    this.clearHighlights();

    if (typeof document !== "undefined" && document.body) {
      document.body.style.removeProperty(
        "--vocab-capture-highlight-color",
      );
      document.body.style.removeProperty(
        "--vocab-capture-unknown-highlight-color",
      );
    }
  }

  async loadSettings() {
    let data = null;
    try {
      data = await this.loadData();
    } catch (error) {
      console.error("[vocab-capture] load settings failed", error);
    }

    const saved = data && typeof data === "object" ? data : {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    delete this.settings.scopeFolder;

    this.settings.wordFilePath =
      String(this.settings.wordFilePath || "").trim() ||
      DEFAULT_SETTINGS.wordFilePath;
    this.settings.unknownFilePath =
      String(this.settings.unknownFilePath || "").trim() ||
      DEFAULT_SETTINGS.unknownFilePath;
    this.settings.highlightColor =
      String(this.settings.highlightColor || "").trim() ||
      DEFAULT_SETTINGS.highlightColor;
    this.settings.unknownHighlightColor =
      String(this.settings.unknownHighlightColor || "").trim() ||
      DEFAULT_SETTINGS.unknownHighlightColor;

    const hotkey = normalizeHotkey(
      saved.hotkey || DEFAULT_SETTINGS.hotkey,
    );
    this.settings.hotkey = hotkey.key
      ? hotkey
      : normalizeHotkey(DEFAULT_SETTINGS.hotkey);

    const unknownHotkey = normalizeHotkey(
      saved.unknownHotkey || DEFAULT_SETTINGS.unknownHotkey,
    );
    this.settings.unknownHotkey = unknownHotkey.key
      ? unknownHotkey
      : normalizeHotkey(DEFAULT_SETTINGS.unknownHotkey);

    this.settings.includeTables = Boolean(this.settings.includeTables);
    this.settings.includeCode = Boolean(this.settings.includeCode);
    this.settings.skipExistingHighlights = Boolean(
      this.settings.skipExistingHighlights,
    );
    this.settings.sortAlphabetically = Boolean(
      this.settings.sortAlphabetically,
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyHighlightColor();
    this.bumpWordsVersion();
    this.scheduleRefresh(0);
  }

  applyHighlightColor() {
    if (typeof document === "undefined" || !document.body) return;

    const color = String(this.settings.highlightColor || "").trim();
    if (color) {
      document.body.style.setProperty(
        "--vocab-capture-highlight-color",
        color,
      );
    } else {
      document.body.style.removeProperty(
        "--vocab-capture-highlight-color",
      );
    }

    const unknownColor = String(
      this.settings.unknownHighlightColor || "",
    ).trim();
    if (unknownColor) {
      document.body.style.setProperty(
        "--vocab-capture-unknown-highlight-color",
        unknownColor,
      );
    } else {
      document.body.style.removeProperty(
        "--vocab-capture-unknown-highlight-color",
      );
    }
  }

  injectHighlightStyle() {
    if (typeof document === "undefined") return;
    this.removeHighlightStyle();
    const style = document.createElement("style");
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = buildHighlightCss(
      getHighlightName(),
      getUnknownHighlightName(),
    );
    (document.head || document.body).appendChild(style);
    this.highlightStyleEl = style;
  }

  removeHighlightStyle() {
    this.highlightStyleEl = null;
    if (typeof document === "undefined") return;
    const existing = document.getElementById(HIGHLIGHT_STYLE_ID);
    if (existing) existing.remove();
  }

  handleKeyDown(event) {
    if (this.recording) return;
    if (event.defaultPrevented || event.isComposing || event.repeat) return;

    const isMainHotkey = matchesHotkey(event, this.settings.hotkey);
    const isUnknownHotkey = matchesHotkey(
      event,
      this.settings.unknownHotkey,
    );
    if (!isMainHotkey && !isUnknownHotkey) return;
    if (isEditableTarget(event.target)) return;
    if (document.querySelector(".modal-container, .prompt")) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const mode = view.getMode();
    if (mode !== "preview" && mode !== "source") return;

    const info = this.getSelectionInfo(view);
    if (!info) return;

    event.preventDefault();
    event.stopPropagation();

    if (isMainHotkey) {
      this.captureFromView(view, false, info);
    } else {
      this.captureUnknownFromView(view, false, info);
    }
  }

  getSelectionInfo(view) {
    if (view.getMode() === "source") {
      const editor = view.editor;
      if (!editor) return null;

      let selections = [];
      try {
        selections = editor.listSelections ? editor.listSelections() : [];
      } catch (error) {
        selections = [];
      }
      if (selections && selections.length > 1) return null;

      const text = editor.getSelection ? editor.getSelection() : "";
      if (!text) return null;

      return {
        text,
        anchorParent: null,
        source: "editor",
      };
    }

    const preview = getPreviewElement(view);
    if (!preview) return null;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    if (
      !preview.contains(selection.anchorNode) ||
      !preview.contains(selection.focusNode)
    ) {
      return null;
    }

    const anchorParent =
      selection.anchorNode && selection.anchorNode.parentElement
        ? selection.anchorNode.parentElement
        : null;

    return {
      text: selection.toString(),
      anchorParent,
      source: "preview",
    };
  }

  captureFromView(view, showMissingNotice, knownInfo) {
    const info = knownInfo || this.getSelectionInfo(view);
    if (!info) {
      if (showMissingNotice) {
        new Notice("请先选中英文单词、英文短语或中文词语");
      }
      return;
    }

    const entry = normalizeEntry(info.text);
    if (!entry) {
      new Notice(
        "请选择一个英文单词、英文短语或中文词语；不支持中英混合、数字或内部标点",
      );
      return;
    }

    if (
      info.source === "preview" &&
      !this.settings.includeCode &&
      info.anchorParent &&
      info.anchorParent.closest("code, pre")
    ) {
      new Notice("代码区域默认不参与高亮，可在插件设置中打开“包含代码”");
      return;
    }

    if (
      info.source === "preview" &&
      !this.settings.includeTables &&
      info.anchorParent &&
      info.anchorParent.closest("table")
    ) {
      new Notice("表格默认不参与高亮，可在插件设置中打开“包含表格”");
      return;
    }

    if (!view.file || this.isWordFile(view.file)) {
      new Notice("生词本文件本身不参与收录和高亮");
      return;
    }

    void this.toggleEntry(entry);
  }

  async toggleEntry(entry) {
    const normalized = normalizeEntry(entry);
    if (!normalized) return;

    try {
      await this.store.ensureLoaded();
      const existed = this.store.words.has(normalized);
      const changed = existed
        ? await this.store.remove(normalized)
        : await this.store.add(normalized);

      this.bumpWordsVersion();
      this.scheduleRefresh(0);

      const kind = classifyEntry(normalized);
      const label =
        kind === "zh"
          ? "中文词条"
          : normalized.includes(" ")
            ? "英文短语"
            : "英文单词";
      const count = this.store.words.size;

      if (changed && existed) {
        new Notice(`已移除${label}“${normalized}” · 剩余 ${count} 个词条`);
      } else if (changed) {
        new Notice(`已收录${label}“${normalized}” · 共 ${count} 个词条`);
      } else {
        new Notice(
          existed
            ? `“${normalized}” 已不在词集中`
            : `“${normalized}” 已在词集中`,
        );
      }
    } catch (error) {
      console.error("[vocab-capture] toggle entry failed", error);
      new Notice(`更新生词本失败：${String(error.message || error)}`);
    }
  }

  async captureUnknownFromView(view, showMissingNotice, knownInfo) {
    const info = knownInfo || this.getSelectionInfo(view);
    if (!info) {
      if (showMissingNotice) {
        new Notice("请先选中要记录的内容");
      }
      return;
    }

    const text = normalizeUnknownSelection(info.text);
    if (!text) {
      new Notice("请先选中要记录的内容");
      return;
    }

    try {
      const result = await this.appendUnknown(text);
      if (result.added) {
        new Notice(`已记录不理解的内容 · 共 ${result.count} 条`);
      } else {
        new Notice("该内容已在“不理解的词”文件中");
      }
    } catch (error) {
      console.error("[vocab-capture] record unknown failed", error);
      new Notice(`记录不理解内容失败：${String(error.message || error)}`);
    }
  }

  async appendUnknown(rawText) {
    const entry = normalizeUnknownSelection(rawText);
    if (!entry) return { added: false, count: 0 };

    await this.unknownStore.ensureLoaded();
    const path = this.settings.unknownFilePath;
    const existing = await this.readTextFile(path);
    const result = appendUnknownRecord(existing, entry);
    if (!result.added) {
      return { added: false, count: countUnknownLines(existing) };
    }

    this.unknownStore.saving = true;
    try {
      await this.writeTextFile(path, result.text);
    } finally {
      this.unknownStore.saving = false;
    }

    this.unknownStore.entries.add(entry);
    this.unknownStore.loadedPath = path;
    this.bumpWordsVersion();
    this.scheduleRefresh(0);

    return { added: true, count: countUnknownLines(result.text) };
  }

  async countUnknown() {
    await this.unknownStore.ensureLoaded();
    return this.unknownStore.entries.size;
  }

  async openUnknownFile() {
    const rawPath = String(this.settings.unknownFilePath || "").trim();
    if (!rawPath) {
      new Notice("请先在插件设置中填写“不理解的词”文件路径");
      return;
    }

    if (isAbsolutePath(rawPath)) {
      new Notice(`“不理解的词”文件位于 vault 外，请用文件管理器打开：\n${rawPath}`);
      return;
    }

    try {
      const vaultPath = normalizeVaultPath(rawPath);
      if (!(await this.app.vault.adapter.exists(vaultPath))) {
        await this.writeTextFile(vaultPath, "");
      }
      await this.app.workspace.openLinkText(vaultPath, "", false);
    } catch (error) {
      new Notice(`打开“不理解的词”文件失败：${String(error.message || error)}`);
    }
  }

  isWordFile(file) {
    if (!file) return false;
    const rawPath = String(this.settings.wordFilePath || "").trim();
    if (!rawPath || isAbsolutePath(rawPath)) return false;
    try {
      return file.path === normalizeVaultPath(rawPath);
    } catch (error) {
      return false;
    }
  }

  isUnknownFile(file) {
    if (!file) return false;
    const rawPath = String(this.settings.unknownFilePath || "").trim();
    if (!rawPath || isAbsolutePath(rawPath)) return false;
    try {
      return file.path === normalizeVaultPath(rawPath);
    } catch (error) {
      return false;
    }
  }

  getVaultUnknownPath() {
    const rawPath = String(this.settings.unknownFilePath || "").trim();
    if (!rawPath || isAbsolutePath(rawPath)) return null;
    try {
      return normalizeVaultPath(rawPath);
    } catch (error) {
      return null;
    }
  }

  getVaultWordPath() {
    const rawPath = String(this.settings.wordFilePath || "").trim();
    if (!rawPath || isAbsolutePath(rawPath)) return null;
    try {
      return normalizeVaultPath(rawPath);
    } catch (error) {
      return null;
    }
  }

  async readTextFile(rawPath) {
    const path = String(rawPath || "").trim();
    if (!path) return "";

    if (isAbsolutePath(path)) {
      let fs;
      try {
        fs = require("fs");
      } catch (error) {
        throw new Error("绝对路径词表仅支持桌面版 Obsidian");
      }
      try {
        return await fs.promises.readFile(path, "utf8");
      } catch (error) {
        if (error && error.code === "ENOENT") return "";
        throw error;
      }
    }

    const vaultPath = normalizeVaultPath(path);
    if (!vaultPath) return "";
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(vaultPath))) return "";
    return adapter.read(vaultPath);
  }

  async writeTextFile(rawPath, text) {
    const path = String(rawPath || "").trim();
    if (!path) throw new Error("生词本路径为空");

    if (isAbsolutePath(path)) {
      let fs;
      let nodePath;
      try {
        fs = require("fs");
        nodePath = require("path");
      } catch (error) {
        throw new Error("绝对路径词表仅支持桌面版 Obsidian");
      }
      await fs.promises.mkdir(nodePath.dirname(path), { recursive: true });
      await fs.promises.writeFile(path, text, "utf8");
      return;
    }

    const vaultPath = normalizeVaultPath(path);
    if (!vaultPath) throw new Error("生词本路径为空");

    const dir = vaultPath.split("/").slice(0, -1).join("/");
    if (dir) {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(dir))) {
        try {
          await this.app.vault.createFolder(dir);
        } catch (error) {
          if (!(await adapter.exists(dir))) throw error;
        }
      }
    }

    await this.app.vault.adapter.write(vaultPath, text);
  }

  async openWordFile() {
    const rawPath = String(this.settings.wordFilePath || "").trim();
    if (!rawPath) {
      new Notice("请先在插件设置中填写生词本路径");
      return;
    }

    if (isAbsolutePath(rawPath)) {
      new Notice(`生词本位于 vault 外，请用文件管理器打开：\n${rawPath}`);
      return;
    }

    try {
      const vaultPath = normalizeVaultPath(rawPath);
      if (!(await this.app.vault.adapter.exists(vaultPath))) {
        const text = serializeWordSet(
          this.store.words,
          Boolean(this.settings.sortAlphabetically),
        );
        await this.writeTextFile(vaultPath, text);
      }
      await this.app.workspace.openLinkText(vaultPath, "", false);
    } catch (error) {
      new Notice(`打开生词本失败：${String(error.message || error)}`);
    }
  }

  async reloadWordStore(showNotice = false) {
    try {
      await this.store.load();
      this.bumpWordsVersion();
      this.scheduleRefresh(0);
      return true;
    } catch (error) {
      console.error("[vocab-capture] reload word list failed", error);
      if (showNotice) {
        new Notice(`读取生词本失败：${String(error.message || error)}`);
      }
      return false;
    }
  }

  async reloadUnknownStore(showNotice = false) {
    try {
      await this.unknownStore.load();
      this.bumpWordsVersion();
      this.scheduleRefresh(0);
      return true;
    } catch (error) {
      console.error("[vocab-capture] reload unknown list failed", error);
      if (showNotice) {
        new Notice(`读取不理解词文件失败：${String(error.message || error)}`);
      }
      return false;
    }
  }

  scheduleRefresh(delay = 60) {
    if (this.refreshTimer) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      try {
        this.ensureObservers();
        this.refreshHighlights();
        this.refreshEditorHighlights();
      } catch (error) {
        console.error("[vocab-capture] refresh failed", error);
      }
    }, delay);
  }

  ensureObservers() {
    if (typeof MutationObserver === "undefined") return;
    if (!this.observers) this.observers = new Map();

    const seen = new Set();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      if (view.getMode() !== "preview") continue;

      const preview = getPreviewElement(view);
      if (!preview) continue;
      if (preview.ownerDocument !== document) continue;

      seen.add(preview);
      if (!this.observers.has(preview)) {
        const observer = new MutationObserver(() =>
          this.scheduleRefresh(60),
        );
        observer.observe(preview, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        this.observers.set(preview, observer);
      }
    }

    for (const [element, observer] of this.observers) {
      if (!seen.has(element)) {
        observer.disconnect();
        this.observers.delete(element);
      }
    }
  }

  refreshHighlights() {
    if (!this.highlightSupported) return;

    const mainEntries = this.store ? this.store.words : new Set();
    const unknownEntries = this.unknownStore
      ? this.unknownStore.entries
      : new Set();
    if (mainEntries.size === 0 && unknownEntries.size === 0) {
      this.clearHighlights();
      return;
    }

    const mainRegex = buildWordRegex(mainEntries);
    const unknownRegex = buildUnknownRegex(unknownEntries);
    if (!mainRegex && !unknownRegex) {
      this.clearHighlights();
      return;
    }

    const mainRanges = [];
    const unknownRanges = [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      if (view.getMode() !== "preview") continue;
      if (
        !view.file ||
        this.isWordFile(view.file) ||
        this.isUnknownFile(view.file)
      ) {
        continue;
      }

      const preview = getPreviewElement(view);
      if (!preview) continue;
      if (preview.ownerDocument !== document) continue;

      const rangeOptions = {
        includeCode: this.settings.includeCode,
        includeTables: this.settings.includeTables,
        skipExistingHighlights: this.settings.skipExistingHighlights,
      };
      if (mainRegex) {
        mainRanges.push(...collectRanges(preview, mainRegex, rangeOptions));
      }
      if (unknownRegex) {
        unknownRanges.push(
          ...collectRanges(preview, unknownRegex, rangeOptions),
        );
      }
    }

    this.currentHighlight = this.setHighlight(
      getHighlightName(),
      mainRanges,
    );
    this.currentUnknownHighlight = this.setHighlight(
      getUnknownHighlightName(),
      unknownRanges,
    );
  }

  setHighlight(name, ranges) {
    if (
      typeof window === "undefined" ||
      !window.CSS ||
      !window.CSS.highlights ||
      !this.HighlightCtor
    ) {
      return null;
    }

    if (!ranges || !ranges.length) {
      try {
        window.CSS.highlights.delete(name);
      } catch (error) {
        // 注册表被宿主清理时忽略。
      }
      return null;
    }

    const highlight = new this.HighlightCtor();
    for (const range of ranges) {
      highlight.add(range);
    }
    window.CSS.highlights.set(name, highlight);
    return highlight;
  }

  clearHighlights() {
    this.currentHighlight = null;
    this.currentUnknownHighlight = null;
    if (
      typeof window === "undefined" ||
      !window.CSS ||
      !window.CSS.highlights
    ) {
      return;
    }
    for (const name of [getHighlightName(), getUnknownHighlightName()]) {
      try {
        window.CSS.highlights.delete(name);
      } catch (error) {
        // 注册表被宿主清理时忽略。
      }
    }
  }
}

/* --------------------------------------------------------------------------
 * 设置页
 * ------------------------------------------------------------------------ */

class VocabCaptureSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.pathTimer = null;
    this.unknownPathTimer = null;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "生词捕获" });
    containerEl.createEl("p", {
      text: "主快捷键收录/移除词条并高亮；另一个快捷键把不理解的内容记录到独立文件，使用橙色高亮，不做格式校验。",
    });

    const count = this.plugin.store ? this.plugin.store.words.size : 0;
    containerEl.createEl("p", {
      text: `当前词表：${count} 个词条 · ${this.plugin.settings.wordFilePath}`,
    });

    const unknownInfo = containerEl.createEl("p", {
      text: "不理解词：读取中…",
    });
    void this.plugin
      .countUnknown()
      .then((unknownCount) => {
        unknownInfo.setText(
          `不理解词：${unknownCount} 条 · ${this.plugin.settings.unknownFilePath}`,
        );
      })
      .catch(() => {
        unknownInfo.setText(
          `不理解词：无法读取 · ${this.plugin.settings.unknownFilePath}`,
        );
      });

    new Setting(containerEl)
      .setName("生词本文件")
      .setDesc(
        "相对 vault 根目录，或填绝对路径（绝对路径仅桌面版）。默认 生词本.txt。",
      )
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.wordFilePath)
          .setValue(this.plugin.settings.wordFilePath)
          .onChange((value) => {
            this.plugin.settings.wordFilePath =
              value.trim() || DEFAULT_SETTINGS.wordFilePath;
            void this.plugin.saveSettings();

            if (this.pathTimer) window.clearTimeout(this.pathTimer);
            this.pathTimer = window.setTimeout(() => {
              this.pathTimer = null;
              void this.plugin.reloadWordStore(true);
            }, 600);
          });
      });

    new Setting(containerEl)
      .setName("不理解的词文件")
      .setDesc(
        "独立于生词本，记录不理解的内容；使用橙色独立高亮，不做格式校验。默认 不理解的词.txt。",
      )
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.unknownFilePath)
          .setValue(this.plugin.settings.unknownFilePath)
          .onChange((value) => {
            this.plugin.settings.unknownFilePath =
              value.trim() || DEFAULT_SETTINGS.unknownFilePath;
            void this.plugin.saveSettings();

            if (this.unknownPathTimer) {
              window.clearTimeout(this.unknownPathTimer);
            }
            this.unknownPathTimer = window.setTimeout(() => {
              this.unknownPathTimer = null;
              void this.plugin.reloadUnknownStore(true);
            }, 600);
          });
      });

    new Setting(containerEl)
      .setName("收录快捷键")
      .setDesc(
        "在阅读/编辑视图中选中词条后按下。支持单键或组合键；单键只在有选区时生效。",
      )
      .addText((text) => {
        text.setValue(formatHotkey(this.plugin.settings.hotkey));
        text.inputEl.disabled = true;
        text.inputEl.style.width = "10em";
        this.hotkeyText = text;
      })
      .addButton((button) => {
        button.setButtonText("录制").onClick(() => {
          this.startRecording(this.hotkeyText, button);
        });
      })
      .addButton((button) => {
        button.setButtonText("恢复默认").onClick(async () => {
          this.plugin.settings.hotkey = normalizeHotkey(
            DEFAULT_SETTINGS.hotkey,
          );
          await this.plugin.saveSettings();
          if (this.hotkeyText) {
            this.hotkeyText.setValue(
              formatHotkey(this.plugin.settings.hotkey),
            );
          }
        });
      });

    new Setting(containerEl)
      .setName("不理解词快捷键")
      .setDesc(
        "选中内容后记录到独立文件并橙色高亮，不做格式校验。",
      )
      .addText((text) => {
        text.setValue(formatHotkey(this.plugin.settings.unknownHotkey));
        text.inputEl.disabled = true;
        text.inputEl.style.width = "10em";
        this.unknownHotkeyText = text;
      })
      .addButton((button) => {
        button.setButtonText("录制").onClick(() => {
          this.startRecording(
            this.unknownHotkeyText,
            button,
            "unknownHotkey",
          );
        });
      })
      .addButton((button) => {
        button.setButtonText("恢复默认").onClick(async () => {
          this.plugin.settings.unknownHotkey = normalizeHotkey(
            DEFAULT_SETTINGS.unknownHotkey,
          );
          await this.plugin.saveSettings();
          if (this.unknownHotkeyText) {
            this.unknownHotkeyText.setValue(
              formatHotkey(this.plugin.settings.unknownHotkey),
            );
          }
        });
      });

    new Setting(containerEl)
      .setName("高亮颜色")
      .setDesc(
        "任意 CSS 颜色值，例如 rgba(64, 190, 160, 0.28) 或 #7ee0c0。",
      )
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.highlightColor)
          .setValue(this.plugin.settings.highlightColor)
          .onChange((value) => {
            this.plugin.settings.highlightColor =
              value.trim() || DEFAULT_SETTINGS.highlightColor;
            void this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("不理解词高亮颜色")
      .setDesc(
        "不理解词使用独立颜色高亮，默认橙色；任意 CSS 颜色值。",
      )
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.unknownHighlightColor)
          .setValue(this.plugin.settings.unknownHighlightColor)
          .onChange((value) => {
            this.plugin.settings.unknownHighlightColor =
              value.trim() || DEFAULT_SETTINGS.unknownHighlightColor;
            void this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("包含表格")
      .setDesc("是否高亮表格单元格中的词条（词库表）。")
      .addToggle((toggle) => {
        toggle
          .setValue(Boolean(this.plugin.settings.includeTables))
          .onChange(async (value) => {
            this.plugin.settings.includeTables = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("包含代码")
      .setDesc("是否处理行内代码和代码块；默认关闭。")
      .addToggle((toggle) => {
        toggle
          .setValue(Boolean(this.plugin.settings.includeCode))
          .onChange(async (value) => {
            this.plugin.settings.includeCode = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("跳过已有高亮")
      .setDesc("跳过 md 中已有的 ==高亮==（例如填空编号），避免叠色。")
      .addToggle((toggle) => {
        toggle
          .setValue(Boolean(this.plugin.settings.skipExistingHighlights))
          .onChange(async (value) => {
            this.plugin.settings.skipExistingHighlights = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("按字母排序")
      .setDesc("关闭后按首次收录顺序写入生词本。")
      .addToggle((toggle) => {
        toggle
          .setValue(Boolean(this.plugin.settings.sortAlphabetically))
          .onChange(async (value) => {
            this.plugin.settings.sortAlphabetically = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("操作")
      .setDesc("立即刷新高亮，或重新读取词表。")
      .addButton((button) => {
        button.setButtonText("刷新高亮").onClick(() => {
          this.plugin.scheduleRefresh(0);
          new Notice("已刷新高亮");
        });
      })
      .addButton((button) => {
        button.setButtonText("重新加载").onClick(async () => {
          if (await this.plugin.reloadWordStore(true)) {
            new Notice(`已加载 ${this.plugin.store.words.size} 个词条`);
          }
        });
      })
      .addButton((button) => {
        button.setButtonText("打开生词本").onClick(() => {
          void this.plugin.openWordFile();
        });
      })
      .addButton((button) => {
        button.setButtonText("打开不理解词文件").onClick(() => {
          void this.plugin.openUnknownFile();
        });
      });
  }

  hide() {
    if (this.pathTimer) {
      window.clearTimeout(this.pathTimer);
      this.pathTimer = null;
    }
    if (this.unknownPathTimer) {
      window.clearTimeout(this.unknownPathTimer);
      this.unknownPathTimer = null;
    }
    if (this.plugin.recording && this.plugin.recordingCleanup) {
      this.plugin.recordingCleanup();
    }
    if (typeof super.hide === "function") super.hide();
  }

  startRecording(textComponent, button, settingKey = "hotkey") {
    if (!textComponent) return;
    if (this.plugin.recording && this.plugin.recordingCleanup) {
      this.plugin.recordingCleanup();
    }

    const previous = formatHotkey(this.plugin.settings[settingKey]);
    this.plugin.recording = true;
    textComponent.setValue("请按键…");
    button.setButtonText("按 Esc 取消");

    const finish = async (hotkey) => {
      window.removeEventListener("keydown", onKeyDown, true);
      this.plugin.recording = false;
      this.plugin.recordingCleanup = null;
      button.setButtonText("录制");

      if (!hotkey) {
        textComponent.setValue(previous);
        return;
      }

      this.plugin.settings[settingKey] = hotkey;
      try {
        await this.plugin.saveSettings();
      } catch (error) {
        console.error("[vocab-capture] save hotkey failed", error);
        new Notice(`保存快捷键失败：${String(error.message || error)}`);
      }
      textComponent.setValue(formatHotkey(hotkey));

      if (
        formatHotkey(this.plugin.settings.hotkey) ===
        formatHotkey(this.plugin.settings.unknownHotkey)
      ) {
        new Notice("警告：两个快捷键相同，主快捷键会优先触发。");
      } else {
        new Notice(`快捷键已设为 ${formatHotkey(hotkey)}`);
      }
    };

    const onKeyDown = (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        void finish(null);
        return;
      }
      if (MODIFIER_KEYS.has(event.key)) {
        textComponent.setValue("继续按非修饰键…");
        return;
      }

      const hotkey = eventToHotkey(event);
      if (!hotkey.key) return;
      void finish(hotkey);
    };

    this.plugin.recordingCleanup = () => {
      void finish(null);
    };

    window.addEventListener("keydown", onKeyDown, true);
  }
}

/* --------------------------------------------------------------------------
 * 导出
 * ------------------------------------------------------------------------ */

module.exports = VocabCapturePlugin;
module.exports.__test = {
  normalizeEntry,
  classifyEntry,
  normalizeUnknownSelection,
  countUnknownLines,
  parseUnknownSet,
  appendUnknownRecord,
  parseWordSet,
  serializeWordSet,
  buildWordPatternSource,
  buildWordRegex,
  buildUnknownPatternSource,
  buildUnknownRegex,
  findMatches,
  normalizeHotkey,
  formatHotkey,
  eventToHotkey,
  matchesHotkey,
  normalizeVaultPath,
  isAbsolutePath,
  collectRanges,
  collectEditorSkipRanges,
  buildEditorDecorations,
  overlapsRanges,
  isEditableTarget,
  getHighlightName,
  getUnknownHighlightName,
  buildHighlightCss,
  WordStore,
  UnknownStore,
};
