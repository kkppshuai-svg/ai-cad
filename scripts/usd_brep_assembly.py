"""Native multi-body USD BRep build; keeps mechanical parts separate."""
import json
import math
import os
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import time

import usd_brep as b
from usd_brep_build import build_solid, write_stl
from usd_brep_export import stage_units
from brep_review_core import compare_geometry


def facts(body):
    box = body.bounding_box()
    return {"solidCount": body.material_census()["solid_count"],
            "volume": b.compute_volume(body, relative_accuracy=1e-8),
            "bbox": [box[1][i]-box[0][i] for i in range(3)],
            "boundsMin": list(box[0]), "boundsMax": list(box[1]),
            "center": list(body.center()), "faceCount": body.face_count(), "edgeCount": body.edge_count()}


def build_assembly(plan, output_dir):
    parts = plan.get("parts", [])
    ids = [p.get("id") for p in parts]
    if not 1 <= len(parts) <= 12 or len(set(ids)) != len(ids):
        raise ValueError("Native assembly requires 1..12 uniquely named parts")
    if any(not isinstance(i, str) or not i.replace('_','').replace('-','').isalnum() or not i.isascii() for i in ids):
        raise ValueError("Native part IDs must be ASCII letters, digits, underscores or hyphens")
    if any(p.get("measurements") for p in parts):
        raise ValueError("Native assembly measurements are not implemented; cannot silently skip them")
    if plan.get("prototype") == "planetary-5to1-native-v1":
        gears = {p['id']: next((n.get('params',{}) for n in p.get('featureTree',[]) if n['type']=='base_spur_gear'), {}) for p in parts}
        if set(ids) != {'sun','planet_1','planet_2','planet_3','ring','carrier'}:
            raise ValueError("Planetary prototype requires sun, three planets, ring and carrier")
        zs, zp, zr = (gears[key].get('teeth') for key in ('sun','planet_1','ring'))
        if not all(isinstance(z,int) for z in (zs,zp,zr)) or zr != zs+2*zp or zr != 4*zs or (zs+zr)%3:
            raise ValueError("Planetary tooth counts do not satisfy ratio, center distance and assembly phase")
        if any(gears[key].get('teeth') != zp for key in ('planet_2','planet_3')) or not gears['ring'].get('internal'):
            raise ValueError("Planet gears must match and ring must have internal teeth")
    output = Path(output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    start = time.perf_counter()
    bodies, reports, meshes, traces = [], [], [], {}
    with tempfile.TemporaryDirectory(prefix="native-assembly-", dir=os.path.realpath(tempfile.gettempdir())) as tmp:
        tmp = Path(tmp)
        for part in parts:
            print("Native build: "+part['id'], file=sys.stderr, flush=True)
            body, trace = build_solid(part)
            if not b.is_manifold_solid(body):
                raise ValueError("Non-manifold native part: "+part['id'])
            original = facts(body)
            if original['solidCount'] != 1 or not math.isfinite(original['volume']) or original['volume'] <= 0:
                raise ValueError("Part must be one positive closed solid: "+part['id'])
            exact = tmp/(part['id']+'.usda')
            b.usd.export_brep(body, str(exact))
            exact.write_text(stage_units(exact.read_text(encoding='utf-8')), encoding='utf-8')
            restored = b.usd.import_breps(str(exact))
            if len(restored) != 1 or not b.is_manifold_solid(restored[0]):
                raise ValueError("Part USD roundtrip lost solid: "+part['id'])
            roundtrip = compare_geometry(original, facts(restored[0]))
            if not roundtrip['valid']:
                raise ValueError("Part USD drift: "+json.dumps(roundtrip['issues']))
            shutil.copyfile(exact, output/exact.name)
            mesh = b.tessellate(body, chord_height_tolerance=0.03, curve_angle_tolerance_deg=8, surface_angle_tolerance_deg=8)
            write_stl(mesh, output/(part['id']+'.stl'))
            bodies.append(body)
            meshes.append(mesh)
            traces[part['id']] = trace
            reports.append({"partId": part['id'], "valid": True, "facts": original,
                            "issues": [], "measurements": [], "usdRoundTrip": roundtrip})
        exact = tmp/'assembly.usda'
        b.usd.export_breps(bodies, str(exact))
        exact.write_text(stage_units(exact.read_text(encoding='utf-8')), encoding='utf-8')
        restored = b.usd.import_breps(str(exact))
        if len(restored) != len(bodies):
            raise ValueError("Assembly USD lost bodies")
        comparisons = [compare_geometry(item['facts'], facts(body)) for item,body in zip(reports,restored)]
        if not all(b.is_manifold_solid(body) for body in restored) or not all(c['valid'] for c in comparisons):
            raise ValueError("Assembly USD roundtrip drift")
        shutil.copyfile(exact, output/'native-solid.usda')
        mesh_file = tmp/'mesh.usda'
        b.usd.export_meshes(meshes, str(mesh_file))
        (output/'native-mesh.usda').write_text(stage_units(mesh_file.read_text(encoding='utf-8')), encoding='utf-8')
    # Concatenate binary triangles, preserving independent closed part shells.
    buffers = [(output/(p['id']+'.stl')).read_bytes() for p in parts]
    with (output/'native-preview.stl').open('wb') as handle:
        handle.write(b'NVIDIA SMLib native assembly'.ljust(80,b'\0'))
        handle.write(struct.pack('<I', sum(struct.unpack_from('<I',v,80)[0] for v in buffers)))
        for data in buffers:
            handle.write(data[84:])
    result = {"engine":"nvidia-usd-brep", "kernel":"SMLib", "representation":"brep",
              "cadqueryUsed":False, "parts":reports, "featureTrace":traces,
              "usdRoundTrip":{"valid":True,"issues":[],"parts":comparisons},
              "roundTrip":"passed", "bodyCount":len(bodies), "durationMs":(time.perf_counter()-start)*1000,
              "interferenceStatus":"unverified", "motionStatus":"unverified",
              "limitations":["Sampled involute flanks; radial root transitions", "Motion and strength not qualified"]}
    if plan.get('prototype') == 'planetary-5to1-native-v1':
        result['kinematicArithmetic'] = {"ratio":1+zr/zs, "sunTeeth":zs, "planetTeeth":zp, "ringTeeth":zr,
            "assemblyPhaseCondition":(zs+zr)/3, "assumption":"ring fixed, sun input, carrier output", "status":"pass"}
    (output/'native-build-report.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    (output/'native-feature-plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2),encoding='utf-8')
    return result


if __name__ == '__main__':
    try:
        request = json.load(sys.stdin)
        print(json.dumps(build_assembly(request['plan'], request['outputDir'])))
    except ValueError as error:
        print(json.dumps({"error":str(error),"code":"USD_BREP_UNSUPPORTED_OR_INVALID"}))
        sys.exit(2)
