# Implementation and verification

1. Add isolated inhibitor lifecycle and activity monitor with injected ports.
2. Expose existing authoritative counts, wire config/diagnostics and connection row.
3. Add synthetic process/clock/source/component regressions and CHANGELOG entry.
4. Run requested tests, relevant adapter/diagnostics/managed gateway regressions,
   typecheck, lint and build sequentially where dist is rebuilt; self-review changes.
5. Audit diff and commit metadata, commit task branch, push with retries and open PR.

Browser origin approval was declined earlier; use component tests and report that
actual device sleep behavior and phone visual acceptance remain manual checks.
