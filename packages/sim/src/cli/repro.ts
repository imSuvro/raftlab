// pnpm repro <failure-file.json> — re-run a failure artifact and assert the
// identical violation at the identical trace hash (ADR-0005).

import { loadFailureArtifact, repro } from './failure.js';

const file = process.argv[2];
if (file === undefined) {
  console.error('usage: pnpm repro <failure-file.json>');
  process.exit(2);
}

const artifact = loadFailureArtifact(file);
console.log(
  `replaying seed ${artifact.scenario.seed} (${artifact.scenario.nodes} nodes, horizon ${artifact.scenario.horizonMs}ms) — expecting ${artifact.violation.invariant} at seq ${artifact.violation.eventSeq}`,
);
const result = repro(artifact);
if (result.reproduced) {
  console.log(`REPRODUCED: ${result.reason}`);
  process.exit(0);
}
console.error(`NOT REPRODUCED: ${result.reason}`);
process.exit(1);
