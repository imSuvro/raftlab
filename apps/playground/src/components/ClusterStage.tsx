import { useMemo, useState } from 'react';
import type { ClusterView } from '@raftlab/sim';
import { useStore } from '../store.js';

const W = 800;
const H = 520;
const CX = W / 2;
const CY = H / 2 - 10;
const R = 165;

function positions(n: number): { x: number; y: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
  });
}

function sameGroup(view: ClusterView, a: number, b: number): boolean {
  if (view.partitions === null) return true;
  const ga = view.partitions.findIndex((grp) => grp.includes(a));
  const gb = view.partitions.findIndex((grp) => grp.includes(b));
  return ga === gb;
}

export function ClusterStage({ view }: { view: ClusterView }): React.JSX.Element {
  const [menu, setMenu] = useState<number | null>(null);
  const inject = useStore((s) => s.inject);
  const dismissHint = useStore((s) => s.dismissHint);
  const hintDismissed = useStore((s) => s.hintDismissed);
  const pos = useMemo(() => positions(view.nodes.length), [view.nodes.length]);

  const leaderIdx = view.leaderId;
  const showHint = !hintDismissed && leaderIdx !== null;

  const killLeader = (): void => {
    if (leaderIdx === null) return;
    dismissHint();
    inject({ op: 'crash', node: leaderIdx });
  };

  return (
    <div className="stage panel">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img"
        aria-label="Cluster of nodes showing each node's role and term">
        {/* edges — cut edges render as dashed red */}
        {pos.map((p, i) =>
          pos.slice(i + 1).map((q, j) => {
            const other = i + j + 1;
            const cut = !sameGroup(view, i, other);
            return (
              <line
                key={`${i}-${other}`}
                className={cut ? 'edge cut' : 'edge'}
                x1={p.x}
                y1={p.y}
                x2={q.x}
                y2={q.y}
              />
            );
          }),
        )}

        {/* in-flight messages, positioned by virtual time */}
        {view.inflight.slice(0, 120).map((m, i) => {
          const a = pos[m.from];
          const b = pos[m.to];
          if (a === undefined || b === undefined) return null;
          const span = Math.max(1, m.deliverG - m.sendG);
          const t = Math.min(1, Math.max(0, (view.g - m.sendG) / span));
          const vote = m.kind.startsWith('RequestVote');
          return (
            <circle
              key={`${m.from}-${m.to}-${m.sendG}-${i}`}
              className={vote ? 'pulse-vote' : 'pulse-append'}
              r={3.4}
              cx={a.x + (b.x - a.x) * t}
              cy={a.y + (b.y - a.y) * t}
            />
          );
        })}

        {/* nodes */}
        {view.nodes.map((n, i) => {
          const p = pos[i];
          if (p === undefined) return null;
          const cls = n.alive ? n.role : 'down';
          return (
            <g
              key={n.id}
              className={`node ${cls}`}
              transform={`translate(${p.x},${p.y})`}
              onClick={() => setMenu(menu === n.id ? null : n.id)}
              tabIndex={0}
              role="button"
              aria-label={`Node ${n.id + 1}, ${n.alive ? n.role : 'down'}, term ${n.term}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setMenu(menu === n.id ? null : n.id);
                }
              }}
            >
              {n.role === 'leader' && n.alive && <circle className="halo" r={26} />}
              <circle className="disc" r={26} />
              <text className="nid" textAnchor="middle" dy={1}>
                N{n.id + 1}
              </text>
              <text className="nterm" textAnchor="middle" dy={14}>
                t{n.term}
              </text>
              {n.alive && n.role === 'leader' && (
                <text className="crown" textAnchor="middle" dy={-34}>
                  ♛
                </text>
              )}
              {n.alive && n.role === 'candidate' && (
                <text className="ballot" textAnchor="middle" dy={-34}>
                  ☑
                </text>
              )}
              {n.clockOffsetMs !== 0 && n.alive && (
                <text className="nterm" textAnchor="middle" dy={40}>
                  ⏱ skewed
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {showHint && leaderIdx !== null && (
        <button
          className="hint"
          style={{
            left: `${((pos[leaderIdx]?.x ?? CX) / W) * 100}%`,
            top: `${((pos[leaderIdx]?.y ?? CY) / H) * 100}%`,
          }}
          onClick={killLeader}
        >
          Try: kill the leader ✕
        </button>
      )}

      {menu !== null && (
        <NodeMenu
          nodeId={menu}
          alive={view.nodes[menu]?.alive ?? false}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function NodeMenu({
  nodeId,
  alive,
  onClose,
}: {
  nodeId: number;
  alive: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const inject = useStore((s) => s.inject);
  const dismissHint = useStore((s) => s.dismissHint);
  const act = (op: Parameters<typeof inject>[0]): void => {
    dismissHint();
    inject(op);
    onClose();
  };
  return (
    <div className="popover" style={{ left: 16, bottom: 16 }} role="dialog" aria-label={`Node ${nodeId + 1} controls`}>
      <h3>Node {nodeId + 1}</h3>
      {alive ? (
        <button onClick={() => act({ op: 'crash', node: nodeId })}>Kill node</button>
      ) : (
        <button onClick={() => act({ op: 'restart', node: nodeId })}>Restart node</button>
      )}
      <button onClick={() => act({ op: 'clockSkew', node: nodeId, offsetMs: 0, driftPpm: 60_000 })}>
        Slow this node&apos;s clock
      </button>
      <button onClick={onClose}>Close</button>
    </div>
  );
}
