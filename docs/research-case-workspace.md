# 隔离科研案例工作区

验证案例保存在 `research/validation/cases/<case>/runtime/research`，主应用则使用自己的 userData 数据目录。此前的 Markdown 审阅包可读，但主应用的 Research Workspace 无法直接打开这些隔离记录。新增入口直接访问所选案例，不复制审批、完成状态或实验结果，也不启动 DSH 或模型服务。

在仓库根目录运行（Windows 开发环境）：

```powershell
# 默认只读：可以查看提案、完整绑定文件和已有运行记录
npm run research:case:workspace -- --case research/validation/cases/imputation-tests-1793367740427

# 可审批模式：打开窗口仍然不批准、不执行
npm run research:case:workspace -- --case research/validation/cases/imputation-tests-1793367740427 --review
```

用户在窗口中分别操作：

1. 核查问题、任务范围及材料来源/开发者介入记录。
2. 点击“批准此任务（不执行）”，授权当前计划的任务。
3. 点击“查看完整代码和输入”，逐项展开文件并核对提案 SHA-256。加载器不能读取完整绑定文件时，窗口拒绝批准和执行。
4. 点击“批准此版本（不执行）”，保存具体内容版本的批准。
5. 点击“执行已批准的提案”，由原有研究内核再次核对批准及全部文件后运行；真实 stdout、stderr、退出码及失败状态显示在运行记录中。

以上操作必须由用户完成。仅打开 `--review` 不是批准；预览文件不是 Agent 阅读回执。行为测试检查点只授权 `imputation.test.mjs` 提案，不能授权 `run.mjs`、完整模拟、设计或原主案例。执行后任务是否完成仍由正常内核完成契约判断，本窗口不自动标记任务/研究成功。已有运行的提案不在此窗口重复执行，需要审阅后另建提案。

窗口不提供新建项目、修改预算、启动 Agent、直接改写研究产物、设计质量审阅或来源支持性审阅。它是隔离案例的提案审阅/执行入口，不能替代完整 Research Workspace 的所有功能。

## 权限和状态边界

- 使用生产 `research-access.mjs` 的窗口、顶层 frame、精确生成文档及只读/owner 校验；专用 preload 只暴露六个方法。
- 主进程仅接受所选项目、当前计划任务和精确提案哈希。预览回执保存在主进程，绑定窗口发送者与提案哈希；截断、文件缺失、内容变化及新窗口不能沿用回执。
- 路径按 realpath 核查，所选目录必须位于 `research/validation/cases` 内；仓库与实验 workspace 必须位于该案例内，拒绝指向外部的 junction。
- 每个规范案例路径有独立 Electron 单实例锁和临时 userData。它不锁定其他 CLI 或外部程序；并发文件变更由原有内核批准/启动核对拒绝，不宣称操作系统隔离。
- 加载仅查询持久化状态，不调用恢复、批准、执行或模型。退出时取消本窗口启动的运行并等待终态保存；历史 interrupted 状态不会在启动时自动重试。
- 页面按文本展示来源、代码与日志，禁止外部资源及导航。只读拒绝由生产访问控制完成；该开发入口不向研究仓库写入被拒请求的审计，以保持只读打开不改写案例。

## 验证

单元测试覆盖作用域、当前计划、哈希、完整预览、发送者隔离、重复运行拒绝、只读/伪造 frame 拒绝，以及真实案例加载时的项目/协议/路径核对。

```powershell
npm run research:case:workspace:smoke -- --case research/validation/cases/imputation-tests-1793367740427 --out research/validation/case-workspace-smoke-new
```

`--out` 必须为尚不存在的目录。Smoke 在隐藏只读窗口中加载实际检查点，通过界面预览全部绑定文件，并验证三个写接口均被拒绝；对比前后权威项目快照。它不批准、不执行候选，不证明候选行为或科研质量。实际证据见 `research/validation/cases/imputation-tests-1793367740427/workspace-smoke-20261030-v2/summary.json`，包括 7 个完整文件已渲染、0 批准、0 执行、快照未变。

随后用户在对话中明确批准了该精确行为测试提案，已通过正常内核执行，exitCode 0，测试项目完成。授权及真实运行证据位于该案例的 `behavior-run-20261030/`。上述只读 smoke 是批准前的历史证据，当前仓库应显示 1 次完成运行；不要把旧 summary/snapshot 当作当前状态，也不要重复运行一次性授权记录脚本。
