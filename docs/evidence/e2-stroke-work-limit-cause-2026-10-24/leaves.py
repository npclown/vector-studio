# Diagnostic projection only: leaf counts per scene stroke under the current leaf rule (A)
# and a candidate band rule (B, with fallback to A on folded leaves). Float64, no guards.
import json, math, sys, collections, statistics
scene = json.load(open(sys.argv[1]))
def sub(a,b): return (a[0]-b[0],a[1]-b[1])
def dot(a,b): return a[0]*b[0]+a[1]*b[1]
def cr(a,b): return a[0]*b[1]-a[1]*b[0]
def nrm(a): return math.hypot(*a)
def split(Q):
    m=lambda a,b:((a[0]+b[0])/2,(a[1]+b[1])/2)
    a,b,c,d=Q; ab,bc,cd=m(a,b),m(b,c),m(c,d); abc,bcd=m(ab,bc),m(bc,cd); x=m(abc,bcd)
    return (a,ab,abc,x),(x,bcd,cd,d)
def metrics(Q):
    Q0,Q1,Q2,Q3=Q
    q1=sub(Q1,((2*Q0[0]+Q3[0])/3,(2*Q0[1]+Q3[1])/3)); q2=sub(Q2,((Q0[0]+2*Q3[0])/3,(Q0[1]+2*Q3[1])/3))
    delta=max(nrm(q1),nrm(q2)); V=sub(Q3,Q0)
    D=[tuple(3*x for x in sub(Q1,Q0)),tuple(3*x for x in sub(Q2,Q1)),tuple(3*x for x in sub(Q3,Q2))]
    a=min(dot(V,d) for d in D); b=max(abs(cr(V,d)) for d in D)
    return delta,V,D,a,b
def acceptA(Q,r,tol):
    delta,V,D,a,b=metrics(Q)
    if a<=0: return False
    s=min(1,b/math.hypot(a,b)); return delta+4*r*s<=tol
def acceptB(Q,r,tol):
    delta,V,D,a,b=metrics(Q)
    if a<=0: return None
    s=min(1,b/math.hypot(a,b)); alpha=math.asin(s)
    lv=nrm(V); c2=2*max(nrm(sub(D[1],D[0])),nrm(sub(D[2],D[1])))
    kup=c2*lv*lv/(a*a)          # |C''| / |C'|^2 with |C'| >= a/|V|
    if r*kup>0.5: return None   # possible fold: not a B-leaf
    lc=(nrm(D[0])+nrm(D[1])+nrm(D[2]))/3
    lo=lc+6*r*alpha             # offset length bound
    dev=lo/2*math.sin(min(math.pi/2,2*alpha))
    return dev<=tol
def leaves(Q,r,tol,rule,depth=0):
    if rule=="A": ok=acceptA(Q,r,tol)
    else:
        ok=acceptB(Q,r,tol)
        if ok is None: ok=acceptA(Q,r,tol)
    if ok: return 1
    if depth>=20: return math.inf
    L,R=split(Q); return leaves(L,r,tol,rule,depth+1)+leaves(R,r,tol,rule,depth+1)
out=[]
for p in scene:
    if p["i"]%4==3: continue
    pts=p["points"]; tol=2.0**p["e"]; r=p["width"]/2
    P=[(pts[k],pts[k+1]) for k in range(0,len(pts),2)]
    cur=P[0]; ca=cb=0; k=1
    for v in p["verbs"][1:]:
        if v==2:
            Q=(cur,P[k],P[k+1],P[k+2]); k+=3; cur=Q[3]
            ca+=leaves(Q,r,tol,"A"); cb+=leaves(Q,r,tol,"B")
    sc=p["zoom"]*p["dpr"]
    out.append((p["i"],p["width"]*sc,max(math.hypot(*q) for q in P)*sc,ca,cb))
json.dump(out,open(sys.argv[2],"w"))
B=[0,0.0625,0.25,1,4,16,1e9]
g=collections.defaultdict(list)
for i,w,R,a,b in out:
    for j in range(len(B)-1):
        if w<B[j+1]: g[B[j]].append((a,b)); break
for k in sorted(g):
    A=[x[0] for x in g[k]]; Bb=[x[1] for x in g[k]]
    fin=lambda L:[x for x in L if x!=math.inf]
    print(f"devw>={k}: n={len(A)} A median {statistics.median(A)} (<=170: {sum(x<=170 for x in A)})  B median {statistics.median(Bb)} (<=170: {sum(x<=170 for x in Bb)})")
