import math,sys
exec(open(__import__("os").path.join(__import__("os").path.dirname(__file__), "ruleD.py")).read().split("scene=json.load")[0])
k=0.5522847498
def circle(R):
    P=[(R,0),(R,R*k),(R*k,R),(0,R),(-R*k,R),(-R,R*k),(-R,0),(-R,-R*k),(-R*k,-R),(0,-R),(R*k,-R),(R,-R*k),(R,0)]
    return [(P[3*i],P[3*i+1],P[3*i+2],P[3*i+3]) for i in range(4)]
for R in (16,64,256,1024):
  for w in (0.25,1,4,16):
    tol=2.0**-3; r=w/2
    a=sum(leaves(Q,r,tol,"A") for Q in circle(R)); d=sum(leavesD(Q,r,tol) for Q in circle(R))
    print(f"R={R} w={w}: A {a}  D {d}")
