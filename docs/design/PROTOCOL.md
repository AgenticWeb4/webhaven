# WebHaven 概念与交付协议

协议版本 1。来源是已确认的四项能力：采集、归档、发布、消费；缓存属于消费侧性能支持。产品由两个进程组成，并非一个概念对应一个进程。

## Capturing [Source, Artifact]

目的：取得指定来源范围的内容，并给出可解释的覆盖结果。

状态：每个采集 ID 唯一对应来源描述、范围、任务状态与结果。初始无任务；queued/running 与 complete/partial/failed/interrupted 互斥。Source、Artifact 是外部类型参数，不预设身份字段。

动作：start(spec) 返回 captureId，非法配置返回拒绝且不产生运行任务；完成产生 artifact 与覆盖/缺口信息；失败产生原因，不宣称得到完整内容；status(captureId) 返回唯一任务或 not-found。外部程序提交完整或部分 Artifact 是另一入口，不要求系统执行该程序。

操作原则：提交指定来源与范围，等待完成，再读取所得内容及缺口报告；取得了哪些内容、哪些未取得均可判断。排队本身不满足目的。

## Archiving [Artifact]

目的：保留以后可读取的内容版本。

状态：不可变版本清单与内容对象；每条文件路径唯一，大小和 SHA-256 匹配。未结束上传的候选不属于可发布归档；初始为空。来源原始凭证不进入清单。

动作：create(artifactDescription, baseInventory) 返回候选 ID；put(candidate, digest, bytes) 仅在上传阶段允许匹配的声明对象；finalize(candidate) 校验所有文件和可观察静态依赖后返回版本及合格/有缺口状态，缺文件/损坏则拒绝，不能发布半成品；get(version) 返回指定内容或 not-found。内容就绪后不允许修改。外部声明完整与验证通过共同决定资格，不由 HTTP 200 推断。

操作原则：保存并完成版本后，按标识再次取得相同内容；保存下一版不改变上一版。文件原始对象保留；清单中的缺口属于新版本的固定说明。

## Publishing [ContentRef]

目的：让稳定地址受控地选择可读取内容。

状态：每集合一个发布头，包含单调递增修订、ContentRef 与操作 ID。初始修订 0、无选择。ContentRef 是外部标识参数；概念定义不依赖爬虫或 S3。

动作：select(collection, contentRef, expectedRevision, operationId) 在修订匹配、内容已就绪并满足应用批准策略时选择新内容并返回修订；冲突返回 409，旧选择不变；同操作同输入重放返回已提交结果，同操作不同输入拒绝。resolve(collection) 返回当前选择或未发布。回滚调用 select 选择旧内容，修订仍递增。

操作原则：选定版本后，稳定地址解析到该版本；再次选择切换至新版本，拒绝不替换当前选择。

## Replicating / Serving [Release]

目的：独立提供已经收到并验证的发布内容。

状态：本地已验证版本、当前选择及同步错误；消费端不拥有生产端发布权。每集合初始无本地版本。

动作：sync(collection) 读取发布头、清单及对象，校验身份、摘要、大小和限额后准备本地版本并整体激活；缺失、损坏、存储不可达、空间不足时保留旧选择并记录错误。read(collection, path) 定位当前版本；固定版本地址直接读取该版本，找不到返回 404，不回源。restart 重新验证本地版本，损坏版本不能服务。retain(n) 只淘汰非当前历史版本。

操作原则：同步完成后，即使发布来源或生产进程停止，读取仍获得本地已验证内容。HTTP GET/HEAD、ETag、Range 是此能力的协议映射。

## 应用协调

概念之间不互相导入业务实现；应用编排组合动作。实现是普通 Node.js 函数与持久文件，不声称具备通用同步引擎或 exactly-once 外部效果。以下规则是设计记法：

```text
sync ArchiveCapture
when Capturing/finish => [artifact, report]
then Archiving/create [artifact, report]

sync AutoPublishQualified
when Archiving/finalize => [version, qualified: true, expectedRevision]
then Publishing/select [version, expectedRevision, operationId]

sync ApprovePartial
when Web/approve => [collection, version, reason, expectedRevision, operationId]
where token has publish permission; candidate ready; nonempty reason
then Publishing/select [version, expectedRevision, operationId, approval: reason]

sync RefreshReplica
when Timer/tick => [consumer]
where consumer configured collections; each collection bound separately
then Replicating/sync [collection]

sync ReadPublished
when HTTP/request => [method: GET|HEAD, collection, path]
then Serving/read [collection, path]
```

入口响应：提交任务 202，创建候选 201，读取/完成/发布成功 200；输入错误 400、无令牌 401、无权限 403、不存在 404、冲突 409、超限 413、内容校验或缺口批准问题 422、空间不足 507。自动发布失败保留 ready 候选并返回 publishError，采集成功不冒充发布成功。

只读查询不触发发布。多个集合并行语义互不覆盖；当前实现每进程写任务串行，单次 HTTP 采集内部有可配置并发。

## 交付仓布局

两种适配器使用完全相同的键空间：

```text
objects/<sha256>                       内容对象
manifests/<version>.json               完整逻辑清单
releases/<collection>/<revision>-<operationId>.json
heads/<collection>.json                唯一发布生效指针
```

清单包含 schema、collection、version、createdAt、source、complete、issues 和 files[{path,sha256,bytes,type}]。发布记录包含清单摘要、修订、版本、操作、前一记录键与批准原因。

对象和清单先持久化，发布记录再写入，最后条件更新 heads。S3 用 If-None-Match/If-Match，冲突不盲重试；参见 [AWS 条件写入协议](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)。本地目录使用单生产进程锁和同文件系统原子替换，不提供多机写锁保证。交付根目录、生产与消费数据目录由可信运维用户管理，不可由上传者直接写入。

消费端使用独立数据目录，下载到 staging，逐文件验证，再提交版本目录并原子替换 current.json。访问稳定地址先跳转到固定版本 URL，资源使用相对路径，避免一次页面加载跨版本混用。文件服务从已验证清单查找，不把用户路径直接映射到任意磁盘文件。

发布生效前中断只留下未引用数据；生效后客户端丢失响应可用相同 operationId 重试。消费中断时 current.json 仍指向旧版或新完整版本，重启清理 staging 并重新校验。两个进程的锁与本地目录相互独立。

## 保留与局限

消费端按成功激活修订保留最近 N 个版本；回滚版本也计为最近激活。归档和交付仓暂不自动清理共享对象。默认文件上限 20 MiB、逻辑版本上限 250 MiB，可调整；消费端上限需与生产端匹配。大视频需显式提高限额，本版有界缓冲单对象，不宣称任意大小流式采集。

静态内容检查不覆盖任意脚本运行时行为。程序提交目录应使用可迁移的相对资源路径；根绝对路径或外部静态依赖会使候选不合格。浏览器模式不构成网络沙箱，私网访问控制仍需部署层约束。跨消费节点是最终一致，30 秒轮询再加下载时间；不提供全节点同时切换。
