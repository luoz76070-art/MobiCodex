# Verification

- `corepack pnpm test:mobile`: 595 passed, including 5 actual connection-card/model tests.
- `corepack pnpm test:claude-cli`: 39 passed, including running-turn vs retained-process coverage.
- Relevant isolated Relay suite: 337 passed across keep-awake (15), diagnostics,
  managed gateway, Agent gateway, DeepSeek live/history, OpenCode, Claude bridge,
  attention, desktop control/approvals/recovery, availability, correctness and model switching.
- `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm build`: passed.
- `corepack pnpm build:plugin`: passed; rebuilt independent bundle diagnostics and
  managed-gateway regression also passed.
- No real inhibitor, model task, user session read or deployment was used.
- Existing production build warning: mobile main chunk remains above 500 kB.

# Boundaries

Actual OS sleep behavior and phone visual acceptance remain manual: local browser
origin approval was declined earlier, so no alternate browser route was used.
Desktop coverage is limited to running threads already observed by desktop control;
the monitor keeps their existing read-only follow until completion. Unobservable
threads are not loaded. Bridge status is polled every two seconds; read failures
retain the last active count and show an unavailable-source notice, so prolonged
bridge failure can keep the inhibitor held longer. Full unsubscribed DeepSeek
coverage needs the updated count-only bridge endpoint; older bridges still use
available snapshots and display the partial-observation notice.
