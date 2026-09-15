import cadquery as cq
L,W=500,300; t=8; wd=85; ww=30
parts=[]
plate=cq.Workplane('XY').box(L-20,W,t).edges('|Z').fillet(10); parts.append(plate)
for y in (-W/2+18,W/2-18): parts.append(cq.Workplane('XY').box(L-20,12,18).translate((0,y,t/2+9)))
for x in (-170,170):
 for y in (-W/2-ww/2,W/2+ww/2): parts.append(cq.Workplane('XZ').center(x,42.5).circle(wd/2).extrude(ww).translate((0,y,0)))
for x in (-170,170):
 for y in (-W/2+22,W/2-22): parts.append(cq.Workplane('XY').box(35,32,28).translate((x,y,t/2+14)))
parts.append(cq.Workplane('XY').box(220,150,25).translate((0,0,t/2+12.5)))
assy=cq.Compound.makeCompound([p.val() for p in parts]); cq.exporters.export(assy,'/home/kkk/ai-cad/cad/ackermann/ackermann_chassis.step')
