import type { ClusterView } from '@raftlab/sim';
import { useStore } from '../store.js';

const SPEEDS = [0.25, 1, 4, 16];

export function Transport({ view }: { view: ClusterView }): React.JSX.Element {
  const playing = useStore((s) => s.playing);
  const speed = useStore((s) => s.speed);
  const horizonMs = useStore((s) => s.horizonMs);
  const send = useStore((s) => s.send);
  const inject = useStore((s) => s.inject);
  const dismissHint = useStore((s) => s.dismissHint);
  const partitioned = view.partitions !== null;

  const splitNetwork = (): void => {
    dismissHint();
    const ids = view.nodes.map((n) => n.id);
    const cut = Math.floor(ids.length / 2);
    inject({ op: 'partition', groups: [ids.slice(0, cut), ids.slice(cut)] });
  };

  return (
    <div className="transport panel">
      <button
        className="tbtn"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={() => {
          if (playing) send({ t: 'pause' });
          else send({ t: 'play', speed });
        }}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <button className="tbtn" aria-label="Step one event" onClick={() => send({ t: 'stepOnce' })}>
        ▶❙
      </button>
      <select
        className="speed"
        aria-label="Playback speed"
        value={speed}
        onChange={(e) => {
          const next = Number(e.target.value);
          useStore.setState({ speed: next });
          if (playing) send({ t: 'play', speed: next });
        }}
      >
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>

      <div className="timeline">
        <span className="clock">{(view.g / 1000).toFixed(1)}s</span>
        <input
          type="range"
          min={0}
          max={horizonMs}
          step={100}
          value={view.g}
          aria-label="Timeline scrubber"
          onChange={(e) => send({ t: 'scrubTo', g: Number(e.target.value) })}
        />
      </div>

      <div className="faults">
        <button className="fbtn" onClick={splitNetwork} disabled={partitioned}>
          Split network
        </button>
        <button
          className="fbtn"
          onClick={() => {
            dismissHint();
            inject({ op: 'heal' });
          }}
          disabled={!partitioned}
        >
          Heal network
        </button>
        <button
          className="fbtn danger"
          onClick={() => {
            dismissHint();
            if (view.leaderId !== null) inject({ op: 'crash', node: view.leaderId });
          }}
          disabled={view.leaderId === null}
        >
          Kill the leader
        </button>
      </div>
    </div>
  );
}
