// Failure-artifact file IO (CLI layer; the lint IO ban is relaxed here).
// The pure capture/repro logic lives in ../harness.ts.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateScenario } from '../scenario.js';
import type { FailureArtifact } from '../harness.js';

export function writeFailureArtifact(dir: string, artifact: FailureArtifact): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `failure-${artifact.scenario.seed}.json`);
  writeFileSync(path, JSON.stringify(artifact, null, 2));
  return path;
}

export function loadFailureArtifact(path: string): FailureArtifact {
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as FailureArtifact;
  validateScenario(artifact.scenario);
  validateScenario(artifact.minimizedScenario);
  return artifact;
}
