# WebHaven

**Capture, archive and publish content. Serve verified local versions independently.**

WebHaven 是独立开源的内容归档与访问项目。生产端获取网址、S3 前缀或外部程序提交的文件，归档并发布不可变版本；消费端同步并验证到本地，通过 HTTP 提供静态浏览与下载。生产端或交付仓停止，不影响消费端已保存内容的读取。

当前为 0.1.0 原型，采用两个独立子项目和进程；不承诺任意动态网站的完整离线复现。

```text
网址 / 来源 S3 / 外部程序
          ↓
 apps/producer：采集 → 归档 → 检查 → 发布
          ↓
 交付仓：本地目录 或 S3 兼容存储
          ↓
 apps/consumer：同步 → SHA-256 校验 → 整体切换 → HTTP 访问
```

## 快速开始

需要 Node.js 24+。从仓库根目录运行：

```sh
npm ci
cp .env.example .env
# 编辑 .env，替换 PRODUCER_TOKENS 和 WEBHAVEN_TOKEN 中的占位令牌。
npm run producer
# 另开终端
npm run consumer
# 第三个终端提交自定义程序输出的目录
npm run cli -- submit --collection docs --directory examples/site
```

默认自动发布合格版本，消费端默认每 30 秒同步。打开 <http://127.0.0.1:8080/sites/docs/>。

外部程序自行生成目录，不由 WebHaven 执行；`submit` 命令遍历常规文件、计算清单并通过生产端 API 上传。拒绝符号链接、隐藏路径、路径穿越与冲突路径。上传相同摘要复用对象；每个版本的清单仍完整。

```sh
# 主动获取网页入口及已观察到的静态依赖；目标由参数提供，没有默认网站。
npm run cli -- capture --collection docs --url https://example.com/
# 浏览器模式，首次使用前安装 Chromium
npx playwright install --with-deps chromium
npm run cli -- capture --collection docs --url https://example.com/ --browser
# 主动读取配置的来源桶/前缀
npm run cli -- capture --collection docs --s3
# 仅归档，稍后人工发布
npm run cli -- submit --collection docs --directory examples/site --no-publish
npm run cli -- head --collection docs
npm run cli -- publish --collection docs --version VERSION_ID --expected-revision 1 --operation-id my-release-2
```

采集命令返回任务 ID，使用带令牌的 `GET /v1/collections/docs/captures/ID` 查询。网页模式首版范围是一个入口及观察到的静态依赖；直接文件 URL 保存为清单中给出的文件路径，超出页面导航范围的链接返回不可用；动态拼接请求、登录、交易、实时 API 和视频转码不在范围内。浏览器正文检查不是验证码识别保证，实际网页仍需人工检查。

## 交付仓配置

**本地目录**：默认 `DELIVERY_DRIVER=local`，配置 `DELIVERY_DIR`。同机两个进程共用目录；跨机器可挂载相同交付目录，但本地适配器的写入侧限单个生产进程与可靠本地文件系统，不宣称网络文件系统的锁或断电语义。消费端挂载只读，自有数据目录独立。每个进程的数据目录不可共用。

**S3 兼容存储**：设置 `DELIVERY_DRIVER=s3`、`S3_BUCKET`，可选 `S3_ENDPOINT`、`S3_PREFIX`、`S3_REGION`。AWS SDK 使用该进程的标准凭证链。生产端需要交付前缀 GetObject/PutObject，消费端仅需 GetObject；两端分别配置凭证。兼容服务必须支持 PutObject 的 If-Match/If-None-Match 条件写，否则不支持安全发布。

来源 S3 与交付仓是两回事：`SOURCE_S3_BUCKET/PREFIX/ENDPOINT/REGION` 及独立 `SOURCE_S3_ACCESS_KEY_ID/SECRET_ACCESS_KEY` 配置来源。来源凭证只读，即使交付仓用本地目录也能采集 S3。S3 列举不是跨对象事务快照；采集期间来源应保持稳定，严格一致性需来源先生成不可变清单。

