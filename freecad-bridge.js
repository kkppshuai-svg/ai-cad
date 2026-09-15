import { constraintToFreeCadManifest, normalizeConstraints, resolveDatum } from "./assembly-constraints.js";

function safeSlug(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function vector(values, fallback = [0, 0, 0]) {
  const source = Array.isArray(values) ? values : fallback;
  return [0, 1, 2].map((index) => Number(source[index] ?? fallback[index] ?? 0));
}

function pose(value) {
  return {
    xyz: vector(value?.xyz),
    rpy: vector(value?.rpy)
  };
}

function metersToMm(values) {
  return vector(values).map((value) => Number((value * 1000).toFixed(6)));
}

function jointTypeToFreeCad(type) {
  const normalized = String(type || "fixed").toLowerCase();
  if (normalized === "revolute" || normalized === "continuous") return "Revolute";
  if (normalized === "prismatic" || normalized === "slider") return "Slider";
  if (normalized === "cylindrical") return "Cylindrical";
  if (normalized === "ball") return "Ball";
  return "Fixed";
}

export function buildPackageMates({ parts, relations, joints, effectiveJoints }) {
  const partIds = new Set((parts || []).map((part) => part.id));
  const relationMates = (relations || []).map((relation, index) => ({
    id: safeSlug(`relation-${index + 1}-${relation.from || "world"}-${relation.to || "part"}`),
    source: "relation",
    type: relation.type || "reference",
    from: partIds.has(relation.from) ? relation.from : relation.from || null,
    to: partIds.has(relation.to) ? relation.to : relation.to || null,
    origin: pose(relation.origin),
    axis: vector(relation.axis, [0, 0, 1]),
    offset: pose(relation.offset),
    limit: relation.limit || null,
    description: relation.description || "",
    valid: partIds.has(relation.from) && partIds.has(relation.to)
  }));
  const explicitJointIds = new Set((joints || []).map((joint) => joint.id));
  const jointMates = (effectiveJoints || []).map((joint, index) => ({
    id: safeSlug(`joint-${index + 1}-${joint.id}`),
    source: explicitJointIds.has(joint.id) ? "joint" : "generated-fixed-joint",
    type: joint.type || "fixed",
    from: joint.parent || "world",
    to: joint.child,
    origin: pose(joint.origin),
    axis: vector(joint.axis, [0, 0, 1]),
    offset: pose(joint.offset),
    limit: joint.limit || null,
    description: `${joint.parent || "world"} -> ${joint.child}`,
    valid: joint.parent === "world" || (partIds.has(joint.parent) && partIds.has(joint.child))
  }));
  return [...relationMates, ...jointMates];
}

export function buildAssemblyConstraintManifest({
  assemblyName,
  parts,
  relations,
  joints,
  effectiveJoints,
  constraints,
}) {
  const partIds = new Set((parts || []).map((part) => part.id));
  const explicitJointIds = new Set((joints || []).map((joint) => joint.id));
  const jointConstraints = (effectiveJoints || []).map((joint, index) => {
    const jointPose = pose(joint.origin);
    return {
      id: safeSlug(joint.id || `joint-${index + 1}`),
      source: explicitJointIds.has(joint.id) ? "joint" : "generated-fixed-joint",
      type: joint.type || "fixed",
      freecadJointType: jointTypeToFreeCad(joint.type),
      from: { part: joint.parent || "world" },
      to: { part: joint.child || null },
      connector1: {
        originMm: metersToMm(jointPose.xyz),
        rpyRad: jointPose.rpy,
        axis: vector(joint.axis, [0, 0, 1])
      },
      connector2: {
        originMm: metersToMm(joint.offset?.xyz || [0, 0, 0]),
        rpyRad: vector(joint.offset?.rpy || [0, 0, 0]),
        axis: vector(joint.axis, [0, 0, 1])
      },
      limit: joint.limit || null,
      valid: Boolean(joint.child && partIds.has(joint.child) && (joint.parent === "world" || partIds.has(joint.parent)))
    };
  });
  const relationConstraints = (relations || []).map((relation, index) => {
    const relationPose = pose(relation.origin);
    const offsetPose = pose(relation.offset);
    return {
      id: safeSlug(`relation-${index + 1}-${relation.from || "world"}-${relation.to || "part"}`),
      source: "relation",
      type: relation.type || "reference",
      freecadJointType: relation.type === "align" ? "Parallel" : "Fixed",
      from: { part: relation.from || null },
      to: { part: relation.to || null },
      connector1: {
        originMm: metersToMm(relationPose.xyz),
        rpyRad: relationPose.rpy,
        axis: vector(relation.axis, [0, 0, 1])
      },
      connector2: {
        originMm: metersToMm(offsetPose.xyz),
        rpyRad: offsetPose.rpy,
        axis: vector(relation.axis, [0, 0, 1])
      },
      description: relation.description || "",
      valid: Boolean(partIds.has(relation.from) && partIds.has(relation.to))
    };
  });
  const parametricPlan = { parts: parts || [], constraints: constraints || [] };
  const parametricConstraints = normalizeConstraints(parametricPlan).map((constraint) => {
    try {
      return constraintToFreeCadManifest(constraint, {
        from: resolveDatum(parametricPlan, constraint.from),
        to: resolveDatum(parametricPlan, constraint.to)
      });
    } catch (error) {
      return { ...constraintToFreeCadManifest(constraint), valid: false, error: error.message };
    }
  });
  return {
    format: "ai-cad-assembly-constraints-v1",
    assembly: {
      name: assemblyName || "AI_CAD_Assembly",
      units: {
        connectorTranslation: "mm",
        connectorRotation: "rad"
      }
    },
    parts: (parts || []).map((part) => ({
      id: part.id,
      name: part.name || part.id,
      localStepFile: part.localStepFile || null,
      placedStepFile: part.placedStepFile || null
    })),
    constraints: [...jointConstraints, ...relationConstraints, ...parametricConstraints]
  };
}

export function renderFreeCadOpenScript() {
  return `import json
import os
import sys

import FreeCAD as App
import Import
import Part


ROOT = os.path.dirname(os.path.abspath(__file__))
KINEMATICS = os.path.join(ROOT, "assembly-kinematics.json")
CONSTRAINTS = os.path.join(ROOT, "assembly-constraints.json")
FREECAD_ASSEMBLY_STEP = os.path.join(ROOT, "freecad_assembly.step")
ASSEMBLY_STEP = FREECAD_ASSEMBLY_STEP if os.path.exists(FREECAD_ASSEMBLY_STEP) else os.path.join(ROOT, "assembly.step")
OUT_FILE = os.path.join(ROOT, "ai_cad_assembly.FCStd")


def as_text(value):
    return json.dumps(value, ensure_ascii=False, indent=2)


def safe_name(value):
    text = "".join(ch if ch.isalnum() or ch in "_-" else "_" for ch in str(value))
    return text[:60] or "item"


def add_string_prop(obj, name, value):
    obj.addProperty("App::PropertyString", name, "AI_CAD")
    setattr(obj, name, str(value or ""))


def add_json_prop(obj, name, value):
    add_string_prop(obj, name, as_text(value))


def load_json(path_value, fallback):
    if not os.path.exists(path_value):
        return fallback
    with open(path_value, "r", encoding="utf-8") as handle:
        return json.load(handle)


def placement_from_connector(connector):
    base = connector.get("originMm") or [0, 0, 0]
    rpy = connector.get("rpyRad") or [0, 0, 0]
    try:
        return App.Placement(
            App.Vector(float(base[0]), float(base[1]), float(base[2])),
            App.Rotation(float(rpy[2]) * 180.0 / 3.141592653589793, float(rpy[1]) * 180.0 / 3.141592653589793, float(rpy[0]) * 180.0 / 3.141592653589793),
        )
    except Exception:
        return App.Placement()


def placement_from_pose(pose):
    translate = list((pose or {}).get("translate") or [0, 0, 0]) + [0, 0, 0]
    rotate = list((pose or {}).get("rotate") or [0, 0, 0]) + [0, 0, 0]
    try:
        placement = App.Placement(App.Vector(float(translate[0]), float(translate[1]), float(translate[2])), App.Rotation())
        placement = placement.multiply(App.Placement(App.Vector(), App.Rotation(App.Vector(1, 0, 0), float(rotate[0]))))
        placement = placement.multiply(App.Placement(App.Vector(), App.Rotation(App.Vector(0, 1, 0), float(rotate[1]))))
        placement = placement.multiply(App.Placement(App.Vector(), App.Rotation(App.Vector(0, 0, 1), float(rotate[2]))))
        return placement
    except Exception:
        return App.Placement()


def import_step(path_value, fallback_name):
    if not path_value:
        return []
    step_path = path_value if os.path.isabs(path_value) else os.path.join(ROOT, path_value)
    if not os.path.exists(step_path):
        return []
    before = set(obj.Name for obj in doc.Objects)
    Import.insert(step_path, doc.Name)
    imported = [obj for obj in doc.Objects if obj.Name not in before]
    for index, obj in enumerate(imported):
        obj.Label = fallback_name if len(imported) == 1 else "{}_{}".format(fallback_name, index + 1)
    return imported


def set_visibility(objects, visible):
    for obj in objects:
        try:
            obj.ViewObject.Visibility = bool(visible)
        except Exception:
            pass


def add_to_group(group, objects):
    if not group or not objects:
        return
    for obj in objects:
        try:
            group.addObject(obj)
        except Exception:
            pass


def create_editable_part(part, group):
    label = safe_name(part.get("id", "part"))
    imported = import_step(part.get("localStepFile") or part.get("placedStepFile"), "AI_CAD_Source_" + label)
    shapes = []
    for obj in imported:
        try:
            if hasattr(obj, "Shape") and not obj.Shape.isNull():
                shapes.append(obj.Shape.copy())
        except Exception:
            pass

    container = doc.addObject("App::Part", "AI_CAD_Part_" + label)
    container.Label = part.get("name") or part.get("id") or label
    container.Placement = placement_from_pose(part.get("pose", {}))
    geometry = container.newObject("Part::Feature", "Geometry")
    geometry.Label = "{} Geometry".format(container.Label)
    if len(shapes) == 1:
        geometry.Shape = shapes[0]
    elif shapes:
        geometry.Shape = Part.makeCompound(shapes)
    add_string_prop(container, "PartId", part.get("id", ""))
    add_string_prop(container, "PartName", part.get("name", ""))
    add_string_prop(container, "Role", part.get("role", ""))
    add_json_prop(container, "PoseJson", part.get("pose", {}))
    add_json_prop(container, "CadQueryFeatureJson", {
        "id": part.get("id"),
        "name": part.get("name"),
        "role": part.get("role"),
        "primitives": part.get("primitives", []),
        "features": part.get("features", []),
        "featureTree": part.get("featureTree", []),
        "pose": part.get("pose", {}),
    })
    add_json_prop(container, "ParametricFeatureTreeJson", part.get("featureTree", []))
    add_string_prop(container, "RevisionId", part.get("revisionId", ""))
    add_string_prop(container, "LocalStepFile", part.get("localStepFile", ""))
    add_string_prop(container, "PlacedStepFile", part.get("placedStepFile", ""))
    add_string_prop(geometry, "PartId", part.get("id", ""))
    add_string_prop(geometry, "RevisionId", part.get("revisionId", ""))
    add_string_prop(geometry, "EditHint", "Use Part/Part Design tools for direct edits; regenerate from CadQueryFeatureJson for parametric source changes.")
    for obj in reversed(imported):
        try:
            doc.removeObject(obj.Name)
        except Exception:
            pass
    add_to_group(group, [container])
    return container, geometry, len(shapes)


def create_assembly_object(doc, name):
    try:
        assembly = doc.addObject("Assembly::AssemblyObject", "Assembly")
        assembly.Label = name
        try:
            joint_group = assembly.newObject("Assembly::JointGroup", "Joints")
        except Exception:
            joint_group = doc.addObject("Assembly::JointGroup", "Joints")
        return assembly, joint_group, None
    except Exception as exc:
        group = doc.addObject("App::DocumentObjectGroup", "AI_CAD_Assembly_Group")
        group.Label = name
        return group, None, str(exc)


def joint_type_index(freecad_joint_type):
    types = getattr(JointObject, "JointTypes", [])
    if freecad_joint_type in types:
        return types.index(freecad_joint_type)
    raise RuntimeError("Unsupported FreeCAD joint type: {}".format(freecad_joint_type))


def create_freecad_joint(joint_group, constraint, imported_by_part):
    if joint_group is None:
        raise RuntimeError("Assembly::JointGroup is unavailable")
    if "JointObject" not in globals():
        raise RuntimeError("JointObject module is unavailable")
    from_part = constraint.get("from", {}).get("part")
    to_part = constraint.get("to", {}).get("part")
    from_objs = imported_by_part.get(from_part) or []
    to_objs = imported_by_part.get(to_part) or []
    obj = joint_group.newObject("App::FeaturePython", "AI_CAD_Joint_" + safe_name(constraint.get("id", "constraint")))
    if from_part == "world" and constraint.get("freecadJointType") == "Fixed":
        if not to_objs:
            raise RuntimeError("Grounded constraint target is unavailable")
        JointObject.GroundedJoint(obj, to_objs[0])
        obj.Label = constraint.get("id", obj.Name)
        add_json_prop(obj, "AI_CAD_ConstraintJson", constraint)
        return obj
    JointObject.Joint(obj, joint_type_index(constraint.get("freecadJointType", "Fixed")))
    obj.Label = constraint.get("id", obj.Name)
    obj.Detach1 = True
    obj.Detach2 = True
    obj.Placement1 = placement_from_connector(constraint.get("connector1", {}))
    obj.Placement2 = placement_from_connector(constraint.get("connector2", {}))
    if from_objs and from_part != "world":
        obj.Reference1 = [from_objs[0], [from_objs[1].Name + ".Face1", from_objs[1].Name + ".Vertex1"]]
    if to_objs:
        obj.Reference2 = [to_objs[0], [to_objs[1].Name + ".Face1", to_objs[1].Name + ".Vertex1"]]
    limit = constraint.get("limit") or {}
    if obj.JointType == "Revolute":
        if limit.get("lower") is not None:
            obj.EnableAngleMin = True
            obj.AngleMin = float(limit.get("lower")) * 180.0 / 3.141592653589793
        if limit.get("upper") is not None:
            obj.EnableAngleMax = True
            obj.AngleMax = float(limit.get("upper")) * 180.0 / 3.141592653589793
    if obj.JointType == "Slider":
        if limit.get("lower") is not None:
            obj.EnableLengthMin = True
            obj.LengthMin = float(limit.get("lower")) * 1000.0
        if limit.get("upper") is not None:
            obj.EnableLengthMax = True
            obj.LengthMax = float(limit.get("upper")) * 1000.0
    add_json_prop(obj, "AI_CAD_ConstraintJson", constraint)
    return obj


doc = App.newDocument("AI_CAD_Assembly")

try:
    import JointObject
except Exception as exc:
    JointObject = None
    JOINT_IMPORT_ERROR = str(exc)
else:
    JOINT_IMPORT_ERROR = None

data = load_json(KINEMATICS, {})
constraints = load_json(CONSTRAINTS, {"constraints": []})
assembly_obj, joint_group, assembly_error = create_assembly_object(doc, constraints.get("assembly", {}).get("name") or data.get("assembly", {}).get("name", "AI_CAD_Assembly"))

metadata = doc.addObject("App::FeaturePython", "AI_CAD_Metadata")
add_string_prop(metadata, "Format", data.get("format", "ai-cad-kinematics-v2"))
add_string_prop(metadata, "AssemblyName", data.get("assembly", {}).get("name", "AI_CAD_Assembly"))
add_string_prop(metadata, "Units", as_text(data.get("assembly", {}).get("units", {})))
add_json_prop(metadata, "RelationsJson", data.get("relations", []))
add_json_prop(metadata, "JointsJson", data.get("joints", []))
add_json_prop(metadata, "MatesJson", data.get("mates", []))
add_json_prop(metadata, "ConstraintsJson", constraints)
add_json_prop(metadata, "AuditJson", data.get("audit", {}))

part_group = doc.addObject("App::DocumentObjectGroup", "AI_CAD_Visible_Placed_Parts")
part_group.Label = "AI_CAD visible placed parts"

assembly_objs = import_step(os.path.basename(ASSEMBLY_STEP), "AI_CAD_Complete_Assembly_REFERENCE")
set_visibility(assembly_objs, False)

imported_by_part = {}
part_visible_count = 0
for part in data.get("parts", []):
    label = safe_name(part.get("id", "part"))
    container, geometry, source_shape_count = create_editable_part(part, part_group)
    imported_by_part[part.get("id", "")] = [container, geometry]
    part_visible_count += 1
    meta = doc.addObject("App::FeaturePython", "AI_CAD_PartMeta_" + label)
    add_string_prop(meta, "PartId", part.get("id", ""))
    add_string_prop(meta, "PartName", part.get("name", ""))
    add_string_prop(meta, "Role", part.get("role", ""))
    add_string_prop(meta, "PoseJson", as_text(part.get("pose", {})))
    add_string_prop(meta, "LocalStepFile", part.get("localStepFile", ""))
    add_string_prop(meta, "PlacedStepFile", part.get("placedStepFile", ""))
    add_string_prop(meta, "MeshFile", part.get("meshFile", ""))
    add_string_prop(meta, "ImportedObjects", geometry.Name)
    add_string_prop(meta, "ContainerObject", container.Name)
    add_string_prop(meta, "SourceShapeCount", source_shape_count)

if part_visible_count == 0:
    set_visibility(assembly_objs, True)

for index, relation in enumerate(data.get("relations", []), start=1):
    obj = doc.addObject("App::FeaturePython", "AI_CAD_Relation_{:03d}".format(index))
    add_string_prop(obj, "Type", relation.get("type", "reference"))
    add_string_prop(obj, "From", relation.get("from", ""))
    add_string_prop(obj, "To", relation.get("to", ""))
    add_string_prop(obj, "Description", relation.get("description", ""))
    add_string_prop(obj, "RelationJson", as_text(relation))

for index, mate in enumerate(data.get("mates", []), start=1):
    obj = doc.addObject("App::FeaturePython", "AI_CAD_Mate_{:03d}_{}".format(index, safe_name(mate.get("id", "mate"))))
    add_string_prop(obj, "MateId", mate.get("id", ""))
    add_string_prop(obj, "Source", mate.get("source", ""))
    add_string_prop(obj, "Type", mate.get("type", "reference"))
    add_string_prop(obj, "From", mate.get("from", ""))
    add_string_prop(obj, "To", mate.get("to", ""))
    add_string_prop(obj, "MateJson", as_text(mate))

bridge_report = {
    "assemblyObject": getattr(assembly_obj, "Name", None),
    "jointGroup": getattr(joint_group, "Name", None) if joint_group else None,
    "jointObjectModule": JOINT_IMPORT_ERROR is None,
    "jointObjectError": JOINT_IMPORT_ERROR,
    "assemblyError": assembly_error,
    "visiblePartObjectCount": part_visible_count,
    "hiddenReferenceObjectCount": len(assembly_objs),
    "createdConstraints": [],
    "failedConstraints": []
}
for constraint in constraints.get("constraints", []):
    meta = doc.addObject("App::FeaturePython", "AI_CAD_Constraint_" + safe_name(constraint.get("id", "constraint")))
    add_string_prop(meta, "ConstraintId", constraint.get("id", ""))
    add_string_prop(meta, "Source", constraint.get("source", ""))
    add_string_prop(meta, "FreeCadJointType", constraint.get("freecadJointType", "Fixed"))
    add_json_prop(meta, "ConstraintJson", constraint)
    try:
        joint = create_freecad_joint(joint_group, constraint, imported_by_part)
        bridge_report["createdConstraints"].append({"id": constraint.get("id"), "object": joint.Name, "type": getattr(joint, "JointType", "")})
    except Exception as exc:
        bridge_report["failedConstraints"].append({"id": constraint.get("id"), "error": str(exc)})

report = doc.addObject("App::FeaturePython", "AI_CAD_FreeCAD_Bridge_Report")
add_json_prop(report, "ReportJson", bridge_report)

doc.recompute()
doc.saveAs(OUT_FILE)
print("Saved", OUT_FILE)
print(json.dumps(bridge_report, ensure_ascii=False))
`;
}
