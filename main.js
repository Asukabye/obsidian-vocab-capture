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
  unknownRootFolder: "不理解的词",
  unknownNotePath: "不理解的词/未分类/未分类.md",
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
  let value = raw
    .replace(/\r\n?|\n/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const code = /^(`+)([\s\S]*?)\1$/.exec(value);
  if (code) value = code[2].trim();
  return value;
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
    .map((line) => normalizeUnknownSelection(line))
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

function removeUnknownRecord(existing, entry) {
  const current = String(existing == null ? "" : existing);
  const normalized = normalizeUnknownSelection(entry);
  if (!normalized) return { text: current, removed: false };

  const lines = current.split(/\r?\n/);
  const kept = lines.filter(
    (line) => normalizeUnknownSelection(line) !== normalized,
  );
  if (kept.length === lines.length) {
    return { text: current, removed: false };
  }

  let text = kept.join("\n");
  if (text && !text.endsWith("\n")) text += "\n";
  return { text, removed: true };
}

function normalizeUnknownKey(value) {
  return normalizeUnknownSelection(value)
    .toLocaleLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[‐‑–—]/g, "-");
}

function findUnknownEntryForText(text, entries) {
  const key = normalizeUnknownKey(text);
  if (!key) return null;
  for (const entry of entries || []) {
    if (normalizeUnknownKey(entry) === key) return entry;
  }

  const compact = key.replace(/\s+/g, "");
  if (!compact) return null;
  for (const entry of entries || []) {
    if (normalizeUnknownKey(entry).replace(/\s+/g, "") === compact) {
      return entry;
    }
  }
  return null;
}

function findUnknownEntryAtOffset(text, offset, entries) {
  const regex = buildUnknownRegex(entries);
  if (!regex || !text) return null;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    if (offset >= from && offset <= to) {
      return findUnknownEntryForText(match[0], entries);
    }
    if (from > offset) break;
  }
  return null;
}

function normalizeCategoryName(value) {
  return String(value == null ? "" : value)
    .replace(/\r\n?|\n/g, " ")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseUnknownNote(text) {
  const source = String(text == null ? "" : text);
  const lines = source.split(/\r?\n/);
  const categories = [];
  const cards = [];
  let currentCategory = null;
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1) {
      currentCategory = {
        name: h1[1].trim(),
        start: index,
        end: lines.length,
        cards: [],
      };
      categories.push(currentCategory);
      continue;
    }

    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2 && currentCategory) {
      const card = {
        name: h2[1].trim(),
        start: index,
        end: lines.length,
        category: currentCategory.name,
      };
      currentCategory.cards.push(card);
      cards.push(card);
    }
  }

  for (let index = 0; index < categories.length; index += 1) {
    const category = categories[index];
    if (index + 1 < categories.length) {
      category.end = categories[index + 1].start;
    }
    for (let cardIndex = 0; cardIndex < category.cards.length; cardIndex += 1) {
      const card = category.cards[cardIndex];
      const next =
        cardIndex + 1 < category.cards.length
          ? category.cards[cardIndex + 1].start
          : category.end;
      card.end = next;
    }
  }

  for (const card of cards) {
    const body = lines.slice(card.start + 1, card.end);
    const tags = new Set();
    let snippet = "";
    let inFence = false;
    for (const line of body) {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      for (const match of line.matchAll(/#[\p{L}\p{N}_/-]+/gu)) {
        tags.add(match[0]);
      }
      if (!snippet && line.trim()) {
        const plain = line
          .replace(/^\s*[-*+]\s*/, "")
          .replace(/\*\*/g, "")
          .trim();
        if (plain && !/^#[\p{L}\p{N}_/-]+$/.test(plain)) {
          snippet = plain;
        }
      }
    }
    card.tags = Array.from(tags);
    card.snippet = snippet;
  }

  return { text: source, lines, categories, cards };
}

function ensureTrailingNewline(text) {
  const cleaned = String(text == null ? "" : text).replace(/\n+$/, "");
  return cleaned ? `${cleaned}\n` : "";
}

function addUnknownCategoryText(text, name) {
  const current = String(text == null ? "" : text);
  const category = normalizeCategoryName(name);
  if (!category) return { text: current, changed: false };

  const parsed = parseUnknownNote(current);
  if (parsed.categories.some((item) => item.name === category)) {
    return { text: current, changed: false };
  }

  const lines = current.split(/\r?\n/);
  const uncategorized = parsed.categories.find(
    (item) => item.name === "未分类",
  );
  const at = uncategorized ? uncategorized.start : lines.length;
  const block = [];
  if (at > 0 && lines[at - 1].trim()) block.push("");
  block.push(`# ${category}`, "");

  lines.splice(at, 0, ...block);
  return { text: ensureTrailingNewline(lines.join("\n")), changed: true };
}

function deleteUnknownCategoryText(text, name) {
  const current = String(text == null ? "" : text);
  const categoryName = normalizeCategoryName(name);
  if (!categoryName || categoryName === "未分类") {
    return { text: current, changed: false, movedCards: 0 };
  }

  const parsed = parseUnknownNote(current);
  const target = parsed.categories.find(
    (item) => item.name === categoryName,
  );
  if (!target) return { text: current, changed: false, movedCards: 0 };

  const lines = current.split(/\r?\n/);
  const uncategorized = parsed.categories.find(
    (item) => item.name === "未分类",
  );

  if (!uncategorized) {
    lines[target.start] = "# 未分类";
    return {
      text: ensureTrailingNewline(lines.join("\n")),
      changed: true,
      movedCards: target.cards.length,
    };
  }

  const body = lines.slice(target.start + 1, target.end);
  lines.splice(target.start, target.end - target.start);
  let remaining = ensureTrailingNewline(lines.join("\n"));
  const nextParsed = parseUnknownNote(remaining);
  const nextUncategorized = nextParsed.categories.find(
    (item) => item.name === "未分类",
  );

  if (!nextUncategorized) {
    return { text: current, changed: false, movedCards: 0 };
  }

  const nextLines = remaining.split(/\r?\n/);
  const block = body.slice();
  const at = nextUncategorized.end;
  if (
    block.length &&
    at > 0 &&
    nextLines[at - 1] &&
    nextLines[at - 1].trim() &&
    block[0].trim()
  ) {
    block.unshift("");
  }
  if (block.length && !block[block.length - 1].trim()) {
    // 保留原有结尾空行。
  } else if (block.length) {
    block.push("");
  }

  nextLines.splice(at, 0, ...block);
  remaining = ensureTrailingNewline(nextLines.join("\n"));
  return {
    text: remaining,
    changed: true,
    movedCards: target.cards.length,
  };
}

function moveUnknownCardText(text, cardName, targetCategory) {
  const current = String(text == null ? "" : text);
  const name = normalizeUnknownSelection(cardName);
  const targetName = normalizeCategoryName(targetCategory);
  if (!name || !targetName) return { text: current, changed: false };

  const parsed = parseUnknownNote(current);
  const card = parsed.cards.find((item) => item.name === name);
  const target = parsed.categories.find(
    (item) => item.name === targetName,
  );
  if (!card || !target || card.category === targetName) {
    return { text: current, changed: false };
  }

  const lines = current.split(/\r?\n/);
  const block = lines.slice(card.start, card.end);
  lines.splice(card.start, card.end - card.start);
  let remaining = ensureTrailingNewline(lines.join("\n"));

  const nextParsed = parseUnknownNote(remaining);
  const nextTarget = nextParsed.categories.find(
    (item) => item.name === targetName,
  );
  if (!nextTarget) return { text: current, changed: false };

  const nextLines = remaining.split(/\r?\n/);
  const at = nextTarget.end;
  const insert = block.slice();
  if (
    insert.length &&
    at > 0 &&
    nextLines[at - 1] &&
    nextLines[at - 1].trim() &&
    insert[0].trim()
  ) {
    insert.unshift("");
  }
  if (insert.length && insert[insert.length - 1].trim()) {
    insert.push("");
  }

  nextLines.splice(at, 0, ...insert);
  remaining = ensureTrailingNewline(nextLines.join("\n"));
  return { text: remaining, changed: true };
}

function renameUnknownCategoryText(text, oldName, newName) {
  const current = String(text == null ? "" : text);
  const sourceName = normalizeCategoryName(oldName);
  const targetName = normalizeCategoryName(newName);
  if (!sourceName || !targetName || sourceName === "未分类") {
    return { text: current, changed: false };
  }

  const parsed = parseUnknownNote(current);
  const category = parsed.categories.find(
    (item) => item.name === sourceName,
  );
  if (!category) return { text: current, changed: false };
  if (
    sourceName !== targetName &&
    parsed.categories.some((item) => item.name === targetName)
  ) {
    return { text: current, changed: false };
  }

  const lines = current.split(/\r?\n/);
  lines[category.start] = `# ${targetName}`;
  return {
    text: ensureTrailingNewline(lines.join("\n")),
    changed: sourceName !== targetName,
  };
}

function rebuildUnknownCategories(parsed, lines, orderedBlocks) {
  const preamble = lines.slice(0, parsed.categories[0]?.start || 0);
  return ensureTrailingNewline(
    [...preamble, ...orderedBlocks.flat()].join("\n"),
  );
}

function reorderUnknownCategoryText(text, name, direction) {
  const current = String(text == null ? "" : text);
  const categoryName = normalizeCategoryName(name);
  if (
    !categoryName ||
    categoryName === "未分类" ||
    !Number.isFinite(direction) ||
    direction === 0
  ) {
    return { text: current, changed: false };
  }

  const parsed = parseUnknownNote(current);
  const index = parsed.categories.findIndex(
    (item) => item.name === categoryName,
  );
  const targetIndex = index + Math.sign(direction);
  if (index < 0 || targetIndex < 0 || targetIndex >= parsed.categories.length) {
    return { text: current, changed: false };
  }
  if (parsed.categories[targetIndex].name === "未分类") {
    return { text: current, changed: false };
  }

  const lines = current.split(/\r?\n/);
  const blocks = parsed.categories.map((item) =>
    lines.slice(item.start, item.end),
  );
  [blocks[index], blocks[targetIndex]] = [
    blocks[targetIndex],
    blocks[index],
  ];
  return {
    text: rebuildUnknownCategories(parsed, lines, blocks),
    changed: true,
  };
}

function moveUnknownCategoryBeforeText(text, name, targetName) {
  const current = String(text == null ? "" : text);
  const sourceName = normalizeCategoryName(name);
  const destination = normalizeCategoryName(targetName);
  if (
    !sourceName ||
    !destination ||
    sourceName === destination ||
    sourceName === "未分类"
  ) {
    return { text: current, changed: false };
  }

  const parsed = parseUnknownNote(current);
  const source = parsed.categories.find(
    (item) => item.name === sourceName,
  );
  const target = parsed.categories.find(
    (item) => item.name === destination,
  );
  if (!source || !target) return { text: current, changed: false };

  const lines = current.split(/\r?\n/);
  const blocks = parsed.categories.map((item) => ({
    name: item.name,
    lines: lines.slice(item.start, item.end),
  }));
  const sourceBlock = blocks.find((item) => item.name === sourceName);
  const rest = blocks.filter((item) => item.name !== sourceName);
  const targetIndex = rest.findIndex((item) => item.name === destination);
  if (targetIndex < 0) return { text: current, changed: false };
  rest.splice(targetIndex, 0, sourceBlock);

  return {
    text: rebuildUnknownCategories(
      parsed,
      lines,
      rest.map((item) => item.lines),
    ),
    changed: true,
  };
}

function ensureUnknownHeadingsText(existing, entries) {
  const current = String(existing == null ? "" : existing);
  const unique = Array.from(
    new Set(
      Array.from(entries || [], (entry) =>
        normalizeUnknownSelection(String(entry)),
      ).filter(Boolean),
    ),
  );
  if (!unique.length) return { text: current, changed: false };

  let text = current;
  let parsed = parseUnknownNote(text);

  if (
    parsed.categories.length === 1 &&
    parsed.categories[0].name === "不理解的词"
  ) {
    const lines = text.split(/\r?\n/);
    lines[parsed.categories[0].start] = "# 未分类";
    text = ensureTrailingNewline(lines.join("\n"));
    parsed = parseUnknownNote(text);
  }

  if (!parsed.categories.length) {
    const body = text
      .replace(/^\uFEFF/, "")
      .replace(/^\n+/, "");
    text = body
      ? `# 未分类\n\n${body}`
      : "# 未分类\n";
    text = ensureTrailingNewline(text);
    parsed = parseUnknownNote(text);
  } else if (!parsed.categories.some((item) => item.name === "未分类")) {
    text = addUnknownCategoryText(text, "未分类").text;
    parsed = parseUnknownNote(text);
  }

  const existingCards = new Set(parsed.cards.map((item) => item.name));
  const missing = unique.filter((entry) => !existingCards.has(entry));
  if (!missing.length) {
    return { text, changed: text !== current };
  }

  const uncategorized = parsed.categories.find(
    (item) => item.name === "未分类",
  );
  if (!uncategorized) return { text, changed: text !== current };

  const lines = text.split(/\r?\n/);
  let insertAt = uncategorized.end;
  while (insertAt > 0 && lines[insertAt - 1] === "") {
    insertAt -= 1;
  }

  const insert = [];
  if (insertAt > 0 && lines[insertAt - 1] && lines[insertAt - 1].trim()) {
    insert.push("");
  }
  for (const entry of missing) {
    insert.push(`## ${entry}`, "");
  }
  lines.splice(insertAt, 0, ...insert);
  text = ensureTrailingNewline(lines.join("\n"));
  return { text, changed: text !== current };
}

function findHeadingLine(text, heading) {
  const target = normalizeUnknownSelection(heading);
  if (!target) return -1;
  const lines = String(text == null ? "" : text).split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^#{1,6}[ \t]+(.+?)[ \t]*$/.exec(lines[index]);
    if (match && match[1].trim() === target) return index;
  }
  return -1;
}

