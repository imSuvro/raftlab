import type { ClusterView } from '@raftlab/sim';

// Muted term cycle: deliberately excludes the semantic commit green and the
// role colors, so "which leader wrote this" reads without competing with
// role state. Committed-ness reads through opacity, not hue.
const TERM_COLORS = ['#4e7fc4', '#c9a34e', '#9b6fd0', '#4e9fb8', '#c4645a', '#3fa893'];
const termColor = (t: number): string => TERM_COLORS[(t - 1) % TERM_COLORS.length] ?? '#4e7fc4';

export function LogWall({ view }: { view: ClusterView }): React.JSX.Element {
  return (
    <div className="logwall panel">
      <div className="lwhead">
        Replicated logs · one strip per node · color = term · committed entries are solid
      </div>
      <div className="strips">
        {view.nodes.map((n) => (
          <div className="strip" key={n.id}>
            <span className="sid">N{n.id + 1}</span>
            <div className="cells">
              {n.logWindow.map((e) => (
                <div
                  key={e.index}
                  className={`cell${e.index <= n.commitIndex ? '' : ' uncommitted'}`}
                  style={{ background: termColor(e.term) }}
                  title={`index ${e.index}, term ${e.term}`}
                />
              ))}
            </div>
            <span className="meta">
              {n.commitIndex}/{n.logLength}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
