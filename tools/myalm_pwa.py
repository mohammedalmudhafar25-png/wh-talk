#!/usr/bin/env python3
"""MYALM App Packer — make any MYALM lesson work on every phone, forever.

  python3 tools/myalm_pwa.py web <lesson-folder> [<lesson-folder> ...]
      Turns a lesson folder of this repo into an installable offline app:
      manifest.webmanifest, icon-192/512.png, sw.js (offline cache) and the
      MYALM app layer injected into index.html (and any other .html page there).

  python3 tools/myalm_pwa.py all
      Same for every lesson folder in the repo (skips redirect-only folders).

  python3 tools/myalm_pwa.py offline <in.html> <out.html> --web <app-url>
      Hardens a single-file offline lesson (the WhatsApp/USB copy): recording via
      the phone recorder when the mic is blocked, clean speech-check fallback,
      and a "Get the app" button that opens <app-url>.

Re-running is safe: the injected block is replaced, never duplicated.
Also repairs a damaged embedded MYALM logo (PNG with bad checksums).
"""
import base64, hashlib, html, io, json, os, re, struct, sys, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PAGES = 'https://mohammedalmudhafar25-png.github.io/wh-talk/'
SHIM = open(os.path.join(HERE, 'myalm-app.js'), encoding='utf-8').read()
SW = open(os.path.join(HERE, 'sw-template.js'), encoding='utf-8').read()
LOGO = open(os.path.join(HERE, 'myalm-logo.png'), 'rb').read()
BEGIN, END = '<!--MYALM-APP v1-->', '<!--/MYALM-APP-->'
SKIP_DIRS = {'pack', '.git', 'tools'}
MAX_MEDIA = 60 * 1024 * 1024   # skip single files above this from offline precache


def png_ok(d):
    if d[:8] != b'\x89PNG\r\n\x1a\n':
        return False
    i = 8
    while i + 12 <= len(d):
        ln = struct.unpack('>I', d[i:i + 4])[0]
        if i + 12 + ln > len(d):
            return False
        if struct.unpack('>I', d[i + 8 + ln:i + 12 + ln])[0] != zlib.crc32(d[i + 4:i + 8 + ln]):
            return False
        if d[i + 4:i + 8] == b'IEND':
            return True
        i += 12 + ln
    return False


def repair_logo(s):
    """Replace damaged embedded PNGs that have the MYALM logo's exact size with the good logo."""
    lw, lh = struct.unpack('>II', LOGO[16:24])
    good = base64.b64encode(LOGO).decode()
    fixed = 0

    def sub(m):
        nonlocal fixed
        try:
            d = base64.b64decode(m.group(1) + '=' * (-len(m.group(1)) % 4))
        except Exception:
            return m.group(0)
        if len(d) > 24 and d[:8] == b'\x89PNG\r\n\x1a\n' and struct.unpack('>II', d[16:24]) == (lw, lh) and not png_ok(d):
            fixed += 1
            return 'data:image/png;base64,' + good
        return m.group(0)
    s = re.sub(r'data:image/png;base64,([A-Za-z0-9+/=]{2000,})', sub, s)
    return s, fixed


def page_icon(s):
    for pat in (r'rel="apple-touch-icon"[^>]*href="data:image/png;base64,([^"]+)"',
                r'rel="icon"[^>]*href="data:image/png;base64,([^"]+)"'):
        m = re.search(pat, s)
        if m:
            d = base64.b64decode(m.group(1) + '=' * (-len(m.group(1)) % 4))
            if png_ok(d):
                return d
    return LOGO


