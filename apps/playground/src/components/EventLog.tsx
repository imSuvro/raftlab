import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiEvent } from '@raftlab/sim';

type Filter = 'all' | 'election' | 'fault';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'election', label: 'Elections' },
  { key: 'fault', label: 'Faults' },
];

export function EventLog({ events }: { events: UiEvent[] }): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('all');
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(
    () => (filter === 'all' ? events : events.filter((e) => e.kind === filter)).slice(-200),
    [events, filter],
  );

  useEffect(() => {
    const el = listRef.current;
    if (el === null) return;
    // Auto-follow only when the reader is already at the bottom.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  return (
    <div className="events">
      <div className="evhead">
        Events
        <span style={{ flex: 1 }} />
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`chip${filter === f.key ? ' on' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="evlist" ref={listRef} role="log" aria-live="polite">
        {shown.map((e, i) => (
          <div className={`ev k-${e.kind}`} key={`${e.g}-${i}-${e.summary}`}>
            <span className="t">{(e.g / 1000).toFixed(2)}s</span>
            <span className="m">{e.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
