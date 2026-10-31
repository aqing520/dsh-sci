# P2 正文、阅读与证据协议

2026-10-30。本轮为 P2 核心实现；科研质量仍需独立来源、反证、真实扫描材料和人工引用核查。完整研究目标没有缩小为阅读探针。

## 内容与读取

来源登记不等于获取内容，获取内容不等于 Agent 阅读。`source` action 的摘录、reading、版本指针和 provenance 不能产生可信阅读历史。旧草稿没有版本依据的“已读”会归为 discovered。

`reference` 获取 Crossref/arXiv 摘要或网页抽取文本，`document` 解析本地文本/PDF/OCR。内容保存为不可覆盖的 `dsh-sci.source-content.v1`，包括 project/source/version、获取地址/时间、abstract/full-text 范围、text/OCR 抽取方式、截断标记、正文哈希、可获得的原始材料哈希和分块定位。成功内容标 available；另存获取日志，保留 pending/metadata-only/unreadable/restricted/not-found/failed。重启不为 pending 自动重复抓取。

正文最多保存 200,000 个 JavaScript UTF-16 字符。网页响应读取最多 8 MiB，并设置 30 秒网络超时。解析超限、付费限制与无文本层不当作成功阅读。当前不保存网页原始 HTML 或 PDF 页图；原始哈希用于标识材料，逐字引用校验基于抽取文本。OCR 支持性仍需核对扫描页图。

内容通过现有 Repository 加密配置保存。更新同来源时创建新内容版本，更新最新指针、摘录和当前材料元数据；旧引文仍绑定原版本。正文更新后阅读状态重回 discovered。多文件写入失败可能留下未被来源最新指针引用的内容，获取日志保留未完成/失败，不能声称多文件事务或断电保障。

```json
{"action":"source-read","projectId":"...","sourceId":"...","contentVersionId":"content-...","offset":0,"limit":2}
```

`chunk-read` 为同一有限读取接口的别名。offset 是从 0 开始的 chunk 序号；limit 为 1—3，每块最多 4,000 字符，响应正文最多 12,000 字符。返回下一 offset、内容摘要和实际分块。PDF/OCR 的物理空白页保留页号，长页拆块；无法可靠定位页码的 PDF 文本回退不编造页码。字符偏移是整个保存文本中的 UTF-16 位置，endOffset 不包含在范围内。

Agent 读取回执绑定当前 plan/task/attempt、内容版本、哈希和返回 chunk。Workspace 浏览单独标 audience=workspace，不使 Agent 阅读门槛通过。当前阅读状态可累计同版本多次 Agent 覆盖；任务完成仍要求本次 attempt 读过被引文定位的范围。截断材料即使读完保存部分也保持 partially-read；摘要完整读取仅为 abstract-read。

`inspect` 返回有界目录和计数，指定 collection/offset/limit 分页；limit 最大 20，不返回正文或完整报告。Workspace 导出保留完整结构记录、内容目录与阅读回执，正文通过专用读取接口访问。这里实现的是上下文控制，不是已经验证了固定比例的 token 节省。

## 检索

`search` 支持 backend=auto/configured/crossref。auto 使用已配置服务，否则使用无需密钥的公开 Crossref 学术元数据索引；显式 configured 在缺配置时记录失败，不悄悄切换。已配置服务调用失败也不自动改用其他来源。公开索引不是全文或通用网页搜索。

每次查询保存 query/provider/actor/plan/task/时间/状态，保留原结果排名、canonical URL 去重、过滤理由及结果上限。当前适配器只支持第一页，日志明确 pagination.supported=false，不伪造后续页。canonical URL 去重不证明论文独立性；预印本、正式版与同题论文仍需关系核查。搜索摘要只是线索，不创建正文或阅读回执。

