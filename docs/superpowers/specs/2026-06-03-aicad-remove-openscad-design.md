# AI-CAD Remove OpenSCAD Design

## Goal

Remove the OpenSCAD auxiliary module from `ai-cad` entirely so the product only exposes CadQuery and FreeCAD workflows.

## Scope

This change removes OpenSCAD code paths, environment variables, status reporting, routes, UI wording, setup references, and sample files from the repository.

This change does not alter the CadQuery assembly pipeline or FreeCAD `.FCStd` primary output flow beyond removing OpenSCAD-specific wording and fallback behavior.

## Backend Changes

The backend will stop detecting or reporting an OpenSCAD executable. `OPENSCAD_BIN`, `starterScad`, `runOpenScad()`, OpenSCAD-specific validation, and any helper logic that only exists to render `.scad` into preview artifacts will be removed.

The old OpenSCAD-oriented endpoints will be removed as hard deletions rather than compatibility shims. Requests to deleted endpoints will fall through to the existing API 404 behavior.

## Frontend Changes

The frontend engine status text will no longer mention OpenSCAD. Any UI copy that implies OpenSCAD is part of the supported workflow will be rewritten to reflect the CadQuery and FreeCAD-only product surface.

Any client logic that depends on deleted OpenSCAD preview/export endpoints will be removed. The remaining preview and assembly flows must continue to work through the existing CadQuery outputs already used by the current UI.

## Documentation And Repo Cleanup

Repository docs will remove OpenSCAD installation and configuration guidance, `OPENSCAD_BIN` examples, and statements that describe OpenSCAD as an auxiliary mode.

Repository artifacts that only exist for OpenSCAD, including `desk.scad` and OpenSCAD-only notes, will be removed. Skill and setup references that mention OpenSCAD as a required or optional dependency will be updated to match the new product boundary.

## Error Handling

No OpenSCAD-specific runtime errors should remain after this change. If any old code path still tries to require SCAD input or launch OpenSCAD, that is a bug and should be removed rather than guarded.

Deleted API endpoints should not get bespoke replacement errors; they should simply no longer exist.

## Testing

Tests will verify that:

- the backend no longer exposes OpenSCAD status fields or wording,
- the codebase no longer depends on `OPENSCAD_BIN`,
- deleted OpenSCAD entry points are not part of the active product surface,
- existing non-OpenSCAD checks still pass with the reduced code path.

Run `npm run check` after implementation.
