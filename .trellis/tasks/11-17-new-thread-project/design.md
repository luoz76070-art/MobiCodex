# Design

A relay ProjectCatalog owns discovery and canonical directory matching. GET /api/projects returns { projects: [{ name, cwd }] }. Explicit cwd is checked inside the submission callback, before LiveTurnController is invoked. Desktop state is optional and malformed shapes are ignored.

A scoped new-thread runtime field stores cwd with durable input. A shared project picker reads the API and gates sidebar, shortcut, share, text, voice and attachment entry points. Selection is a draft action; it never sends a message automatically. Existing conversation sends retain their current cwd behavior. Unknown project errors reopen selection without losing text or attachments.

Keep changes in relay catalog/routes, mobile new-thread orchestration/picker/cache/styles, and isolated tests. No deployment or unrelated control changes.