Docker Compose 提供本地交付模式：配置 `.env` 后 `docker compose up --build -d`。生产和消费可分别 `docker compose up producer` / `docker compose up consumer`；S3 模式使用 `docker compose -f compose.yaml -f compose.s3.yaml up --build -d`，配置单独的 PRODUCER_AWS_* 和 CONSUMER_AWS_* 凭证。跨机器 S3 部署使用独立环境文件和存储凭证，不把生产端令牌传给消费端。默认 Docker 镜像支持 HTTP 和 S3；浏览器模式需另装 Chromium 及系统依赖。消费端无须浏览器。

## 发布、失败与回滚

- `complete=true` 且缺口为空、全部声明对象校验通过，才自动发布。这是“声明范围完整”，不是互联网全站完整性证明。
- `--partial` 表示不完整结果，默认不自动发布；人工发布必须通过 publish 权限并给出 `--approval "接受缺口的原因"`。
- 不完整提交继承基础版本中未提交的文件，不推断删除；完整清单中缺席的文件在新版本中删除，旧归档保留。
- 发布指定 expectedRevision，旧任务不能覆盖新修订；同一 operationId 重试返回已提交结果，回滚也是修订号递增的新发布。
- 发布对象与清单先完成，条件写发布指针是生效点；中途失败不影响旧指针，未引用对象暂保留。
- 消费端校验摘要和字节数，在本地完整生成版本后原子替换 current.json。稳定地址跳转到版本路径，避免加载中混入新旧资源。当前版本默认保留最近 3 个成功激活版本，可配置。
- 空间不足停止更新，保留当前版本。生产端归档和交付仓首版不自动删除，需监测容量；消费端独立清理历史版本。被清理版本的旧链接会返回 404。
- 重启时排队采集重新领取，运行中断任务标记 interrupted，重新提交即可。消费端离线启动重新校验本地版本后服务。原子 rename 与 fsync 不等于存储损坏或所有文件系统下的断电保证。

## 权限与访问

生产端默认仅监听 localhost，所有内容操作需要 Bearer 令牌；`PRODUCER_AUTH_FILE` 可指向私有 JSON 文件，格式同 `.env.example` 的令牌数组。令牌按集合区分 `submit` 和 `publish`；合格版本自动发布属于生产策略，submit 可触发，部分版本人工批准必须有 publish 权限。公网部署应在生产端前配置 TLS 和网络访问控制。

消费端只提供公开 GET/HEAD 与健康检查，不执行上传程序。支持 ETag、单段 Range、HEAD、不可变版本缓存头。镜像与管理进程使用不同 origin；镜像 CSP 禁止实时网络接口、表单提交、外部框架等。各集合内容默认公开；不同不可信租户需要额外 origin 隔离，本项目首版不是多租户安全沙箱。

## 验证

```sh
npm run check
npm test
npm audit --omit=dev
npm run bench
# 默认 3 轮，响应体 1 KiB / 64 KiB / 1 MiB，并发 1 / 32 / 128
DURATION=3 REPEATS=3 npm run bench
```

测试覆盖发布冲突、重复提交、部分版本批准、回滚、篡改/缺失对象、磁盘不足、生产与消费独立进程、源站停止、离线重启、Range 与权限。S3 集成测试默认跳过，需要 `TEST_S3_ENDPOINT` 和测试凭证；它会创建专用随机测试桶，仅用于隔离测试环境。

[性能与验证说明](docs/VALIDATION.md) 区分本地测试和真实云端验证。[交付协议与概念设计](docs/design/PROTOCOL.md) 记录状态所有权和提交顺序。

## 项目结构与许可

`apps/producer` 和 `apps/consumer` 可独立启动；`packages/core` 仅共享文件清单、校验、存储协议与工具。Consumer 不导入 Producer，也不在访问请求中调用 Producer 或源站。

Apache-2.0，见 [LICENSE](LICENSE)。
