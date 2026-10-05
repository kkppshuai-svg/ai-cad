import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Snapshot the production builder so archived examples keep their original semantics.
export async function saveCadqueryExample({ plan, directory, builderPath }) {
  await mkdir(directory, { recursive: true });
  await copyFile(builderPath, path.join(directory, "cadquery_build.py"));
  const script = `import json
from pathlib import Path

import cadquery as cq
from cadquery_build import assembly_root_name, build_manifest_part, pose_location

ROOT = Path(__file__).resolve().parent
PLAN = json.loads((ROOT / "feature-plan.json").read_text(encoding="utf-8"))


def build_example():
    assembly = cq.Assembly(name=assembly_root_name(PLAN))
    parts = {}
    for original in PLAN.get("parts", []):
        part = dict(original)
        if part.get("mode") != "standard_part":
            part.pop("reuseStepPath", None)
        built = build_manifest_part(part)
        parts[part["id"]] = built
        assembly.add(built, name=part["id"], loc=pose_location(part.get("pose") or {}))
    return assembly, parts


if __name__ == "__main__":
    assembly, parts = build_example()
    assembly.save(str(ROOT / "example.step"))
`;
  await writeFile(path.join(directory, "feature-plan.json"), JSON.stringify(plan, null, 2), "utf8");
  await writeFile(path.join(directory, "excellent_cadquery.py"), script, "utf8");
  return script;
}
