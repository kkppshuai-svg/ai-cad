"""NVIDIA SMLib involute-profile prototype, millimeters/degrees.

Flanks are sampled line segments of an analytic involute; tips/roots use
native circular arcs. Root transitions are radial, not generated trochoids.
"""
import math

import usd_brep as b


def profile(module, teeth, width, *, internal=False, backlash=0.12, samples=16, outside_radius=None):
    if not all(math.isfinite(float(v)) for v in (module, teeth, width, backlash)):
        raise ValueError("Gear dimensions must be finite")
    if module <= 0 or width <= 0 or int(teeth) != teeth or not 18 <= teeth <= 160 or not 0 <= backlash < module:
        raise ValueError("Gear requires positive module/width, 18..160 integer teeth and backlash < module")
    teeth = int(teeth)
    pitch = module * teeth / 2
    base = pitch * math.cos(math.radians(20))
    root = pitch - (1 if internal else 1.25) * module
    tip = pitch + (1.25 if internal else 1) * module
    low = max(root, base)
    inv_pitch = math.tan(math.radians(20)) - math.radians(20)
    half = math.pi / (2 * teeth) + (1 if internal else -1) * backlash / (2 * pitch)

    def polar(radius, angle):
        return (radius * math.cos(angle), radius * math.sin(angle), -width / 2)

    def angle(radius):
        t = math.sqrt(max(0, (radius / base) ** 2 - 1))
        return half + inv_pitch - (t - math.atan(t))

    # Uniform involute parameter, including base-circle cusp when applicable.
    t0 = math.sqrt(max(0, (low / base) ** 2 - 1))
    t1 = math.sqrt((tip / base) ** 2 - 1)
    radii = [base * math.sqrt(1 + (t0 + (t1-t0)*i/samples)**2) for i in range(samples+1)]
    if angle(tip) <= 0 or angle(low) >= math.pi / teeth:
        raise ValueError("Invalid tooth profile")
    curves = []
    max_midpoint_error = 0
    def line(p, q):
        if math.dist(p, q) > 1e-10:
            curves.append(b.create_line_segment(p, q))

    for k in range(teeth):
        center = k * 2 * math.pi / teeth
        left = [polar(r, center-angle(r)) for r in radii]
        right = [polar(r, center+angle(r)) for r in reversed(radii)]
        line(polar(root, center-angle(low)), left[0])
        for p, q in zip(left, left[1:]):
            line(p, q)
        curves.append(b.create_arc((0, 0, -width/2), tip,
                                  math.degrees(center-angle(tip)), math.degrees(center+angle(tip))))
        for p, q in zip(right, right[1:]):
            line(p, q)
        line(right[-1], polar(root, center+angle(low)))
        curves.append(b.create_arc((0, 0, -width/2), root,
                                  math.degrees(center+angle(low)),
                                  math.degrees(center+2*math.pi/teeth-angle(low))))
    for i in range(samples):
        ta = t0+(t1-t0)*i/samples
        tb = t0+(t1-t0)*(i+1)/samples
        tm = (ta+tb)/2
        rm = base*math.sqrt(1+tm*tm)
        p, q = polar(radii[i], angle(radii[i])), polar(radii[i+1], angle(radii[i+1]))
        v = tuple(q[j]-p[j] for j in range(3))
        point = polar(rm, angle(rm))
        u = sum((point[j]-p[j])*v[j] for j in range(3))/sum(x*x for x in v)
        max_midpoint_error = max(max_midpoint_error, math.dist(point, tuple(p[j]+u*v[j] for j in range(3))))
    if outside_radius is not None:
        curves.insert(0, b.create_circle((0,0,-width/2), outside_radius))
    return b.linear_sweep(curves, (0,0,1), width, cap_ends=True), {
        "moduleMm": module, "teeth": teeth, "widthMm": width,
        "pitchDiameterMm": 2*pitch, "pressureAngleDeg": 20,
        "backlashAllocationMm": backlash, "flankSegments": samples,
        "maxSampledMidpointChordErrorMm": max_midpoint_error,
        "profile": "sampled-involute-with-native-circular-tip-and-root",
        "rootTransition": "radial; trochoid/root fillet unverified",
        "internalCavity": internal,
    }


def gear(spec):
    if not all(key in spec for key in ('module', 'teeth', 'width')):
        raise ValueError("Gear requires module, teeth and width")
    internal = spec.get("internal", False)
    module, teeth, width = float(spec["module"]), spec["teeth"], float(spec["width"])
    bore = float(spec.get("boreRadius", float(spec.get("boreDiameter", 0))/2))
    if not math.isfinite(bore) or bore < 0 or bore >= module*(teeth/2-1.25):
        raise ValueError("Gear bore must stay inside root circle")
    outside = None
    if internal:
        outside = float(spec.get("outsideRadius", module*teeth/2+4*module))
        if not math.isfinite(outside) or outside <= module*(teeth/2+1.25):
            raise ValueError("Internal ring outside radius must exceed cavity tip radius")
    body, facts = profile(module, teeth, width, internal=internal, backlash=float(spec.get("backlash", 0.12)), outside_radius=outside)
    if not internal:
        if bore:
            body = b.boolean_difference(body, b.create_cylinder((0,0,-width), bore, 2*width))
    return body, facts
