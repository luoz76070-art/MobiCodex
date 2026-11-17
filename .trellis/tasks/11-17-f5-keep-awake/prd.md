# F5: gateway idle sleep prevention

Any local Agent running a turn holds an idle-sleep inhibitor. After all turns finish,
release after 60 seconds unless another turn starts. CC Desk is remote and excluded.
Default keepAwake=true; false never spawns. macOS uses caffeinate -i -w with the
gateway PID; Linux uses systemd-inhibit --what=idle and an owned stdin-bound helper.
Unsupported systems and failures must remain visible without affecting the gateway.
Diagnostics and the existing phone connection card show state and per-Agent counts.
No offline notifications, lid-close override, real model work or real inhibitor tests.

Acceptance: injected process/clock tests cover grace, new work, multiple Agents,
disabled/unsupported/error/stop and command selection; source and phone wiring tests;
mobile, relay, Claude CLI, typecheck, lint and production build pass; task branch PR.