相同工作、预印本/正式版、修正版和复现实验之间的关系由可信 Workspace 作为独立 `dsh-sci.research-source-relation.v1` 记录；模型不能写入关系或 `countsAsIndependent` 判断。`same-work`、`preprint-of`、`version-of` 和 `correction-of` 强制不计为独立证据，`replication-of` 与 `related` 必须由人工说明是否独立。报告展示来源关系，辅助核查同一出版物是否重复使用；目前不据此自动宣称达到独立来源数量门槛。

## 引文和主张审阅

引文保存 sourceId/contentVersionId，以及 locator.chunkId、page 或完整 start/endOffset；保存短引文后，内核分别检查内容目标、定位和逐字文本匹配。NFKC/空白归一化只用于匹配，不改变保存偏移。任意 section/paragraph 标签目前不能自动验证，保留未核验结果。

逐字匹配不表示支持某个科研主张。未在可用位置找到文本标 not-in-available-content，不能推断整篇论文不存在该句。research/source-review 完成要求至少一条已验证定位/文字、且本次任务实际读取过对应范围的引文；完成候选阅读任务不表示所有候选主张均被科学确认。

证据关系支持 citationId，并关联具体 claim/source。人工支持性记录为独立 `dsh-sci.evidence-review.v1`，包含对象 ID、主张/关系/引文/内容哈希、结论、必要备注和时间。支持/反驳审阅前要求原文定位和引文匹配。更改主张或关系后旧审阅显示过期，不能继续认定有效；同一引用对其他主张没有自动支持效力。

只有已认证 Workspace IPC 提供 evidence-review-context / evidence-review；Agent bridge 不暴露人工审阅动作，工具输入中的 review 字段也不会成为人工审阅凭据。报告对未核验引文、缺少当前支持审阅及与提议关系矛盾的判断显示警告。draft/reviewed 的正式报告门槛留在 P5。

## 证据与仍待完成

- [自动化验证](../research/validation/source-content-1793302618754/summary.json)：构建、179 项测试（178 通过、1 跳过）、新增 13 项来源相关回归，以及实际 Electron/SDK/Harness/package smoke。
- [真实阅读探针](../research/validation/source-live-1793302351900/summary.json)：11 请求、156,171 token；12 个发现来源中只有 3 个保存内容并发生读取；1 条引用逐字匹配。开发者指定一个任务、提供两个补充网页线索，无自动规划/完整实验验收。原代码哈希保留；随后刷新元数据及结果提交补强另由自动化回归覆盖。
- [待审阅材料](../research/validation/source-live-1793302351900/review-packet.md)：原文、模型主张、支持关系和范围疑问，未写入人工认可记录。

W05 的来源关系内核、持久化和 Workspace 保存入口已经实现，并有专项回归；下一步仍是主案例的独立来源、反证及人工引用核查。真实扫描 PDF 页图核对、通用搜索覆盖、翻页和全文可获取性仍需补验；不能据合成 OCR/Workspace 测试宣布这些科研质量门槛通过。安装包未生成。

## HTTP 200 访问挑战页

网页采集在创建来源及正文版本之前，拒绝明确的浏览器挑战标题（例如本次真实 PMC 的 `Checking your browser - reCAPTCHA`）、Cloudflare `cf-mitigated: challenge` 标记和短浏览器检查文本。失败记录为 `restricted / access-challenge`，不伪造 HTTP 403，不保存挑战正文、阅读回执或引用；刷新失败保留原有可读版本与引用。CAPTCHA 研究文章和普通页脚验证码组件不因关键词本身被拒绝。

这是对明确挑战页的有界识别，不是通用登录墙或内容真实性分类器；历史已保存的挑战页不会自动改写或重新标注。历史案例 `imputation-v1-1793354437755` 已保留为 blocked，第三条引用来自挑战页，不能作为科学证据。人工支持性审阅仍不可省略。17 项正文专项与一次真实 PMC 请求的证据见 [guard/网络与正文增量](../research/validation/w13-guard-network-20261030/summary.json)。
