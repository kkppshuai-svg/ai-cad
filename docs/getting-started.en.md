# Getting started

[Overview](../README.md) · [中文指南](getting-started.md) · [Configuration (中文)](configuration.md)

## Requirements

Node.js 20+ and Python with `venv`. CadQuery handles the baseline modeling backend. NVIDIA USD BRep requires an optional separate Python 3.12 environment. FreeCAD is optional for related bridge/export features.

AI planning and visual review require a configured provider; the deterministic plate example does not call an AI model. Configuration supports Codex and DeepSeek.

## Linux

```bash
git clone https://github.com/kkppshuai-svg/ai-cad.git
cd ai-cad
npm ci
bash scripts/setup_cadquery_env.sh
npm start
```

The setup script creates `.venv-cadquery` and creates `.env.local` if absent. Open `http://127.0.0.1:3101`. `npm start` runs in the foreground; stop it with Ctrl+C. Linux background launch/stop scripts are also available.

## Windows PowerShell

After cloning and entering the repository:

```powershell
npm ci
py -3.12 -m venv .venv-cadquery
& ./.venv-cadquery/Scripts/python.exe -m pip install -r requirements-cadquery.txt
$env:CADQUERY_PYTHON = (Resolve-Path ./.venv-cadquery/Scripts/python.exe).Path
npm start
```

The variable applies to the current terminal. Save the Python path in `.env.local` for persistent configuration. Keep local paths and credentials outside source commits.

## First model and review

1. Open the workbench and click the plate-example button (`加载带孔板示例`).
2. Inspect the 3D preview and available download links.
3. Click unified review (`统一审查`). Select geometry-only evidence (`仅核对几何证据`) if no visual provider is configured.
4. Configure an AI provider to use chat planning and combined visual review.

The workbench currently uses Chinese UI labels. A geometry pass can still have a pending delivery decision; complete delivery requires current visual evidence as well. The plate example checks the local modeling path, not general engineering suitability.

## Select a backend

| Backend | Use | Main outputs |
| --- | --- | --- |
| CadQuery / OpenCascade | Broader parts and assemblies | STEP and preview meshes; optional FreeCAD bridge |
| NVIDIA USD BRep / SMLib | Supported primitives, holes, cuts, unions, and transforms | Precise USD BRep and STL preview |

Set `USD_BREP_PYTHON` to a Python 3.12 environment containing the packages in `requirements-usd-brep.txt` to enable native modeling. When available, it is selected by default unless the user has retained CadQuery. Native unsupported features fail explicitly; they do not silently switch backends. Native modeling currently provides no STEP/FCStd export.

Detailed setup and coverage are in [USD BRep integration (中文)](usd-brep.md); the review contract is in [Unified review (中文)](unified-brep-review.md).

## Checks and troubleshooting

```bash
npm run check
```

The checks load `.env.local` to locate configured runtimes. Install pytest into the CadQuery environment before running them; see [Development (中文)](development.md).

| Symptom | Check |
| --- | --- |
| Python cannot start | Set `CADQUERY_PYTHON` or `USD_BREP_PYTHON` to the intended executable |
| AI/visual request fails | Check the configured provider and its runtime or credentials |
| Delivery remains pending | Confirm current visual evidence exists; geometry-only success is insufficient |
| Wrong page or occupied port | Use the address shown by the running server and check `PORT` |

HTTP status information is available at `/api/status`. API, configuration, and engineering limits remain documented in the [documentation index (中文)](README.md).
