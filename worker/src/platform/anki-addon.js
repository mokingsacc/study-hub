// The Study Hub add-on for desktop Anki (Settings > Link your Anki): a .ankiaddon file made for one person, with
// their hub address and push key already inside, so installing it is the whole set-up. After every Anki sync (so
// reviews done on the phone count too, once they reach the computer through AnkiWeb) and from Tools > Study Hub,
// it sends copies of changed cards and new reviews to POST /api/p/anki/push (cards.js ingestAnki). It never changes
// anything in Anki. A .ankiaddon is a plain zip; addonZip stores the files uncompressed.

// Python's except keyword goes in as ${EXCEPT}: SQL checks over worker/src read EXCEPT as a compound SELECT.
const EXCEPT = 'except';
const INIT_PY = String.raw`# Study Hub link: sends copies of your Anki cards and reviews to your Study Hub after every sync and from
# Tools > Study Hub. It only reads; it never changes anything in Anki. Reviews from your phone count once they
# reach this computer through AnkiWeb sync.
import json
import os
import re
import ssl
import time
import urllib.error
import urllib.request
from html import unescape

from aqt import gui_hooks, mw
from aqt.qt import QAction, QMenu
from aqt.utils import getText, showInfo, tooltip

HERE = os.path.dirname(os.path.abspath(__file__))
USER = os.path.join(HERE, "user_files")
CARDS_PER_PUSH = 200
REVIEWS_PER_PUSH = 500
MAX_PUSHES = 20
FIRST_DAYS = 30
busy = False


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    ${EXCEPT} Exception:
        return {}


def write_json(path, data):
    os.makedirs(USER, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def link():
    # The newer of the key that came inside the add-on and one pasted in by hand.
    packed = read_json(os.path.join(HERE, "link.json"))
    typed = read_json(os.path.join(USER, "link.json"))
    best = typed if typed.get("made", 0) > packed.get("made", 0) else packed
    hub, key = str(best.get("hub", "")).rstrip("/"), str(best.get("key", ""))
    return (hub, key) if hub.startswith("https://") and key.startswith("pk_") else (None, None)


def state_path(hub):
    return os.path.join(USER, "state-" + re.sub(r"[^a-z0-9]+", "-", hub.lower()) + ".json")


TAG = re.compile(r"<[^>]+>")


def plain(s):
    s = re.sub(r"(?i)<br\s*/?>|</div>|</p>|</li>", "\n", s or "")
    s = re.sub(r"\[sound:[^\]]*\]", "", s)
    s = unescape(TAG.sub("", s))
    return re.sub(r"\n\s*\n+", "\n", s).strip()[:590]


def cloze(text, ord_):
    n = str(ord_ + 1)
    hidden = re.sub(r"\{\{c" + n + r"::(.*?)(?:::[^}]*)?\}\}", "[...]", text)
    shown = re.sub(r"\{\{c\d+::(.*?)(?:::[^}]*)?\}\}", r"\1", hidden)
    answers = re.findall(r"\{\{c" + n + r"::(.*?)(?:::[^}]*)?\}\}", text)
    return plain(shown), plain("; ".join(answers))


def schedule(ctype, queue, due, odue, odid, today):
    if ctype == 0:
        return "new"
    if ctype in (1, 3):
        return "learning"
    days = (odue if odid and odue else due) - today
    if days > 0:
        return "due in %d days" % days
    if days == 0:
        return "due today"
    return "overdue by %d days" % -days


def collect(st):
    col = mw.col
    today = col.sched.today
    is_cloze = {}
    batches = []
    cmod, cid = st.get("card_mod", 0), st.get("card_id", 0)
    for _ in range(MAX_PUSHES):
        rows = col.db.all(
            "select c.id, c.ord, c.type, c.queue, c.due, c.odue, c.odid, c.did, c.reps, c.lapses, c.mod, n.flds, n.tags, n.mid "
            "from cards c join notes n on n.id = c.nid where c.mod > ? or (c.mod = ? and c.id > ?) order by c.mod, c.id limit ?",
            cmod, cmod, cid, CARDS_PER_PUSH)
        if not rows:
            break
        cards = []
        for (id_, ord_, ctype, queue, due, odue, odid, did, reps, lapses, mod, flds, tags, mid) in rows:
            if mid not in is_cloze:
                m = col.models.get(mid)
                is_cloze[mid] = bool(m and m.get("type") == 1)
            fields = flds.split("\x1f")
            if is_cloze[mid]:
                q, a = cloze(fields[0], ord_)
            else:
                q, a = plain(fields[0]), plain(fields[1] if len(fields) > 1 else "")
            cards.append({"card_id": id_, "question": q, "answer": a, "deck": col.decks.name(odid or did),
                          "tags": tags.split()[:40], "schedule": schedule(ctype, queue, due, odue, odid, today),
                          "suspended": queue == -1, "reps": reps, "lapses": lapses})
        cmod, cid = rows[-1][10], rows[-1][0]
        batches.append(({"card_stats": cards}, {"card_mod": cmod, "card_id": cid}))
        if len(rows) < CARDS_PER_PUSH:
            break
    since = st.get("review_ms") or int((time.time() - FIRST_DAYS * 86400) * 1000)
    for _ in range(MAX_PUSHES):
        rows = col.db.all("select id, cid, ease, time from revlog where id > ? and ease between 1 and 4 order by id limit ?",
                          since, REVIEWS_PER_PUSH)
        if not rows:
            break
        revs = [{"card_id": c, "at": i, "rating": e, "duration_ms": t} for (i, c, e, t) in rows]
        since = rows[-1][0]
        batches.append(({"card_reviews": revs}, {"review_ms": since}))
        if len(rows) < REVIEWS_PER_PUSH:
            break
    return batches


def context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    ${EXCEPT} Exception:
        return ssl.create_default_context()


def post(hub, key, body):
    req = urllib.request.Request(hub + "/api/p/anki/push", data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + key,
                                          "User-Agent": "StudyHubAnki/1"})
    with urllib.request.urlopen(req, timeout=40, context=context()) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def send(hub, key, batches):
    done, cards, reviews, err = [], 0, 0, None
    for body, cursor in batches:
        try:
            out = post(hub, key, body)
        ${EXCEPT} urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode("utf-8")).get("error")
            ${EXCEPT} Exception:
                err = None
            err = err or ("The hub said no (%d)." % e.code)
            break
        ${EXCEPT} Exception as e:
            err = "Could not reach your Study Hub: %s" % e
            break
        cards += out.get("cards", 0)
        reviews += out.get("reviews", 0)
        done.append(cursor)
    return done, cards, reviews, err


def run(loud=False):
    global busy
    if busy or not mw.col:
        return
    hub, key = link()
    if not hub:
        if loud:
            set_link()
        return
    path = state_path(hub)
    st = read_json(path)
    batches = collect(st)
    if not batches:
        if loud:
            tooltip("Study Hub: nothing new to send.")
        return
    busy = True

    def finished(fut):
        global busy
        busy = False
        try:
            done, cards, reviews, err = fut.result()
        ${EXCEPT} Exception as e:
            done, cards, reviews, err = [], 0, 0, str(e)
        for cursor in done:
            st.update(cursor)
        if done:
            st["sent_at"] = int(time.time())
            write_json(path, st)
        if err:
            (showInfo if loud else tooltip)("Study Hub: " + err)
        elif loud or cards or reviews:
            tooltip("Study Hub: sent %d cards and %d reviews." % (cards, reviews))

    mw.taskman.run_in_background(lambda: send(hub, key, batches), finished)


def set_link():
    hub, _ = link()
    h, ok = getText("Your Study Hub address (from Settings > Link your Anki):", default=hub or "https://")
    if not ok:
        return
    k, ok = getText("Your Anki key (starts with pk_):")
    if not ok:
        return
    h, k = h.strip().rstrip("/"), k.strip()
    if not h.startswith("https://") or not k.startswith("pk_"):
        showInfo("That does not look right. The address starts with https:// and the key with pk_.")
        return
    write_json(os.path.join(USER, "link.json"), {"hub": h, "key": k, "made": int(time.time() * 1000)})
    run(loud=True)


def about():
    hub, _ = link()
    st = read_json(state_path(hub)) if hub else {}
    when = time.strftime("%d %b %Y, %H:%M", time.localtime(st["sent_at"])) if st.get("sent_at") else "not yet"
    showInfo("Study Hub link\n\nHub: %s\nLast sent: %s\n\nIt sends after every sync. Sync your phone first, then "
             "this computer, and your phone's reviews count too. It only reads; nothing in Anki changes." % (hub or "not set", when))


def setup_menu():
    menu = QMenu("Study Hub", mw)
    for label, fn in (("Send to Study Hub now", lambda: run(loud=True)), ("Change hub address or key", set_link),
                      ("About the link", about)):
        a = QAction(label, mw)
        a.triggered.connect(fn)
        menu.addAction(a)
    mw.form.menuTools.addMenu(menu)


setup_menu()
gui_hooks.sync_did_finish.append(lambda: run(loud=False))
def later():
    if hasattr(mw.progress, "single_shot"):
        mw.progress.single_shot(4000, lambda: run(loud=False))
    else:
        mw.progress.timer(4000, lambda: run(loud=False), False)


gui_hooks.profile_did_open.append(later)
`;

