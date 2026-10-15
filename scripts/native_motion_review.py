"""Motion clearance of the supported Z-extruded planetary mechanism.

Cross sections come from NVIDIA BRep plane intersections. GEOS performs only
2D distance/intersection queries; no CadQuery/OpenCascade geometry is used.
"""
import math
import time
import usd_brep as b


def motion_contract(plan):
    parts = {p['id']: p for p in plan.get('parts', [])}
    if plan.get('prototype') != 'planetary-5to1-native-v1' or set(parts) != {'sun','planet_1','planet_2','planet_3','ring','carrier'}:
        raise ValueError('Motion model is only defined for the native planetary prototype')
    gears = {}
    for pid, part in parts.items():
        rotate = part.get('pose', {}).get('rotate', [0,0,0])
        if any(abs(float(v)) > 1e-9 for v in rotate[:2]):
            raise ValueError('Motion cross-section review supports Z-axis rotations only')
        active = [n for n in part['featureTree'] if n.get('enabled', True) and n['type'] != 'dimension']
        if pid != 'carrier':
            if len(active) != 1 or active[0]['type'] != 'base_spur_gear':
                raise ValueError('Gear symmetry must be re-established after adding non-gear features')
            gears[pid] = active[0]['params']
            local=gears[pid].get('pose',{})
            if any(abs(float(x))>1e-9 for x in local.get('translate',[0,0,0])[:2]) or any(abs(float(x))>1e-9 for x in local.get('rotate',[0,0,0])[:2]):
                raise ValueError('Gear-local axes must coincide with their declared motion axes')
            if pid != 'ring' and gears[pid].get('internal'):
                raise ValueError('Sun and planets must have external teeth')
        else:
            for node in active:
                params = node.get('params', {})
                if node['type'] not in ('base_cylinder','base_box','add_primitive','hole','cut_box'):
                    raise ValueError('Carrier contains unsupported non-prismatic geometry')
                if node['type'] == 'hole' and params.get('axis','z') != 'z':
                    raise ValueError('Carrier transverse holes require general 3D motion review')
                primitive = params.get('primitive', {})
                if node['type'] == 'add_primitive' and primitive.get('type') not in ('box','cylinder'):
                    raise ValueError('Carrier additions must be Z-extruded boxes/cylinders')
                poses = [params.get('pose',{}), primitive.get('pose',{})]
                if any(any(abs(float(x))>1e-9 for x in pose.get('rotate',[0,0,0])[:2]) for pose in poses) or any(abs(float(x))>1e-9 for x in params.get('rotate',[0,0,0])[:2]):
                    raise ValueError('Carrier contains tilted primitives')
    zs, zp, zr = (int(gears[pid]['teeth']) for pid in ('sun','planet_1','ring'))
    module = float(gears['sun']['module'])
    if zr != zs+2*zp or any(int(gears[p]['teeth']) != zp for p in ('planet_2','planet_3')):
        raise ValueError('Planetary tooth counts are inconsistent')
    if any(float(g['module']) != module for g in gears.values()) or not gears['ring'].get('internal'):
        raise ValueError('Planetary gear module or internal ring is inconsistent')
    for pid in ('sun','ring','carrier'):
        if any(abs(float(x)) > 1e-6 for x in parts[pid].get('pose',{}).get('translate',[0,0,0])[:2]):
            raise ValueError('Sun, ring and carrier axes must coincide')
    radius = module*(zs+zp)/2
    angles = []
    for pid in ('planet_1','planet_2','planet_3'):
        x,y = parts[pid]['pose']['translate'][:2]
        if abs(math.hypot(x,y)-radius) > 1e-6:
            raise ValueError('Planet centers do not match the native gear pitch distance')
        angles.append(math.atan2(y,x)%(2*math.pi))
    angles.sort()
    if any(abs((angles[(i+1)%3]-angles[i])%(2*math.pi)-2*math.pi/3)>1e-7 for i in range(3)):
        raise ValueError('Three planets must be equally spaced')
    ratio = 1+zr/zs
    return parts, zs, zp, zr, ratio


