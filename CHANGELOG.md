# Changelog

## 0.2.1

- 修复修改插件 ID/名称后阅读视图不高亮：`::highlight()` 样式改为按 `HIGHLIGHT_NAME` 动态注入，不再依赖 styles.css 中的固定名称。
- 高亮名称做合法性校验，非法值回退到 `vocab-highlight`。
- 增加动态样式注入测试。

## 0.2.0

- 生词本改为 vault 级共享词集，移除 `原文` 文件夹限制。
- 同一个快捷键 `Alt+W` 切换收录/移除。
- 增加编辑视图高亮：CodeMirror 6 `Decoration.mark`，覆盖 Live Preview 与 Source。
- 直接编辑 `生词本.txt` 后自动重载；监听创建、删除、重命名。
- 词表增删、全局阅读视图高亮和编辑器刷新。
- 增加测试、功能展示图与安装包。

## 0.1.0

- 首个版本：阅读视图选词、写入 `生词本.txt`、CSS Custom Highlight API 高亮。
