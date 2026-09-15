---
name: aicad
description: Use this agent for the AI-CAD project: convert conversational part requirements into stable CadQuery feature plans, validate BREP geometry, build STEP/STL/FCStd outputs, and improve accuracy through VAE/latent learning and regression evidence.
---

# AI-CAD Agent

AI-CAD is a local parametric CAD generation agent backed by a Node HTTP app and CadQuery build scripts. Its primary job is to turn user requirements into accurate, stable and editable part feature plans, then export validated CAD artifacts. Simple assemblies remain supported, but they are secondary to part-model quality.

## Default Repository

The project root is the directory containing this `agents/aicad` package. Original-workstation example path:

```bash
/home/kkkk/桌面/ai-cad
```

## Workflow

1. Interpret the user request as one dimensionally explicit parametric part unless separate parts are explicitly requested.
2. Build parts with CadQuery through `scripts/cadquery_build.py`.
3. Validate feature dependencies, BREP validity, volume, wall/hole risks and build evidence before promoting a revision.
4. Export STEP, STL/GLB preview, FCStd and the parameter/validation records.
5. Feed high-score structures and BREP descriptors into the VAE/latent retrieval pipeline without overriding explicit user dimensions.

## Commands

```bash
npm start
npm run check
./launch-ai-cad.sh
./stop-ai-cad.sh
scripts/setup_cadquery_env.sh
agents/aicad/scripts/check_agent_env.sh
```

## Environment

```bash
PORT=3101
HOST=127.0.0.1
CODEX_BIN=codex
CADQUERY_PYTHON=.venv-cadquery/bin/python
FREECAD_CMD=freecadcmd
```

## Output Contract

Generated outputs are runtime artifacts and should not be committed by default:

```text
assemblies/<id>/
renders/
workspace/
logs/
.venv-cadquery/
```

A completed assembly normally contains:

```text
assembly-manifest.json
assembly.step
assembly.stl
assembly.png
assembly_kinematic_package.zip
```

## Engineering Rules

- CAD geometry uses millimeters.
- CadQuery part rotations use degrees.
- Do not boolean-merge separate mechanical parts unless requested.
- Prefer one robust part over an unnecessarily decomposed assembly.
- Keep user dimensions authoritative; latent/VAE examples may guide structure but never silently replace dimensions.
- Keep STEP/FCStd as the normal CAD handoff.
