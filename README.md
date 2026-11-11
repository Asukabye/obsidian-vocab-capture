# CET4 生词捕获

Obsidian 插件：把选中的英文单词收录到 **vault 级词集**，并在阅读视图与编辑视图中高亮所有出现位置；再次按下同一快捷键即可移除。

> 说明：以下图片为功能效果示意（模拟 Obsidian 界面），实际字体、行距与颜色随主题变化。

![阅读视图](docs/feature-reading.png)

> 阅读视图：`exercise`、`beneficial`、`people`、`declined`、`linked`、`moderate` 为插件高亮；`==26==` 的黄色为原有填空高亮。

![编辑视图](docs/feature-editor.png)

> 编辑视图：通过 CodeMirror 6 Decoration 渲染，与阅读视图共用同一词集。

![添加与移除](docs/feature-toggle.png)

> 同一个快捷键按“词是否在词集中”切换收录/移除；也可以直接编辑 `生词本.txt`。

---

## 功能

- **vault 级词集**：词表位于 vault 根目录的 `生词本.txt`，一行一词，自动去重、转小写、按字母排序。
- **一键增删**：阅读/编辑视图中选中单词，按 `Alt+W`：未收录则加入，已收录则移除。
- **自动高亮**：词表中的词在 vault 内所有 Markdown 文件中高亮，大小写不敏感、整词匹配。
- **阅读视图**：使用 CSS Custom Highlight API，不修改 DOM、不修改 md。
- **编辑视图**：使用 CodeMirror 6 `Decoration.mark`，覆盖 Live Preview 与 Source 模式。
- **直接编辑词表**：在 Obsidian 中增删 `生词本.txt` 行，保存后自动重新加载。
- **零构建**：单个 `main.js`，直接 `require("obsidian")` 与 `require("@codemirror/view")`，无需打包。

---

## 安装

要求 **Obsidian 1.5.0 或更高版本**。

### 方式一：Release 安装包

1. 从 [Releases](../../releases) 下载 `cet4-vocab-capture-0.2.0.zip`（仓库内 [`dist/cet4-vocab-capture-0.2.0.zip`](dist/cet4-vocab-capture-0.2.0.zip) 也可直接下载）。
2. 解压到：

```text
<你的 vault>/.obsidian/plugins/cet4-vocab-capture/
```

3. 打开 Obsidian → 设置 → 第三方插件 → 关闭“安全模式/受限模式”→ 启用 **CET4 生词捕获**。
4. 如果列表中没有，重启 Obsidian 或刷新插件列表。

### 方式二：手动安装

将以下文件放入同一目录即可：

```text
manifest.json
main.js
styles.css
```

`README.md` 与 `docs/` 仅用于说明，可省略。

> Release 中的 zip 已包含运行所需的全部文件。

### 方式三：BRAT

已安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 的话，可直接添加：

```text
Asukabye/obsidian-cet4-vocab-capture
```

---

## 使用

### 快捷键增删

1. 打开任意 Markdown 文件，切到 **阅读视图** 或 **编辑视图**。
2. 双击选中一个英文单词（或拖选）。
3. 按 `Alt+W`：
   - 未收录 → 加入词表并高亮；
   - 已收录 → 从词表移除，所有高亮消失。

只接受一个英文单词；多词、数字、符号会被拒绝。  
toggle 判断的是“该词是否在词集中”，不是“当前屏幕上是否正好有青绿色高亮”。因此词在词集中但因代码/表格设置或词形变化没有显示高亮时，按键仍会移除它。

### 直接编辑生词本

默认词表：

```text
<你的 vault>/生词本.txt
```

一行一个单词。直接在 Obsidian 中增加或删除行，保存/自动保存后，所有打开文件的高亮会同步更新。

```text
beneficial
decline
moderate
people's
up-to-date
```

---

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| 生词本文件 | `生词本.txt` | 相对 vault 根目录；也可填绝对路径（仅桌面版） |
| 收录快捷键 | `Alt+W` | 点击“录制”后按新键；支持单键或组合键 |
| 高亮颜色 | `rgba(64, 190, 160, 0.28)` | 任意 CSS 颜色 |
| 包含表格 | 开 | 表格中的单词也高亮；关闭后阅读视图和编辑视图都跳过表格行 |
| 包含代码 | 关 | 行内代码、代码块默认不处理 |
| 跳过已有高亮 | 开 | 跳过 `==26==` 这类已有 `<mark>`，避免叠色 |
| 按字母排序 | 开 | 关闭后按首次收录顺序写入 |

