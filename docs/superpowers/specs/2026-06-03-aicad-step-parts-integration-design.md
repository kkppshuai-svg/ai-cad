# AI-CAD step.parts Integration Design

## Goal

Connect AI-CAD to the hosted step.parts catalog so conversational CAD plans can use real downloaded standard STEP parts instead of approximating common hardware with generated CadQuery geometry.

## Scope

The first version supports standard parts requested through natural language and represented in the assembly plan. It does not add a full browser-side catalog UI.

Supported standard-part examples include screws, bolts, nuts, washers, bearings, standoffs, connectors, small motors, servos, and similar off-the-shelf parts available in step.parts.

## Plan Schema

Assembly plan parts gain a source mode:

```json
{
  "id": "bearing_608zz",
  "name": "608ZZ bearing",
  "role": "shaft support bearing",
  "mode": "standard_part",
  "standardPart": {
    "provider": "step.parts",
    "query": "608ZZ bearing",
    "id": "",
    "category": "",
    "family": "",
    "standard": "",
    "tag": ""
  },
  "pose": {
    "translate": [0, 0, 0],
    "rotate": [0, 0, 0]
  }
}
```

Generated CadQuery parts keep the current schema and are treated as `mode: "generated"` when `mode` is missing.

If `standardPart.id` is provided, the backend fetches that exact part. Otherwise it searches with `query` plus any non-empty facet fields. If no clear result is found, the assembly fails with a clear error instead of silently generating an approximate part.

`mode: "standard_part"` parts do not require `primitives` or `features` and must not be filled with the current default box geometry during validation. They still require `id`, `name`, `role`, and `pose`, and they still participate in `relations` and `joints`.

## Backend Architecture

Add a focused step.parts module responsible for:

- searching `https://api.step.parts/v1/parts`,
- fetching exact records from `/v1/parts/{id}`,
- downloading via `downloadUrl`,
- verifying `sha256` when present,
- caching downloaded STEP files under a local runtime cache,
- returning provenance metadata for manifests and logs.

The module must not scrape HTML. It uses the hosted API as the canonical source.

Network and API failures are reported as step.parts availability errors. Tests use local mocks and do not require live network access.

## Assembly Build Flow

Before running `scripts/cadquery_build.py`, `buildAssembly()` hydrates any `mode: "standard_part"` parts:

1. Resolve the requested step.parts record.
2. Download or reuse the cached STEP file.
3. Add provenance metadata to the part.
4. Keep the part pose in the same millimeter/degree convention used by generated parts.

`scripts/cadquery_build.py` is extended to handle mixed assemblies:

- Generated parts keep the existing CadQuery build path.
- Standard parts import the downloaded local STEP file.
- The build output still includes per-part local STEP, placed STEP, STL, and assembly STEP/STL where possible.

The kinematic package copies standard-part STEP files into the same `parts/local` and `parts/placed` folders used by generated parts. The FreeCAD `.FCStd` primary output therefore contains visible geometry for both generated and step.parts sourced components.

## Prompt Contract

The planner prompt tells Codex to use `mode: "standard_part"` when the user asks for a recognizable standard/off-the-shelf part. The prompt must not ask Codex to invent exact dimensions for standard parts when step.parts lookup is appropriate.

The planner should prefer exact part ids only when the user gives one or the previous plan already contains one. Otherwise it should provide a focused query and optional facets.

## Public Output

`publicAssembly()` and manifests expose standard-part provenance:

- selected step.parts id,
- name,
- API URL,
- page URL,
- checksum status,
- local assembly file URLs when available.

The UI can initially show this data in the existing JSON/log/download surfaces. A dedicated visual catalog picker is out of scope for this version.

## Error Handling

Assembly generation fails clearly when:

- step.parts is unreachable,
- no result matches the requested standard part,
- a selected part lacks a downloadable STEP file,
- checksum verification fails,
- imported STEP geometry cannot be converted to required assembly outputs.

The error message should name the requested standard part and explain whether the failure was search, download, checksum, or import.

## Caching

Downloaded files are cached by step.parts part id and sha256 when available. Repeated builds of the same standard part should not redownload unless the cached file is missing or the checksum does not match.

Cache files are runtime artifacts and should not be committed.

## Testing

Tests cover:

- search URL construction and exact-id fetch behavior,
- download caching and checksum verification,
- clear errors for no match and checksum mismatch,
- assembly hydration of a `mode: "standard_part"` part into a local STEP path and provenance metadata,
- prompt contract requiring `mode: "standard_part"` for standard/off-the-shelf parts,
- `npm run check` remains green without live network.

Live step.parts smoke testing is optional and requires network access.
