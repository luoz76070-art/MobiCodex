# GitHub Source Package

This repository contains the source tree. Android builds are published as GitHub Releases, not committed.

Included:
- TypeScript source for the mobile app and relay.
- Windows Manager/Watchdog source and PowerShell scripts under `scripts/`.
- Android native project shell and resources.
- Stable documentation; the 10-20 to 11-14 process history is summarised in `docs/history.md`.

Archived on 2026-11-18 (#41) and kept at tag `archive/pre-cleanup-2026-11`: the Kelivo 0.1.x source and integration bridge with its AGPL license, the generated protocol typings, the versioned preview delivery that used to live in `releases/android/kelivo-preview/` (its APKs, source archives and SHA256 files are also attached to the 0.1.5–0.1.11 GitHub Releases), the process audits and the finished plans.

Excluded:
- `node_modules` and nested package-manager output.
- Other APK/EXE files, build caches and local packaged installs.
- `.env.local`, relay pid files, logs, upload data, and personal paths.
- Development smoke logs and local conversation notes.

Before publishing, run the checks in `docs/github-public-release-plan.md` and review every credential-like match manually.
