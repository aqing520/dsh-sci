# 候选代码准备、静态检查与修订

更新：2026-10-30。本文描述当前实现；不代表主案例、候选代码正确性或科研质量已验收。

## 工具与持久化

- `code-stage` 保存新内容寻址 bundle。旧候选不覆盖；代码、输入、依赖均记录字节数和 SHA-256。结果中的 `syntaxChecks` 仅表示静态解析状态。
- `code-stage {baseBundleId,files}` 可以做局部修订。内核先重新读取并核对基线 bundle 的所有文件，再把指定文件按原 name/kind 替换，生成新的完整内容寻址 bundle；未提供的文件按字节继承。基线篡改、未知 bundle、重复文件或超限会拒绝，旧 bundle 和任何审批不变。局部修订也会重新执行静态语法检查。
- `code-read {bundleId,fileName,offset,limit}` 仅读取当前计划中本任务或依赖任务的已注册文件。limit 为 1—12000 个 UTF-16 字符，按 `nextOffset` 继续；每次读取重新核对 manifest、路径和文件哈希，保存当前 task/attempt 回执。
- `code-review` 要求当前 attempt 完整读取 bundle 的所有 code/input/dependency 文件，保存 findings、文件字符范围及 limitations。有设计祖先时绑定当前设计内容哈希；草稿可用于静态比较，不能充当批准。
- 检查记录固定 `actor=agent`、`scientificQuality=not-reviewed`。有发现时为 `findings-recorded`；空发现为 `no-findings-reported`，均不是正确性或人工验收。

代码审查任务与文献审查使用不同契约。`code-review` 不能调用 citation、code-stage 或 experiment；模型须在代码准备任务保存修订包，再由后续审查任务读取。默认计划为 9 步，实验任务位于代码审查之后，仍要求明确审批。

## 长检查记录的读取

`inspect {collection:"codeReviews",offset:0,limit:10}` 返回检查 ID、bundle 哈希、finding/limitation 数量和摘要。完整发现可按下面的请求分页取回，不会因为 inventory 大小限制而整条丢失：

```json
{"action":"inspect","collection":"codeReviews","recordId":"code-review-...","field":"findings","offset":0,"limit":1}
```

field 为 `findings` 或 `limitations`，limit 为 1—3，按 nextOffset 继续。详情保持项目 capability 范围，也可通过只读 capability 获取。读取详情不会生成代码阅读回执、批准、任务完成或运行记录。持久化校验同时检查数组/文本上限、文件范围和哈希，不能仅重算 ID 就写入越界记录。

## JavaScript 静态解析

代码准备任务暂存 `.mjs`、`.cjs` 和 `.js` 时，内核使用可信 Node 的 `--check` 从 stdin 解析；不导入候选、不解析其依赖、不执行顶层语句或测试。解析进程没有 shell，不继承 NODE_OPTIONS、预加载钩子或 provider 密钥，限制堆大小、输入和等待时间。Electron 主进程使用 Node 模式，开发版实际 smoke 已覆盖。

语法错误候选仍保存为失败证据，code-stage 返回文件、行号和有界诊断。模型必须另存修订版本。完成代码准备时重新读取文件并解析；`syntax-error` 或 `parser-unavailable` 阻止完成。Python/其他文件类型显式 `not-checked`；`.js` 可按 module/CommonJS 解析，但这不确定实际运行时的模块类型。

静态解析不会证明测试断言正确、协议遵循、数值正确、依赖可用或可复现。候选运行及行为测试仍须 Workspace 对具体不可变内容明确授权。

## 定点修订与测试提案

真实修订脚本可从导入目录的 `revision.json` 接受 `correctiveRequirements`，只在 `--revise` 模式使用，限制为 1—16 条、每条最多 2400 字符。它们作为 operator 输入连同原始文件哈希保存，不算模型自主发现。定点要求替代旧的通用修订段落，完整冻结协议仍保留；项目问题仍受原有 16000 字符限制。失败记录区分配置、代理、创建项目、导入、Agent 执行阶段，不保存任意异常文本。

