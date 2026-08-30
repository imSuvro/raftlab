# Render the README GIF from real simulator frames (dumpframes.mts output).
# Draws the playground's two signature elements: the cluster ring and the
# log wall, using the ux.md palette.
import json, math, sys
from PIL import Image, ImageDraw, ImageFont

SRC, OUT = sys.argv[1], sys.argv[2]
d = json.load(open(SRC))
frames = d["frames"]
PART_AT, HEAL_AT = d["partitionAt"], d["healAt"]

W, H = 720, 396
BG = (14, 20, 32)
SURFACE = (22, 30, 46)
LINE = (36, 48, 74)
TEXT = (216, 225, 240)
MUTED = (132, 148, 176)
LEADER = (245, 184, 61)
FOLLOWER = (91, 141, 217)
CANDIDATE = (183, 110, 240)
DOWN = (74, 85, 104)
COMMIT = (70, 194, 142)
FAULT = (225, 96, 79)
TERM_COLORS = [(78, 127, 196), (201, 163, 78), (155, 111, 208),
               (78, 159, 184), (196, 100, 90), (63, 168, 147)]

def term_color(t): return TERM_COLORS[(t - 1) % len(TERM_COLORS)]

# The absolute window the log wall shows: spans the partition (minority
# frozen at ~79) through the majority's progress and the post-heal catch-up.
WIN_LO, WIN_HI = 62, 105
def role_color(r):
    return {"leader": LEADER, "candidate": CANDIDATE, "follower": FOLLOWER}.get(r, DOWN)

FONTS = r"C:\Windows\Fonts"
def font(name, size):
    try: return ImageFont.truetype(rf"{FONTS}\{name}", size)
    except Exception: return ImageFont.load_default()

F_CAP = font("segoeui.ttf", 15)
F_SMALL = font("consola.ttf", 12)
F_TINY = font("consola.ttf", 11)
F_NODE = font("consolab.ttf", 13)

# ring geometry (left panel)
RCX, RCY, RR = 168, 232, 108
def node_pos(i, n):
    a = -math.pi / 2 + i * 2 * math.pi / n
    return (RCX + RR * math.cos(a), RCY + RR * math.sin(a))

def dashed(dr, p, q, color, width=1, dash=6, gap=5):
    x1, y1 = p; x2, y2 = q
    dist = math.hypot(x2 - x1, y2 - y1)
    if dist == 0: return
    ux, uy = (x2 - x1) / dist, (y2 - y1) / dist
    t = 0.0
    while t < dist:
        e = min(t + dash, dist)
        dr.line([x1 + ux * t, y1 + uy * t, x1 + ux * e, y1 + uy * e], fill=color, width=width)
        t = e + gap

def group_of(f, i):
    # minority group is {0,1} in this scenario; derived from partitioned flag
    return 0 if i in (0, 1) else 1

def caption(f):
    g = f["g"]
    if g < PART_AT:
        return "Five nodes, one leader. Every write replicates to all of them.", TEXT
    if f["partitioned"]:
        return "Network split 2 | 3 — the minority can't reach a quorum, so it can't commit.", FAULT
    if g < HEAL_AT + 2000:
        return "Healed. The stale side's higher term forces a re-election.", COMMIT
    return "Reconciled. All five logs agree again, down to the last entry.", COMMIT