def sample_curve(curve, tolerance):
    lo,hi=curve.parameter_range()
    result=[]
    def walk(a,p,c,q,depth):
        mid=(a+c)/2
        point=tuple(curve.evaluate(mid))
        chord=tuple((p[i]+q[i])/2 for i in range(3))
        if math.dist(point,chord)>tolerance:
            if depth>=20: raise ValueError('Native section sampling exceeded precision budget')
            walk(a,p,mid,point,depth+1);walk(mid,point,c,q,depth+1)
        else: result.append((round(p[0],8),round(p[1],8)))
    start,end=tuple(curve.evaluate(lo)),tuple(curve.evaluate(hi))
    walk(lo,start,hi,end,0)
    result.append((round(end[0],8),round(end[1],8)))
    return result


def section(body,z,tolerance):
    from shapely.geometry import LineString, Polygon
    from shapely.ops import polygonize
    curves=b.intersect_brep_with_plane(body,(0,0,z),(0,0,1))
    lines=[LineString(sample_curve(c,tolerance)) for c in curves]
    polygons=list(polygonize(lines))
    if not polygons: raise ValueError('Native section curves did not form closed loops')
    # Polygonize produces a face for each nested loop. XOR the exterior rings
    # to retain holes and internal-tooth cavities rather than filling them.
    result=Polygon()
    for face in polygons: result=result.symmetric_difference(Polygon(face.exterior))
    if not result.is_valid or result.is_empty: raise ValueError('Native section polygon is invalid')
    return result


