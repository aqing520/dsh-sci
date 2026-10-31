# 研究权限与安全审计

本轮实现 W13 的 bridge 只读 capability、项目范围约束、只读 Workspace 会话、全局安全审计和离线研究数据迁移。独立安全评审、安装升级、系统网络和 Linux 仍在 W13 范围内，尚未完成。

## 自动 Agent 的真实工具边界

自动 runner 启动前要求 DSH `tools` 服务同时提供 `guard`、`restrict`、`presentAs` 和 `register`；缺少任一能力会拒绝启动，不会退化为未限制的 Agent。生产 guard 在工具执行管线中统一拒绝 shell、文件写入、`run_code` 和未知工具，并覆盖作用域内注册的工具以及带父执行令牌的嵌套入口。自动 runner 强制 Agent 使用 `native` 工具呈现，即使部署默认是 PTC；科研工具仍通过 bridge 工作，不能通过 PTC 或其他工具绕过 bridge。实际 Harness 的 native/默认 PTC 两种配置均已验证，哨兵工具体从未执行。探针是合成权限验证，不代表科研质量或 PTC 程序本身已执行。

## 权限在何处确定

本地主进程调用 `startResearchBridge` 时确定权限并签发随机 bearer token；请求正文中的 `role` 或 `access` 不会改变权限。启动参数会复制保存，调用者后续修改原参数对象不能改变该会话权限。

| 会话 | 允许范围 | 拒绝范围 |
| --- | --- | --- |
| 普通插件 bridge（默认 `research`） | 已支持的研究记录、规划、查询等动作 | bridge 没有实验审批/执行、设计质量审阅或报告人工审阅接口 |
| 自动 runner bridge | 当前项目、当前运行任务及任务类型允许的动作 | 跨项目、非当前任务、暂停任务、人工审批和审阅 |
| `access: "read-only"` bridge | context、list、inspect、approval-queue、report-read、memory-retrievals、memory-conflicts | 其他动作；请求伪造 owner/research 角色也会被拒绝 |
| 可信 Workspace IPC | 绑定的普通窗口可写动作，或绑定的只读窗口读取/预览/报告查看 | 未绑定窗口、子 frame、替换页面、弹窗和只读窗口写动作 |

`scopeProjectId` 可把 bridge 限制到一个项目；列表、上下文和检索记录也受此约束，不能用省略项目 ID 或全局列表绕过。带项目范围的 capability 不能创建另一个项目。自动 runner 与只读模式不能组合，互相矛盾的项目范围会在启动时拒绝。

来源阅读会保存阅读回执，文献搜索会保存查询日志，记忆搜索会保存索引/检索记录，因此这些 API 需要写权限。只读 context 不自动检索或注入记忆，不写项目事件、不恢复待提交日志；只读请求的安全审计单独保存。

这属于单用户本地服务边界。直接持有 Repository/Orchestrator 的主进程内部代码仍是可信代码；本轮不提供操作系统沙箱、多人身份认证或独立进程间强事务。

## 审计内容与容量

研究根目录下的 `security-audit.jsonl` 保存请求 ID、审计 ID、时间、已知动作类别、accepted/rejected、固定原因和已解析项目的 ID。客户端可用响应头 `x-research-request-id` 对照记录。未知动作归为 `unknown`；未认证请求不读取其正文来确定动作。

认证失败、无效路由、请求限流、畸形请求、无项目动作、动作拒绝和成功动作都可留记录。每个请求最多一条全局审计；已有的项目动作事件仍保留，用于正常研究轨迹。全局日志不复制请求正文、候选项目 ID、未知动作文本、错误堆栈、外部服务响应或凭据。

默认保留最近 2000 条，滚动写入；同进程内同一根目录共享写入队列与每分钟 240 条写入上限。洪泛超限时拒绝逻辑继续生效，省略逐条日志；在下个时间窗口首条记录上附加 `suppressedRequests`。计数器在内存中，进程退出后重新开始。配置了研究元数据密码时，日志沿用加密机制；明文/加密重启与滚动保留均有专项验证。

审计持久化失败会产生固定的 `DSH_SCI_SECURITY_AUDIT_UNAVAILABLE` 警告。当前全局审计属于遥测，不以持久化成功作为业务事务提交条件；磁盘不可写时不能保证该请求已留证。日志尚无防篡改签名或跨进程文件锁。

## 只读 Workspace 与迁移

普通 Research Workspace 可以打开独立的只读窗口。只读 renderer 只显示已有项目记录、保存的文献正文预览和已有报告；正文预览不创建阅读回执，报告查看和导出不重新生成报告。主进程 registry 绑定窗口身份和具体 data URL 文档，刷新会签发新文档但保留只读角色；未知 sender、子 frame、替换页面和 popup 在 IPC 层拒绝。实际生产 Electron smoke 覆盖 owner、只读和未绑定窗口。

`npm run research:store:migrate -- --source <关闭应用后的旧 research 根目录> --target <新 research 根目录>` 是离线迁移入口。它先对源目录做文件哈希清单，保留 `<target>.migration/before` 不可变副本，再在临时目录校验 JSON、加密记录、项目主记录、预算/计划/记忆索引和中断实验，重建派生项目索引，最后原子写入 `store-format.json` 的 `ready` 标记并 rename 提交。源目录从不被修改；迁移中断留下 journal 和临时阶段，重试从备份继续；旧计划仍要求协议复核，旧预算不会自动补额度，旧报告的 stored reviewed 标签不能绕过当前审阅。迁移不会批准或执行实验。旧程序不承诺读取新格式，降级应使用源目录或迁移前副本。

## 查看与验收范围

Research Workspace 顶部“查看安全审计”通过可信 IPC 读取最近 200 条记录，使用纯文本渲染。实际 Electron 权限 smoke 验证 35 个写入通道均被只读窗口拒绝、只读正文预览/报告读取不写项目、未绑定 sender 和替换文档拒绝、popup 被禁止、拒绝动作写入审计且进程正常退出；迁移专项覆盖明文/加密旧 fixture、六个写入边界、源/备份哈希、重复迁移、损坏/未来格式和符号链接拒绝。

验收证据见 [W13 增量证据](../research/validation/w13-security-20261030/summary.json)。自动化涵盖只读动作拒绝矩阵、请求角色伪造、项目记录/索引不变、项目范围、未知输入脱敏、每请求单次审计、同根目录洪泛限制、加密恢复和滚动保留。这些检查不代表完整科研案例或独立安全评审已经通过。

最新 [guard 与网络诊断证据](../research/validation/w13-guard-network-20261030/summary.json) 补充两种真实 Harness 配置、缺失 API 拒绝启动、代理断连/超时/HTTP 状态区分与脱敏；[只读/迁移证据](../research/validation/w13-workspace-migration-20261030/summary.json) 和[迁移操作说明](research-migration.md) 保留各自验证范围。网络故障注入限 loopback，未修改用户系统网络。
