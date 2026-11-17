# Implementation and verification

1. Add project discovery, canonical admission and relay route tests.
2. Add durable draft project, picker and shared entry guards; add handler/cache/component tests.
3. Run mobile tests, related relay tests, typecheck, lint and production build. Inspect project picker with a synthetic browser fixture.
4. Review privacy and scoped diff, commit with neutral identity, push the requested branch, create and attach PR with Fixes #31.

Validation completed:
- Mobile suite: 567 passed, including 14 project-entry, picker-lifecycle, draft-cache and error-recovery checks.
- Related relay suites: 89 passed (projects, modelSwitch, threadList, correctness, availability, desktopNativeControl).
- Typecheck and lint passed. Production build passed with the existing large-chunk advisory.
- Synthetic UI fixture API assertions passed. The fixture supports known, unknown, empty and unavailable project catalogs through `/fixture/new-thread-project?mode=ready|unknown|empty|unavailable`.
- Browser verification is incomplete: the headless browser exited during startup and the in-app browser denied permission to access the loopback fixture. No real desktop session, model task or Android device was exercised.
