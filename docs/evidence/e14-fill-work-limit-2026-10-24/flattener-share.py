# E14 flattener-share mirror (scratch analysis, 2026-10-24). Usage: python3 flattener-share.py <dir>
# <dir> holds scene.json (the E11-U2 scene: index, verbs, points, e, zoom, dpr) and
# fill_out_4096.txt (the native diagnostic's JSON lines; only flatVerbs is read, which the
# sizing pass reports independently of the cap). Covers the first 400 scene paths.
import json,math,sys,collections
S=sys.argv[1]
scene=json.load(open(S+'/scene.json'))
rows={json.loads(l)['id']:json.loads(l) for l in open(S+'/fill_out_4096.txt') if l.startswith('{')}
def binary(c,tol):
  p0,p1,p2,p3=c
  q1=(p1[0]-(p0[0]+(p3[0]-p0[0])/3),p1[1]-(p0[1]+(p3[1]-p0[1])/3))
  q2=(p2[0]-(p0[0]+2*(p3[0]-p0[0])/3),p2[1]-(p0[1]+2*(p3[1]-p0[1])/3))
  if max(math.hypot(*q1),math.hypot(*q2))<=tol: return 1
  m=lambda a,b:((a[0]+b[0])/2,(a[1]+b[1])/2)
  p01,p12,p23=m(p0,p1),m(p1,p2),m(p2,p3);p012,p123=m(p01,p12),m(p12,p23);mid=m(p012,p123)
  return binary((p0,p01,p012,mid),tol)+binary((mid,p123,p23,p3),tol)
def ev(c,t):
  u=1-t;return tuple(u**3*c[0][i]+3*u*u*t*c[1][i]+3*u*t*t*c[2][i]+t**3*c[3][i] for i in (0,1))
def segdist(p,a,b):
  dx,dy=b[0]-a[0],b[1]-a[1];L=dx*dx+dy*dy
  t=0 if L==0 else max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/L))
  return math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy)
def uniform_min(c,tol):
  # smallest n so each uniform-in-t chord is within tol (16 samples per chord)
  # Wang's formula upper bound as start
  M=max(math.hypot(c[0][0]-2*c[1][0]+c[2][0],c[0][1]-2*c[1][1]+c[2][1]),math.hypot(c[1][0]-2*c[2][0]+c[3][0],c[1][1]-2*c[2][1]+c[3][1]))
  wang=max(1,math.ceil(math.sqrt(0.75*M/tol)))
  for n in range(1,wang+1):
    ok=True
    for k in range(n):
      a,b=ev(c,k/n),ev(c,(k+1)/n)
      if any(segdist(ev(c,(k+j/16)/n),a,b)>tol for j in range(1,16)): ok=False;break
    if ok: return n,wang
  return wang,wang
agg=collections.defaultdict(lambda:[0,0,0,0,0])
for p in scene[:400]:
  pts=p['points'];tol=2.0**p['e']
  cubics=[];cur=(pts[0],pts[1])
  for k in range(32):
    o=2+6*k;c=(cur,(pts[o],pts[o+1]),(pts[o+2],pts[o+3]),(pts[o+4],pts[o+5]));cubics.append(c);cur=c[3]
  b=sum(binary(c,tol) for c in cubics)
  um=[uniform_min(c,tol) for c in cubics]
  u=sum(x[0] for x in um); w=sum(x[1] for x in um)
  R=max(math.hypot(x,y) for x,y in zip(pts[0::2],pts[1::2]))
  ideal=math.pi*math.sqrt(R/(2*tol))  # circle of the max radius
  key=('loop' if p['i']%4==3 else 'smooth', int(math.log2(max(R*p['zoom']*p['dpr'],0.5))))
  a=agg[key];a[0]+=1;a[1]+=b;a[2]+=u;a[3]+=w;a[4]+=rows[str(p['i'])]['flatVerbs']
for k in sorted(agg):
  n,b,u,w,f=agg[k]
  print(k,'n=%d kernel=%.0f pyBinary=%.0f wang=%.0f uniformMin=%.0f  ratio kernel/uniformMin=%.2f'%(n,f/n,b/n,w/n,u/n,(f/n)/(u/n)))
