# 本地调研资料

项目内的两个目录是 Windows Junction，用于在开发时直接访问本机调研资料：

- `rea/`：本机 `morluto/rea` 源码，用于 JavaScript/Electron 静态分析和运行时观察。
- `rewind-inspect/`：之前解包的 Rewind Harness `app.asar` 内容，用于架构和功能调研。

它们不会进入 dsh-sci 的 Git 提交或安装包。REA 保留自己的 `.git` 历史；Rewind 目录只作为本地样本。

REA 示例命令（在 `dsh-sci` 根目录执行）：

```powershell
node research/rea/scripts/rea.mjs analyze-javascript-application research/rewind-inspect --json
```

如果以后要迁移机器，只需重新创建这两个 Junction；不要把 Rewind 解包内容复制进发布安装包。
