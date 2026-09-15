# AI-CAD FreeCAD Primary Output Design

## Goal

Change AI-CAD so the primary assembly output is a FreeCAD `.FCStd` document instead of STEP. The FreeCAD file must contain the visible assembly geometry, per-part objects, and AI-CAD relationship metadata. STEP and STL remain available as compatibility and preview outputs.

## Scope

This change builds on the existing FreeCAD JSON bridge. It does not add a FreeCAD Assembly Workbench solver or editable native constraints. Relations, joints, and mates are stored as inspectable FreeCAD document metadata objects because the current CadQuery/OCC STEP path does not reliably export editable AP242 kinematic constraints.

## Architecture

`buildAssembly()` keeps the existing geometry flow:

- hydrate standard parts
- write `assembly-manifest.json`
- run `scripts/cadquery_build.py`
- build the FreeCAD kinematic package

After the kinematic package is created, the backend runs the package `open_in_freecad.py` script with `freecadcmd`. That script creates `assembly_kinematic_package/ai_cad_assembly.FCStd`. The job stores this path as `job.fcstdPath`, and `publicAssembly()` exposes it as `fcstdUrl`.

The `.FCStd` file is treated as required for a successful completed assembly. If FreeCAD command-line generation fails or the file is missing, the assembly job fails instead of reporting completion without its primary output.

## UI Behavior

The download area presents the FreeCAD document as the main output:

- `下载 FreeCAD 主文件` points to `fcstdUrl`.
- `下载 STEP` is relabeled as a compatibility export.
- `下载 STEP 装配包` is relabeled as a relationship package rather than the primary output.

The browser STL viewer remains unchanged because it needs STL for fast preview.

The `打开 FreeCAD 装配` button is enabled only when local FreeCAD launching is allowed, the assembly is complete, and `fcstdUrl` exists. Clicking the button asks the backend to open the existing `.FCStd` file in FreeCAD. It does not regenerate the document on every click unless the file is missing and the backend must repair the job.

## API Behavior

`/api/freecad/open` opens the existing generated `.FCStd` path. The response reports the opened file and command. If the job lacks `fcstdPath` or the file no longer exists, the backend may run the bridge script once to recreate it, then opens the recreated file.

## Testing

Tests cover the behavior change before production edits:

- `canOpenFreeCadAssembly()` requires `fcstdUrl`.
- FreeCAD open result wording shows it opens an existing `.FCStd` primary file.
- The FreeCAD bridge script still imports local parts, applies poses, creates mate metadata, and saves `.FCStd`.
- Server-side helper behavior for generated `.FCStd` paths is covered where the existing module boundary allows it.

Run `npm run check` after implementation.
