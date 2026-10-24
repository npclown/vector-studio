# Diagnostic: idealized band rule C (sampled true offset deviation, no fold), leaf counts.
import json, math, sys, collections, statistics
sys.setrecursionlimit(10000)
exec(open(__import__("os").path.join(__import__("os").path.dirname(__file__), "leaves.py")).read().split("out=[]")[0].replace("scene = json.load(open(sys.argv[1]))",""))
def ev(Q,t):
    a,b,c,d=Q; mt=1-t
    p=tuple(mt**3*a[i]+3*mt*mt*t*b[i]+3*mt*t*t*c[i]+t**3*d[i] for i in range(2))
    dp=tuple(3*mt*mt*(b[i]-a[i])+6*mt*t*(c[i]-b[i])+3*t*t*(d[i]-c[i]) for i in range(2))
    ddp=tuple(6*mt*(c[i]-2*b[i]+a[i])+6*t*(d[i]-2*c[i]+b[i]) for i in range(2))
    return p,dp,ddp
def segdist(p,a,b):
    ab=sub(b,a); L=dot(ab,ab)
    u=0 if L==0 else max(0,min(1,dot(sub(p,a),ab)/L))
    return nrm(sub(p,(a[0]+u*ab[0],a[1]+u*ab[1])))
def acceptC(Q,r,tol):
    delta,V,D,a,b=metrics(Q)
    if a<=0: return None
    ts=[k/16 for k in range(17)]; O=[]
    for t in ts:
        p,dp,ddp=ev(Q,t); s=nrm(dp)
        if s==0: return None
        k=abs(cr(dp,ddp))/s**3
        if r*k>0.9: return None
        n=(-dp[1]/s,dp[0]/s); O.append((p,(p[0]+r*n[0],p[1]+r*n[1]),(p[0]-r*n[0],p[1]-r*n[1])))
    for j in range(3):
        a0,a1=O[0][j],O[-1][j]
        if max(segdist(o[j],a0,a1) for o in O)>tol: return False
    return True
def leavesC(Q,r,tol,depth=0):
    ok=acceptC(Q,r,tol)
    if ok is None: ok=acceptA(Q,r,tol)
    if ok: return 1
    if depth>=20: return math.inf
    L,R=split(Q); return leavesC(L,r,tol,depth+1)+leavesC(R,r,tol,depth+1)
scene=json.load(open(sys.argv[1])); prev={x[0]:x for x in json.load(open(sys.argv[2]))}
B=[0,0.0625,0.25,1,4,16,1e9]; g=collections.defaultdict(list)
for p in scene:
    if p["i"]%4==3: continue
    pts=p["points"]; tol=2.0**p["e"]; r=p["width"]/2
    P=[(pts[k],pts[k+1]) for k in range(0,len(pts),2)]
    cur=P[0]; cc=0; k=1
    for v in p["verbs"][1:]:
        if v==2:
            Q=(cur,P[k],P[k+1],P[k+2]); k+=3; cur=Q[3]; cc+=leavesC(Q,r,tol)
    i,w,R,a,b=prev[p["i"]]
    for j in range(len(B)-1):
        if w<B[j+1]: g[B[j]].append((a,b,cc,R)); break
for kk in sorted(g):
    L=g[kk]; n=len(L)
    cnt=lambda f: sum(1 for x in L if f(x))
    print(f"devw>={kk}: n={n} | A<=170 {cnt(lambda x:x[0]<=170)} | L1: A<=512 {cnt(lambda x:x[0]<=512)} | L1+C<=512 {cnt(lambda x:x[2]<=512)} | C median {statistics.median(x[2] for x in L)} | radius median {statistics.median(x[3] for x in L):.0f}")
