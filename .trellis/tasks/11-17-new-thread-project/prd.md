# New Codex threads use the chosen project (#31)

Deliver a merged, canonical, existing-directory project catalog from all thread pages, optional desktop state, and the configured default. Validate explicit new-thread cwd against that catalog before starting a turn; omitted cwd remains compatible. All phone new-thread entry points must select and persist a project, show it in the header, send it, and preserve drafts on unknown_project.

Acceptance: isolated catalog/admission tests and actual phone handler tests; mobile suite, related relay tests, typecheck, lint and build pass. Use only lane Git and GitHub wrappers, work on codex/new-thread-project, open the requested PR. No real sessions, model tasks, personal paths or identities in committed fixtures or delivery metadata.
