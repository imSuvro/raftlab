# Research

This document records the stage-1 research for raftlab: a close read of the Raft paper (extended
version) and the Students' Guide, to establish exactly what a correct implementation must honor;
case studies of the three systems with a documented deterministic-simulation-testing track record
(FoundationDB, TigerBeetle's VOPR, Antithesis); and a source-level survey of every surviving
TypeScript/JavaScript Raft implementation, to verify the gap raftlab claims to fill. Everything
below traces to a fetched source listed in [Sources](#sources); where a page could not be fully
verified, that is said outright.

## Differentiation

The TypeScript/JavaScript row of the Raft ecosystem is the weakest of any mainstream language: the
implementations tracked on raft.github.io's comparison table are largely unmaintained or toy-grade,
thin on persistence, membership changes, and log compaction, and tested — where they are tested at
all — with in-order unit tests and real-timer integration scripts. The bar that landscape fails is
now known precisely, because Antithesis pointed its platform at four mature, production-hardened
implementations (HashiCorp Raft, Aeron Cluster, OpenRaft, MicroRaft) and found safety violations in
every single one, within an hour, using nothing more exotic than network turbulence — no node
kills, no disk faults. If battle-tested Go and Java Raft code harbors State Machine Safety
violations that unit suites never touched, a fresh TS implementation with a green CI badge proves
nothing. Shipping "another Raft in TypeScript" is therefore not the project; shipping the harness
that would have caught those four codebases' bugs is.

Deterministic simulation testing is the one approach with a documented record of buying both
correctness and velocity. FoundationDB built its simulator before the database, ran the equivalent
of roughly a trillion CPU-hours of simulated failure, and shipped with exactly one user-reported
bug before Apple acquired it. TigerBeetle's VOPR subjects real cluster code to network, storage,
and process faults at 1000x speed, continuously, on 1024 cores. Antithesis — founded by the FDB
team when they discovered nothing like their framework existed anywhere else — raised a $105M
Series A with MongoDB, Palantir, and Ethereum's Merge testing as validation that the market now
prices this thesis in dollars. The kicker for raftlab is that TypeScript gets FDB's hardest-won
property for free: FDB had to invent a language (Flow) to compile concurrency down to a single
deterministic thread, whereas JavaScript's event loop already is single-threaded, so the entire
discipline reduces to a sans-IO core that never touches `Date.now`, `Math.random`, or
`setTimeout` — a lint rule where FDB needed a compiler. The residual work is exactly the
interesting part: the discrete-event scheduler, the fault taxonomy, the invariant checkers, and the
seeds.

"The tests are the product" works as positioning because it converts an unverifiable claim into a
clickable one. No reviewing engineer will read three thousand lines of consensus code and judge
them correct — but anyone can open a permalink whose URL fragment carries a seed and fault
schedule, watch a browser cluster replay the exact run where Election Safety tripped, and read a
bug log where every entry carries seed, commit SHA, violated invariant, and fix. That artifact is
precisely the credibility mechanism FDB ("one user-reported bug") and TigerBeetle (the public
devhubdb seed log, the sim.tigerbeetle.com playground) used on the world, and the sans-IO core
makes raftlab's version cheaper than theirs: TigerBeetle had to fight WASM's 2 GiB limit and port a
vector-graphics library to put their simulator in a browser, while the identical TS module runs the
Node fuzz campaign at virtual-time speed and animates in the playground with zero porting.
Shareable seed URLs are a reproducibility demo even sim.tigerbeetle.com does not expose.

## Raft: what an implementation must honor

Primary source: the extended paper ("In Search of an Understandable Consensus Algorithm", Ongaro &
Ousterhout), full text extracted from raft.pdf. Trap catalog cross-checked against the Students'
Guide to Raft.

### Figure 2, condensed

**State.** Persistent on all servers, updated on stable storage *before responding to RPCs*:
`currentTerm` (init 0, monotonic), `votedFor` (candidate voted for in current term, or null),
`log[]` (entry = command + term; first index is 1). Volatile on all servers: `commitIndex`,
`lastApplied` (both init 0, monotonic). Volatile on leaders, reinitialized after election:
`nextIndex[]` (init leader last log index + 1), `matchIndex[]` (init 0, monotonic).

**RequestVote RPC.** Args: term, candidateId, lastLogIndex, lastLogTerm. Receiver: reply false if
term < currentTerm; grant the vote iff votedFor is null or candidateId AND the candidate's log is
at least as up-to-date as the receiver's. "Up-to-date" (§5.4.1) compares last entries: later
last-log term wins; equal terms, longer log wins.

**AppendEntries RPC** (also the heartbeat, with empty `entries[]`). Args: term, leaderId,
prevLogIndex, prevLogTerm, entries[], leaderCommit. Receiver: (1) reply false if term <
currentTerm; (2) reply false if the log has no entry at prevLogIndex whose term matches
prevLogTerm; (3) if an existing entry *conflicts* with a new one (same index, different term),
delete it and all that follow; (4) append any new entries not already in the log; (5) if
leaderCommit > commitIndex, set commitIndex = min(leaderCommit, index of last *new* entry).

**Rules for servers.** All servers: if commitIndex > lastApplied, apply the next entry; if any RPC
request *or response* carries term T > currentTerm, set currentTerm = T and convert to follower.
Followers: become candidate if the election timeout elapses without AppendEntries from the current
leader or granting a vote. Candidates: on conversion, increment currentTerm, vote for self, reset
the election timer, send RequestVote to all; majority wins leadership; AppendEntries from a leader
with term >= own converts back to follower; timeout starts a new election. Leaders: send initial
empty heartbeats on election and repeat during idle; append client commands locally and respond
after apply; on follower log inconsistency, decrement nextIndex and retry; if there exists N >
commitIndex with a majority of matchIndex[i] >= N AND log[N].term == currentTerm, set
commitIndex = N.

### The five safety properties (Figure 3)

1. **Election Safety** — at most one leader can be elected in a given term.
2. **Leader Append-Only** — a leader never overwrites or deletes entries in its log; it only
   appends.
3. **Log Matching** — if two logs contain an entry with the same index and term, the logs are
   identical in all entries up through that index.
4. **Leader Completeness** — if a log entry is committed in a given term, it is present in the
   logs of the leaders of all higher-numbered terms.
5. **State Machine Safety** — if a server has applied a log entry at a given index, no other
   server will ever apply a different entry for that index.

The paper's proof chain runs election restriction -> Leader Completeness -> State Machine Safety,
plus the requirement that servers apply entries in log-index order. All five are directly
executable as invariants over global simulator state; State Machine Safety plus in-order apply is
the end-to-end oracle, and the others localize the diagnosis when it trips.

### Timing (§5.6)

Safety must never depend on timing; only availability does. Requirement: `broadcastTime <<
electionTimeout << MTBF`. broadcastTime is the average parallel round-trip to every server
*including the stable-storage persist on the receiver* (0.5–20 ms depending on storage), so
election timeouts are typically 10–500 ms; the paper's worked example randomizes in 150–300 ms;
MTBF is months. Election timeouts are chosen randomly from a fixed interval and each candidate
re-randomizes at the start of every election — this both prevents and resolves split votes. After a
leader crash, expect roughly one election timeout of unavailability. The randomized timeout is the
*only* nondeterminism in basic Raft, which is why a seeded PRNG makes an entire cluster run a pure
function of (seed, fault schedule).

### Client interaction (§8)

- **Leader discovery.** Clients contact a random server; non-leaders reject and supply the last
  known leader address; on leader crash clients time out and retry a random server.
- **No-op at term start.** A new leader has all committed entries (Leader Completeness) but does
  not know the commit frontier, so each leader commits a blank no-op entry at the start of its
  term before serving reads.
- **Duplicate detection.** Raw Raft can execute a command twice (leader commits, crashes before
  replying, client retries on the new leader). The paper's fix: clients attach unique serial
  numbers and the state machine caches, per client, the latest serial processed plus its response,
  answering duplicates from the cache. raftlab defers this to a later milestone.
- **Reads.** Read-only ops without log writes need two precautions: the term-start no-op, plus a
  deposal check — the leader exchanges heartbeats with a majority before answering each read (what
  etcd later named ReadIndex). The alternative, a heartbeat-based leader lease, is the one place
  the paper allows timing into safety, and it is opt-in. raftlab sidesteps both initially by
  routing reads through the log like any other command — slower, but linearizable by the same
  mechanism as writes.

### Flagged traps

- **Figure 8 / the current-term commit rule (§5.4.2).** A leader must never commit a
  previous-term entry by counting replicas; only entries with log[N].term == currentTerm may be
  committed by counting, older entries commit only indirectly via Log Matching. Figure 8's
  five-server schedule shows a majority-replicated old-term entry being overwritten regardless.
- **Persistence before reply.** currentTerm, votedFor, and log[] must be flushed before responding
  to any RPC. Grant a vote, crash before persisting votedFor, and the server can vote twice in one
  term; ack entries before persisting them and the leader's majority accounting is corrupt.
- **Truncate only on real conflict.** Receiver step 3 deletes only on a same-index/different-term
  conflict. RPCs are idempotent (§5.5): re-delivery of an AppendEntries whose entries are already
  present must be a no-op; a naive suffix-replace deletes committed entries on a stale or
  duplicate message.
- **Election-timer reset rules** (Students' Guide). Reset only on: AppendEntries from the current
  leader, starting an election, or granting a vote. Resetting on any received RequestVote
  livelocks the cluster.
- **Heartbeats are not special.** Validate them exactly like normal AppendEntries; a shortcut ack
  corrupts commit accounting.
- **Stale replies.** On any RPC reply: step down if reply.term > currentTerm; drop the reply if
  term or role changed since sending; compute matchIndex as prevLogIndex + len(entries) from the
  *original request arguments*, never from current log length. nextIndex is an optimistic guess,
  matchIndex a conservative fact — never conflate them.
- **Apply exactly once, in order.** A single dedicated applier path; and a proposal API can return
  the same index twice across leadership changes.
- **Scope guidance.** The paper doubts the AppendEntries fast-backoff optimization is necessary;
  membership changes and log compaction sit outside Figure 2 and are clean later milestones. The
  TLA+ spec is the tie-breaker when the prose is ambiguous.

## Prior art: deterministic simulation testing

### FoundationDB

FDB built the deterministic simulator *before* the database — real-world entropy makes production
bugs unreproducible, so the team refused to debug in that regime at all. Flow, a syntactic
extension to C++, compiles actor-style concurrency to single-threaded callbacks, so there is no
OS-thread nondeterminism to control; every nondeterministic edge lives behind a swappable interface
(INetwork -> SimNetwork, IAsyncFile -> SimFile, simulated time, seeded RNG), and an entire
multi-node cluster runs deterministically in one process at roughly a 10:1 real-to-simulated time
factor. Determinism is itself tested by running the same seed twice and asserting identical runs.
The fault taxonomy covers connection and link failures, machine reboot/recovery, partitions,
degraded machines, full disks, and "brutal" modes where ~10% of function calls fail; the signature
fault is swizzle-clogging — clog a random subset of nodes' connections one at a time, then unclog
in a different random order — credited with surfacing deep issues that only happen in the rarest
real-world cases. BUGGIFY is cooperative fault injection: only ever true in simulation, each
call-site enabled or disabled once per run, enabled sites firing at 25% (or a custom
probability) — the code tells the simulator where the dangerous scenarios are instead of hoping
random faults compose into them. The outcome: about a trillion simulated CPU-hours, and one
user-reported bug before the 2015 Apple acquisition. The honest boundary: simulation cannot catch
bugs below the abstraction, so FDB ran Sinkhole, a real-hardware rig with network-controlled power
supplies, and found bugs beneath their own code.

**raftlab takes:** the interface-swap architecture (in TS, an ESLint ban on
`Date.now`/`Math.random`/`setTimeout` in the core package does what Flow needed a language for); a
synchronous discrete-event scheduler over (virtualTime, seq, event) rather than real Promises; the
double-run determinism self-test in CI; a `buggify()` with FDB's exact three-rule semantics;
swizzle-clogging as a named fault schedule; campaign size reported in simulated cluster-hours; and
one honest paragraph on what the simulator cannot test.

### TigerBeetle VOPR

The VOPR runs an entire TigerBeetle cluster — replicas, standbys, clients, all real production
code — in one process on virtual tick-based time, fully determined by a u64 seed plus the Git
commit; one minute of VOPR time is equivalent to days of real-world testing. One root PRNG derives
independent sub-seeds per component (cluster, network, storage, workload), and swarm testing draws
the fault-injection *parameters themselves* from the seed: packet loss 0–30%, partitions up to
3%/tick with stability windows, storage read/write faults up to 10%, rare crashes, randomized
cluster shape. The storage fault atlas is recoverability-aware by construction (e.g. grid faults
only when replicas > 2), so no seed injects a pattern no correct protocol could survive. Checking
is layered: thousands of always-on assertions in the production code; a StateChecker holding the
canonical hash-chained commit history and asserting every replica's commit checksum against it
(split-brain caught at the exact divergent op); a StorageChecker demanding byte-for-byte identical
state across replicas at every compaction bar and checkpoint. Liveness runs in two phases: chaos
until the workload commits, then `transition_to_liveness_mode` picks a random quorum core, heals
it, makes all non-core failures permanent, and demands convergence within a bounded tick budget —
with a `cluster_recoverable()` triage step before declaring a bug, so unsatisfiable seeds are not
false positives. Every failure prints "you can reproduce this failure with seed=N"; replay is the
same command with the seed appended. The CFO runs a fleet of continuous fuzzers and pushes seed
records to a public repo (devhubdb) with an explicit merge policy preferring failing and
faster-failing seeds. sim.tigerbeetle.com is the actual VOPR compiled to WASM — the hard part was
fitting the cluster under wasm32's 2 GiB — with gamified fault levels and player-injected faults.
The 2026 "protocol-aware DST" framing: check invariants inside each replica, not just at the
client API. Boundary: DST cannot cover what it stubs out, so the non-deterministic Vortex harness
(real binaries, real TCP through a fault proxy) exists, and found production bugs DST missed.

**raftlab takes:** per-component PRNG streams off one root seed; swarm-tested fault parameters; a
simulator-owned canonical committed log with hash-chained checking plus the five Raft properties
as per-tick protocol-aware oracles; the two-phase safety-then-liveness run shape with
recoverability triage; the seed-on-failure replay protocol (seed and commit SHA recorded
together); a scaled-down public bug log with an explicit retention policy; dense fixed-column
state-transition logging; per-run timeouts where a hang counts as a failure and a canary fuzzer
that must fail; and the playground UX of preset fault levels plus direct-manipulation faults —
with seed entry and shareable seed URLs, which sim.tigerbeetle.com does not expose.

### Antithesis

Antithesis generalizes FDB's idea from language level to whole-system level: a proprietary
deterministic hypervisor (a bhyve fork) virtualizes every time source, pins each VM to a single
physical core (multi-core determinism was deemed not worth solving; parallelism comes from many
single-core VMs), controls guest thread scheduling to expose races, and moves I/O through a
deterministic VMCALL channel. Because execution is deterministic and snapshottable, one run
branches into a "multiverse" of alternate timelines, explored by an RL-based component rather than
pure random fuzzing, and every bug found is perfectly reproducible. Sometimes-assertions invert
normal assertions — a condition must fire at least once across all explored executions — serving
both as coverage of *situations* rather than locations and as generalized checkpoints the explorer
can restart from. The case studies define the genre: bugs found in every Raft implementation
tested (HashiCorp Raft, Aeron Cluster, OpenRaft, MicroRaft) with a trivial chain-of-blocks
workload and network turbulence alone, within an hour; a 16-year-latent SQLite WAL race hit in 15
minutes with only generic properties; a NATS/JetStream data-loss sequence (partition, double
restart during recovery, state wipe, stale-node election) reproduced in 3 minutes of virtual time;
etcd's 830 wall-clock hours simulating ~4.5 years of usage. The Raft post also names four implicit
paper assumptions implementations break: atomic per-node event processing; an RPC framework
correlating requests and responses; currentTerm and votedFor updated atomically together; and the
TLA+ spec omitting InstallSnapshot and leadership transfer, so those improvised zones are where
bugs cluster.

**raftlab takes:** the chain-of-blocks harness almost verbatim (state machine hashing command
bytes, State Machine Safety as hash equality at equal indices); partitions/delay/reorder/
duplication as the first fault repertoire, before crashes or disk faults; the four
implicit-assumption zones as explicit fuzz targets; liveness properties alongside safety (two of
the three HashiCorp bugs were deadlock/livelock); sometimes-assertion markers as the campaign's
coverage metric; checkpoint-style bisection of the virtual-time step where failure probability
spikes; a tiny generic property set rather than bespoke oracles; and the bug-log schema of
(property violated, minimal event sequence, virtual time to find, why conventional testing missed
it). The design tradeoff is stated openly: Antithesis determinizes unmodified binaries; raftlab
determinizes by construction — narrower reach, zero heisenbugs.

## Survey: existing TS/JS Raft implementations

All claims verified against test directories and source, not READMEs alone.

| Implementation | Last activity | Scope | Testing approach |
|---|---|---|---|
| liferaft (unshiftio, 245 stars) | pushed 2021-03-23; npm frozen at v1.0.0 (2018) | Election + optional leveldown log; replication incomplete per its own issues (#17, #18); no snapshots; EventEmitter API, transport by subclassing | Five mocha files on real timers and real TCP; the only multi-node election test is `it.skip`'d |
| node-zmq-raft (royaltm, 34 stars) | pushed 2026-08-10 | Most complete JS one: election, replication, file-based ACID persistence, snapshot/compaction, dynamic membership; ZMQ transport "not replaceable"; pure JS, no TS | node-tap unit tests over src modules; no simulation, fuzzing, or linearizability checking; self-described "opinionated", no production claim |
| raft.ts (matthewaveryusa, 7 stars) | pushed 2026-07-21 | Strongest TS competitor: prevote, pipelined replication, joint-consensus membership, pluggable storage; snapshotting "not implemented — log grows without bound" | 115+ mocha tests; the only virtual-clock harness surveyed (tick(), in-memory bus, per-link drops, partition()), but tie-break is a fixed injected constant — no seeded randomness, scripted scenarios only; sole invariant: leader() throws on two leaders |
| consensus.raft.js (coatyio, 8 stars) | pushed 2023-10-19 | TS port of etcd's Go raft, welded to the Coaty framework; requires an MQTT broker; SQLite persistence | tap tests; no simulation, fuzzing, or linearizability tooling |
| @maboke123/raft-core (5 stars) | v0.2.1 2026-03-24; pushed 2026-04-13 | Widest claimed scope: snapshots, learners, gRPC+TLS "production setup"; exports MockTransport/MockClock/SeededRandom for consumers | No test directory in the raft-core package (verified via the GitHub contents API); the devtools visualizer observes a real running cluster over WebSocket, injects nothing |

The historical layer is dead: skiff-algorithm (last publish 2014), raftjs (2013), nodeway-raft
(2019); @nodeguy/raft 404s on the npm registry.

**Verified gap analysis — what none of them have:**

1. **Deterministic simulation testing.** raft.ts has a virtual-clock test fixture, not a
   simulator; the other four test against real timers and real TCP/ZMQ/MQTT, or do not visibly
   test at all.
2. **Seed-reproducible randomized fuzzing.** None. raft.ts deliberately removed randomness (fixed
   tie-break constant); maboke123 ships a SeededRandom class no fuzz campaign uses.
3. **Linearizability checking.** Absent from all five; the strongest safety assertion anywhere in
   the ecosystem is raft.ts's single-leader throw.
4. **An interactive fault-injection playground.** Absent from all five; the nearest artifact
   requires a locally running Node cluster and only observes.
5. **A public bug log.** No surveyed repo documents bugs its own tests found.

The causal reading: every surveyed implementation couples the protocol core to a transport and to
wall-clock timers, and that coupling is exactly why none can run a whole cluster
deterministically. Pure core in, simulation testing falls out for free. Scope bar from the survey:
election + replication + persistence interface + snapshots is credible completeness (zmq-raft
meets it; raft.ts fails it on snapshots and says so); production transports are orthogonal to the
thesis and not worth competing on.

## Design lessons adopted

1. Build the simulator before the database and put every nondeterministic edge — clock, RNG,
   network, storage — behind injected interfaces so an entire cluster runs single-threaded as a
   pure function of one seed (FoundationDB's Flow with INetwork->SimNetwork/IAsyncFile->SimFile,
   replicated by TigerBeetle's VOPR).
2. Test the determinism itself: a CI job runs the same seed twice and asserts byte-identical event
   traces and matching PRNG positions, so accidental nondeterminism is caught the day it is
   introduced (FDB's double-run self-check).
3. Swarm-test by drawing the fault-injection parameters themselves — loss rate, partition
   frequency, crash probability, cluster shape — from per-component PRNG streams derived off one
   root seed, so different seeds explore qualitatively different failure regimes without
   scrambling each other (TigerBeetle's options_swarm and sub-seeded components in vopr.zig).
4. Check invariants protocol-aware — per replica, per tick, against a simulator-owned canonical
   hash-chained committed history — rather than only at the client API, so split-brain is caught
   at the exact divergent index and Figure 3's five safety properties become executable oracles
   (TigerBeetle's StateChecker and 2026 protocol-aware DST framing).
5. Implement buggify() with FDB's exact three-rule semantics — true only in simulation, each
   call-site enabled or disabled once per run, enabled sites firing at 25% or a per-site
   probability — so the code tells the fuzzer where the dangerous scenarios are instead of hoping
   random faults compose into them.
6. Run every fuzz case in two phases — chaos until the workload commits, then heal a random quorum
   core, freeze all non-core faults permanently, and demand convergence within a bounded tick
   budget — and triage whether recovery was even possible before declaring a liveness bug
   (TigerBeetle's transition_to_liveness_mode and cluster_recoverable()).
7. Make every failure print "reproduce with seed=N" plus the commit SHA, make replay literally the
   same command with the seed appended, and publish the bug log with an explicit merge policy that
   prefers failing and faster-failing seeds (TigerBeetle's CFO/devhubdb; FDB's one-user-bug record
   is proof the log is the credibility).
8. Use sometimes-assertions — conditions that must fire at least once across all explored
   executions — as the coverage metric, because code coverage only covers locations while these
   cover situations the fuzzer must actually reach (Antithesis).
9. Port swizzle-clogging — clog a random subset of nodes' links one at a time, then unclog in a
   different random order — as a named fault schedule in both the campaign and the playground,
   since ordering-sensitive partial partitions during leader churn surface the rarest-real-world
   bugs (FDB's signature fault).
10. Write one honest paragraph on what the simulator cannot test — real sockets, real fsync
    semantics, the browser engine beneath the playground — because FDB needed the Sinkhole
    hardware rig and TigerBeetle built the non-deterministic Vortex harness for exactly that gap,
    and naming the boundary reads as expertise, not weakness.

## Paper traps a fuzzer should catch

- **Committing a previous-term entry by counting replicas** — omitting the log[N].term ==
  currentTerm condition on the leader's commit rule, the exact bug of Figure 8 (§5.4.2). Unit
  tests miss it because the buggy majority count is correct in every single-leader scenario a test
  enumerates; the violation needs a five-node, multi-term schedule of partial replication, crash,
  rival election, re-election, and a second crash — an interleaving nobody writes by hand, but
  which a seeded fuzzer with crash and partition scheduling reproduces as a matter of course (and
  which can be scripted directly as the paper's own counterexample).
- **Truncating the follower's log on a stale or duplicate AppendEntries** instead of only on a
  genuine term conflict — a naive "replace my suffix with the leader's entries" deletes committed
  entries the leader may not even have. Unit tests deliver RPCs in order and exactly once, so a
  delayed or duplicated older AppendEntries never arrives after newer entries exist; only
  reordering and duplication — the first faults any network fuzzer injects — expose it (the
  Students' Guide flags this as a top safety bug across hundreds of implementations).
- **Responding to an RPC before persisting** — Figure 2 requires currentTerm, votedFor, and log[]
  flushed before any reply; granting a vote and crashing before persisting votedFor allows a
  double vote in one term. Unit tests model persistence as synchronous and never crash a node
  between the in-memory update and the durable write, so the window does not exist in the test's
  universe; catching it requires persistence as an explicit effect and a scheduler that can kill a
  node between "state changed" and "persist acknowledged".
- **Acting on stale RPC replies after term or role has changed** — including computing matchIndex
  from current log length instead of prevLogIndex + len(entries) from the original request
  arguments. Unit tests complete each request-reply pair synchronously, so nothing intervenes
  between send and receive and the wrong formula is coincidentally correct; only delayed replies
  crossing an election boundary expose it, and Antithesis's HashiCorp findings (heartbeats racing
  dispatchLogs and RequestVote, allowing term regression and double votes) show this class
  surviving into production-grade code.
- **Resetting the election timer on the wrong events** — e.g. on any received RequestVote rather
  than only on current-leader AppendEntries, starting an election, or granting a vote — which
  livelocks the cluster in perpetual elections without ever violating a safety property. Any
  single election in a quiet cluster succeeds, so every election unit test passes; the livelock
  emerges only under contended relative timings across repeated rounds, trips no safety invariant,
  and is caught only by a liveness-mode oracle that heals faults and demands convergence within a
  bounded tick budget (the structure that also found TigerBeetle's round-robin repair "resonance"
  livelock).

## Sources

### Raft paper and implementation guidance

- https://raft.github.io — resource hub: extended paper, dissertation, TLA+ spec, RaftScope, implementation comparison table.
- https://raft.github.io/raft.pdf — the extended paper; full text extracted locally (WebFetch could not parse the PDF streams); primary source for every rule quoted above.
- https://thesquareplanet.com/blog/students-guide-to-raft/ — the canonical trap catalog from hundreds of student implementations.
- http://thesecretlivesofdata.com/raft/ — JavaScript-driven page returned only its shell, so content beyond the title could not be verified; known prior art for a narrative Raft walkthrough.

### FoundationDB

- https://apple.github.io/foundationdb/testing.html — simulation docs: Flow, ~10:1 time factor, swizzle-clogging, fault taxonomy, the trillion-CPU-hours claim.
- https://alex-ii.github.io/notes/2018/04/29/distributed_systems_with_deterministic_simulation.html — detailed third-party notes on Will Wilson's StrangeLoop 2014 talk.
- https://transactional.blog/simulation/buggify — the canonical BUGGIFY write-up: three rules, 25% default, usage patterns.
- https://antithesis.com/company/backstory/ — FDB timeline, one user-reported bug pre-acquisition, Antithesis founding and funding.
- https://databases.systems/posts/open-source-antithesis-p1 — the DST ecosystem descending from FDB: VOPR, madsim, turmoil, Coyote.
- https://www.youtube.com/watch?v=4fFDFbi3toc — the primary talk recording; not fetched directly, content taken from the notes above.

### TigerBeetle VOPR

- https://docs.tigerbeetle.com/concepts/safety/ — VOPR overview: real code, all fault classes, 1000x speed, 1024 cores.
- https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/docs/internals/vopr.md — determinism from seed + commit; stubbed clock/network/disk; FDB and Antithesis cited as inspiration.
- https://tigerbeetle.com/blog/2023-07-11-we-put-a-distributed-database-in-the-browser/ — the VOPR compiled to WASM; the 2 GiB fight; gamified fault levels.
- https://tigerbeetle.com/blog/2023-07-06-simulation-testing-for-liveness/ — the two-phase safety-to-liveness protocol and the "resonance" repair bug.
- https://tigerbeetle.com/blog/2026-08-20-protocol-aware-dst/ — invariants inside each replica vs black-box testing; three checking levels.
- https://tigerbeetle.com/blog/2025-02-13-a-descent-into-the-vortex/ — the complementary non-deterministic harness covering what DST stubs out.
- https://github.com/tigerbeetle/tigerbeetle/blob/main/src/vopr.zig — simulator entry point read in full: seed handling, swarm options, liveness transition, failure reporting.
- https://github.com/tigerbeetle/tigerbeetle/blob/main/src/testing/cluster/state_checker.zig — the canonical-history checker catching split-brain at the divergent op.
- https://github.com/tigerbeetle/tigerbeetle/blob/main/src/testing/cluster/storage_checker.zig — byte-for-byte cross-replica storage verification and its documented exclusions.
- https://github.com/tigerbeetle/tigerbeetle/blob/main/src/testing/packet_simulator.zig — the network fault model: delay, loss, replay, clogging, partition modes.
- https://github.com/tigerbeetle/tigerbeetle/blob/main/src/scripts/cfo.zig — the continuous fuzzing orchestrator and public seed-log merge policy.
- https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/docs/internals/testing.md — the dense fixed-column VOPR log format.
- https://sim.tigerbeetle.com/ — confirmed a minimal HTML shell; the whole experience is the WASM binary rendering to canvas.
- https://raw.githubusercontent.com/tigerbeetle/tigerbeetle/main/build.zig — the replay interface: `zig build vopr -- <seed>`, log-mode build options.

### Antithesis

- https://antithesis.com/blog/ — index used to locate the posts below.
- https://antithesis.com/docs/introduction/how_antithesis_works/ — the multiverse execution model and RL-guided exploration.
- https://antithesis.com/blog/deterministic_hypervisor/ — the bhyve-fork hypervisor: virtualized time sources, one core per VM, the failed PMC experiment.
- https://antithesis.com/blog/2026/finding-bugs-in-raft-implementations/ — bugs in every Raft implementation tested; the chain-of-blocks harness; the four implicit paper assumptions.
- https://antithesis.com/docs/best_practices/sometimes_assertions/ — situations vs locations; sometimes-assertions as checkpoints.
- https://antithesis.com/blog/mongo_bug/ — WiredTiger rollback corruption; checkpoint-bisection localization; Antithesis in MongoDB's CI.
- https://antithesis.com/blog/testing_pyramid/ — why unit-test-heavy pyramids miss emergent distributed failures.
- https://etcd.io/blog/2025/autonomus_testing_with_antithesis/ — etcd under the hypervisor: 830 hours simulating ~4.5 years, four new bugs, five reproduced.
- https://antithesis.com/blog/2025/synadia/ — the NATS/JetStream five-step data-loss sequence, reproduced in 3 minutes of virtual time.
- https://antithesis.com/blog/2026/wal-reset-bug/ — the 16-year SQLite WAL race, found in 15 minutes with generic properties.
- https://antithesis.com/blog/reliability_series_part_1/ — property-based testing scaled to whole systems and their environments.

### TS/JS Raft survey

- https://github.com/unshiftio/liferaft — README and repo page; EventEmitter JS Raft, no snapshots.
- https://api.github.com/repos/unshiftio/liferaft — pushed 2021-03-23, dormant 5+ years.
- https://api.github.com/repos/unshiftio/liferaft/contents/test — five mocha files, unit tests only.
- https://raw.githubusercontent.com/unshiftio/liferaft/master/test/cluster.js — the only multi-node election test, `it.skip`'d; real timers and real TCP.
- https://api.github.com/repos/unshiftio/liferaft/issues?state=open — replication effectively unfinished per issues #17, #18, #20.
- https://registry.npmjs.org/liferaft — v1.0.0 published 2018-03-02, nothing since.
- https://github.com/royaltm/node-zmq-raft — most feature-complete JS implementation; ZMQ transport not replaceable.
- https://api.github.com/repos/royaltm/node-zmq-raft — pushed 2026-08-10, still maintained, 34 stars.
- https://raw.githubusercontent.com/royaltm/node-zmq-raft/master/package.json — v0.8.0; node-tap unit test script; no simulation or fuzzing anywhere.
- https://github.com/matthewaveryusa/raft.ts — prevote, pipelining, joint consensus; snapshotting explicitly not implemented.
- https://api.github.com/repos/matthewaveryusa/raft.ts — pushed 2026-07-21, 7 stars.
- https://raw.githubusercontent.com/matthewaveryusa/raft.ts/master/test/cluster.ts — the virtual-clock harness read at source: fixed tie-break constant, no seeded randomness, one invariant.
- https://github.com/coatyio/consensus.raft.js/ — TS port of etcd raft over Coaty; requires an MQTT broker.
- https://api.github.com/repos/coatyio/consensus.raft.js — pushed 2023-10-19, dormant ~3 years.
- https://registry.npmjs.org/@maboke123%2Fraft-core — v0.2.1 (2026-03-24); ships MockTransport/MockClock/SeededRandom for consumers.
- https://github.com/maboke123/raft-consensus-algorithm — pushed 2026-04-13; devtools visualizer observes a live cluster, injects nothing.
- https://api.github.com/repos/maboke123/raft-consensus-algorithm/contents/packages/raft-core — verified: no test directory in the raft-core package.
- https://registry.npmjs.org/-/v1/search?text=raft%20consensus&size=25 — landscape check; historical packages dead, @nodeguy/raft unpublished.
