# 仅提供隔离压测客户端 wrk，不承载 WebHaven 应用。
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update && apt-get install -y --no-install-recommends wrk ca-certificates && rm -rf /var/lib/apt/lists/*
