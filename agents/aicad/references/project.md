# AI-CAD Project Reference

## Main Components

- `server.js`: local Node HTTP API and static file server.
- `public/`: browser UI for chat-driven modeling and model downloads.
- `scripts/cadquery_build.py`: primary CadQuery builder for STEP/STL/PNG/GLB output.
- `scripts/freecad_assemble.py`: fallback bridge for FreeCAD assembly handling.
- `scripts/aicad_training_30.py`: part-model regression and feedback sample runner.
- `scripts/train_brep_vae.py`: BREP VAE training for latent geometry retrieval.
- `scripts/query_brep_vae.py`: encode and retrieve related BREP geometry samples.
- `requirements-cadquery.txt`: Python dependencies for CadQuery execution.

## API Surface

- `GET /api/status`
- `POST /api/chat`
- `GET /api/assembly/:id`
- `POST /api/preview`
- `GET /api/events`

## Build Outputs

Runtime output directories are ignored:

- `assemblies/`
- `renders/`
- `workspace/`
- `logs/`
- `transfers/`

The repository should contain source code, scripts, docs, and agent metadata only.
