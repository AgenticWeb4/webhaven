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
