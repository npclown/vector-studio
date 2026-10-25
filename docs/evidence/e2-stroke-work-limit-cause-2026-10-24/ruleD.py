# Diagnostic: rule D (curvature-bound band rule via Schur's chord lemma), leaf counts.
import json, math, sys, collections, statistics
exec(open(__import__("os").path.join(__import__("os").path.dirname(__file__), "leaves.py")).read().split("out=[]")[0].replace("scene = json.load(open(sys.argv[1]))",""))
def acceptD(Q,r,tol):
    delta,V,D,a,b=metrics(Q)
    if a<=0: return None
    lv=nrm(V); c2=2*max(nrm(sub(D[1],D[0])),nrm(sub(D[2],D[1])))
    K=c2*lv*lv/(a*a)
    if r*K>0.5: return None
    lc=(nrm(D[0])+nrm(D[1])+nrm(D[2]))/3
    KO=K/(1-r*K); lo=lc*(1+r*K)
    if KO*lo>math.pi: return False
    return KO*lo*lo/8<=tol
def leavesD(Q,r,tol,depth=0):
    ok=acceptD(Q,r,tol)
    if ok is None: ok=acceptA(Q,r,tol)
    if ok: return 1
    if depth>=20: return math.inf
    L,R=split(Q); return leavesD(L,r,tol,depth+1)+leavesD(R,r,tol,depth+1)
scene=json.load(open(sys.argv[1])); prev={x[0]:x for x in json.load(open(sys.argv[2]))}
B=[0,0.0625,0.25,1,4,16,1e9]; g=collections.defaultdict(list)
for p in scene:
    if p["i"]%4==3: continue
    pts=p["points"]; tol=2.0**p["e"]; r=p["width"]/2
    P=[(pts[k],pts[k+1]) for k in range(0,len(pts),2)]
    cur=P[0]; cc=0; k=1
    for v in p["verbs"][1:]:
        if v==2:
            Q=(cur,P[k],P[k+1],P[k+2]); k+=3; cur=Q[3]; cc+=leavesD(Q,r,tol)
    i,w,R,a,b=prev[p["i"]]
    for j in range(len(B)-1):
        if w<B[j+1]: g[B[j]].append((a,cc)); break

for kk in sorted(g):
    L=g[kk]
    print(f"devw>={kk}: n={len(L)} | D median {statistics.median(x[1] for x in L)} | D<=170 {sum(x[1]<=170 for x in L)} | L1+D<=512 {sum(x[1]<=512 for x in L)}")
