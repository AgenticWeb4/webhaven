# Contributing

Use Node.js 24 or newer, run `npm ci`, then `npm run check` and `npm test`.

Keep Producer and Consumer independently runnable. Changes to manifests, release records or failure recovery must include a protocol update and a regression test through the affected interface. Test S3 changes against an isolated compatible service with conditional-write support.

Use reserved example domains and local fixtures in examples. Keep credentials, captured third-party content and machine-specific output out of commits. Benchmark claims must identify workload, response size, concurrency, environment and error counts; a routing microbenchmark is not end-to-end service throughput.

Submit focused pull requests explaining the behavior change and validation performed. Contributions are licensed under Apache-2.0.
