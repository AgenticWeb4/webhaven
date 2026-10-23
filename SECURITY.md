# Security

Publisher is a trusted administrative endpoint. Keep it on a private network or behind authenticated TLS, use per-collection scoped tokens, and give Mirror read-only delivery credentials. Local data and delivery roots must be writable only by trusted operators.

Mirror serves public static content. It is separate from Publisher's origin and credentials. This prototype does not isolate mutually untrusted tenants, provide a browser network sandbox, or reconstruct authenticated applications.

Report vulnerabilities privately through the repository's security reporting channel when available. If unavailable, contact the maintainer through their public profile and request a private channel; do not publish credentials or exploit details in a public issue.
