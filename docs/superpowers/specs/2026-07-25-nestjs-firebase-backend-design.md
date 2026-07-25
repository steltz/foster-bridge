# NestJS + Firebase (ADC) Connectivity Scaffold — Design

**Date:** 2026-07-25
**Status:** Approved
**Location:** new `backend/` subdirectory in this repo

## Goal

Scaffold a NestJS application under `backend/` that connects to Firebase
**Firestore** and **Firebase Storage** using **GCP Application Default
Credentials (ADC)** — explicitly *not* a service-account key file. The initial
deliverable is a *connectivity scaffold*: a minimal app that proves ADC works
end-to-end against both services, with no real domain logic yet.

## Non-Goals

- No domain features (users, uploads, business logic) in this iteration.
- No service-account JSON keys anywhere — in code, env, or committed files.
- No Firebase Auth or other Firebase products beyond Firestore + Storage.
- No live-GCP calls in CI.

## Tooling & Layout

- New `backend/` subdirectory with its own `package.json`, `pnpm-lock.yaml`,
  `tsconfig`, and standard Nest CLI layout. Shares the repo's git history.
- **NestJS** (TypeScript), Node ≥ 20, **pnpm** as the package manager.
- Firebase client layer: **`firebase-admin`** SDK (single SDK for both
  Firestore and Storage).

## Configuration (12-factor, ADC-only)

`@nestjs/config` loads environment variables. Recognized keys:

| Key | Purpose | Default |
| --- | --- | --- |
| `FIREBASE_PROJECT_ID` (fallback `GCLOUD_PROJECT`) | GCP/Firebase project | `app-foster-bridge` |
| `FIREBASE_STORAGE_BUCKET` | Storage bucket | `app-foster-bridge.firebasestorage.app` |
| `PORT` | HTTP port | `3000` |

**Credentials are never placed in code or env.** ADC is resolved by the SDK
from:

- Local dev: `gcloud auth application-default login` (writes ADC to the
  well-known path the SDK reads automatically).
- GCP runtime: the attached service identity / metadata server.

A `.env.example` documents the recognized keys and the one-time
`gcloud auth application-default login` step. `.env` is gitignored.

## Firebase Module (core wiring)

`FirebaseModule` (registered global) initializes the Admin app exactly once:

```ts
initializeApp({ projectId, storageBucket }); // NO `credential` arg → ADC
```

- Idempotent: checks `getApps()` before initializing, so it is safe under
  Nest's lifecycle and hot reload (avoids "app already exists" errors).
- Provides two injectable DI tokens:
  - `FIRESTORE` → `admin.firestore()` (`Firestore` instance)
  - `STORAGE_BUCKET` → `admin.storage().bucket()` (default bucket handle)

Consumers depend only on these tokens, never on the SDK singletons directly, so
the wiring can be mocked in unit tests.

## Endpoints

Health:

- `GET /health` — liveness. No external calls; always cheap. Returns 200.
- `GET /health/ready` — readiness / **live ADC smoke test**. Performs a trivial
  Firestore round-trip and a Storage `bucket.exists()` call, returning a
  per-dependency status object. Degrades gracefully: if one dependency fails it
  reports which one rather than throwing.

Firestore demo (`/demo/firestore`):

- `POST` — writes a document to a `demo` collection; returns the new id.
- `GET` — lists recent `demo` documents.

Storage demo (`/demo/storage`):

- `POST` — uploads a small text object under a `demo/` prefix.
- `GET` — lists objects under the `demo/` prefix.
- `GET /demo/storage/:name/url` — returns a **v4 signed URL** for an object.
  This also exercises ADC's IAM signing path (`iam.serviceAccounts.signBlob`),
  which is a distinct permission from Firestore/Storage data access.

## Error Handling

- A global exception filter maps Google API error codes
  (`permission-denied`, `not-found`, `unauthenticated`, `unauthorized`) to
  clean HTTP responses, so an ADC misconfiguration surfaces as a readable
  4xx/5xx with a helpful message instead of a raw stack trace.
- `/health/ready` catches per-dependency errors and reports status rather than
  propagating exceptions.

## Testing

- **Unit:** `FirebaseModule` provider wiring (correct tokens resolve) and the
  Firestore/Storage service logic (including signed-URL generation) with the
  `firebase-admin` SDK mocked — no network.
- **e2e:** `GET /health` returns 200 with the app booted; runs in CI with no
  live GCP access.
- **Live connectivity:** verified manually by hitting `/health/ready` after
  `gcloud auth application-default login`. Documented in `backend/README.md`;
  not part of CI.

## Deliverables

- Running NestJS app under `backend/`.
- `FirebaseModule` exposing `FIRESTORE` and `STORAGE_BUCKET` via DI.
- Health + Firestore demo + Storage demo endpoints as specified.
- Global Google-API exception filter.
- Unit + e2e tests as specified.
- `.env.example` and `backend/README.md` covering ADC setup and the smoke-test
  procedure.