def render(f):
    im = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(im)

    # caption bar
    dr.rectangle([0, 0, W, 34], fill=SURFACE)
    cap, col = caption(f)
    dr.text((14, 9), cap, font=F_CAP, fill=col)
    dr.text((W - 62, 11), f"{f['g']/1000:5.1f}s", font=F_SMALL, fill=MUTED)

    n = len(f["nodes"])
    pos = [node_pos(i, n) for i in range(n)]

    # edges
    for i in range(n):
        for j in range(i + 1, n):
            cut = f["partitioned"] and group_of(f, i) != group_of(f, j)
            if cut:
                dashed(dr, pos[i], pos[j], FAULT, 1)
            else:
                dr.line([pos[i], pos[j]], fill=LINE, width=1)

    # in-flight messages
    for m in f["inflight"]:
        a, b = pos[m["from"]], pos[m["to"]]
        t = m["t"]
        x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
        c = CANDIDATE if m["vote"] else FOLLOWER
        dr.ellipse([x - 3, y - 3, x + 3, y + 3], fill=c)

    # nodes
    for i, nd in enumerate(f["nodes"]):
        x, y = pos[i]
        c = role_color(nd["role"])
        r = 22
        dr.ellipse([x - r, y - r, x + r, y + r], fill=SURFACE, outline=c, width=3)
        label = f"N{nd['id']+1}"
        tw = dr.textlength(label, font=F_NODE)
        dr.text((x - tw / 2, y - 12), label, font=F_NODE, fill=TEXT if nd["role"] != "down" else DOWN)
        tl = f"t{nd['term']}"
        tw2 = dr.textlength(tl, font=F_TINY)
        dr.text((x - tw2 / 2, y + 2), tl, font=F_TINY, fill=MUTED)
        if nd["role"] == "leader":
            cw = dr.textlength("LEADER", font=F_TINY)
            dr.text((x - cw / 2, y - r - 15), "LEADER", font=F_TINY, fill=LEADER)
        elif nd["role"] == "candidate":
            cw = dr.textlength("VOTING", font=F_TINY)
            dr.text((x - cw / 2, y - r - 15), "VOTING", font=F_TINY, fill=CANDIDATE)

    # log wall (right panel)
    LX, LY, LW = 348, 62, 358
    dr.text((LX, 42), f"LOG ENTRIES {WIN_LO}-{WIN_HI}   color = term   solid = committed", font=F_TINY, fill=MUTED)
    sh, gap = 46, 9
    cellw, cellgap = 6, 1
    for i, nd in enumerate(f["nodes"]):
        y = LY + i * (sh + gap) * 0.72
        dr.text((LX, y + 6), f"N{nd['id']+1}", font=F_SMALL, fill=MUTED)
        bx = LX + 26
        bw = LW - 26 - 54
        dr.rectangle([bx, y, bx + bw, y + 20], fill=SURFACE)
        # Fixed ABSOLUTE index window across all nodes, so the minority's
        # strip visibly stops growing and then fills back in on heal.
        terms = {e["index"]: e["term"] for e in nd["logWindow"]}
        for k in range(WIN_LO, WIN_HI + 1):
            cx = bx + 2 + (k - WIN_LO) * (cellw + cellgap)
            if cx + cellw > bx + bw - 2: break
            t = terms.get(k)
            if t is None:
                dr.rectangle([cx, y + 2, cx + cellw, y + 18], outline=LINE, width=1)
                continue
            c = term_color(t)
            if k > nd["commitIndex"]:
                c = tuple(int(v * 0.42 + BG[q] * 0.58) for q, v in enumerate(c))
            dr.rectangle([cx, y + 2, cx + cellw, y + 18], fill=c)
        meta = f"{nd['commitIndex']}/{nd['logLength']}"
        dr.text((LX + LW - 50, y + 4), meta, font=F_TINY, fill=MUTED)

    # footer note
    dr.text((14, H - 22), "raftlab — deterministic simulator, seed 7", font=F_TINY, fill=MUTED)
    return im

imgs = [render(f) for f in frames]
durs = [130] * len(imgs)
durs[0] = 900
durs[-1] = 1600
# a beat on the partition and heal moments
for i, f in enumerate(frames):
    if abs(f["g"] - PART_AT) < 400 or abs(f["g"] - HEAL_AT) < 400:
        durs[i] = 700

imgs = [im.convert("P", palette=Image.ADAPTIVE, colors=96) for im in imgs]
imgs[0].save(OUT, save_all=True, append_images=imgs[1:], duration=durs, loop=0, optimize=True, disposal=2)
print("wrote", OUT, len(imgs), "frames")
