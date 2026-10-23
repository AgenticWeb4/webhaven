function done(summary, latency, requests)
    io.write(string.format('METRICS requests=%d duration_us=%d bytes=%d p50_us=%d p95_us=%d p99_us=%d status_errors=%d connect_errors=%d read_errors=%d write_errors=%d timeouts=%d\n',
        summary.requests, summary.duration, summary.bytes, latency:percentile(50), latency:percentile(95), latency:percentile(99),
        summary.errors.status, summary.errors.connect, summary.errors.read, summary.errors.write, summary.errors.timeout))
end
