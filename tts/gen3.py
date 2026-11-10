# Regenerate all clips with Microsoft neural voices (no trimming filters), verify each with speech recognition, retry bad ones.
import json, os, re, asyncio, sys, edge_tts
from faster_whisper import WhisperModel
V={"us":{"n":"en-US-AvaNeural","m1":"en-US-AndrewNeural","m2":"en-US-BrianNeural","f2":"en-US-EmmaNeural"},
   "uk":{"n":"en-GB-SoniaNeural","m1":"en-GB-RyanNeural","m2":"en-GB-ThomasNeural","f2":"en-GB-LibbyNeural"}}
FIX=[("Al-Jumhuriya","Al Jumhooriya"),("Al-Ashar","Al Ashar"),("Al-Jazair","Al Jazaa-ir"),("8:00","8 o'clock"),("4:00","4 o'clock")]
clips=json.load(open('clips.json')); os.makedirs('mp3v2',exist_ok=True)
model=WhisperModel("base.en",device="cpu",compute_type="int8")
NUM={'zero':'0','one':'1','two':'2','three':'3','four':'4','five':'5','six':'6','seven':'7','eight':'8','nine':'9','ten':'10','fifteen':'15','twenty':'20','thirty':'30','forty':'40','fifty':'50','thousand':'000'}
def toks(s):
    s=s.lower().replace("’","'"); s=re.sub(r"(\d+):(\d\d)",r"\1 \2",s); s=re.sub(r"[^a-z0-9' ]+"," ",s.replace('-',' '))
    return [NUM.get(w,w) for w in s.split() if w not in ('al','jumhuriya','jumhooriya','ashar','jazair','00','o','clock',"o'clock")]
def score(exp,got):
    E,G=toks(exp),toks(got); used=[False]*len(G); hit=0
    for w in E:
        for i,g in enumerate(G):
            if not used[i] and (g==w or (len(w)>3 and g.startswith(w[:4]))): used[i]=True; hit+=1; break
    return hit/max(1,len(E))
async def synth(text,voice,path):
    for a in range(4):
        try:
            await edge_tts.Communicate(text,voice,rate="-3%").save(path)
            if os.path.getsize(path)>800: return True
        except Exception as e: await asyncio.sleep(3+a*3)
    return False
async def main():
    sem=asyncio.Semaphore(2); bad=[]
    async def one(acc,cid,text,role):
        t=text
        for a,b in FIX: t=t.replace(a,b)
        out=f"mp3v2/{acc}_{cid}.mp3"
        best=(-1,None)
        for attempt in range(3):
            async with sem: ok=await synth(t,V[acc][role],out+".tmp")
            if not ok: continue
            segs,_=model.transcribe(out+".tmp",language="en",beam_size=1)
            heard=" ".join(s.text for s in segs)
            sc=score(text,heard) if len(toks(text))>0 else 1
            if sc>best[0]:
                best=(sc,heard); os.replace(out+".tmp",out)
            if sc>=0.9: break
        if best[0]<0.9: bad.append((acc,cid,round(best[0],2),text,best[1]))
    await asyncio.gather(*[one(a,c,t,r) for a in ("us","uk") for c,(t,r) in clips.items()])
    with open('verify.log','w') as f:
        f.write(f"clips {len(os.listdir('mp3v2'))} below 0.9: {len(bad)}\n")
        for b in bad: f.write(repr(b)+"\n")
    # diagnosis of the previous batch
    with open('diag.log','w') as f:
        for c,(t,r) in clips.items():
            if not c.startswith('dl_home'): continue
            for acc in ('us','uk'):
                p=f"mp3n/{acc}_{c}.mp3"
                if os.path.exists(p):
                    h=" ".join(s.text for s in model.transcribe(p,language="en",beam_size=1)[0])
                    f.write(f"{acc} {c} {round(score(t,h),2)} | {t} | {h}\n")
asyncio.run(main())
