# WebHaven

**发布内容，独立提供经过校验的本地副本。**

[English](README.md) · [使用指南](docs/GUIDE.zh-CN.md) · [技术架构](docs/ARCHITECTURE.md) · [性能与验证](docs/VALIDATION.md)

Publisher 从网址、来源 S3 或外部程序获取内容，归档并发布版本。
Mirror 将版本同步到本地，校验完成后提供 HTTP 访问。Publisher 或交付仓停止，不影响已经保存的内容。

## 技术架构

[![WebHaven 技术架构：Publisher 发布版本，Mirror 校验并提供本地访问。](docs/images/architecture.svg)](docs/images/architecture.svg)

[图表源文件](docs/architecture.mmd)

两端可部署到不同机器。Mirror 的访问请求只读取本地已验证版本，不调用 Publisher 或源站。

## 性能

重构后实测：本地 HTTP、Apple M5、32 并发，每组 3 轮的中位数。

| 响应体 | Mirror RPS |      P99 |
| ------ | ---------: | -------: |
| 1 KiB  |     20,421 |  2.50 ms |
| 64 KiB |     14,225 |  5.03 ms |
| 1 MiB  |  **1,937** | 29.18 ms |

27 轮共 820,833 次请求，0 错误。[测量条件与当前验证](docs/VALIDATION.md)。Nginx/QuickJS 路由微基准单独列出，不作为完整 Mirror 的吞吐。

下载链路：32 个、每个 1 MiB 的资源，8 路下载并发，采集归档 **79.36 MiB/s**，到 Mirror 激活 **803 ms**。这是受控本地源站三轮测试的中位数。

## 快速开始

需要 Node.js 24+，从仓库根目录执行：

```sh
npm ci
cp .env.example .env
```

将 `.env` 中 `PUBLISHER_TOKENS` 和 `WEBHAVEN_TOKEN` 的占位值替换为同一个新令牌，然后分别打开三个终端：

```sh
npm run publisher
npm run mirror
npm run cli -- submit --collection docs --directory examples/site
```

默认每 30 秒同步一次。同步完成后打开 <http://127.0.0.1:8080/sites/docs/>。
默认交付仓是本地目录，来源与 S3 配置见[使用指南](docs/GUIDE.zh-CN.md)。

## 文档

[使用与配置](docs/GUIDE.zh-CN.md) · [发布协议](docs/design/PROTOCOL.md) · [意图编程](docs/CODE_STYLE.md) · [命名迁移](docs/MIGRATION.md) · [参与贡献](CONTRIBUTING.md)

当前为 0.1.0 原型，服务公开静态内容。动态网站完整回放、登录、交易和多租户隔离不在当前范围。

[Apache-2.0](LICENSE)。
