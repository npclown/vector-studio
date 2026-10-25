import math
def ev(P,t):
    u=1-t
    d1=[3*(u*u*(P[1][i]-P[0][i])+2*u*t*(P[2][i]-P[1][i])+t*t*(P[3][i]-P[2][i])) for i in range(2)]
    d2=[6*(u*(P[2][i]-2*P[1][i]+P[0][i])+t*(P[3][i]-2*P[2][i]+P[1][i])) for i in range(2)]
    return d1,d2
def kmax(P,n=20000):
    m=0
    for k in range(n+1):
        d1,d2=ev(P,k/n)
        s=math.hypot(*d1)
        m=max(m,abs(d1[0]*d2[1]-d1[1]*d2[0])/s**3)
    return m
def cross(a,b,c,d):
    def o(p,q,r): return (q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0])
    return o(a,b,c)*o(a,b,d)<0 and o(c,d,a)*o(c,d,b)<0
for L in [20,40]:
  for s in [6,8,9,10,12,14,16,18]:
    for h in [1,2,3,4,5,6]:
        if s>=L/2: continue
        P=[(0,0),(s,h),(L-s,h),(L,0)]
        k=kmax(P)
        for w in [2,4,6,8,10,12,16,20]:
            r=w/2
            if r*k<=1.05: continue
            d0,_=ev(P,0); d3,_=ev(P,1)
            n0=(-d0[1]/math.hypot(*d0),d0[0]/math.hypot(*d0)); n3=(-d3[1]/math.hypot(*d3),d3[0]/math.hypot(*d3))
            A=((P[0][0]-r*n0[0],P[0][1]-r*n0[1]),(P[0][0]+r*n0[0],P[0][1]+r*n0[1]))
            B=((P[3][0]-r*n3[0],P[3][1]-r*n3[1]),(P[3][0]+r*n3[0],P[3][1]+r*n3[1]))
            if cross(A[0],A[1],B[0],B[1]): continue
            print(L,s,h,w,"rk=%.3f"%(r*k))
            break
