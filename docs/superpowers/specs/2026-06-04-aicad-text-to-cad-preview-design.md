# AI-CAD Text-to-CAD Style Preview Design

## Goal

Replace AI-CAD's primary browser preview path with a text-to-cad/CAD Explorer style preview while keeping the existing STL WebGL canvas as a fallback. The user should see generated STEP/STL outputs through the richer CAD Explorer interface inside AI-CAD.

## Approach

AI-CAD will embed the existing local CAD Explorer rather than copying its React/Vite source into the pure Node frontend. The backend will start or reuse CAD Explorer with `dev:ensure`, pass it the selected generated CAD file, and return the URL. The frontend will load that URL in an iframe in the preview panel.

## Behavior

- Generated assemblies prefer `assembly.step` for Explorer preview.
- Selected generated parts prefer per-part STEP, then STL.
- Standard parts and previews use available STEP/STL paths.
- If Explorer startup fails, URL parsing fails, or no file is available, AI-CAD falls back to the current STL/PNG preview.
- The status panel should make the active preview mode visible: Explorer, STL, or PNG fallback.
- The old STL controls remain available for fallback.

## Components

- `cad-explorer-link.js`: pure helper module for choosing preview files and parsing `dev:ensure` output.
- `server.js`: adds `POST /api/explorer-link` and attaches Explorer URLs to assembly/preview payloads where possible.
- `public/index.html`: adds an iframe layer to the preview stage.
- `public/app.js`: loads Explorer iframe first, falls back to STL/PNG if no Explorer URL exists.
- `public/styles.css`: styles the Explorer iframe and mode controls.

## Constraints

- Do not add React/Vite to AI-CAD main app.
- Do not remove the STL WebGL viewer in this pass.
- Do not assume a fixed CAD Explorer port.
- Do not expose arbitrary filesystem paths to browser clients beyond explicit generated AI-CAD files.

## Verification

- Unit tests cover file selection and Explorer URL parsing.
- UI copy tests cover iframe usage and fallback behavior.
- `npm run check` must pass.
