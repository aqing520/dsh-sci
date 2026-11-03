# 本地调研资料

本轮调研与开发方向：

- [Rewind 本机逆向与当前代码对照](rewind-analysis-report.md)
- [在主 Agent 中实现科研能力](../docs/research-native-agent-direction.md)

旧记录中的 `rea/`、`rewind-inspect/` Junction 在本次检查时已不存在。现在直接分析安装包和活跃 Harness 插件，原始证据在被 Git 忽略的 `rewind-analysis-local/`。不要把样本源码或 Evidence bundle 加入提交或发布包。

复现命令（项目根目录，需已有官方 REA 和兼容 Node）：

```powershell
node scripts/research-rewind-inspect.mjs `
  --rea 'C:\Users\wzy\.codex\tools\rea-research\node_modules\rea-agents\scripts\rea.mjs' `
  --node 'C:\Users\wzy\.codex\tools\rea-research\node_modules\node-win-x64\bin\node.exe'
```

可用 --installation 指定安装目录，--output 指定新输出目录，--scope shell|plugin|all 选择范围。脚本拒绝覆盖旧证据，不启动 Rewind，不读用户凭据或聊天数据，不注册 MCP 或安装工具。