def review_motion(plan,bodies,initial_intervals=300,max_intervals=2400,section_tolerance=0.0001):
    start=time.perf_counter()
    try:
        from shapely.affinity import rotate
        from shapely import STRtree, get_num_coordinates, normalize
        from shapely.geometry import LineString
        from shapely.prepared import prep
        parts,zs,zp,zr,ratio=motion_contract(plan)
        ids=[p['id'] for p in plan['parts']]
        # A whole tooth-mesh cycle repeats modulo a common rigid rotation:
        # sun advances one tooth in carrier frame, each planet one tooth,
        # and ring one tooth. This covers a full carrier revolution by symmetry.
        period=360*ratio/(zs*(ratio-1))
        # Include every BRep vertex Z, so carrier shoulders and pin ends create
        # separate slabs; no projection of disjoint axial layers is merged.
        levels=sorted({round(float(v.point()[2]),7) for body in bodies for v in body.vertices()})
        layers=[]
        slabs=[]
        section_cache={}
        bounds=[body.bounding_box() for body in bodies]
        for za,zb in zip(levels,levels[1:]):
            if zb-za<1e-6: continue
            z=(za+zb)/2
            indices=[i for i in range(len(bodies)) if bounds[i][0][2]+1e-7<z<bounds[i][1][2]-1e-7]
            active={}
            for i in indices:
                key=(i,'gear') if ids[i]!='carrier' else (i,z)
                if key not in section_cache: section_cache[key]=section(bodies[i],z,section_tolerance)
                active[i]=section_cache[key]
            slabs.append((za,zb,active))
            if len(active)>1: layers.append((za,zb,active))
        # Include shoulder/end-face contact where a body starts or ends at a
        # layer boundary. Ignoring zero axial thickness would miss rubbing.
        for left,right in zip(slabs,slabs[1:]):
            if abs(left[1]-right[0])>1e-6 or not left[2] or not right[2] or set(left[2])==set(right[2]): continue
            active=dict(left[2])
            for i,shape in right[2].items(): active[i]=active[i].union(shape) if i in active else shape
            if len(active)>1: layers.append((left[1],left[1],active))
        if not layers: raise ValueError('No common axial layers could be reviewed')
        rates={pid:(1-1/ratio if pid=='sun' else -1/ratio if pid=='ring' else -zs/zp*(1-1/ratio) if pid.startswith('planet') else 0) for pid in ids}
        centers={pid:tuple(parts[pid].get('pose',{}).get('translate',[0,0,0])[:2]) if pid.startswith('planet') else (0,0) for pid in ids}
        speeds=[]
        for pid,box in zip(ids,bounds):
            cx,cy=centers[pid]
            radius=max(math.hypot(x-cx,y-cy) for x in (box[0][0],box[1][0]) for y in (box[0][1],box[1][1]))
            speeds.append(abs(rates[pid])*radius)
        intervals=initial_intervals
        checked=0
        indexed=[]
        tokens={}
        shape_indexes={}
        for za,zb,active in layers:
            shapes={}
            shape_ids={}
            for i,shape in active.items():
                fingerprint=normalize(shape).wkb
                if fingerprint not in tokens: tokens[fingerprint]=len(tokens)
                token=tokens[fingerprint]
                shape_ids[i]=token
                if token in shape_indexes:
                    shapes[i]=shape_indexes[token]
                    continue
                boundary=shape.boundary
                rings=list(boundary.geoms) if hasattr(boundary,'geoms') else [boundary]
                segments=[]
                for ring in rings:
                    coords=list(ring.coords)
                    segments.extend(LineString(coords[k:k+17]) for k in range(0,len(coords)-1,16))
                shapes[i]=(prep(shape),STRtree(segments),segments)
                shape_indexes[token]=shapes[i]
            indexed.append((za,zb,active,shapes,shape_ids))
        while True:
            minimum=float('inf');certified=float('inf');worst=None;collisions=[]
            half_step=math.radians(period/intervals)/2
            for frame in range(intervals+1):
                angle=period*frame/intervals
                moved_cache={}
                pair_cache={}
                for za,zb,active,index,shape_ids in indexed:
                    moved={}
                    for i,shape in active.items():
                        key=(i,shape_ids[i])
                        if key not in moved_cache: moved_cache[key]=rotate(shape,rates[ids[i]]*angle,origin=centers[ids[i]]) if rates[ids[i]] else shape
                        moved[i]=moved_cache[key]
                    keys=sorted(moved,key=lambda i:get_num_coordinates(active[i]),reverse=True)
                    for n,i in enumerate(keys):
                        for j in keys[n+1:]:
                            checked+=1
                            # Keep the larger boundary static and query its spatial
                            # index. Avoid O(teeth_i * teeth_j) boundary distance.
                            cache_key=(i,shape_ids[i],j,shape_ids[j])
                            if cache_key not in pair_cache:
                                relative=rotate(moved[j],-rates[ids[i]]*angle,origin=centers[ids[i]]) if rates[ids[i]] else moved[j]
                                prepared,tree,segments=index[i]
                                intersects=prepared.intersects(relative)
                                distance=0.0 if intersects else segments[tree.nearest(relative)].distance(relative)
                                area=active[i].intersection(relative).area if distance==0 else 0.0
                                pair_cache[cache_key]=(distance,area)
                            distance,area=pair_cache[cache_key]
                            if distance<minimum:
                                minimum=distance;worst={'parts':[ids[i],ids[j]],'inputAngleDeg':angle,'zIntervalMm':[za,zb]}
                            certified=min(certified,distance-2*section_tolerance-(speeds[i]+speeds[j])*half_step)
                            if distance==0:
                                if area>1e-8:
                                    collisions.append({'parts':[ids[i],ids[j]],'inputAngleDeg':angle,'overlapAreaMm2':area,
                                        'overlapVolumeMm3':area*(zb-za),'zIntervalMm':[za,zb],
                                        'kind':'unintended_surface_contact' if za==zb else 'solid_interference'})
                if collisions: break
            if collisions or certified>0 or intervals>=max_intervals: break
            intervals=min(intervals*2,max_intervals)
        status='fail' if collisions else 'pass' if certified>0 else 'unverified'
        return {'status':status,'method':'NVIDIA BRep Z sections + GEOS planar motion clearance',
            'engine':'nvidia-usd-brep','cadqueryUsed':False,'ratio':ratio,'motionLaw':{'sun':1,'ring':0,'carrier':1/ratio,'planet':1/ratio-zs/zp*(1-1/ratio)},
            'inputCycleDeg':period,'fullCarrierCycleInputDeg':360*ratio,'symmetryRepeats':(360*ratio)/period,
            'sampleCount':intervals+1,'sectionToleranceMm':section_tolerance,'minimumSampledClearanceMm':minimum,
            'intervalClearanceLowerEstimateMm':certified,'worstPair':worst,'collisions':collisions[:20],
            'pairTests':checked,'axialLayers':len(layers),'durationMs':(time.perf_counter()-start)*1000,
            'coverage':'Supported rigid Z-extruded planetary prototype. Curve discretization plus rigid-motion speed bounds; not a general 3D numerical dynamics or surface Hausdorff proof.'}
    except (ImportError,ValueError,RuntimeError) as error:
        return {'status':'unverified','engine':'nvidia-usd-brep','message':str(error),'durationMs':(time.perf_counter()-start)*1000}