const MANIFEST = { package: 'study_hub_link', name: 'Study Hub link' };

/** The add-on's files for one person: {name: text}. */
export function addonFiles({ hub, key, made }) {
  return {
    '__init__.py': INIT_PY,
    'manifest.json': JSON.stringify(MANIFEST),
    'link.json': JSON.stringify({ hub, key, made }),
    'config.md': 'Study Hub link. Tools > Study Hub sends now, changes the hub address or key, and shows when it last sent.\n',
  };
}

// ------------------------------------------------------------------ a zip with stored (uncompressed) entries
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** files {name: string | Uint8Array} -> Uint8Array of a zip archive. */
export function zipStore(files) {
  const enc = new TextEncoder();
  const DOS_TIME = 0, DOS_DATE = (46 << 9) | (1 << 5) | 1;   // 1 Jan 2026: a fixed stamp keeps the bytes repeatable
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const nm = enc.encode(name), data = typeof body === 'string' ? enc.encode(body) : body, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, DOS_TIME, true); lh.setUint16(12, DOS_DATE, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, DOS_TIME, true); ch.setUint16(14, DOS_DATE, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nm.length, true);
    ch.setUint32(42, offset, true);
    locals.push(new Uint8Array(lh.buffer), nm, data);
    centrals.push(new Uint8Array(ch.buffer), nm);
    offset += 30 + nm.length + data.length;
  }
  const cdSize = centrals.reduce((n, a) => n + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, centrals.length / 2, true); end.setUint16(10, centrals.length / 2, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The person's .ankiaddon as base64 (for a JSON reply). */
export function addonBase64(link) {
  const bytes = zipStore(addonFiles(link));
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
