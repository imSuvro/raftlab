# Playground UX

The playground's single job: **make consensus visible**. A visitor who has
never heard of Raft watches five nodes agree, attacks them, and watches them
recover — and can hand the exact scenario to someone else as a URL. Every
design choice below serves that job.

Design artifacts produced this stage (reviewed before stage 12 builds; source
in `docs/design/`):
- Wireframe (structure + annotations):
  [Raftlab Wireframe](https://claude.ai/code/artifact/d4ef0e0f-daf2-4194-b103-81c7dd39c49a)
- High-fidelity mockup (look, feel, motion, scripted election choreography):
  [Raftlab Mockup](https://claude.ai/code/artifact/3fb9a252-2487-4a97-8c52-9c348ddc28b8)

## Aesthetic direction

**Instrument panel, not dashboard.** The subject's world is terms, quorums,
heartbeats, replicated logs, seeds — the materials of a lab bench. The UI is
a dark blue-slate instrument (deliberately not near-black-with-acid-accent):
quiet surfaces, engraved grid lines, and a functional palette where **color
is protocol data, never decoration**:

| Token | Hex | Meaning |
|---|---|---|
| `--bg` | `#0E1420` | page ground (deep blue-slate) |
| `--surface` | `#161E2E` | panels, cards |
| `--line` | `#24304A` | rules, grid, borders |
| `--text` | `#D8E1F0` | primary text |
| `--muted` | `#8494B0` | secondary text |
| `--leader` | `#F5B83D` | leader (amber halo, crown of the term) |
| `--follower` | `#5B8DD9` | follower (steel blue) |
| `--candidate` | `#B76EF0` | candidate (violet — transient, electric) |
| `--down` | `#4A5568` | dead node (desaturated + hatched) |
| `--commit` | `#46C28E` | committed entries, success |
| `--fault` | `#E1604F` | faults, kill actions, violations |

Log cells are tinted by a fixed 6-color term cycle so "which leader wrote
this" is readable at a glance; the commit watermark is always `--commit`.

**Type**: `Martian Mono` (display — wordmark, section labels, the big term
counter; wide, machined), `IBM Plex Sans` (UI/body), `IBM Plex Mono`
(all data: terms, indices, seeds, event log — tabular numerals). Fallbacks:
`ui-monospace, Consolas, monospace` and `system-ui, sans-serif`.

**Signature element — the log wall.** Five horizontal log strips, one per
node, directly under the cluster ring: each cell one entry, tinted by term,
with a green commit watermark sweeping right as entries commit. Under a
partition the strips visibly diverge; on heal, conflicting cells get struck
and overwritten as the leader's log sweeps across. Nobody else makes the
*logs* the hero, and log convergence is the theorem the project exists to
test. Motion budget is spent here and on heartbeat pulses; everything else
is quiet. `prefers-reduced-motion`: pulses become opacity ticks, sweeps
become instant state changes.

## Layout

Desktop (≥1024px), full-viewport app, no page scroll:

```
+----------------------------------------------------------------------+
| raftlab   [narrator caption................]   seed [0xC0FFEE] Share |
+--------------------------------------------------+-------------------+
|                                                  |  EVENT LOG        |
|                CLUSTER STAGE                     |  12.40s  N3 ->N1  |
|          (ring of 5 nodes, message               |  AppendEntries    |
|           pulses traveling on edges,             |  12.42s  N1 ack   |
|           partition drawn as a wall)             |  ...              |
|                                                  |  (virtualized,    |
+--------------------------------------------------+   filterable)     |
|  LOG WALL: five per-node log strips              |                   |
|  N1 [1|1|2|2|2|3|3.......▮commit]                |                   |
|  ...                                             |                   |
+--------------------------------------------------+-------------------+
| ⏸ ▶ step | speed 1x | timeline ══════╬═══▲═▲════ | Split  Heal  Kill |
+----------------------------------------------------------------------+
```

- **Cluster stage** (center-left, ~60% width): 5 nodes on a ring. A node is
  a disc: role color halo, node id, current term in Plex Mono, a thin
  commit-progress arc. The leader gets a small crown mark. Messages animate
  as glowing dots along edges (color = message kind: append `--follower`,
  vote `--candidate`). A partition renders as a jagged wall dividing the
  ring's groups; a dead node goes gray, hatched, tilted 2°.
- **Log wall** (below stage): the signature. Strip height ~28px; commit
  watermark as a bright green vertical rule with a subtle sweep animation
  when it advances. Clicking a strip scrolls it if longer than the window.
- **Event log** (right rail, 280–320px): virtualized list, Plex Mono,
  newest at bottom, auto-follow with a "jump to live" pill when scrolled
  up. Filter chips: Elections · Appends · Client ops · Faults.
- **Transport bar** (bottom): pause/play, step-one-event, speed (0.25× 1×
  4× 16×), and the **timeline** — a scrubber over virtual time with fault
  markers (▲, colored `--fault`) at every injected fault. Dragging scrubs;
  the whole UI re-renders that instant deterministically.
- **Fault controls** (bottom-right cluster): `Split network` (2/3 preset;
  long-press/right-click opens a group editor), `Heal network`,
  `Kill node` (then click a node; or click a node directly), plus per-node
  popover on click: Kill / Restart / Slow clock (skew slider).
- **Top bar**: wordmark; **narrator caption**; seed field (editable hex,
  Enter reloads the run); `Share this run` (copies URL, toast confirms).

## Zero-learning-curve devices

1. **It's already running.** On load the cluster is mid-flight: heartbeats
   pulse, the commit watermark advances. Nothing to configure, no modal, no
   tour. The first thing a visitor sees is the system working.
2. **The narrator caption.** One line, top center, plain English, updated on
   significant events — the interpreter between protocol and visitor:
   - "Node 3 is the leader. Heartbeats keep the others following."
   - "Node 3 went down. The others will notice when heartbeats stop."
   - "Node 1's election timer fired — it's asking for votes (term 8)."
   - "Node 1 won the election with 3 votes. Term 8 has a leader."
   - "The network is split 2 | 3. The minority side can't commit."
   - "Partition healed. Node 4 is overwriting entries that never committed."
   Caption changes cross-fade; the previous two remain readable in the
   event log anyway.
3. **One irresistible button.** A pulsing hint chip on first load:
   `Try: kill the leader ✕` anchored to the leader node. One click delivers
   the product's whole thesis (death → timeout → election → recovery) in
   four seconds. The chip never returns after first use (localStorage).
4. **Everything is labeled by outcome**, sentence case, active voice:
   "Kill node", "Restart", "Split network", "Heal network", "Slow clock",
   "Share this run". No protocol jargon on any control. Jargon lives in the
   event log where the curious can graduate to it.
5. **Recoverable by design.** `Reset` (in the transport bar) reloads the
   default seed. A malformed share URL never errors: "That link didn't
   decode — loaded a fresh cluster instead." (toast, then default run).

## Interaction rules

- **Determinism is user-visible.** Injecting a fault appends it to the
  scenario script at the current virtual time; scrubbing backward and
  forward replays it identically. The share URL always reproduces exactly
  what the visitor is looking at, including their injected faults.
- Pause does not disable fault buttons — faults injected while paused land
  at the paused instant (and appear on the timeline immediately).
- Node click = popover (Kill/Restart/Slow clock). Kill and Restart are the
  same button with swapped label depending on state.
- Clock skew: per-node slider −500ms…+500ms offset plus drift ±5%; a small
  clock glyph appears on skewed nodes.
- Keyboard: space = pause/play, `.` = step, `←/→` = scrub, `s` = share.
  Focus states visible throughout (2px `--commit` outline).

## Mobile (<768px)

Stacked, scrollable: stage (square, full width) → transport bar (sticky
bottom) → log wall (horizontal scroll) → event log (collapsed drawer,
"Events" handle). Fault controls become a single row of icon+label chips
above the transport bar. Touch targets ≥44px. The hint chip and narrator
caption behave identically — the zero-knowledge path is not desktop-only.

## Data contract (ratified by stage-5 architecture; stage 12 implements)

The UI is a pure renderer of frames posted from the sim worker at ~30Hz.

```ts
interface ClusterView {
  g: number;                       // global virtual time, ms
  nodes: Array<{
    id: number;
    role: 'leader' | 'follower' | 'candidate';
    term: number;
    votedFor: number | null;
    commitIndex: number;
    lastApplied: number;
    logWindow: Array<{ index: number; term: number }>;  // tail, ≤30
    logLength: number;
    alive: boolean;
    clockOffsetMs: number;         // 0 when unskewed
  }>;
  inflight: Array<{ from: number; to: number;
    kind: 'AppendEntries' | 'AppendEntriesReply' | 'RequestVote' | 'RequestVoteReply';
    sendG: number; deliverG: number }>;   // for edge animation
  partitions: number[][] | null;   // null = fully connected
  leaderId: number | null;
}
```

Worker protocol (UI → worker): `load(scenario)`, `play(speed)`, `pause()`,
`stepOnce()`, `scrubTo(g)`, `inject(faultOp)` (worker stamps virtual time,
appends to script, echoes `scenarioChanged(scenario)` so the URL bar
updates). Worker → UI: `frame(ClusterView, eventLogDelta[])`,
`scenarioChanged`. Event-log entries arrive as append-only deltas with
`{g, kind, actors, summary, narratorLine?}` — the narrator caption is the
latest delta carrying `narratorLine`, so narration is computed in the sim
layer (where the protocol context lives), not in React.

Share URL: `#v1.<seed>.<base64url(deflate-raw(JSON({net, script, workload, nodes, horizon})))>`
— absent/invalid hash loads the default scenario (seed 1, 5 nodes, no
faults) auto-playing at 1×.

## Accessibility floor

- Role is never color-only: leader has the crown mark, candidate a ballot
  glyph, dead nodes hatching + tilt. Term numbers are printed, not implied.
- Contrast ≥4.5:1 for text on `--bg`/`--surface` (verified in mockup).
- All controls keyboard-reachable; scrubber is a `range` input.
- `prefers-reduced-motion` honored (see signature section).
- Event log is a `role="log"` live region at `polite`.