单键快捷键只在“阅读/编辑视图有选区”时生效；输入框、命令面板、设置弹窗中不会拦截按键。

---

## 支持范围

- **所有 Markdown 文件**（阅读视图 + 编辑视图）
- 生词本自身不参与高亮
- 不处理 Canvas、PDF、纯文本文件

阅读视图基于渲染后的 DOM，支持：

- YAML frontmatter（不渲染，忽略）
- 标题、callout、多层 blockquote、列表、表格、链接
- `**P1**`、`**A)**`、`**36.**` 等加粗标签
- 行内代码、代码块（默认跳过）
- 已有 `==高亮==`（默认跳过）
- 弯引号 `people’s`、不同连字符 `up‑to‑date`
- 被格式拆开的单词，例如 `**decline**d`：跨节点 `Range` 高亮

编辑视图基于源码做 CM6 Decoration，覆盖 Live Preview 与 Source。默认跳过 frontmatter、代码、URL、已有 `==高亮==`；关闭“包含表格”时跳过表格行。

---

## 实现

```text
manifest.json   插件清单
main.js         插件逻辑与编辑器扩展（无构建）
styles.css      阅读视图 ::highlight 与编辑视图 mark 样式
tests/          Node 单元测试、jsdom DOM 测试、插件集成测试
docs/           功能展示图与截图源文件
dist/           可直接安装的 zip
```

- **选词**：阅读视图用 `window.getSelection()`；编辑视图用 `editor.getSelection()`；要求单选区。
- **词集**：`Set` 去重；UTF-8、一行一词；vault 内用 `vault.adapter`，绝对路径用 Node `fs`。
- **匹配**：Unicode 整词正则，大小写不敏感；`people's` 匹配 `people’s`；`up-to-date` 匹配非标准连字符。
- **阅读视图**：按块拼接文本节点，映射回 `Range`，写入 `CSS.highlights`。
- **编辑视图**：`registerEditorExtension` + `ViewPlugin` + `RangeSetBuilder` + `Decoration.mark`；只处理 `visibleRanges`，词表变化时通过 `StateEffect` 触发重建。
- **直接编辑词表**：`vault` 的 `modify` / `create` / `delete` / `rename` 事件触发重载并刷新。
- **不修改 md**：所有高亮都是运行时渲染效果。

---

## 验证

- `node --check main.js`
- 纯函数测试：19 项
- jsdom DOM 测试：8 项
- 插件集成测试：4 项
- Chromium 150 阅读视图高亮测试：13 项

CM6 扩展使用 Obsidian 运行时提供的 `@codemirror/view` / `@codemirror/state`，与 Obsidian 使用同一份 CodeMirror 实例，不重复打包。项目未包含自动化 Obsidian UI 测试；升级 Obsidian 或更换主题后，建议先在目标 vault 做一次手工验收。

---

## 已知边界

- **精确整词**：收录 `decline` 不会自动高亮 `declined` / `declining`。
- **编辑视图的 Markdown 标记**：编辑器基于源码匹配；`**decline**d` 这种“加粗部分 + 后缀”在源码中不是连续的 `declined`，编辑视图可能只高亮 `decline` 部分；阅读视图不受影响。
- **代码/URL**：编辑视图默认跳过；打开“包含代码”后，fenced code 与行内代码也会参与匹配。
- **多窗口**：阅读视图的 CSS Highlight 覆盖主窗口；Obsidian popout 窗口未做专门验证。
- **绝对路径词表**：桌面版可用，但不会监听 vault 外部的文件变化；修改后执行“重新加载生词本”。
- **不要同时手动编辑词表并按键收录**：自动写入可能覆盖未保存的手动修改。
- 没有插件内可视化管理界面；词表的增删通过快捷键或直接编辑 txt 完成。

---

## 开发与测试

```bash
npm install
npm run check
npm run test:all
```

`test:all` 依次运行：

```bash
node tests/core.test.js
node tests/dom.test.js
node tests/plugin.test.js
```

`tests/dom.test.js` 与 `tests/plugin.test.js` 需要 `jsdom`。

---

## License

[MIT](LICENSE)
