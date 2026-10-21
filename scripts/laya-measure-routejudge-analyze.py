import json
d=json.load(open('/tmp/laya-measure/out.json'))
ok=[o for o in d['out'] if 'local' in o]
lat=sorted(d['lat']); print('n',len(ok),'err',len(d['out'])-len(ok),'lat p50',lat[len(lat)//2],'p95',lat[int(len(lat)*.95)])
def conf(a):
    if 'noul' in a: return max(a['noul'],1-a['noul'])
    return max((a.get('probabilities') or {'x':0}).values())
def same(t,l):
    return t.get('choice')==l.get('choice') if t['type']=='choice' else (t['noul']>.5)==(l.get('noul',0)>.5)
for q in ('tier','route','ambiguous','wrong_reading_costly'):
    pts=[(conf(o['local'][q]),same(o['teacher'][q],o['local'][q])) for o in ok if q in o['local'] and q in o['teacher']]
    if not pts: continue
    base=sum(s for _,s in pts)/len(pts)
    curve=[]
    for th in (.5,.6,.7,.8,.9):
        sub=[s for c,s in pts if c>=th]
        if sub: curve.append(f"≥{th}:{len(sub)/len(pts):.0%}覆蓋/{sum(sub)/len(sub):.0%}對")
    print(q,f"整體 {base:.0%}（n={len(pts)}）"," ".join(curve))
# 注入層面：tier L1/L2 且 conf≥0.6 才有作用
def eff(a): 
    t=a.get('tier',{}); 
    return t.get('choice') if t and conf(t)>=0.6 and t.get('choice') in ('L1','L2') else None
e=[(eff(o['teacher']),eff(o['local'])) for o in ok]
print('注入同(tier 作用)', f"{sum(a==b for a,b in e)/len(e):.0%}", 'teacher有作用',sum(a is not None for a,_ in e),'laya有作用',sum(b is not None for _,b in e))
