import { useEffect, useState } from 'react';
import { ClusterStage } from './components/ClusterStage.js';
import { EventLog } from './components/EventLog.js';
import { LogWall } from './components/LogWall.js';
import { Transport } from './components/Transport.js';
import { useStore } from './store.js';
import { decodeScenario, startingScenario } from './url.js';

export function App(): React.JSX.Element {
  // Atomic selectors: an object-returning selector allocates a fresh
  // reference on every store notification, which in zustand v5 re-renders
  // forever.
  const view = useStore((s) => s.view);
  const events = useStore((s) => s.events);
  const narrator = useStore((s) => s.narrator);
  const violation = useStore((s) => s.violation);
  const toast = useStore((s) => s.toast);
  const scenario = useStore((s) => s.scenario);
  const send = useStore((s) => s.send);
  const setToast = useStore((s) => s.setToast);
  const share = useStore((s) => s.share);
  const [seedText, setSeedText] = useState('');

  // Load the shared run, or a fresh one. A malformed link never errors out.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const fromHash = await decodeScenario(location.hash);
      if (cancelled) return;
      if (location.hash !== '' && fromHash === null) {
        setToast('That link didn’t decode — started a fresh cluster instead.');
      }
      const target = fromHash ?? startingScenario();
      useStore.setState({ scenario: target });
      setSeedText(String(target.seed));
      send({ t: 'load', scenario: target });
    })();
    return () => {
      cancelled = true;
    };
  }, [send, setToast]);

  useEffect(() => {
    if (toast === null) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast, setToast]);

  // Keyboard: space = play/pause, . = step, s = share.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target !== null && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const state = useStore.getState();
      if (e.code === 'Space') {
        e.preventDefault();
        if (state.playing) state.send({ t: 'pause' });
        else state.send({ t: 'play', speed: state.speed });
      } else if (e.key === '.') {
        state.send({ t: 'stepOnce' });
      } else if (e.key === 's') {
        state.share();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const reload = (): void => {
    const seed = Number(seedText);
    if (!Number.isInteger(seed)) {
      setToast('Seed must be a whole number.');
      return;
    }
    const next = startingScenario(seed);
    useStore.setState({ scenario: next, events: [], violation: null });
    history.replaceState(null, '', location.pathname);
    send({ t: 'load', scenario: next });
  };

  return (
    <div className="app">
      <div className="top panel">
        <div className="wordmark">
          raft<span>lab</span>
        </div>
        <div className="narrator">{narrator}</div>
        <div className="seedwrap">
          <label htmlFor="seed">seed</label>
          <input
            id="seed"
            value={seedText}
            spellCheck={false}
            onChange={(e) => setSeedText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') reload();
            }}
          />
        </div>
        <button className="share" onClick={share} disabled={scenario === null}>
          Share this run
        </button>
      </div>

      {view === null ? (
        <div className="stage panel" style={{ display: 'grid', placeItems: 'center' }}>
          <span style={{ color: 'var(--muted)' }}>Starting the cluster…</span>
        </div>
      ) : (
        <ClusterStage view={view} />
      )}
      {view !== null && <LogWall view={view} />}
      <EventLog events={events} />
      {view !== null && <Transport view={view} />}

      {violation !== null && (
        <div className="violation" role="alert">
          <strong>{violation.invariant}</strong> — {violation.detail}. Share this run: the seed and
          fault script reproduce it exactly.
        </div>
      )}
      {toast !== null && <div className="toast">{toast}</div>}
    </div>
  );
}
