# KIVO Import Button API Fix Spec

OpenClaw（dev-01 子Agent）/ 2026-05-24

## 1. Background
KIVO material import UI still posts files to the deprecated `/api/materials/ingest` endpoint. The supported upload endpoint is `/api/v1/wiki/upload`. The import button must use the supported endpoint without changing the visible user flow.

## 2. Scope
Only update `web/components/material/ImportMaterialButton.tsx`. Keep existing file selection, size validation, loading state, toast feedback, and error display behavior. Do not redesign the page or add new import modes.

## 3. Functional Requirement
FR-1: When a user imports a material file from `ImportMaterialButton`, the component shall upload the file to `/api/v1/wiki/upload`, send the request body expected by that endpoint, and parse the endpoint response so success and failure toasts remain accurate.

Acceptance criteria:
- AC-1: No `/api/materials/ingest` reference remains under `web/` after the change.
- AC-2: `npm run build` completes successfully.
- AC-3: A small test file can be uploaded to `/api/v1/wiki/upload` with curl and receives a successful response.

## 4. Non-goals
No backend API redesign, no database schema change, no visual redesign, no changes outside the import button unless the deprecated route has zero references and removal is required after verification.
