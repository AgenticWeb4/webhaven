# 中文注释与意图先行

本项目保留英文标识符，源码注释使用中文。注释与实现一起维护，优先解释职责、约束、原因和失败结果。

## 先写意图，再实现复杂逻辑

新增或修改含状态转换、持久化顺序、并发、恢复、资源重写或多分支策略的逻辑时：

1. 先在目标函数上方写中文意图：要实现什么、按什么顺序、哪些约束必须保持、失败留下什么状态。
2. 再按意图编写主流程，使用能表达领域动作的名称，把机制放入职责明确的实现步骤。
3. 对照实现修订说明，检查每项意图都有对应代码，提交点与失败边界一致。

```js
/**
 * 意图：可重试地选择一个就绪版本，同时保留冲突时的旧选择。
 * 步骤：验证请求 → 查找已提交重放 → 比较修订 → 检查资格 → 交付内容 → 条件提交。
 * 约束：对象和清单先就绪，发布头最后条件更新；重试复用 operationId。
 */
async publishVersion(collection, version, request = {}) {
  // 实现按上述意图展开；完整流程见 apps/publisher/src/publish.js。
}
```

## 注释覆盖要求

- 每个运行时模块说明职责、边界和必要的阅读前提。
- 对外函数、类与公共方法说明用途、关键输入约束、返回结果与调用方需要知道的失败方式；采用中文 JSDoc 或简短契约说明。
- 复杂方法先列意图与步骤；内部注释解释重试、提交点、回滚、字节校验、兼容与清理顺序。
- 简单私有步骤保持简短；测试说明验收场景，性能脚本说明统计口径与限制。
- 注释描述实际保证：进程内串行不等于分布式锁，静态依赖检查不等于任意动态网站完整回放。

以正确、可维护为完备标准，避免逐行复述语法。保持公开协议与已有行为；只有明确需要改变行为时，才单独说明并验证变化。简单转发不因增加说明而额外抽层。

## 提交前核对

核对注释与实际分支、返回值、异常及持久化顺序一致。执行语法检查和既有行为测试。纯注释整理可比较变更前后的语法树，确认可执行结构未改变；不把这种检查当成事实正确性的替代。

---

# Intent-first code

Make the purpose visible before the mechanism. Keep the runtime behavior and failure rules in the protocol unchanged.

## Name the result or the decision

Use `publishVersion`, `requirePublishableCandidate`, `prepareVersion` and `activateVersion`. Use `candidate`, `release`, `manifest`, `collection` and `file` for domain values. Avoid abbreviated domain variables such as `c`, `r`, `m` and `f` in application code. Short loop counters remain appropriate.

Keep one term for each concept. Publisher owns capture, archive and publication. Mirror owns synchronization and local access. A release selects a version; a version describes files. These terms are not interchangeable.

## Read the main flow as a sequence of intentions

The public operation should show its decisions and effects at one level:

```js
const candidate = await this.#requirePublishableCandidate(collection, version, approval);
await this.#stageVersionForDelivery(candidate);
const release = this.#describeRelease(collection, version, candidate, current, request);
await this.#commitRelease(release, current.etag);
return release;
```

Keep byte checks, filesystem operations and storage requests inside the relevant step. Keep helper methods private when callers do not need them. Extract a helper for a coherent decision or effect, not to hide an arbitrary block or forward a call unchanged.

## Make failure and ordering visible

Name predicates and refusal checks. Use early returns for unchanged, missing and replayed results. Keep the publication commit and local activation explicit. Do not move either before content verification.

Use comments for reasons the code cannot express: the commit point, rollback verification, compatibility or recovery constraints. Avoid comments that repeat the next statement.

## Change through the interface

Keep tests focused on behavior: replay, conflict, failure preservation, offline access, and protocol compatibility. Do not couple tests to the number of helpers or their private names. Test a named phase directly only when it is an actual public interface.

Read `apps/publisher/src/main.js`, then `captures.js` and `publish.js`. Read `apps/mirror/src/main.js`, then `mirror.js` and `http.js`. This order follows the running application.