`node scripts/research-code-test-proposal.mjs --probe <已结束静态审查目录>` 只准备行为测试检查点。它要求审查任务实际完成、文件读取覆盖完整且无已记录 blocker，重新核对所有文件及冻结协议、静态解析代码，随后在新的案例目录创建绑定完整 bundle 的 `node imputation.test.mjs` 提案。任务停在 `waiting-approval`，提案没有 approval，运行数为 0；不会导入旧任务完成状态、批准或研究设计。Agent 未报告 blocker 也不等于代码正确，人工仍需查看审查及全文。

再用 `research-case-review-packet.mjs --case <新检查点目录>` 导出完整来源、修订者、代码、哈希、命令与待审事项。新的 `inputProvenance.operatorActions` 保留跨探针来源和外部静态审查，避免把人工纠正记成自主修复。测试通过后仍需单独推进主案例的设计绑定、实际模拟和独立复现；测试批准不能充当模拟批准。

候选运行入口的 `source-manifest.json` 检查是额外的运行前漂移核对：manifest 不包含自身哈希，Workspace/内核在进程启动前对完整 manifest、所有代码与输入绑定批准，才构成外部可信依据。报告输出同时保留实际代码哈希。有效重复数显式保存为 `validReplicates`；任何无效输入会在汇总前拒绝，不能靠减少有效重复数隐去失败。

## 结果身份修复

SDK 对最终结果的 project/task/plan/attempt/version 保持精确校验。若结果 schema 合法但身份错误，且任务仍处于同一运行身份，记录一次 `task-result-repair-requested`，向同一模型会话请求更正身份。模型自己重新提交结果；程序不填补身份、状态、输出或审批。

最多一次修复；再次错误仍失败。任务已变化或暂停时不进行修复。修复请求使用原模型代理、预算和任务 deadline，不增加任务 attempt 或重置额度。合法身份仍不能替代必需产物、当前轮阅读、设计绑定、实验审批等门槛。SDK 合成传输 smoke 覆盖故意返回旧身份、一次修复、预算计量和唯一完成；它不代替真实模型科研验收。

## 结果引用纠正

SDK 也会在返回结果前检查 `refs` 是否属于当前项目的已保存记录。它与内核提交共享同一引用清单，包括当前项目或全局研究记忆；其他项目的记忆不会进入反馈。未知引用仅反馈数组位置，不回显模型填写的未知文本。反馈携带最多 64 个当前项目记录 ID，优先本轮审查及其绑定代码包，供模型重新复制确切 ID。

身份与引用纠正合计每个 attempt 最多一次。纠正请求写入事件，SDK 断连重建或 Repository/Executor 重建后不能重新获得次数；暂停、任务身份变化或取消会阻止纠正。模型重新提交，程序不删除、替换或补写其 refs；再次引用未知 ID 仍失败。引用存在仅证明登记关系，最终内核仍验证完整阅读、当前任务产物、语法和审批门槛；不存在所需产物时必须保持阻塞或等待审阅。

`node scripts/research-sdk-smoke.mjs --reference-repair` 用合成 Responses 传输经过官方 SDK，验证一次错误引用后的模型响应、真实产品请求计量和只完成一次。另有边界测试覆盖代码包 ID 纠正、跨项目记忆隔离、重复错误、身份和引用同时错误、暂停、取消、断连/新 Executor 后次数不重置及缺产物仍拒绝。它们不证明真实模型一定能纠错，也不替代科研质量验收。

## 验证边界

本轮真实模型修订使用新项目及 operator 提供的任务、导入文件和纠错要求，没有复制旧状态或批准，也没有修改旧主案例。Operator 初始草稿中的错误、第一次模型审查的漏检、后续新发现和第二次修订的结果身份失败均保留。完整主案例、行为测试、独立复现和人工科研审阅仍待完成，详情见 [验证汇总](../research/validation/code-revision-20261030/summary.json)。
