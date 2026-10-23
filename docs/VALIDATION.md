# 验证与性能记录

日期：2026-10-23。当前为原型验收，不是生产容量承诺。

## 功能

完整启用 Chromium 和隔离 MinIO 后，21 项测试通过、0 失败、0 跳过。默认 `npm test` 会跳过需要外部 Chromium/测试 S3 的两项；它们已在本次验收中显式启用。

覆盖：主动 HTTP 与浏览器采集、被动 API/CLI 提交、静态依赖缺口、完整/部分清单的删除规则、路径与私网校验、令牌拒绝、版本冲突、人工批准、幂等重放、回滚、提交前故障与提交后丢失响应、缺失/篡改对象、磁盘不足、历史保留、离线重启、Range/HEAD/ETag。浏览器测试关闭源站后检查最终正文、实际脚本运行和样式，并拒绝任何外部请求。

S3 使用本机独立 MinIO 容器，版本 RELEASE.2025-09-07T16-13-09Z。验证来源前缀采集、SDK 签名请求、条件创建/更新冲突、消费端同步，以及服务端 readonly 账号可读但 PutObject 返回 403。没有使用或验证任何真实云账号，其他兼容供应商需在部署环境复测条件写。

两个非 root Docker 镜像分别构建并运行，Node v24.22.0；通过 CLI 上传示例、只读挂载交付目录，并在停止 Producer 后继续读取 Consumer。镜像默认没有 Chromium，浏览器功能在宿主测试环境验证。

复现可选测试（变量使用自己的隔离测试配置）：

```sh
npx playwright install chromium
ALLOW_PRIVATE_NETWORK=true RUN_BROWSER_TESTS=true npm test
TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
  AWS_ACCESS_KEY_ID=YOUR_TEST_KEY AWS_SECRET_ACCESS_KEY=YOUR_TEST_SECRET \
  TEST_S3_READ_ONLY_ACCESS_KEY_ID=YOUR_READER_KEY \
  TEST_S3_READ_ONLY_SECRET_ACCESS_KEY=YOUR_READER_SECRET \
  node --test test/s3.test.js
```

`ALLOW_PRIVATE_NETWORK=true` 只用于受控 localhost 夹具，不是公开部署推荐配置。运行时依赖审计结果为 0 个已知漏洞。

## 完整 Consumer：本地目录与 HTTP

Apple M5、arm64、10 个逻辑 CPU、24 GiB 内存、macOS、Node v26.7.0。每组 3 秒、重复 3 轮；并发 1/32/128，体积 1 KiB/64 KiB/1 MiB，共 27 轮。合计 506,450 次成功请求，0 错误。

下表为 32 并发时三轮中位数，P99 列是三轮各自 P99 的中位数，不是合并分位数。

| 响应体 |    RPS |      P99 |
| ------ | -----: | -------: |
| 1 KiB  | 13,222 |  4.81 ms |
| 64 KiB |  8,842 | 10.38 ms |
| 1 MiB  |  1,573 | 44.67 ms |

本测试负载线程与 HTTP 服务在同一个 OS 进程，记录中的 CPU/RSS 包含二者，不可当作独立服务端资源消耗。没有单独的预热轮，使用 keep-alive、本地回环与操作系统页缓存；不能据此推导公网吞吐或比较其他机器。1 MiB 明确为 1,048,576 字节。

## 主动下载、归档、发布与同步

受控 localhost 源站，每次 32 个二进制资源和一个 HTML 入口；三种资源大小、三种下载并发，每组重复三轮，27 次均无缺口。下面是每资源 1 MiB 时中位数。

| 下载并发 | 采集＋归档的有效载荷速度 | 到 Consumer 激活的端到端时间 |
| -------- | -----------------------: | ---------------------------: |
| 1        |              72.98 MiB/s |                       874 ms |
| 8        |              76.07 MiB/s |                       831 ms |
| 32       |              73.96 MiB/s |                       839 ms |

采集速度包含依赖发现、下载、内容归档、文件校验和持久写入；端到端额外包含发布和 Consumer 本地复制/激活，不含定时轮询等待。重复发布会复用已存在交付对象，首轮与后续发布成本不同。来源为受控夹具，没有向第三方网站压测。这里只是单次采集的内部下载并发，未声称可并发执行大量采集任务。

## Nginx / QuickJS 路由微基准

同一份二进制响应、相同状态和响应头；Nginx 4 worker、4 CPU/256 MiB 限额，wrk 客户端 2 CPU/256 MiB，32 并发。每轮预热 1 秒、测量 3 秒，各 3 轮。Native 直接文件发送；QuickJS 仅 internalRedirect 到同一个文件路径。全部测量轮无状态/连接/读写/超时错误。

| 响应体 | Nginx 原生 RPS | QuickJS 路由 RPS |
| ------ | -------------: | ---------------: |
| 1 KiB  |        118,264 |          101,392 |
| 64 KiB |         68,893 |           64,325 |
| 1 MiB  |         12,646 |           11,370 |

这是路由开销微基准，**不是 WebHaven Consumer 的实测吞吐**；当前默认 Consumer 是独立 Node.js 进程，尚未集成 Nginx 数据路径。这组结果支持后续将大资源保持在 Nginx 原生发送路径的方向，不证明已交付相同容量。

测量在共享开发机器和 Docker 虚拟环境，其他活动未隔离，各轮有波动；不把中位数差异解释为稳定的生产增益。复现：先 `docker build -t webhaven-bench bench`，再 `python3 bench/nginx.py`；使用本机已有 Nginx 镜像，脚本创建并清理隔离网络及容器。

## 记录与限制

[机器可读摘要](benchmark-summary.json) 保留测量环境、轮数、统计口径与限制。脚本原始输出写到本地 `results/`，包含各轮延迟、错误、CPU/RSS、阶段耗时与镜像身份；不提交采集内容、私有凭证或本机临时目录。

本次没有重测以前的第三方网站；开源项目没有默认目标网站。任意网站的交互完整性、来源变化时跨对象一致性、分布式同时切换、对象仓自动回收、断电和磁盘损坏容灾都不在当前验证结论内。
