# EminiPlayer Playwright Module — Design

**Date:** 2026-08-05
**Status:** Approved
**Scope:** Automate authenticated navigation to https://www.eminiplayer.net/archive.aspx from the NestJS backend. No content parsing yet — this is the foundation a future parser will build on.

## Goal

An injectable NestJS service that, when called, launches a Playwright-driven Chromium browser, logs in to eminiplayer.net when needed, lands on the archive page, verifies it got there, and returns proof (page metadata plus a screenshot). Other modules will later call into it to parse archive content.

## Architecture

New feature module at `backend/src/eminiplayer/`, following the backend's module-per-feature layout:

```
backend/src/eminiplayer/
  eminiplayer.module.ts        # EminiplayerModule — exports EminiplayerService
  playwright.service.ts        # Generic browser lifecycle (internal provider)
  eminiplayer.service.ts       # Site-specific login + navigation
  *.spec.ts                    # Unit tests alongside, matching repo convention
```

Two layers, one module:

- **`PlaywrightService`** — owns the Chromium browser, context, and one shared page. Lazily launches on first use, reuses everything across calls, closes it all in `onModuleDestroy()`. Knows nothing about eminiplayer.net. **Concurrency contract:** the page is a single mutable browser tab, so all access goes through `withPage(fn)`, which serializes callbacks on an internal promise-chain mutex — exactly one callback uses the page at a time. This also makes the lazy launch single-flight (concurrent first calls launch one browser, not two). **Crash recovery:** if the Chromium process has died (`browser.isConnected()` is false), `withPage` drops the stale browser/context/page references and relaunches instead of failing forever. **Ownership:** `PlaywrightService` is module-private (not exported from `EminiplayerModule`); the page has a single owner, `EminiplayerService`.
- **`EminiplayerService`** — exposes `openArchivePage()`. Runs the site's login flow and archive navigation inside one `withPage()` callback, verifies arrival on the archive page. This is where future parsing methods will live — each must also run inside `withPage()` and re-assert the page URL rather than assume where the page was left.

No controller, no cron — service only. Consumers inject `EminiplayerService`. `EminiplayerModule` is registered in `AppModule` (approved scope: it lets the manual smoke test resolve the service from the app context); future consumer modules import `EminiplayerModule` for the exported service.

## Dependencies

- Add `playwright` to `backend/package.json` dependencies.
- Browser binaries installed via `npx playwright install chromium` (Chromium only). Document in `backend/README.md`.

## Configuration

Extend `backend/src/config/configuration.ts` with an `eminiplayer` namespace:

| Key | Env var | Default |
|---|---|---|
| `username` | `EMINIPLAYER_USERNAME` | undefined |
| `password` | `EMINIPLAYER_PASSWORD` | undefined |
| `headless` | `EMINIPLAYER_HEADLESS` | `true` |
| `screenshotDir` | `EMINIPLAYER_SCREENSHOT_DIR` | `<backend>/artifacts/eminiplayer`, anchored via `__dirname` like `benchmark.repoRoot` — never cwd, so screenshots of authenticated content can't land outside the git-ignored dir |

Credentials live only in env vars / `.env` (git-ignored) — never in code or committed files. `openArchivePage()` throws a descriptive error at call time if credentials are missing and login is required.

## `openArchivePage()` flow

> **Site behavior (verified 2026-08-05):** this supersedes the spec's original "redirected to a login form" assumption, which was disproven against the live site. `archive.aspx` returns HTTP 200 even when logged out — no redirect, no inline form. The logged-out signal is the nav anchor `a#ctl00_aLogin` without `logoff` in its href (amended 2026-08-06 by live verification: the anchor `#ctl00_aLogin` exists in BOTH auth states — "Member Login" → `/login.aspx` logged out, "Log off" → `/login.aspx?logoff` logged in — and a members-only "Change password" link also points at `login.aspx`, which is why the id anchor matters; the original `a[href*="login.aspx"]` matched while authenticated. Shipped selector: `a#ctl00_aLogin:not([href*="logoff"])`, see `backend/src/eminiplayer/eminiplayer.constants.ts`), and logging in requires an explicit navigation to `login.aspx` (ASP.NET WebForms form: `#ctl00_cphBody_Login1_UserName`, `#ctl00_cphBody_Login1_Password`, submit `#ctl00_cphBody_Login1_LoginButton`).

The whole flow runs as one `withPage()` callback (single-flight; see Architecture):

1. Acquire the shared page (lazily launching Chromium if needed).
2. `page.goto('https://www.eminiplayer.net/archive.aspx')` with the 30s default timeout.
3. **Login detection:** if the login nav link is present, the session is logged out — navigate to `login.aspx`, fill credentials from config, submit, wait for the post-back redirect away from `login.aspx`, then `goto` archive.aspx again. If the login link is still present after that, throw a descriptive error (bad credentials).
4. **Verification:** parse the final URL structurally — hostname must be `eminiplayer.net` (or a subdomain) and pathname exactly `/archive.aspx`. A substring check is not acceptable: it would pass on `login.aspx?ReturnUrl=%2farchive.aspx`, the URL a failed forms-auth flow produces. Otherwise throw an error naming the failure.
5. Screenshot the page to `<screenshotDir>/archive-<ISO timestamp>.png` (directory created on demand).
6. Return `{ url, title, screenshotPath }`. The underlying `Page` stays open in the service for future parsing calls; a follow-up `openArchivePage()` reuses the authenticated session.

## Error handling

- Navigation/login steps use Playwright's 30s default timeouts; failures throw `Error` with step context (e.g. "eminiplayer login failed: still on login page after submit").
- No retry logic yet (YAGNI — add when parsing/scheduling exists).
- `onModuleDestroy()` closes context and browser defensively (swallowing close errors).

## Testing

- Unit tests with mocked Playwright objects (jest mocks, same style as existing backend specs):
  - already-authenticated path (no login link → straight to archive)
  - login path (login link detected → credentials filled on login.aspx → lands on archive)
  - failed login (login link still present after submit → descriptive throw)
  - missing credentials when login required → descriptive throw
  - forms-auth redirect URL (`login.aspx?ReturnUrl=%2farchive.aspx`) → descriptive throw
  - navigation failures rethrown with step context
  - concurrent calls serialize (no interleaved navigation, single browser launch)
  - browser death (`isConnected()` false) → relaunch instead of failing forever
  - module destroy closes browser
- No live e2e against the real site in CI (external, credentialed, rate-limit risk). Manual verification: run once locally and inspect the returned metadata + screenshot.

## Out of scope

- Parsing any archive content.
- HTTP endpoints, scheduling, retries, session persistence to disk.
