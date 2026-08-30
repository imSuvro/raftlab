# README GIF generator

The partition/heal GIF in the project README is **rendered from real
simulator output**, not drawn by hand or screen-recorded. These two scripts
regenerate it, so the claim is checkable:

```bash
pnpm tsx tools/gif/dump-frames.mts frames.json
python tools/gif/render-gif.py frames.json docs/media/partition-heal.gif
```

`dump-frames.mts` builds a `World` — the same one the fuzz campaign drives —
with a 2|3 partition at 9s and a heal at 21s, then samples `clusterView()`
on a fixed virtual-time grid. `render-gif.py` draws those frames with Pillow
using the `docs/ux.md` palette.

Because the scenario is seeded (seed 7), the frames are identical on every
machine and every run. Regenerating the GIF from the same seed produces the
same animation.

Requirements: `pnpm tsx` (already a dev dependency) and Python with Pillow.