def make_icons(src, folder):
    from PIL import Image
    im = Image.open(io.BytesIO(src)).convert('RGBA')
    bb = im.getbbox()
    if bb:
        im = im.crop(bb)
    for size in (192, 512):
        canvas = Image.new('RGBA', (size, size), (255, 255, 255, 255))
        box = int(size * 0.70)                       # inside the maskable safe zone
        t = im.copy(); t.thumbnail((box, box), Image.LANCZOS)
        canvas.paste(t, ((size - t.width) // 2, (size - t.height) // 2), t)
        canvas.convert('RGB').save(os.path.join(folder, 'icon-%d.png' % size), optimize=True)


def head_block(web_url, manifest, theme, add_apple):
    parts = [BEGIN]
    if web_url:
        parts.append('<meta name="myalm-web" content="%s">' % html.escape(web_url, quote=True))
    if manifest:
        parts.append('<link rel="manifest" href="manifest.webmanifest">')
    if theme:
        parts.append('<meta name="theme-color" content="%s">' % theme)
    if add_apple:
        parts.append('<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">'
                     '<link rel="apple-touch-icon" href="icon-192.png">')
    parts.append('<script>' + SHIM + '</script>')
    parts.append(END)
    return ''.join(parts)


def inject(s, block):
    s = re.sub(re.escape(BEGIN) + r'.*?' + re.escape(END), '', s, flags=re.S)
    m = re.search(r'<meta\s+charset[^>]*>', s, flags=re.I) or re.search(r'<head[^>]*>', s, flags=re.I)
    if not m:
        return block + s
    return s[:m.end()] + block + s[m.end():]


def meta(s, name):
    m = re.search(r'<meta\s+name="%s"\s+content="([^"]*)"' % re.escape(name), s)
    return html.unescape(m.group(1)) if m else ''


def sha(*blobs):
    h = hashlib.sha1()
    for b in blobs:
        h.update(b if isinstance(b, bytes) else b.encode())
    return h.hexdigest()[:10]


def pack_web(folder):
    folder = folder.rstrip('/')
    name = os.path.basename(os.path.abspath(folder))
    idx = os.path.join(folder, 'index.html')
    s = open(idx, encoding='utf-8').read()
    if len(s) < 2000 and 'http-equiv="refresh"' in s:
        print('skip (redirect):', name); return
    url = PAGES + name + '/'
    s, nfix = repair_logo(s)
    s = re.sub(r'<link\s+rel="manifest"[^>]*>', '', s)   # one manifest only: ours (has 192/512 icons)
    own_manifest = False
    title = html.unescape(re.search(r'<title>(.*?)</title>', s, re.S).group(1).strip()) if '<title>' in s else name
    short = meta(s, 'apple-mobile-web-app-title') or title.split('·')[0].split('—')[0].strip()[:24]
    theme = meta(s, 'theme-color') or '#1E2A5A'
    make_icons(page_icon(s), folder)
    man = {'name': title, 'short_name': short, 'id': './', 'start_url': './', 'scope': './',
           'display': 'standalone', 'orientation': 'any', 'background_color': '#FFFFFF', 'theme_color': theme,
           'description': meta(s, 'description') or 'MYALM Education interactive lesson',
           'icons': [{'src': 'icon-192.png', 'sizes': '192x192', 'type': 'image/png', 'purpose': 'any'},
                     {'src': 'icon-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any'},
                     {'src': 'icon-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'}]}
    with open(os.path.join(folder, 'manifest.webmanifest'), 'w', encoding='utf-8') as f:
        json.dump(man, f, ensure_ascii=False, indent=1)
    block = head_block(url, not own_manifest, None if meta(s, 'theme-color') else theme,
                       'apple-touch-icon' not in s)
    pages = []
    for fn in sorted(os.listdir(folder)):
        if fn.endswith('.html'):
            p = os.path.join(folder, fn)
            t = s if fn == 'index.html' else open(p, encoding='utf-8').read()
            if fn != 'index.html':
                t, n2 = repair_logo(t); nfix += n2
            t = inject(t, block)
            open(p, 'w', encoding='utf-8').write(t)
            pages.append(fn)
    shell = ['./'] + pages + ['manifest.webmanifest', 'icon-192.png', 'icon-512.png']
    if own_manifest and os.path.exists(os.path.join(folder, 'manifest.json')):
        shell.append('manifest.json')
    media, big = [], []
    for root, dirs, files in os.walk(folder):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for fn in sorted(files):
            rel = os.path.relpath(os.path.join(root, fn), folder).replace(os.sep, '/')
            if rel in shell or rel == 'sw.js' or fn.endswith(('.zip', '.md', '.py')):
                continue
            if os.path.getsize(os.path.join(root, fn)) > MAX_MEDIA:
                big.append(rel); continue
            media.append(rel)
    hs = sha(*[open(os.path.join(folder, f), 'rb').read() for f in shell if f != './'], SW, SHIM)
    hm = sha(*[f + str(os.path.getsize(os.path.join(folder, f))) + sha(open(os.path.join(folder, f), 'rb').read()) for f in media])
    sw = (SW.replace('__APP__', 'myalm-' + name).replace('__SHELL__', hs).replace('__MEDIA__', hm)
            .replace('__SHELL_FILES__', json.dumps(shell)).replace('__MEDIA_FILES__', json.dumps(media)))
    open(os.path.join(folder, 'sw.js'), 'w', encoding='utf-8').write(sw)
    mb = sum(os.path.getsize(os.path.join(folder, f)) for f in shell[1:] + media) / 1e6
    print('app ready: %-28s pages=%s media=%d offline=%.1f MB logo-fixes=%d%s' %
          (name, pages, len(media), mb, nfix, (' SKIPPED-BIG=%s' % big) if big else ''))


def pack_offline(src, dst, web_url):
    s = open(src, encoding='utf-8').read()
    s, nfix = repair_logo(s)
    s = inject(s, head_block(web_url, False, None, False))
    open(dst, 'w', encoding='utf-8').write(s)
    print('offline copy ready:', dst, '%.1f MB' % (len(s.encode()) / 1e6), 'logo-fixes=%d' % nfix)


if __name__ == '__main__':
    a = sys.argv[1:]
    if not a:
        print(__doc__); sys.exit(1)
    if a[0] == 'web':
        for f in a[1:]:
            pack_web(f)
    elif a[0] == 'all':
        for d in sorted(os.listdir(REPO)):
            p = os.path.join(REPO, d)
            if os.path.isdir(p) and d not in SKIP_DIRS and os.path.exists(os.path.join(p, 'index.html')):
                pack_web(p)
    elif a[0] == 'offline':
        web = a[a.index('--web') + 1] if '--web' in a else ''
        pack_offline(a[1], a[2], web)
    else:
        print(__doc__); sys.exit(1)