function getCaretRangeFromEvent(event) {
  if (typeof document === "undefined") return null;
  if (typeof document.caretRangeFromPoint === "function") {
    return document.caretRangeFromPoint(event.clientX, event.clientY);
  }
  if (typeof document.caretPositionFromPoint === "function") {
    const position = document.caretPositionFromPoint(
      event.clientX,
      event.clientY,
    );
    if (!position) return null;
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  return null;
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

        this.clickHandler = (event) => {
          if (event.defaultPrevented || event.button !== 0) return;
          if (
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          if (!view.state.selection.main.empty) return;
          if (!plugin.unknownStore || !plugin.unknownStore.entries.size) {
            return;
          }
          if (event.target && event.target.closest("a")) return;

          const position = view.posAtCoords({
            x: event.clientX,
            y: event.clientY,
          });
          if (position == null) return;

          const entry = findUnknownEntryAtOffset(
            view.state.doc.toString(),
            position,
            plugin.unknownStore.entries,
          );
          if (!entry) return;

          event.preventDefault();
          event.stopPropagation();
          void plugin.openUnknownEntry(entry);
        };
        view.dom.addEventListener("click", this.clickHandler);

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
        this.editorView.dom.removeEventListener(
          "click",
          this.clickHandler,
        );
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

function parseMarkdownHeadings(text) {
  const source = String(text == null ? "" : text);
  const lines = source.split(/\r?\n/);
  const headings = [];
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    headings.push({
      title: match[2].trim(),
      level: match[1].length,
      start: index,
      end: lines.length,
    });
  }

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    for (let next = index + 1; next < headings.length; next += 1) {
      if (headings[next].level <= heading.level) {
        heading.end = headings[next].start;
        break;
      }
    }
  }

  return { source, lines, headings };
}

function convertFlatUnknownNoteToCards(text) {
  const current = String(text == null ? "" : text);
  const parsed = parseUnknownNote(current);
  const lines = current.split(/\r?\n/);
  const blocks = [];

  for (const card of parsed.cards) {
    const block = lines.slice(card.start, card.end);
    if (!block.length) continue;
    block[0] = `# ${card.name}`;
    while (block.length && !block[block.length - 1].trim()) {
      block.pop();
    }
    if (block.length) {
      blocks.push(block.join("\n"));
    }
  }

  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

function normalizeSafeFolderName(value) {
  const name = String(value == null ? "" : value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name === "." || name === "..") return "";
  return name;
}

function normalizeSafeMarkdownName(value) {
  let name = String(value == null ? "" : value).trim();
  if (!name) return "";
  if (!name.toLowerCase().endsWith(".md")) name += ".md";
  const base = normalizeSafeFolderName(name.slice(0, -3));
  return base ? `${base}.md` : "";
}

function headingLevelsWithinLimit(heading) {
  return heading && heading.level >= 1 && heading.level <= 6;
}

function findHeadingSection(text, title) {
  const parsed = parseMarkdownHeadings(text);
  const heading = parsed.headings.find((item) => item.title === title);
  if (!heading) return null;
  return {
    heading,
    section: parsed.lines.slice(heading.start, heading.end),
    before: parsed.lines.slice(0, heading.start),
    after: parsed.lines.slice(heading.end),
  };
}

function insertHeadingSection(text, parentTitle, section) {
  const parsed = parseMarkdownHeadings(text);
  const lines = parsed.lines.slice();
  let at = lines.length;

  if (parentTitle) {
    const parent = parsed.headings.find((item) => item.title === parentTitle);
    if (!parent) return null;
    at = parent.end;
  }

  while (at > 0 && !lines[at - 1].trim()) at -= 1;
  const insert = section.slice();
  if (at > 0 && lines[at - 1] && lines[at - 1].trim()) insert.unshift("");
  if (insert.length && insert[insert.length - 1].trim()) insert.push("");
  lines.splice(at, 0, ...insert);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return `${lines.join("\n")}\n`;
}

function removeHeadingSection(text, title) {
  const found = findHeadingSection(text, title);
  if (!found) return null;
  const lines = `${found.before.join("\n")}\n${found.after.join("\n")}`.split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return `${lines.join("\n")}\n`;
}

function uniqueHeadingTitles(text) {
  const parsed = parseMarkdownHeadings(text);
  const seen = new Set();
  const duplicates = [];
  for (const heading of parsed.headings) {
    if (seen.has(heading.title)) duplicates.push(heading.title);
    seen.add(heading.title);
  }
  return { parsed, duplicates, seen };
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
    this.unknownLinkRanges = [];
    this.unknownHoverTarget = null;
    this.unknownUiState = {
      managerOpen: false,
      expanded: new Set(),
      selectedFile: null,
      selectedHeading: null,
      folder: null,
      search: "",
    };
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
      await this.ensureUnknownWorkspace();
      await this.ensureUnknownHeadings(this.unknownStore.entries, false);
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
      name: "收录/取消不理解内容",
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
      id: "open-unknown-note",
      name: "打开不理解词笔记",
      callback: () => {
        void this.openUnknownNote();
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

    const onClick = (event) => this.handleReadingUnknownClick(event);
    document.addEventListener("click", onClick, true);
    this.register(() =>
      document.removeEventListener("click", onClick, true),
    );

    const onMouseMove = (event) =>
      this.handleReadingUnknownMouseMove(event);
    document.addEventListener("mousemove", onMouseMove, true);
    this.register(() =>
      document.removeEventListener("mousemove", onMouseMove, true),
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
          return;
        }

        if (this.isUnknownNoteFile(file)) {
          void this.refreshUnknownNoteUi();
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
          return;
        }

        if (this.isUnknownNoteFile(file)) {
          void this.refreshUnknownNoteUi();
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

  getUnknownRootPath() {
    const raw = String(this.settings.unknownRootFolder || "").trim();
    const fallback = String(this.settings.unknownNotePath || "")
      .split("/")
      .slice(0, -1)
      .join("/");
    const candidate = raw || fallback || "不理解的词";
    if (isAbsolutePath(candidate)) return null;
    try {
      return normalizeVaultPath(candidate);
    } catch (error) {
      return null;
    }
  }

  getDefaultUnknownNotePath() {
    const root = this.getUnknownRootPath();
    if (!root) return null;
    try {
      return normalizeVaultPath(root + "/未分类/未分类.md");
    } catch (error) {
      return null;
    }
  }

  async ensureUnknownFolder(path) {
    const target = normalizeVaultPath(path);
    if (!target) return false;
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(target)) return true;
    try {
      await this.app.vault.createFolder(target);
      return true;
    } catch (error) {
      return Boolean(await adapter.exists(target));
    }
  }

  async ensureUnknownWorkspace() {
    const root = this.getUnknownRootPath();
    if (!root) return false;
    await this.ensureUnknownFolder(root);
    await this.ensureUnknownFolder(root + "/未分类");

    const dashboard = this.getDefaultUnknownNotePath();
    if (!dashboard) return false;
    this.settings.unknownNotePath = dashboard;

    const adapter = this.app.vault.adapter;
    const directDashboard = normalizeVaultPath(root + "/未分类.md");
    if (!(await adapter.exists(dashboard)) && directDashboard !== dashboard && (await adapter.exists(directDashboard))) {
      try { await adapter.rename(directDashboard, dashboard); } catch (error) {}
    }
    const dashboardExists = await adapter.exists(dashboard);
    const legacyCandidates = [
      String(this.legacyUnknownNotePath || "").trim(),
      String(this.settings.unknownNotePath || "").trim(),
      "不理解的词.md",
    ].filter(Boolean);
    if (!dashboardExists) {
      for (const legacy of legacyCandidates) {
        if (legacy === dashboard) continue;
        try {
          if (await adapter.exists(legacy)) {
            const oldText = await this.readTextFile(legacy);
            const converted = convertFlatUnknownNoteToCards(oldText);
            if (converted.trim()) {
              await this.writeTextFile(dashboard, converted);
              await this.saveSettings();
              break;
            }
          }
        } catch (error) {
          console.error("[vocab-capture] migrate unknown note failed", error);
        }
      }
    }
    if (!(await adapter.exists(dashboard))) {
      await this.writeTextFile(dashboard, "");
    }
    if (this.settings.unknownNotePath !== dashboard) {
      this.settings.unknownNotePath = dashboard;
      await this.saveSettings();
    }
    return true;
  }

  async getUnknownMarkdownFiles() {
    const root = this.getUnknownRootPath();
    if (!root) return [];
    return this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path === root || file.path.startsWith(root + "/"))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async getUnknownWorkspaceData() {
    const root = this.getUnknownRootPath();
    const dashboard = this.getDefaultUnknownNotePath();
    const files = [];
    for (const file of await this.getUnknownMarkdownFiles()) {
      let text = "";
      try {
        text = await this.readTextFile(file.path);
      } catch (error) {
        text = "";
      }
      const parsed = parseMarkdownHeadings(text);
      files.push({
        path: file.path,
        name: file.name,
        basename: file.basename,
        headings: parsed.headings,
        text,
      });
    }

    if (dashboard && !files.some((file) => file.path === dashboard)) {
      try {
        const dashboardText = await this.readTextFile(dashboard);
        const parsed = parseMarkdownHeadings(dashboardText);
        files.push({
          path: dashboard,
          name: dashboard.split("/").pop(),
          basename: dashboard.split("/").pop().replace(/\.md$/i, ""),
          headings: parsed.headings,
          text: dashboardText,
        });
      } catch (error) {}
    }

    const fileMap = new Map(files.map((file) => [file.path, file]));
    let tree = null;
    try {
      const rootFile = this.app.vault.getAbstractFileByPath(root);
      if (rootFile && rootFile.children) {
        const convert = (node) => {
          if (node.path && fileMap.has(node.path)) {
            return {
              name: node.name,
              path: node.path,
              type: "file",
              count: fileMap.get(node.path).headings.length,
            };
          }
          if (node.children) {
            const children = node.children
              .map(convert)
              .filter(Boolean)
              .sort((a, b) => {
                if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
                return a.name.localeCompare(b.name);
              });
            return {
              name: node.name || (node.path === root ? "不理解的词" : ""),
              path: node.path,
              type: "folder",
              count: children.reduce((sum, child) => sum + (child.count || 0), 0),
              children,
            };
          }
          return null;
        };
        tree = convert(rootFile);
      }
    } catch (error) {
      tree = null;
    }

    if (!tree || (!tree.children?.length && files.length)) {
      tree = {
        name: root.split("/").pop() || "不理解的词",
        path: root,
        type: "folder",
        count: files.reduce((sum, file) => sum + file.headings.length, 0),
        children: files.map((file) => ({
          name: file.name,
          path: file.path,
          type: "file",
          count: file.headings.length,
        })),
      };
    }

    if (tree && dashboard && fileMap.has(dashboard)) {
      const hasDashboard = (node) => {
        if (!node) return false;
        if (node.type === "file" && node.path === dashboard) return true;
        return (node.children || []).some(hasDashboard);
      };
      if (!hasDashboard(tree)) {
        tree.children = tree.children || [];
        tree.children.unshift({
          name: dashboard.split("/").pop(),
          path: dashboard,
          type: "file",
          count: fileMap.get(dashboard).headings.length,
        });
      }
    }

    return { root, dashboard, files, fileMap, tree };
  }

  getUnknownCardIndex(workspace) {
    const index = new Map();
    const dashboard = workspace.dashboard;
    for (const file of workspace.files) {
      for (const heading of file.headings) {
        const item = {
          title: heading.title,
          level: heading.level,
          line: heading.start,
          filePath: file.path,
        };
        const key = normalizeUnknownSelection(heading.title);
        const current = index.get(key);
        if (!current || (file.path === dashboard && current.filePath !== dashboard)) {
          index.set(key, item);
        }
      }
    }
    return index;
  }

  invalidateUnknownCardIndex() {
    this.unknownCardIndex = null;
  }

  async getUnknownCard(entry) {
    const workspace = await this.getUnknownWorkspaceData();
    const index = this.getUnknownCardIndex(workspace);
    return index.get(normalizeUnknownSelection(entry)) || null;
  }

  async addUnknownFolder(parentPath, name) {
    const root = this.getUnknownRootPath();
    const safe = normalizeSafeFolderName(name);
    if (!root || !safe) return { changed: false, notice: "文件夹名无效" };
    const parent = normalizeVaultPath(parentPath || root);
    let target = parent + "/" + safe;
    let suffix = 2;
    while (await this.app.vault.adapter.exists(target)) {
      target = parent + "/" + safe + "-" + suffix;
      suffix += 1;
    }
    try {
      await this.app.vault.createFolder(target);
      return { changed: true, path: target };
    } catch (error) {
      return { changed: false, notice: String(error.message || error) };
    }
  }

  async addUnknownMarkdown(folderPath, name) {
    const safe = normalizeSafeMarkdownName(name);
    if (!safe) return { changed: false, notice: "Markdown 文件名无效" };
    const folder = normalizeVaultPath(folderPath);
    let target = folder + "/" + safe;
    let suffix = 2;
    while (await this.app.vault.adapter.exists(target)) {
      target = folder + "/" + safe.replace(/\.md$/i, "-" + suffix + ".md");
      suffix += 1;
    }
    try {
      await this.app.vault.create(target, "");
      return { changed: true, path: target };
    } catch (error) {
      return { changed: false, notice: String(error.message || error) };
    }
  }

  async renameUnknownNode(path, newName) {
    const source = this.app.vault.getAbstractFileByPath(path);
    if (!source) return { changed: false, notice: "文件不存在" };
    const isFile = source.extension === "md";
    const safe = isFile ? normalizeSafeMarkdownName(newName) : normalizeSafeFolderName(newName);
    if (!safe) return { changed: false, notice: "名称无效" };
    const parent = path.split("/").slice(0, -1).join("/");
    const target = parent + "/" + safe;
    if (target === path) return { changed: false };
    if (await this.app.vault.adapter.exists(target)) {
      return { changed: false, notice: "同名文件已存在" };
    }
    try {
      await this.app.vault.adapter.rename(path, target);
      this.invalidateUnknownCardIndex();
      return { changed: true, path: target };
    } catch (error) {
      return { changed: false, notice: String(error.message || error) };
    }
  }

  isUnknownUnclassifiedPath(path) {
    const root = this.getUnknownRootPath();
    if (!root) return false;
    const base = root + "/未分类";
    return path === base || path.startsWith(base + "/");
  }

  async removeUnknownPath(path) {
    const node = this.app.vault.getAbstractFileByPath(path);
    if (!node) return { changed: false, notice: "文件不存在" };
    try {
      if (node.children) {
        await this.app.vault.adapter.rmdir(path, true);
      } else {
        await this.app.vault.delete(node, true);
      }
      this.invalidateUnknownCardIndex();
      return { changed: true };
    } catch (error) {
      return { changed: false, notice: String(error.message || error) };
    }
  }

  async moveUnknownFolder(sourcePath, targetFolderPath) {
    const root = this.getUnknownRootPath();
    const source = normalizeVaultPath(sourcePath);
    const target = normalizeVaultPath(targetFolderPath);
    if (!root || !source || !target || source === root || target === source) {
      return { changed: false, notice: "不能移动到当前位置" };
    }
    if (source.split("/").slice(0, -1).join("/") === target) {
      return { changed: false, notice: "已经在目标文件夹" };
    }
    if (target === source || target.startsWith(source + "/")) {
      return { changed: false, notice: "不能移动到自身子文件夹" };
    }
    const node = this.app.vault.getAbstractFileByPath(source);
    if (!node || !node.children) return { changed: false, notice: "不是文件夹" };
    const targetNode = this.app.vault.getAbstractFileByPath(target);
    if (!targetNode || !targetNode.children) return { changed: false, notice: "目标不是文件夹" };
    const name = source.split("/").pop();
    let next = target + "/" + name;
    let suffix = 2;
    while (await this.app.vault.adapter.exists(next)) {
      next = target + "/" + name + "-" + suffix;
      suffix += 1;
    }
    try {
      await this.app.vault.adapter.rename(source, next);
      this.invalidateUnknownCardIndex();
      return { changed: true, path: next };
    } catch (error) {
      return { changed: false, notice: String(error.message || error) };
    }
  }

  async moveUnknownMarkdown(sourcePath, targetFolderPath) {
    const source = normalizeVaultPath(sourcePath);
    const target = normalizeVaultPath(targetFolderPath);
    if (!source || !target) return { changed: false, notice: "路径无效" };
    const node = this.app.vault.getAbstractFileByPath(source);
    if (!node || node.children) return { changed: false, notice: "不是 Markdown" };
    const targetNode = this.app.vault.getAbstractFileByPath(target);
    if (!targetNode || !targetNode.children) return { changed: false, notice: "目标不是文件夹" };
    if (source.split("/").slice(0, -1).join("/") === target) {
      return { changed: false, notice: "已经在目标文件夹" };
    }
    const name = source.split("/").pop();
    let next = target + "/" + name;
    let suffix = 2;
    while (await this.app.vault.adapter.exists(next)) {
      const stem = name.replace(/\.md$/i, "");
      next = target + "/" + stem + "-" + suffix + ".md";
      suffix += 1;
    }
    try {
      await this.app.vault.adapter.rename(source, next);
      this.invalidateUnknownCardIndex();
      return { changed: true, path: next };
    } catch (error) {
      return { changed: false, notice: String(error.message || error) };
    }
  }

  async deleteUnknownFolder(path) {
    const root = this.getUnknownRootPath();
    const unclassified = root ? normalizeVaultPath(root + "/未分类") : null;
    if (!root || !unclassified || path === root) {
      return { changed: false, notice: "根目录不能删除" };
    }
    if (path === unclassified) {
      return { changed: false, notice: "未分类文件夹不能整体删除" };
    }
    const node = this.app.vault.getAbstractFileByPath(path);
    if (!node || !node.children) return { changed: false, notice: "不是文件夹" };

    if (this.isUnknownUnclassifiedPath(path)) {
      return this.removeUnknownPath(path);
    }

    await this.ensureUnknownFolder(unclassified);
    const children = [...(node.children || [])];
    for (const child of children) {
      const name = child.name;
      let next = unclassified + "/" + name;
      let suffix = 2;
      while (await this.app.vault.adapter.exists(next)) {
        next = unclassified + "/" + name + "-" + suffix;
        suffix += 1;
      }
      try {
        await this.app.vault.adapter.rename(child.path, next);
      } catch (error) {
        return { changed: false, notice: String(error.message || error) };
      }
    }
    await this.removeUnknownPath(path);
    this.invalidateUnknownCardIndex();
    return { changed: true, path: unclassified };
  }

  async deleteUnknownCard(filePath, title) {
    const node = this.app.vault.getAbstractFileByPath(filePath);
    if (!node || node.children) return { changed: false, notice: "Markdown 不存在" };
    const text = await this.readTextFile(filePath);
    const next = removeHeadingSection(text, title);
    if (next == null) return { changed: false, notice: "卡片不存在" };
    await this.writeTextFile(filePath, next);
    this.invalidateUnknownCardIndex();
    return { changed: true };
  }

  async moveUnknownCardToParent(sourceFile, title, targetFile, parentTitle) {
    if (!sourceFile || !targetFile) return { changed: false, notice: "文件无效" };
    try {
      const sourceText = await this.readTextFile(sourceFile);
      const targetText = sourceFile === targetFile ? sourceText : await this.readTextFile(targetFile);
      const sourceParsed = parseMarkdownHeadings(sourceText);
      const source = sourceParsed.headings.find((item) => item.title === title);
      if (!source) return { changed: false, notice: "卡片不存在" };
      const section = sourceParsed.lines.slice(source.start, source.end);
      const targetParsed = parseMarkdownHeadings(targetText);
      let parentLevel = 0;
      if (parentTitle) {
        const parent = targetParsed.headings.find((item) => item.title === parentTitle);
        if (!parent) return { changed: false, notice: "父级不存在" };
        parentLevel = parent.level;
      }
      const targetLevel = parentLevel + 1;
      if (targetLevel > 6) return { changed: false, notice: "超过 H6" };
      const delta = targetLevel - source.level;
      const adjusted = section.slice();
      const sectionParsed = parseMarkdownHeadings(section.join("\n"));
      for (const heading of sectionParsed.headings) {
        if (heading.level + delta > 6) return { changed: false, notice: "移动后超过 H6" };
      }
      adjusted[0] = "#".repeat(targetLevel) + adjusted[0].replace(/^#{1,6}/, "");
      for (let i = 1; i < adjusted.length; i += 1) {
        const match = /^(#{1,6})(\s+.*)$/.exec(adjusted[i]);
        if (match) adjusted[i] = "#".repeat(match[1].length + delta) + match[2];
      }

      const movingTitles = parseMarkdownHeadings(adjusted.join("\n")).headings.map((item) => item.title);
      const targetHeadings = targetParsed.headings
        .filter((item) => !(sourceFile === targetFile && movingTitles.includes(item.title)))
        .map((item) => item.title);
      const duplicateTitle = movingTitles.find((item) => targetHeadings.includes(item));
      if (duplicateTitle) return { changed: false, notice: "目标 Markdown 已有同名标题" };
      if (sourceFile === targetFile && parentTitle) {
        const parent = sourceParsed.headings.find((item) => item.title === parentTitle);
        if (parent && parent.start >= source.start && parent.start < source.end) {
          return { changed: false, notice: "不能移动到自身子级" };
        }
      }

      let nextSource = sourceFile === targetFile ? sourceText : removeHeadingSection(sourceText, title);
      let nextTarget = sourceFile === targetFile ? removeHeadingSection(sourceText, title) : targetText;
      const inserted = insertHeadingSection(nextTarget, parentTitle || null, adjusted);
      if (inserted == null) return { changed: false, notice: "父级不存在" };

      if (sourceFile === targetFile) {
        await this.writeTextFile(sourceFile, inserted);
      } else {
        await this.writeTextFile(sourceFile, nextSource);
        await this.writeTextFile(targetFile, inserted);
      }
      this.invalidateUnknownCardIndex();
      return { changed: true };
    } catch (error) {
      return { changed: false, notice: String(error.message || error) };
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
    this.legacyUnknownNotePath = String(this.settings.unknownNotePath || "").trim();
    this.settings.unknownRootFolder =
      String(this.settings.unknownRootFolder || "").trim() ||
      DEFAULT_SETTINGS.unknownRootFolder;
    this.settings.unknownNotePath =
      String(this.settings.unknownNotePath || "").trim() ||
      DEFAULT_SETTINGS.unknownNotePath;
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
      const result = await this.toggleUnknown(text);
      if (result.removed) {
        new Notice(
          `已取消收录该内容 · 剩余 ${result.count} 条`,
        );
      } else if (result.added) {
        new Notice(`已记录不理解的内容 · 共 ${result.count} 条`);
      } else {
        new Notice("不理解词文件没有变化");
      }
    } catch (error) {
      console.error("[vocab-capture] toggle unknown failed", error);
      new Notice(`更新不理解词失败：${String(error.message || error)}`);
    }
  }

  async toggleUnknown(rawText) {
    const entry = normalizeUnknownSelection(rawText);
    if (!entry) return { added: false, removed: false, count: 0 };

    await this.unknownStore.ensureLoaded();
    const path = this.settings.unknownFilePath;
    const existing = await this.readTextFile(path);
    const entries = parseUnknownSet(existing);
    const exists = entries.has(entry);

    const result = exists
      ? removeUnknownRecord(existing, entry)
      : appendUnknownRecord(existing, entry);

    if (!result.removed && !result.added) {
      return {
        added: false,
        removed: false,
        count: entries.size,
      };
    }

    this.unknownStore.saving = true;
    try {
      await this.writeTextFile(path, result.text);
    } finally {
      this.unknownStore.saving = false;
    }

    if (exists) {
      entries.delete(entry);
    } else {
      entries.add(entry);
    }
    this.unknownStore.entries = entries;
    this.unknownStore.loadedPath = path;
    if (!exists) {
      await this.ensureUnknownHeadings(entries, true);
    }
    this.bumpWordsVersion();
    this.scheduleRefresh(0);

    return {
      added: !exists,
      removed: exists,
      count: entries.size,
    };
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
    await this.ensureUnknownHeadings(this.unknownStore.entries, true);
    this.bumpWordsVersion();
    this.scheduleRefresh(0);

    return { added: true, count: countUnknownLines(result.text) };
  }

  async countUnknown() {
    await this.unknownStore.ensureLoaded();
    return this.unknownStore.entries.size;
  }

  async ensureUnknownHeadings(entries, showNotice = false) {
    const list = Array.from(entries || [])
      .map((entry) => normalizeUnknownSelection(String(entry)))
      .filter(Boolean);
    if (!list.length) return false;

    const workspace = await this.getUnknownWorkspaceData();
    if (!workspace.dashboard) {
      if (showNotice) {
        new Notice("不理解词根目录无效");
      }
      return false;
    }

    const index = this.getUnknownCardIndex(workspace);
    const dashboard = workspace.dashboard;
    let text = await this.readTextFile(dashboard);
    let changed = false;

    for (const entry of list) {
      if (index.has(entry)) continue;
      const heading = `# ${entry}`;
      const lines = text.split(/\r?\n/);
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      if (lines.length) lines.push("");
      lines.push(heading);
      lines.push("");
      text = lines.join("\n");
      index.set(entry, { title: entry, level: 1, line: lines.length - 2, filePath: dashboard });
      changed = true;
    }

    if (changed) {
      await this.writeTextFile(dashboard, text);
      this.invalidateUnknownCardIndex();
    }
    return changed;
  }

  async findUnknownHeadingLine(entry) {
    const card = await this.getUnknownCard(entry);
    return card ? card.line : -1;
  }

  async openUnknownEntry(entry) {
    const normalized = normalizeUnknownSelection(entry);
    if (!normalized) return;

    try {
      let card = await this.getUnknownCard(normalized);
      if (!card) {
        await this.ensureUnknownWorkspace();
        await this.ensureUnknownHeadings(
          new Set([...(this.unknownStore.entries || []), normalized]),
          false,
        );
        card = await this.getUnknownCard(normalized);
      }
      if (!card) {
        new Notice("未找到对应的不理解的词卡片");
        return;
      }
      await this.app.workspace.openLinkText(card.filePath, "", false);
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && typeof view.setEphemeralState === "function") {
        view.setEphemeralState({ line: card.line });
      }
    } catch (error) {
      new Notice(`打开不理解的词失败：${String(error.message || error)}`);
    }
  }

  async openUnknownNote() {
    try {
      await this.ensureUnknownWorkspace();
      const dashboard = this.getDefaultUnknownNotePath();
      if (!dashboard) {
        new Notice("不理解词根目录无效");
        return;
      }
      await this.app.workspace.openLinkText(dashboard, "", false);
    } catch (error) {
      new Notice(`打开不理解的词失败：${String(error.message || error)}`);
    }
  }

  async refreshUnknownNoteUi() {
    const notePath = this.getVaultUnknownNotePath();
    if (!notePath) return;

    const token = (this.unknownUiRefreshToken || 0) + 1;
    this.unknownUiRefreshToken = token;

    let workspace;
    try {
      workspace = await this.getUnknownWorkspaceData();
    } catch (error) {
      return;
    }
    if (token !== this.unknownUiRefreshToken) return;
    if (!workspace.dashboard) return;

    const state = this.unknownUiState || {};
    if (!state.expanded || !(state.expanded instanceof Set)) {
      state.expanded = new Set([workspace.root]);
    }
    if (state.selectedFile && !workspace.fileMap.has(state.selectedFile)) {
      state.selectedFile = null;
      state.selectedHeading = null;
    }
    if (typeof state.managerOpen !== "boolean") state.managerOpen = false;
    if (typeof state.search !== "string") state.search = "";
    if (typeof state.folder !== "string") state.folder = workspace.root;
    if (typeof state.drag !== "object") state.drag = null;
    if (!Array.isArray(state.recentTargets)) state.recentTargets = [];
    if (!state.recentTargets.length && workspace.dashboard) {
      state.recentTargets = [workspace.dashboard];
    }
    this.unknownUiState = state;

    const signature = JSON.stringify({
      files: workspace.files.map((file) => ({
        path: file.path,
        headings: file.headings.map((heading) => ({ title: heading.title, level: heading.level })),
      })),
      managerOpen: state.managerOpen,
      selectedFile: state.selectedFile,
      selectedHeading: state.selectedHeading || null,
      expanded: Array.from(state.expanded),
      folder: state.folder,
      recentTargets: state.recentTargets || [],
      folderSelected: Boolean(state.folderSelected),
    });

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      if (!view.file || view.file.path !== workspace.dashboard) continue;

      const preview = getPreviewElement(view);
      const host = preview
        ? view.containerEl.querySelector(".markdown-reading-view") || preview.parentElement
        : view.containerEl.querySelector(".markdown-source-view");
      if (!host) continue;

      let panel = host.querySelector(":scope > .vocab-capture-note-ui");
      if (!panel) {
        panel = document.createElement("div");
        panel.className = "vocab-capture-note-ui";
        host.prepend(panel);
      }
      if (panel.dataset.uiSignature === signature) continue;
      panel.dataset.uiSignature = signature;
      this.renderUnknownFolderUi(panel, workspace, state);
    }
  }

  renderUnknownNoteUi(panel, structure) {
    if (!panel) return;
    const state = this.unknownUiState || {
      expanded: false,
      selectedCategory: "未分类",
      search: "",
      confirmDelete: null,
      focusAdd: false,
    };
    this.unknownUiState = state;

    const names = structure.categories.map((item) => item.name);
    if (!names.includes(state.selectedCategory)) {
      state.selectedCategory =
        (names.includes("未分类") && names.length === 1
          ? "未分类"
          : names[0]) || "未分类";
    }
    if (typeof state.search !== "string") state.search = "";
    if (typeof state.expanded !== "boolean") state.expanded = false;
    if (typeof state.focusAdd !== "boolean") state.focusAdd = false;

    panel.replaceChildren();

    const make = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text != null) element.textContent = text;
      return element;
    };
    const makeButton = (text, title, className, onClick) => {
      const button = make("button", className, text);
      button.type = "button";
      button.title = title || "";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick();
      });
      return button;
    };
    const render = () => this.renderUnknownNoteUi(panel, structure);

    const compact = make("div", "vocab-capture-ui__compact");
    const compactLeft = make("div", "vocab-capture-ui__compact-left");
    compactLeft.appendChild(
      make("span", "vocab-capture-ui__title", "不理解词"),
    );
    compactLeft.appendChild(
      make(
        "span",
        "vocab-capture-ui__meta",
        `${structure.cards.length} 条 · ${structure.categories.length} 个分类`,
      ),
    );
    compact.appendChild(compactLeft);

    const chips = make("div", "vocab-capture-ui__chips");
    for (const category of structure.categories) {
      const chip = makeButton(
        category.name,
        `查看 ${category.name}`,
        "vocab-capture-ui__chip",
        () => {
          state.selectedCategory = category.name;
          state.expanded = true;
          render();
        },
      );
      const count = make(
        "span",
        "vocab-capture-ui__chip-count",
        category.cards.length,
      );
      chip.appendChild(count);
      if (category.name === state.selectedCategory) {
        chip.classList.add("is-active");
      }
      chips.appendChild(chip);
    }
    compact.appendChild(chips);

    const compactActions = make("div", "vocab-capture-ui__compact-actions");
    compactActions.appendChild(
      makeButton("＋ 分类", "新增分类", "vocab-capture-ui__ghost", () => {
        state.expanded = true;
        state.focusAdd = true;
        render();
      }),
    );
    compactActions.appendChild(
      makeButton(
        state.expanded ? "收起" : "管理",
        state.expanded ? "收起管理台" : "展开管理台",
        "vocab-capture-ui__primary",
        () => {
          state.expanded = !state.expanded;
          render();
        },
      ),
    );
    compact.appendChild(compactActions);
    panel.appendChild(compact);

    if (!state.expanded) {
      if (state.focusAdd) state.focusAdd = false;
      this.applyUnknownUiCardFilter(panel);
      return;
    }

    const manager = make("div", "vocab-capture-ui__manager");
    const head = make("div", "vocab-capture-ui__manager-head");
    const headTitle = make("div", "vocab-capture-ui__manager-title", "分类与卡片管理");
    head.appendChild(headTitle);
    head.appendChild(
      make(
        "div",
        "vocab-capture-ui__manager-sub",
        "拖动卡片可快速归类",
      ),
    );
    const search = make("input", "vocab-capture-ui__search");
    search.type = "search";
    search.placeholder = "搜索词条、标签、释义…";
    search.value = state.search;
    head.appendChild(search);
    const closeButton = makeButton(
      "×",
      "关闭管理台",
      "vocab-capture-ui__close",
      () => {
        state.expanded = false;
        render();
      },
    );
    head.appendChild(closeButton);
    manager.appendChild(head);

    const body = make("div", "vocab-capture-ui__manager-body");
    const categoriesPane = make(
      "aside",
      "vocab-capture-ui__pane vocab-capture-ui__categories",
    );
    const categoriesHead = make("div", "vocab-capture-ui__pane-head");
    categoriesHead.appendChild(
      make("span", "vocab-capture-ui__pane-title", "分类"),
    );
    categoriesPane.appendChild(categoriesHead);

    const categoryList = make("div", "vocab-capture-ui__category-list");
    for (const category of structure.categories) {
      const row = make("div", "vocab-capture-ui__category");
      if (category.name === state.selectedCategory) {
        row.classList.add("is-active");
      }
      row.draggable = category.name !== "未分类";

      row.appendChild(make("span", "vocab-capture-ui__drag", "⋮⋮"));
      const name = make(
        "span",
        "vocab-capture-ui__category-name",
        category.name,
      );
      name.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        if (category.name === "未分类") return;
        this.beginUnknownCategoryRename(row, category.name, panel, structure);
      });
      row.appendChild(name);
      row.appendChild(
        make(
          "span",
          "vocab-capture-ui__count",
          String(category.cards.length),
        ),
      );

      if (category.name !== "未分类") {
        const actions = make("span", "vocab-capture-ui__actions");
        actions.appendChild(
          makeButton("✎", "重命名分类", "vocab-capture-ui__icon", () => {
            this.beginUnknownCategoryRename(
              row,
              category.name,
              panel,
              structure,
            );
          }),
        );
        actions.appendChild(
          makeButton("↑", "上移分类", "vocab-capture-ui__icon", () => {
            void this.reorderUnknownCategory(category.name, -1);
          }),
        );
        actions.appendChild(
          makeButton("↓", "下移分类", "vocab-capture-ui__icon", () => {
            void this.reorderUnknownCategory(category.name, 1);
          }),
        );
        actions.appendChild(
          makeButton("×", "删除分类", "vocab-capture-ui__icon is-danger", () => {
            state.confirmDelete = category.name;
            render();
          }),
        );
        row.appendChild(actions);
      }

      row.addEventListener("click", () => {
        state.selectedCategory = category.name;
        render();
      });
      row.addEventListener("dragstart", (event) => {
        if (category.name === "未分类") {
          event.preventDefault();
          return;
        }
        state.dragCategory = category.name;
        state.dragCard = null;
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", category.name);
        }
        row.classList.add("is-dragging");
      });
      row.addEventListener("dragend", () => {
        state.dragCategory = null;
        row.classList.remove("is-dragging");
      });
      row.addEventListener("dragover", (event) => {
        if (state.dragCategory || state.dragCard) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          row.classList.add("is-drop-target");
        }
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("is-drop-target");
      });
      row.addEventListener("drop", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        row.classList.remove("is-drop-target");
        const cardName = state.dragCard;
        const categoryName = state.dragCategory;
        state.dragCard = null;
        state.dragCategory = null;
        if (cardName) {
          await this.moveUnknownCard(cardName, category.name);
        } else if (categoryName) {
          await this.moveUnknownCategoryBefore(categoryName, category.name);
        }
      });

      categoryList.appendChild(row);
    }
    categoriesPane.appendChild(categoryList);

    const addRow = make("div", "vocab-capture-ui__category-add");
    const addInput = make("input", "vocab-capture-ui__input");
    addInput.type = "text";
    addInput.placeholder = "新分类名称";
    addInput.value = "";
    const addButton = makeButton(
      "添加",
      "新增分类",
      "vocab-capture-ui__small-primary",
      async () => {
        const value = addInput.value.trim();
        if (!value) {
          new Notice("请输入分类名");
          return;
        }
        state.selectedCategory = normalizeCategoryName(value);
        await this.addUnknownCategory(value);
      },
    );
    addInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void addButton.click();
      }
    });
    addRow.appendChild(addInput);
    addRow.appendChild(addButton);
    categoriesPane.appendChild(addRow);
    categoriesPane.appendChild(
      make(
        "div",
        "vocab-capture-ui__pane-note",
        "“未分类”固定在最下方，不能删除。",
      ),
    );
    body.appendChild(categoriesPane);

    const cardsPane = make(
      "section",
      "vocab-capture-ui__pane vocab-capture-ui__cards",
    );
    const cardsHead = make("div", "vocab-capture-ui__cards-head");
    const cardsHeading = make(
      "span",
      "vocab-capture-ui__cards-heading",
      state.selectedCategory,
    );
    cardsHead.appendChild(cardsHeading);
    const visibleCount = make(
      "span",
      "vocab-capture-ui__cards-count",
      "",
    );
    cardsHead.appendChild(visibleCount);
    cardsHead.appendChild(
      make(
        "span",
        "vocab-capture-ui__cards-hint",
        "拖动卡片到左侧分类即可移动",
      ),
    );
    cardsPane.appendChild(cardsHead);

    const cardList = make("div", "vocab-capture-ui__card-list");
    const selectedCards = structure.cards.filter(
      (card) => card.category === state.selectedCategory,
    );
    if (!selectedCards.length) {
      cardList.appendChild(
        make(
          "div",
          "vocab-capture-ui__empty",
          "该分类暂时没有卡片。按 F2 收录新词后会出现在这里。",
        ),
      );
    }
    for (const card of selectedCards) {
      const row = make("div", "vocab-capture-ui__card");
      row.draggable = true;
      const searchText = [
        card.name,
        card.category,
        ...(card.tags || []),
        card.snippet || "",
      ]
        .join(" ")
        .toLocaleLowerCase();
      row.dataset.searchText = searchText;
      row.appendChild(make("span", "vocab-capture-ui__drag", "⋮⋮"));

      const main = make("div", "vocab-capture-ui__card-main");
      const titleLine = make("div", "vocab-capture-ui__card-title-line");
      titleLine.appendChild(
        make("span", "vocab-capture-ui__card-title", card.name),
      );
      for (const tag of card.tags || []) {
        titleLine.appendChild(
          make("span", "vocab-capture-ui__tag", tag),
        );
      }
      main.appendChild(titleLine);
      if (card.snippet) {
        main.appendChild(
          make("div", "vocab-capture-ui__snippet", card.snippet),
        );
      }
      row.appendChild(main);

      const actions = make("span", "vocab-capture-ui__actions");
      actions.appendChild(
        makeButton(
          "↗",
          "定位到卡片",
          "vocab-capture-ui__icon",
          () => {
            void this.openUnknownEntry(card.name);
          },
        ),
      );
      row.appendChild(actions);
      row.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        void this.openUnknownEntry(card.name);
      });
      row.addEventListener("dragstart", (event) => {
        state.dragCard = card.name;
        state.dragCategory = null;
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", card.name);
        }
        row.classList.add("is-dragging");
      });
      row.addEventListener("dragend", () => {
        state.dragCard = null;
        row.classList.remove("is-dragging");
      });
      cardList.appendChild(row);
    }
    cardsPane.appendChild(cardList);

    const cardsFoot = make("div", "vocab-capture-ui__cards-foot");
    cardsFoot.appendChild(
      make(
        "span",
        "vocab-capture-ui__cards-foot-text",
        "卡片内容仍在 Markdown 正文中编辑；这里只管理结构和位置。",
      ),
    );
    cardsPane.appendChild(cardsFoot);
    body.appendChild(cardsPane);
    manager.appendChild(body);

    const foot = make("div", "vocab-capture-ui__manager-foot");
    foot.appendChild(
      make(
        "span",
        "",
        "删除分类时，卡片会移至“未分类”，内容不会删除。",
      ),
    );
    foot.appendChild(
      make(
        "span",
        "vocab-capture-ui__foot-right",
        `${structure.cards.length} 条 · ${structure.categories.length} 个分类`,
      ),
    );
    manager.appendChild(foot);

    if (state.confirmDelete) {
      const layer = make(
        "div",
        "vocab-capture-ui__modal-layer",
      );
      const modal = make("div", "vocab-capture-ui__modal");
      modal.appendChild(
        make(
          "div",
          "vocab-capture-ui__modal-title",
          `删除分类“${state.confirmDelete}”？`,
        ),
      );
      const target = structure.categories.find(
        (item) => item.name === state.confirmDelete,
      );
      modal.appendChild(
        make(
          "p",
          "",
          `该分类下的 ${target ? target.cards.length : 0} 张卡片将移动到“未分类”。`,
        ),
      );
      modal.appendChild(
        make(
          "p",
          "vocab-capture-ui__modal-warn",
          "卡片标题、释义、备注等内容不会删除。",
        ),
      );
      const actions = make("div", "vocab-capture-ui__modal-actions");
      actions.appendChild(
        makeButton("取消", "", "vocab-capture-ui__button", () => {
          state.confirmDelete = null;
          render();
        }),
      );
      actions.appendChild(
        makeButton(
          "删除并移动卡片",
          "",
          "vocab-capture-ui__button is-danger",
          async () => {
            const name = state.confirmDelete;
            state.confirmDelete = null;
            await this.removeUnknownCategory(name);
          },
        ),
      );
      modal.appendChild(actions);
      layer.appendChild(modal);
      manager.appendChild(layer);
    }

    panel.appendChild(manager);

    search.addEventListener("input", () => {
      state.search = search.value;
      this.applyUnknownUiCardFilter(panel);
    });
    this.applyUnknownUiCardFilter(panel);

    if (state.focusAdd) {
      state.focusAdd = false;
      window.setTimeout(() => addInput.focus(), 0);
    }
  }

  applyUnknownUiCardFilter(panel) {
    if (!panel) return;
    const state = this.unknownUiState || {};
    const query = String(state.search || "").trim().toLocaleLowerCase();
    const rows = panel.querySelectorAll(".vocab-capture-ui__card");
    let visible = 0;
    for (const row of rows) {
      const match =
        !query || (row.dataset.searchText || "").includes(query);
      row.hidden = !match;
      if (match) visible += 1;
    }
    const count = panel.querySelector(".vocab-capture-ui__cards-count");
    if (count) count.textContent = `${visible} 个词条`;
  }

  beginUnknownCategoryRename(row, oldName, panel, structure) {
    if (!row || oldName === "未分类") return;
    const nameElement = row.querySelector(
      ".vocab-capture-ui__category-name",
    );
    if (!nameElement || row.querySelector(".vocab-capture-ui__input")) {
      return;
    }
    const input = document.createElement("input");
    input.className = "vocab-capture-ui__category-rename";
    input.type = "text";
    input.value = oldName;
    nameElement.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = async (save) => {
      if (finished) return;
      finished = true;
      if (!save) {
        this.renderUnknownNoteUi(panel, structure);
        return;
      }
      const value = input.value.trim();
      if (!value || value === oldName) {
        this.renderUnknownNoteUi(panel, structure);
        return;
      }
      await this.renameUnknownCategory(oldName, value);
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        void finish(false);
      }
    });
    input.addEventListener("blur", () => {
      if (!finished) void finish(false);
    });
  }

  renderUnknownFolderUi(panel, workspace, state) {
    if (!panel) return;
    panel.replaceChildren();

    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    };
    const button = (text, className, onClick, title) => {
      const node = el("button", className, text);
      node.type = "button";
      if (title) node.title = title;
      node.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick();
      });
      return node;
    };
    const render = () => this.renderUnknownFolderUi(panel, workspace, state);
    const refresh = async () => {
      await this.rerenderUnknownNoteViews();
      await this.refreshUnknownNoteUi();
    };
    const selectedFile = state.selectedFile
      ? workspace.fileMap.get(state.selectedFile)
      : null;
    const selectedHeadings = selectedFile ? selectedFile.headings : [];
    const totalCards = workspace.files.reduce((sum, file) => sum + file.headings.length, 0);
    const folderCount = Math.max(0, this.countUnknownFolders(workspace.tree) - 1);
    const query = String(state.search || "").trim().toLocaleLowerCase();

    const compact = el("div", "vocab-capture-folder-ui__compact");
    const compactLeft = el("div", "vocab-capture-folder-ui__compact-left");
    compactLeft.appendChild(el("span", "vocab-capture-folder-ui__title", "不理解词"));
    compactLeft.appendChild(
      el(
        "span",
        "vocab-capture-folder-ui__meta",
        `${totalCards} 条 · ${folderCount} 个文件夹 · ${workspace.files.length} 个 Markdown`,
      ),
    );
    compact.appendChild(compactLeft);
    const compactActions = el("div", "vocab-capture-folder-ui__compact-actions");
    compactActions.appendChild(
      button("新建文件夹", "vocab-capture-folder-ui__quiet", () => {
        this.promptUnknownUi(panel, "新建文件夹", "文件夹名", "", async (value) => {
          const parent = this.getUnknownSelectedFolder(workspace, state);
          const result = await this.addUnknownFolder(parent, value);
          if (!result.changed) new Notice(result.notice || "新建文件夹失败");
          state.expanded.add(parent);
          await refresh();
        });
      }),
    );
    compactActions.appendChild(
      button("新建 Markdown", "vocab-capture-folder-ui__quiet", () => {
        this.promptUnknownUi(panel, "新建 Markdown", "文件名", "新文件.md", async (value) => {
          const folder = this.getUnknownSelectedFolder(workspace, state);
          const result = await this.addUnknownMarkdown(folder, value);
          if (!result.changed) new Notice(result.notice || "新建 Markdown 失败");
          else {
            state.selectedFile = result.path;
            state.folder = folder;
          }
          await refresh();
        });
      }),
    );
    compactActions.appendChild(
      button(state.managerOpen ? "收起" : "管理", "vocab-capture-folder-ui__primary", () => {
        state.managerOpen = !state.managerOpen;
        if (state.managerOpen) {
          state.selectedFile = null;
          state.selectedHeading = null;
          state.folder = workspace.root;
          state.folderSelected = false;
          state.expanded = new Set([workspace.root]);
        }
        render();
      }),
    );
    compact.appendChild(compactActions);
    panel.appendChild(compact);

    if (!state.managerOpen) return;

    const manager = el("div", "vocab-capture-folder-ui__manager");
    const head = el("div", "vocab-capture-folder-ui__head");
    head.appendChild(el("span", "vocab-capture-folder-ui__head-title", "文件夹与卡片"));
    head.appendChild(el("span", "vocab-capture-folder-ui__head-sub", "文件夹只负责分类；卡片只能写入 Markdown"));
    const search = el("input", "vocab-capture-folder-ui__search");
    search.type = "search";
    search.placeholder = "搜索文件夹、Markdown、标题";
    search.value = state.search;
    head.appendChild(search);
    head.appendChild(
      button("关闭", "vocab-capture-folder-ui__close", () => {
        state.managerOpen = false;
        render();
      }),
    );
    manager.appendChild(head);

    const body = el("div", "vocab-capture-folder-ui__body");
    const left = el("aside", "vocab-capture-folder-ui__left");
    const leftHead = el("div", "vocab-capture-folder-ui__section-head");
    leftHead.appendChild(el("span", "vocab-capture-folder-ui__section-title", "文件夹 / Markdown"));
    leftHead.appendChild(
      button("折叠全部", "vocab-capture-folder-ui__fold-all", () => {
        state.expanded = new Set([workspace.root]);
        render();
      }),
    );
    left.appendChild(leftHead);

    const tree = el("div", "vocab-capture-folder-ui__tree");
    const keyForFolder = (path) => `folder:${path}`;
    const keyForFile = (path) => `file:${path}`;
    const keyForHeading = (filePath, title) => `heading:${filePath}:${title}`;
    const isSelectedHeading = (filePath, title) =>
      state.selectedFile === filePath && state.selectedHeading === title;
    const isSelectedFile = (path) => state.selectedFile === path && !state.selectedHeading;
    const isSelectedFolder = (path) => !state.selectedFile && state.folderSelected === true && state.folder === path;
    const rememberRecent = (path) => {
      if (!path) return;
      state.recentTargets = [
        path,
        ...(state.recentTargets || []).filter((item) => item !== path),
      ].slice(0, 5);
    };
    const expandPath = (path) => {
      const parts = String(path).split("/");
      let current = "";
      for (const part of parts) {
        current = current ? current + "/" + part : part;
        state.expanded.add(current);
      }
    };
    const expandHeadingPath = (file, heading) => {
      expandPath(file.path);
      const headings = file.headings || [];
      const index = headings.indexOf(heading);
      const stack = [];
      for (let i = 0; i < index; i += 1) {
        while (stack.length && stack[stack.length - 1].level >= headings[i].level) stack.pop();
        stack.push(headings[i]);
      }
      for (const item of stack) state.expanded.add(keyForHeading(file.path, item.title));
      state.expanded.add(keyForHeading(file.path, heading.title));
    };
    const matches = (node) => {
      if (!query) return true;
      if (node.name && node.name.toLocaleLowerCase().includes(query)) return true;
      if (node.type === "file") {
        const file = workspace.fileMap.get(node.path);
        return Boolean(file && file.headings.some((heading) => heading.title.toLocaleLowerCase().includes(query)));
      }
      return (node.children || []).some(matches);
    };
    const matchesHeading = (heading) => !query || heading.title.toLocaleLowerCase().includes(query);
    const findFile = (path) => workspace.fileMap.get(path) || null;

    const renderHeading = (heading, filePath, depth) => {
      if (!matchesHeading(heading) && !isSelectedHeading(filePath, heading.title)) return;
      const key = keyForHeading(filePath, heading.title);
      const row = el(
        "div",
        "vocab-capture-folder-ui__row vocab-capture-folder-ui__heading-row" +
          (isSelectedHeading(filePath, heading.title) ? " is-selected" : ""),
      );
      row.style.paddingLeft = `${5 + depth * 16}px`;
      row.dataset.type = "heading";
      row.dataset.path = filePath;
      row.dataset.title = heading.title;
      row.appendChild(el("span", "vocab-capture-folder-ui__name", heading.title));
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        const file = findFile(filePath);
        if (!file) return;
        state.folder = filePath.split("/").slice(0, -1).join("/");
        state.folderSelected = false;
        state.selectedFile = filePath;
        state.selectedHeading = heading.title;
        expandHeadingPath(file, heading);
        render();
      });
      row.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        render();
      });
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const file = findFile(filePath);
        if (file) {
          state.selectedFile = filePath;
          state.selectedHeading = heading.title;
          this.showUnknownCardContext(panel, event, workspace, state, file, heading, refresh);
        }
      });

      row.draggable = true;
      row.addEventListener("dragstart", (event) => {
        state.drag = { type: "card", filePath, title: heading.title };
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", JSON.stringify(state.drag));
        }
        row.classList.add("is-dragging");
      });
      row.addEventListener("dragend", () => {
        state.drag = null;
        row.classList.remove("is-dragging");
        tree.querySelectorAll(".is-drop-target").forEach((item) => item.classList.remove("is-drop-target"));
      });
      row.addEventListener("dragover", (event) => {
        if (!state.drag) return;
        event.preventDefault();
        row.classList.add("is-drop-target");
      });
      row.addEventListener("dragleave", () => row.classList.remove("is-drop-target"));
      row.addEventListener("drop", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        row.classList.remove("is-drop-target");
        const drag = state.drag;
        state.drag = null;
        if (!drag) return;
        if (drag.type === "card") {
          const result = await this.moveUnknownCardToParent(
            drag.filePath,
            drag.title,
            filePath,
            heading.title,
          );
          if (!result.changed) new Notice(result.notice || "移动失败");
          else rememberRecent(filePath);
        } else {
          new Notice("只能把卡片放到标题上");
        }
        await refresh();
      });

      tree.appendChild(row);
      if (state.expanded.has(key) || query) {
        const file = findFile(filePath);
        const headings = file ? file.headings : [];
        const index = headings.indexOf(heading);
        for (let i = index + 1; i < headings.length; i += 1) {
          if (headings[i].level <= heading.level) break;
          if (headings[i].level === heading.level + 1) {
            renderHeading(headings[i], filePath, depth + 1);
          }
        }
      }
    };

    const addNode = (node, depth) => {
      if (!matches(node)) return;
      const row = el(
        "div",
        "vocab-capture-folder-ui__row" +
          (node.type === "file" && isSelectedFile(node.path) ? " is-selected" : "") +
          (node.type === "folder" && isSelectedFolder(node.path) ? " is-folder-selected" : ""),
      );
      row.style.paddingLeft = `${5 + depth * 16}px`;
      row.dataset.path = node.path;
      row.dataset.type = node.type;
      row.appendChild(el("span", "vocab-capture-folder-ui__name", node.name));
      row.appendChild(el("span", "vocab-capture-folder-ui__count", String(node.count || 0)));
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        if (node.type === "folder") {
          state.folder = node.path;
          state.folderSelected = true;
          state.selectedFile = null;
          state.selectedHeading = null;
          state.expanded.add(node.path);
        } else {
          state.folder = node.path.split("/").slice(0, -1).join("/");
          state.folderSelected = false;
          state.selectedFile = node.path;
          state.selectedHeading = null;
          state.expanded.add(node.path);
        }
        render();
      });
      row.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        if (state.expanded.has(node.path)) state.expanded.delete(node.path);
        else state.expanded.add(node.path);
        render();
      });
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (node.type === "file") {
          this.showUnknownFileContext(panel, event, workspace, state, node, refresh);
        } else {
          this.showUnknownFolderContext(panel, event, workspace, state, node, refresh);
        }
      });

      row.draggable = true;
      row.addEventListener("dragstart", (event) => {
        state.drag = { type: node.type, path: node.path };
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", JSON.stringify(state.drag));
        }
        row.classList.add("is-dragging");
      });
      row.addEventListener("dragend", () => {
        state.drag = null;
        row.classList.remove("is-dragging");
        tree.querySelectorAll(".is-drop-target").forEach((item) => item.classList.remove("is-drop-target"));
      });
      row.addEventListener("dragover", (event) => {
        if (!state.drag) return;
        event.preventDefault();
        row.classList.add("is-drop-target");
      });
      row.addEventListener("dragleave", () => row.classList.remove("is-drop-target"));
      row.addEventListener("drop", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        row.classList.remove("is-drop-target");
        const drag = state.drag;
        state.drag = null;
        if (!drag) return;
        let result = null;
        if (drag.type === "folder" && node.type === "folder") {
          result = await this.moveUnknownFolder(drag.path, node.path);
        } else if (drag.type === "file" && node.type === "folder") {
          result = await this.moveUnknownMarkdown(drag.path, node.path);
        } else if (drag.type === "card" && node.type === "file") {
          result = await this.moveUnknownCardToParent(drag.filePath, drag.title, node.path, null);
          if (result.changed) rememberRecent(node.path);
        } else if (drag.type === "card" && node.type === "folder") {
          const fileNode = (node.children || []).find((child) => child.type === "file");
          if (!fileNode) {
            new Notice("该文件夹没有 Markdown，无法放入卡片");
            return;
          }
          result = await this.moveUnknownCardToParent(drag.filePath, drag.title, fileNode.path, null);
          if (result.changed) rememberRecent(fileNode.path);
        } else {
          new Notice("不能放到这个位置");
          return;
        }
        if (result && !result.changed) new Notice(result.notice || "移动失败");
        await refresh();
      });

      tree.appendChild(row);
      if (node.type === "folder" && (state.expanded.has(node.path) || query)) {
        for (const child of node.children || []) addNode(child, depth + 1);
      }
      if (node.type === "file" && (state.expanded.has(node.path) || query)) {
        const file = findFile(node.path);
        for (const heading of file ? file.headings : []) {
          if (heading.level === 1) renderHeading(heading, node.path, depth + 1);
        }
      }
    };

    addNode(workspace.tree, 0);
    left.appendChild(tree);
    left.appendChild(
      el(
        "div",
        "vocab-capture-folder-ui__tree-note",
        "选中节点自动展开直接子级；双击折叠该分支；分类多时可使用“折叠全部”。",
      ),
    );
    body.appendChild(left);

    const right = el("section", "vocab-capture-folder-ui__right");
    if (!selectedFile) {
      const path = state.folder || workspace.root;
      right.appendChild(el("div", "vocab-capture-folder-ui__breadcrumb", path));
      const emptyHead = el("div", "vocab-capture-folder-ui__right-head");
      emptyHead.appendChild(el("span", "vocab-capture-folder-ui__right-title", "请选择 Markdown"));
      right.appendChild(emptyHead);
      right.appendChild(
        el(
          "div",
          "vocab-capture-folder-ui__empty",
          "从左侧选择 Markdown 后，右侧显示它的 H1–H6 卡片。",
        ),
      );
    } else {
      const breadcrumb = el("div", "vocab-capture-folder-ui__breadcrumb");
      const parts = selectedFile.path.split("/");
      parts.forEach((part, index) => {
        const span = el("span", "", part);
        if (index === parts.length - 1) span.className = "vocab-capture-folder-ui__crumb-current";
        breadcrumb.appendChild(span);
        if (index < parts.length - 1) breadcrumb.appendChild(el("span", "vocab-capture-folder-ui__sep", "/"));
      });
      right.appendChild(breadcrumb);

      const rightHead = el("div", "vocab-capture-folder-ui__right-head");
      rightHead.appendChild(el("span", "vocab-capture-folder-ui__right-title", selectedFile.name));
      rightHead.appendChild(el("span", "vocab-capture-folder-ui__right-count", `${selectedHeadings.length} 个卡片`));
      const actions = el("div", "vocab-capture-folder-ui__right-actions");
      actions.appendChild(
        button("移动到…", "vocab-capture-folder-ui__primary", () => {
          if (!state.selectedHeading) {
            new Notice("请先选择卡片");
            return;
          }
          const heading = selectedHeadings.find((item) => item.title === state.selectedHeading);
          if (!heading) return;
          this.openUnknownMoveUi(panel, workspace, state, selectedFile, heading, refresh);
        }),
      );
      rightHead.appendChild(actions);
      right.appendChild(rightHead);
      right.appendChild(
        el(
          "div",
          "vocab-capture-folder-ui__hint",
          "拖动卡片到左侧 Markdown 或标题；也可以点击下方快速目标。",
        ),
      );

      if (state.recentTargets && state.recentTargets.length) {
        const quick = el("div", "vocab-capture-folder-ui__quick");
        quick.appendChild(el("div", "vocab-capture-folder-ui__quick-title", "快速移动最近目标"));
        const chips = el("div", "vocab-capture-folder-ui__chips");
        for (const target of state.recentTargets.slice(0, 4)) {
          chips.appendChild(
            button(target, "vocab-capture-folder-ui__chip", async () => {
              if (!state.selectedHeading) {
                new Notice("请先选择卡片");
                return;
              }
              const file = workspace.fileMap.get(target);
              if (!file) return;
              const result = await this.moveUnknownCardToParent(
                selectedFile.path,
                state.selectedHeading,
                target,
                null,
              );
              if (!result.changed) new Notice(result.notice || "移动失败");
              else rememberRecent(target);
              await refresh();
            }),
          );
        }
        quick.appendChild(chips);
        right.appendChild(quick);
      }

      const headingList = el("div", "vocab-capture-folder-ui__headings");
      const visibleHeadings = selectedHeadings.filter((heading) => matchesHeading(heading));
      if (!visibleHeadings.length) {
        headingList.appendChild(
          el(
            "div",
            "vocab-capture-folder-ui__empty",
            selectedHeadings.length ? "没有匹配的卡片。" : "该 Markdown 暂无卡片。",
          ),
        );
      }
      for (const heading of visibleHeadings) {
        const row = el(
          "div",
          "vocab-capture-folder-ui__heading" +
            (heading.title === state.selectedHeading ? " is-selected" : ""),
        );
        row.style.marginLeft = `${(heading.level - 1) * 18}px`;
        row.appendChild(
          el("span", `vocab-capture-folder-ui__level is-h${heading.level}`, `H${heading.level}`),
        );
        const main = el("div", "vocab-capture-folder-ui__heading-main");
        main.appendChild(el("span", "vocab-capture-folder-ui__heading-title", heading.title));
        row.appendChild(main);
        row.addEventListener("click", () => {
          state.selectedHeading = heading.title;
          state.folder = selectedFile.path.split("/").slice(0, -1).join("/");
          state.folderSelected = false;
          expandHeadingPath(selectedFile, heading);
          render();
        });
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          event.stopPropagation();
          state.selectedHeading = heading.title;
          this.showUnknownCardContext(panel, event, workspace, state, selectedFile, heading, refresh);
        });

        row.draggable = true;
        row.addEventListener("dragstart", (event) => {
          state.drag = { type: "card", filePath: selectedFile.path, title: heading.title };
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", JSON.stringify(state.drag));
          }
          row.classList.add("is-dragging");
        });
        row.addEventListener("dragend", () => {
          state.drag = null;
          row.classList.remove("is-dragging");
          headingList.querySelectorAll(".is-drop-target").forEach((item) => item.classList.remove("is-drop-target"));
        });
        row.addEventListener("dragover", (event) => {
          if (!state.drag || state.drag.type !== "card") return;
          event.preventDefault();
          row.classList.add("is-drop-target");
        });
        row.addEventListener("dragleave", () => row.classList.remove("is-drop-target"));
        row.addEventListener("drop", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          row.classList.remove("is-drop-target");
          const drag = state.drag;
          state.drag = null;
          if (!drag || drag.type !== "card") return;
          const result = await this.moveUnknownCardToParent(
            drag.filePath,
            drag.title,
            selectedFile.path,
            heading.title,
          );
          if (!result.changed) new Notice(result.notice || "移动失败");
          else rememberRecent(selectedFile.path);
          await refresh();
        });
        headingList.appendChild(row);
      }
      right.appendChild(headingList);
      right.appendChild(
        el(
          "div",
          "vocab-capture-folder-ui__right-foot",
          "卡片只能移动，不能在这里新建；F2 初次收录写入未分类.md 的 H1。",
        ),
      );
    }
    body.appendChild(right);
    manager.appendChild(body);

    const foot = el("div", "vocab-capture-folder-ui__foot");
    foot.appendChild(el("span", "", "删除文件夹时内容移动到未分类；未分类中的内容直接删除。"));
    foot.appendChild(el("span", "vocab-capture-folder-ui__foot-right", `${totalCards} 条`));
    manager.appendChild(foot);
    panel.appendChild(manager);

    search.addEventListener("input", () => {
      state.search = search.value;
      const caret = search.selectionStart;
      render();
      const next = panel.querySelector(".vocab-capture-folder-ui__search");
      if (next) {
        next.focus();
        try { next.setSelectionRange(caret, caret); } catch (error) {}
      }
    });
  }

  countUnknownFolders(node) {
    if (!node) return 0;
    if (node.type !== "folder") return 0;
    return 1 + (node.children || []).reduce((sum, child) => sum + this.countUnknownFolders(child), 0);
  }

  getUnknownSelectedFolder(workspace, state) {
    if (state.folder && workspace.fileMap.has(state.folder)) {
      return state.folder.split("/").slice(0, -1).join("/");
    }
    if (state.folder) return state.folder;
    if (state.selectedFile) return state.selectedFile.split("/").slice(0, -1).join("/");
    return workspace.root;
  }

  promptUnknownUi(panel, title, label, value, onConfirm) {
    const layer = document.createElement("div");
    layer.className = "vocab-capture-folder-ui__modal-layer";
    const modal = document.createElement("div");
    modal.className = "vocab-capture-folder-ui__modal";
    const heading = document.createElement("div");
    heading.className = "vocab-capture-folder-ui__modal-title";
    heading.textContent = title;
    modal.appendChild(heading);
    const field = document.createElement("label");
    field.className = "vocab-capture-folder-ui__field";
    field.appendChild(document.createTextNode(label));
    const input = document.createElement("input");
    input.type = "text";
    input.value = value || "";
    field.appendChild(input);
    modal.appendChild(field);
    const actions = document.createElement("div");
    actions.className = "vocab-capture-folder-ui__modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "vocab-capture-folder-ui__secondary";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => layer.remove());
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "vocab-capture-folder-ui__primary";
    ok.textContent = "确定";
    ok.addEventListener("click", async () => {
      const next = input.value.trim();
      if (!next) return;
      layer.remove();
      await onConfirm(next);
    });
    actions.appendChild(cancel);
    actions.appendChild(ok);
    modal.appendChild(actions);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void ok.click();
      }
      if (event.key === "Escape") layer.remove();
    });
    layer.appendChild(modal);
    panel.appendChild(layer);
    window.setTimeout(() => input.focus(), 0);
  }

  showUnknownFolderContext(panel, event, workspace, state, node, refresh) {
    this.openUnknownContextMenu(panel, event, [
      ["新建子文件夹", () => {
        this.promptUnknownUi(panel, "新建子文件夹", "文件夹名", "", async (value) => {
          const result = await this.addUnknownFolder(node.path, value);
          if (!result.changed) new Notice(result.notice || "新建失败");
          state.expanded.add(node.path);
          await refresh();
        });
      }],
      ["新建 Markdown", () => {
        this.promptUnknownUi(panel, "新建 Markdown", "文件名", "新文件.md", async (value) => {
          const result = await this.addUnknownMarkdown(node.path, value);
          if (!result.changed) new Notice(result.notice || "新建失败");
          else state.selectedFile = result.path;
          await refresh();
        });
      }],
      ...(node.path === workspace.root
        ? []
        : [
            ["重命名文件夹", () => {
              this.promptUnknownUi(panel, "重命名文件夹", "新名称", node.name, async (value) => {
                const result = await this.renameUnknownNode(node.path, value);
                if (!result.changed) new Notice(result.notice || "重命名失败");
                await refresh();
              });
            }],
            ["删除文件夹", () => {
              if (!window.confirm(`删除文件夹“${node.name}”？未分类中的内容会直接删除；其他位置的内容会移动到未分类。`)) return;
              void this.deleteUnknownFolder(node.path).then(async (result) => {
                if (!result.changed) new Notice(result.notice || "删除失败");
                await refresh();
              });
            }],
          ]),
    ]);
  }

  showUnknownFileContext(panel, event, workspace, state, node, refresh) {
    this.openUnknownContextMenu(panel, event, [
      ["打开", () => {
        state.selectedFile = node.path;
        state.folder = node.path.split("/").slice(0, -1).join("/");
        state.selectedHeading = null;
        this.renderUnknownFolderUi(panel, workspace, state);
      }],
      ["重命名 Markdown", () => {
        this.promptUnknownUi(panel, "重命名 Markdown", "新名称", node.name, async (value) => {
          const result = await this.renameUnknownNode(node.path, value);
          if (!result.changed) new Notice(result.notice || "重命名失败");
          await refresh();
        });
      }],
      ...(this.isUnknownUnclassifiedPath(node.path)
        ? [["删除 Markdown（直接删除）", () => {
            if (!window.confirm(`删除 Markdown“${node.name}”？内容会直接删除。`)) return;
            void this.removeUnknownPath(node.path).then(async (result) => {
              if (!result.changed) new Notice(result.notice || "删除失败");
              await refresh();
            });
          }]]
        : []),
    ]);
  }

  showUnknownCardContext(panel, event, workspace, state, file, heading, refresh) {
    this.openUnknownContextMenu(panel, event, [
      ["移动卡片", () => {
        this.openUnknownMoveUi(panel, workspace, state, file, heading, refresh);
      }],
      ...(this.isUnknownUnclassifiedPath(file.path)
        ? [["删除卡片（直接删除）", () => {
            if (!window.confirm(`删除卡片“${heading.title}”？内容会直接删除。`)) return;
            void this.deleteUnknownCard(file.path, heading.title).then(async (result) => {
              if (!result.changed) new Notice(result.notice || "删除失败");
              await refresh();
            });
          }]]
        : []),
    ]);
  }

  openUnknownContextMenu(panel, event, items) {
    panel.querySelectorAll(".vocab-capture-folder-ui__context").forEach((node) => node.remove());
    const menu = document.createElement("div");
    menu.className = "vocab-capture-folder-ui__context";
    for (const [label, action] of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        menu.remove();
        action();
      });
      menu.appendChild(button);
    }
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    panel.appendChild(menu);
    const close = (next) => {
      if (!menu.contains(next.target)) {
        menu.remove();
        document.removeEventListener("click", close);
      }
    };
    window.setTimeout(() => document.addEventListener("click", close), 0);
  }

  openUnknownMoveUi(panel, workspace, state, sourceFile, sourceHeading, refresh) {
    const layer = document.createElement("div");
    layer.className = "vocab-capture-folder-ui__modal-layer";
    const modal = document.createElement("div");
    modal.className = "vocab-capture-folder-ui__modal is-wide";
    modal.appendChild(
      Object.assign(document.createElement("div"), {
        className: "vocab-capture-folder-ui__modal-title",
        textContent: "移动到…",
      }),
    );
    modal.appendChild(
      Object.assign(document.createElement("div"), {
        className: "vocab-capture-folder-ui__modal-sub",
        textContent: "只能移动已有卡片；选择目标 Markdown 与父级后自动重算标题级别。",
      }),
    );
    const source = document.createElement("div");
    source.className = "vocab-capture-folder-ui__path";
    source.textContent = `${sourceFile.path} · ${sourceHeading.title}（H${sourceHeading.level}）`;
    modal.appendChild(source);

    if (state.recentTargets && state.recentTargets.length) {
      const recent = document.createElement("div");
      recent.className = "vocab-capture-folder-ui__quick";
      recent.appendChild(
        Object.assign(document.createElement("div"), {
          className: "vocab-capture-folder-ui__quick-title",
          textContent: "最近目标",
        }),
      );
      const chips = document.createElement("div");
      chips.className = "vocab-capture-folder-ui__chips";
      for (const target of state.recentTargets.slice(0, 4)) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "vocab-capture-folder-ui__chip";
        chip.textContent = target;
        chip.addEventListener("click", () => {
          const option = Array.from(fileSelect.options).find((item) => item.value === target);
          if (option) {
            fileSelect.value = target;
            paintParents();
          }
        });
        chips.appendChild(chip);
      }
      recent.appendChild(chips);
      modal.appendChild(recent);
    }

    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "搜索目标 Markdown 或父级";
    search.className = "vocab-capture-folder-ui__search is-modal";
    modal.appendChild(search);

    const fileLabel = document.createElement("label");
    fileLabel.className = "vocab-capture-folder-ui__field";
    fileLabel.appendChild(document.createTextNode("目标 Markdown"));
    const fileSelect = document.createElement("select");
    fileLabel.appendChild(fileSelect);
    modal.appendChild(fileLabel);

    const parentLabel = document.createElement("label");
    parentLabel.className = "vocab-capture-folder-ui__field";
    parentLabel.appendChild(document.createTextNode("目标父级"));
    const parentSelect = document.createElement("select");
    parentLabel.appendChild(parentSelect);
    modal.appendChild(parentLabel);

    const preview = document.createElement("div");
    preview.className = "vocab-capture-folder-ui__level-preview";
    modal.appendChild(preview);

    const actions = document.createElement("div");
    actions.className = "vocab-capture-folder-ui__modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "vocab-capture-folder-ui__secondary";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => layer.remove());
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "vocab-capture-folder-ui__primary";
    confirm.textContent = "移动卡片";
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    modal.appendChild(actions);
    layer.appendChild(modal);
    panel.appendChild(layer);

    const files = workspace.files.slice();
    const paintFiles = () => {
      const query = search.value.trim().toLocaleLowerCase();
      fileSelect.innerHTML = "";
      for (const file of files) {
        if (query && !file.path.toLocaleLowerCase().includes(query)) continue;
        const option = document.createElement("option");
        option.value = file.path;
        option.textContent = file.path;
        fileSelect.appendChild(option);
      }
      if (!fileSelect.options.length) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "没有匹配的 Markdown";
        fileSelect.appendChild(option);
      }
      fileSelect.value = files.some((file) => file.path === state.selectedFile) &&
        !query
        ? state.selectedFile
        : fileSelect.options[0].value;
      paintParents();
    };
    const paintParents = () => {
      parentSelect.innerHTML = "";
      const file = workspace.fileMap.get(fileSelect.value);
      const md = document.createElement("option");
      md.value = "";
      md.textContent = "Markdown 文件（卡片 H1）";
      parentSelect.appendChild(md);
      for (const heading of file ? file.headings : []) {
        if (heading.level >= 6) continue;
        if (file.path === sourceFile.path && heading.title === sourceHeading.title) continue;
        const option = document.createElement("option");
        option.value = heading.title;
        option.textContent = `H${heading.level} ${heading.title}（卡片 H${heading.level + 1}）`;
        parentSelect.appendChild(option);
      }
      paintPreview();
    };
    const paintPreview = () => {
      const parent = parentSelect.value;
      const level = parent ? (workspace.fileMap.get(fileSelect.value)?.headings.find((item) => item.title === parent)?.level || 0) + 1 : 1;
      preview.textContent = `移动后：H${level}`;
    };
    search.addEventListener("input", paintFiles);
    fileSelect.addEventListener("change", paintParents);
    parentSelect.addEventListener("change", paintPreview);
    paintFiles();

    confirm.addEventListener("click", async () => {
      const targetFile = fileSelect.value;
      if (!targetFile) return;
      const result = await this.moveUnknownCardToParent(
        sourceFile.path,
        sourceHeading.title,
        targetFile,
        parentSelect.value || null,
      );
      if (!result.changed) {
        new Notice(result.notice || "移动失败");
        return;
      }
      state.recentTargets = [
        targetFile,
        ...(state.recentTargets || []).filter((item) => item !== targetFile),
      ].slice(0, 5);
      layer.remove();
      state.selectedFile = targetFile;
      state.selectedHeading = sourceHeading.title;
      await refresh();
    });
    window.setTimeout(() => search.focus(), 0);
  }

  askUnknownName(message, fallback) {
    return window.prompt(message, fallback || "");
  }


  async addUnknownCategory(name) {
    const notePath = this.getVaultUnknownNotePath();
    if (!notePath) return;
    const result = addUnknownCategoryText(
      await this.readTextFile(notePath),
      name,
    );
    if (!result.changed) {
      new Notice("分类已存在或名称为空");
      return;
    }
    await this.writeTextFile(notePath, result.text);
    if (this.unknownUiState) {
      this.unknownUiState.selectedCategory = normalizeCategoryName(name);
      this.unknownUiState.focusAdd = false;
    }
    new Notice(`已添加分类“${normalizeCategoryName(name)}”`);
    await this.afterUnknownNoteChange();
  }

  async removeUnknownCategory(name) {
    const notePath = this.getVaultUnknownNotePath();
    if (!notePath) return;
    const result = deleteUnknownCategoryText(
      await this.readTextFile(notePath),
      name,
    );
    if (!result.changed) {
      new Notice("分类不存在，或不能删除“未分类”");
      return;
    }
    await this.writeTextFile(notePath, result.text);
    if (this.unknownUiState) {
      if (this.unknownUiState.selectedCategory === normalizeCategoryName(name)) {
        this.unknownUiState.selectedCategory = "未分类";
      }
      this.unknownUiState.confirmDelete = null;
    }
    new Notice(
      result.movedCards
        ? `已删除分类“${normalizeCategoryName(name)}”，${result.movedCards} 个词条移至未分类`
        : `已删除分类“${normalizeCategoryName(name)}”`,
    );
    await this.afterUnknownNoteChange();
  }

  async moveUnknownCard(cardName, targetCategory) {
    const notePath = this.getVaultUnknownNotePath();
    if (!notePath) return;
    const result = moveUnknownCardText(
      await this.readTextFile(notePath),
      cardName,
      targetCategory,
    );
    if (!result.changed) {
      new Notice("词条或目标分类不存在，或已在目标分类");
      return;
    }
    await this.writeTextFile(notePath, result.text);
    new Notice(
      `已将“${normalizeUnknownSelection(cardName)}”移动到“${normalizeCategoryName(targetCategory)}”`,
    );
    await this.afterUnknownNoteChange();
  }

  async renameUnknownCategory(oldName, newName) {
    const notePath = this.getVaultUnknownNotePath();
    if (!notePath) return;
    const result = renameUnknownCategoryText(
      await this.readTextFile(notePath),
      oldName,
      newName,
    );
    if (!result.changed) {
      new Notice("分类未变化、已存在或不能重命名“未分类”");
      await this.refreshUnknownNoteUi();
      return;
    }
    await this.writeTextFile(notePath, result.text);
    if (this.unknownUiState) {
      this.unknownUiState.selectedCategory = normalizeCategoryName(newName);
      this.unknownUiState.confirmDelete = null;
    }
    new Notice(
      `已将分类“${normalizeCategoryName(oldName)}”重命名为“${normalizeCategoryName(newName)}”`,
    );
    await this.afterUnknownNoteChange();
  }

  async reorderUnknownCategory(name, direction) {
    const notePath = this.getVaultUnknownNotePath();
    if (!notePath) return;
    const result = reorderUnknownCategoryText(
      await this.readTextFile(notePath),
      name,
      direction,
    );
    if (!result.changed) {
      new Notice("该分类无法继续移动");
      return;
    }
    await this.writeTextFile(notePath, result.text);
    await this.afterUnknownNoteChange();
  }

  async moveUnknownCategoryBefore(name, targetName) {
    const notePath = this.getVaultUnknownNotePath();
    if (!notePath) return;
    const result = moveUnknownCategoryBeforeText(
      await this.readTextFile(notePath),
      name,
      targetName,
    );
    if (!result.changed) return;
    await this.writeTextFile(notePath, result.text);
    await this.afterUnknownNoteChange();
  }

  rerenderUnknownNoteViews() {
    const notePath = this.getVaultUnknownNotePath();
    if (!notePath) return;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      if (!view.file || view.file.path !== notePath) continue;
      try {
        if (view.previewMode && view.previewMode.rerender) {
          view.previewMode.rerender(true);
        }
      } catch (error) {
        // 预览模式不可用时忽略。
      }
    }
  }

  async afterUnknownNoteChange() {
    this.rerenderUnknownNoteViews();
    await this.refreshUnknownNoteUi();
  }

  findUnknownLinkAtPoint(event) {
    if (!this.unknownLinkRanges || !this.unknownLinkRanges.length) {
      return null;
    }
    const caret = getCaretRangeFromEvent(event);
    if (!caret) return null;

    for (const item of this.unknownLinkRanges) {
      const range = item.range;
      if (!range || !range.startContainer || !range.startContainer.isConnected) {
        continue;
      }
      try {
        if (
          range.isPointInRange(
            caret.startContainer,
            caret.startOffset,
          )
        ) {
          return item;
        }
      } catch (error) {
        // Range 所在 DOM 已被替换时忽略。
      }
    }
    return null;
  }

  handleReadingUnknownClick(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (document.querySelector(".modal-container, .prompt")) return;

    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    const preview = target.closest(".markdown-preview-view");
    if (!preview || target.closest("a")) return;

    const selection =
      typeof window !== "undefined" ? window.getSelection() : null;
    if (selection && !selection.isCollapsed) return;

    const hit = this.findUnknownLinkAtPoint(event);
    if (!hit) return;

    event.preventDefault();
    event.stopPropagation();
    void this.openUnknownEntry(hit.entry);
  }

  handleReadingUnknownMouseMove(event) {
    if (!this.unknownLinkRanges || !this.unknownLinkRanges.length) {
      this.clearUnknownHover();
      return;
    }

    const target = event.target;
    if (!target || typeof target.closest !== "function") {
      this.clearUnknownHover();
      return;
    }
    const preview = target.closest(".markdown-preview-view");
    if (!preview) {
      this.clearUnknownHover();
      return;
    }

    const hit = this.findUnknownLinkAtPoint(event);
    if (!hit) {
      this.clearUnknownHover();
      return;
    }

    if (this.unknownHoverTarget !== preview) {
      this.clearUnknownHover();
      this.unknownHoverTarget = preview;
    }
    preview.classList.add("vocab-capture-unknown-link-hover");
  }

  clearUnknownHover() {
    if (this.unknownHoverTarget) {
      this.unknownHoverTarget.classList.remove(
        "vocab-capture-unknown-link-hover",
      );
      this.unknownHoverTarget = null;
    }
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

  isUnknownNoteFile(file) {
    if (!file) return false;
    const rawPath = String(this.settings.unknownNotePath || "").trim();
    if (!rawPath || isAbsolutePath(rawPath)) return false;
    try {
      return file.path === normalizeVaultPath(rawPath);
    } catch (error) {
      return false;
    }
  }

  getVaultUnknownNotePath() {
    const rawPath = String(this.settings.unknownNotePath || "").trim();
    if (!rawPath || isAbsolutePath(rawPath)) return null;
    try {
      return normalizeVaultPath(rawPath);
    } catch (error) {
      return null;
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
      await this.ensureUnknownHeadings(this.unknownStore.entries, showNotice);
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
        void this.refreshUnknownNoteUi();
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
    const unknownLinkRanges = [];
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
        const ranges = collectRanges(preview, unknownRegex, rangeOptions);
        unknownRanges.push(...ranges);
        for (const range of ranges) {
          const entry = findUnknownEntryForText(
            range.toString(),
            unknownEntries,
          );
          if (entry) unknownLinkRanges.push({ range, entry });
        }
      }
    }

    this.clearUnknownHover();
    this.unknownLinkRanges = unknownLinkRanges;
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
    this.unknownLinkRanges = [];
    this.clearUnknownHover();
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
    this.unknownNoteTimer = null;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "生词捕获" });
    containerEl.createEl("p", {
      text: "主快捷键收录/移除词条并高亮；另一个快捷键收录/取消不理解的内容，使用橙色独立高亮并链接到笔记标题，不做格式校验。",
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
        "独立于生词本，记录不理解的内容；再次按快捷键取消收录。使用橙色独立高亮，不做格式校验。默认 不理解的词.txt。",
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
      .setName("不理解词根目录")
      .setDesc(
        "不理解词的根文件夹。未分类.md 直接放在该目录下；分类使用真实子文件夹，Markdown 需在管理界面手动创建。",
      )
      .addText((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.unknownRootFolder)
          .setValue(this.plugin.settings.unknownRootFolder)
          .onChange((value) => {
            this.plugin.settings.unknownRootFolder =
              value.trim() || DEFAULT_SETTINGS.unknownRootFolder;
            this.plugin.settings.unknownNotePath =
              this.plugin.settings.unknownRootFolder.replace(/\/$/, "") +
              "/未分类.md";
            void this.plugin.saveSettings();

            if (this.unknownNoteTimer) {
              window.clearTimeout(this.unknownNoteTimer);
            }
            this.unknownNoteTimer = window.setTimeout(() => {
              this.unknownNoteTimer = null;
              void this.plugin.ensureUnknownWorkspace().then(() => {
                return this.plugin.ensureUnknownHeadings(
                  this.plugin.unknownStore.entries,
                  true,
                );
              });
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
        "选中内容后切换收录/取消；橙色独立高亮，不做格式校验。",
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
      })
      .addButton((button) => {
        button.setButtonText("打开不理解词笔记").onClick(() => {
          void this.plugin.openUnknownNote();
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
    if (this.unknownNoteTimer) {
      window.clearTimeout(this.unknownNoteTimer);
      this.unknownNoteTimer = null;
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
  removeUnknownRecord,
  ensureUnknownHeadingsText,
  findHeadingLine,
  findUnknownEntryForText,
  findUnknownEntryAtOffset,
  parseUnknownNote,
  parseMarkdownHeadings,
  convertFlatUnknownNoteToCards,
  normalizeSafeFolderName,
  normalizeSafeMarkdownName,
  insertHeadingSection,
  removeHeadingSection,
  addUnknownCategoryText,
  deleteUnknownCategoryText,
  moveUnknownCardText,
  renameUnknownCategoryText,
  reorderUnknownCategoryText,
  moveUnknownCategoryBeforeText,
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
