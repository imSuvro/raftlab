// The fuzz campaign CLI (ADR-0006, backlog E1).
//
//   pnpm fuzz --seeds 0:500 --profile mixed
//   pnpm fuzz --seeds 0:1250 --profile all --paranoid 1000 --out fuzz-failures
//
// Per seed: generate a scenario from the profile, run with checkers armed,
// and on violation minimize + write failure-<seed>.json. Exits non-zero if
// any seed failed. Writes a Markdown table to $GITHUB_STEP_SUMMARY when set.

import { appendFileSync } from 'node:fs';
import { captureFailure } from '../harness.js';
import { minimizeScenario } from '../fuzz/minimizer.js';
import { generateScenario, PROFILES, type ProfileName } from '../fuzz/profiles.js';
import { writeFailureArtifact } from './failure.js';

interface Args {
  from: number;
  to: number;
  profiles: ProfileName[];
  paranoid: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { from: 0, to: 500, profiles: ['mixed'], paranoid: 0, out: 'fuzz-failures' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a ?? ''}`);
      return v;
    };
    if (a === '--seeds') {
      const [lo, hi] = next().split(':');
      args.from = Number(lo);
      args.to = Number(hi);
      if (!Number.isInteger(args.from) || !Number.isInteger(args.to) || args.to <= args.from) {
        throw new Error('--seeds expects from:to with to > from');
      }
    } else if (a === '--profile') {
      const p = next();
      if (p === 'all') args.profiles = [...PROFILES];
      else if ((PROFILES as readonly string[]).includes(p)) args.profiles = [p as ProfileName];
      else throw new Error(`unknown profile ${p} (${PROFILES.join(', ')}, all)`);
    } else if (a === '--paranoid') {
      args.paranoid = Number(next());
    } else if (a === '--out') {
      args.out = next();
    } else {
      throw new Error(`unknown argument ${a ?? ''}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const started = Date.now();
let run = 0;
const failures: { seed: number; profile: string; invariant: string; script: string; file: string }[] = [];

for (const profile of args.profiles) {
  for (let seed = args.from; seed < args.to; seed++) {
    const scenario = generateScenario(seed, profile);
    const opts = args.paranoid > 0 ? { paranoidEveryEvents: args.paranoid } : {};
    const { violation, artifact } = captureFailure(scenario, opts);
    run++;
    if (violation !== null && artifact !== null) {
      const minimized = minimizeScenario(scenario);
      artifact.minimizedScenario = minimized.scenario;
      const file = writeFailureArtifact(args.out, artifact);
      failures.push({
        seed,
        profile,
        invariant: artifact.violation.invariant,
        script: JSON.stringify(minimized.scenario.script),
        file,
      });
      console.error(
        `FAIL seed=${seed} profile=${profile} ${artifact.violation.invariant} — minimized to ${minimized.scenario.script.length} fault ops in ${minimized.probes} probes -> ${file}`,
      );
    }
    if (run % 250 === 0) {
      const rate = Math.round(run / ((Date.now() - started) / 60_000));
      console.log(`…${run} seeds, ${failures.length} failures, ~${rate} seeds/min`);
    }
  }
}

const elapsedS = ((Date.now() - started) / 1000).toFixed(1);
const rate = Math.round(run / ((Date.now() - started) / 60_000));
console.log(
  `done: ${run} seeds across ${args.profiles.join('+')} in ${elapsedS}s (~${rate} seeds/min), ${failures.length} failure(s)`,
);

const summaryPath = process.env['GITHUB_STEP_SUMMARY'];
if (summaryPath !== undefined && summaryPath !== '') {
  let md = `### Fuzz: ${run} seeds (${args.from}:${args.to}) × ${args.profiles.join(', ')} — ${failures.length} failure(s), ~${rate} seeds/min\n\n`;
  if (failures.length > 0) {
    md += '| seed | profile | invariant | minimized script | repro |\n|---|---|---|---|---|\n';
    for (const f of failures) {
      md += `| ${f.seed} | ${f.profile} | ${f.invariant} | \`${f.script.slice(0, 120)}\` | \`pnpm repro ${f.file}\` |\n`;
    }
  }
  appendFileSync(summaryPath, md);
}

process.exit(failures.length > 0 ? 1 : 0);
