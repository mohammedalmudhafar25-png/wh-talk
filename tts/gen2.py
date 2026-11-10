import json, os, asyncio, subprocess, sys, edge_tts
PROXY=os.environ.get('HTTPS_PROXY')
V={"us":{"n":"en-US-AvaNeural","m1":"en-US-AndrewNeural","m2":"en-US-BrianNeural","f2":"en-US-EmmaNeural"},
   "uk":{"n":"en-GB-SoniaNeural","m1":"en-GB-RyanNeural","m2":"en-GB-ThomasNeural","f2":"en-GB-LibbyNeural"}}
FIX=[("Al-Jumhuriya","Al Jumhooriya"),("Al-Ashar","Al Ashar"),("Al-Jazair","Al Jazaa-ir"),("8:00","8 o'clock"),("4:00","4 o'clock"),("4 o'clock","4 o'clock")]
clips=json.load(open('clips.json'))
sem=asyncio.Semaphore(6)
async def one(acc,cid,text,role):
    out=f"mp3n/{acc}_{cid}.mp3"
    if os.path.exists(out) and os.path.getsize(out)>1000: return
    t=text
    for a,b in FIX: t=t.replace(a,b)
    raw=f"/tmp/raw_{acc}_{cid}.mp3"
    async with sem:
        for attempt in range(4):
            try:
                await edge_tts.Communicate(t,V[acc][role],proxy=PROXY).save(raw)
                if os.path.getsize(raw)>500: break
            except Exception as e:
                await asyncio.sleep(2+attempt*3)
        else:
            print('FAIL',acc,cid,flush=True);return
    # trim edges, normalise loudness, mono 40k
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i",raw,"-af",
      "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08,areverse,loudnorm=I=-16:TP=-1.5:LRA=11,adelay=60",
      "-ac","1","-ar","24000","-b:a","48k",out])
    os.remove(raw)
async def main(accs):
    jobs=[one(a,cid,t,r) for a in accs for cid,(t,r) in clips.items()]
    await asyncio.gather(*jobs)
    print('DONE',len(os.listdir('mp3n')),flush=True)
asyncio.run(main(sys.argv[1:] or ['us','uk']))
