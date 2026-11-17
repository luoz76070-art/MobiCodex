# Design

KeepAwake owns only the OS inhibitor and grace timer, not task lifecycle. A small
monitor reconciles LiveTurnController.listActiveTurns, DesktopControl's existing
stream snapshots, ClaudeCliRuntime's run snapshots, OpenCode's active endpoint,
DeepSeek's existing native status and Claude bridge's registered active turns.
Poll read-only Agent counts every two seconds independently of phone subscriptions;
listen to live/desktop snapshots and Claude CLI runtime publications for immediate reconciliation. Deduplicate Codex
live/desktop by thread. Never inspect CC Desk or launch an Agent for observation.
DeepSeek adds one count-only authenticated bridge route because its session list
has no activity and opening history/SSE would read content. Older bridge failure
is surfaced as a source warning; previously observed running counts are retained
until a successful refresh; observed active snapshots remain a fallback for older bridges. Diagnostics contain only stable source IDs and counts.

Process creation is injected. Linux helper exits on stdin EOF, including gateway
crash. Grace and poll timers are unref'ed. Stop cancels monitoring first, invalidates
pending starts/reads and releases the owned inhibitor before adapter shutdown.
Only additive optional fields reach the connection card; old gateways stay usable.
