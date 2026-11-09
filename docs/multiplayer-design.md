# Multiplayer without a game server (design note, not implemented)

Status: proposal, kept for later. Written 2026-11-09 against the code at commit `1e96c36`.

The game is already shaped for **deterministic lockstep**: the simulation runs at a fixed 60 Hz with a
seeded RNG, golden-hash tests prove a run is reproducible, and replays work from recorded inputs
(`InputStream` / `InputPlayer`). Peers therefore never exchange world state: every player runs the same
simulation and only **player inputs** travel over the network.

## 1. Connection: browser to browser

- **Transport:** WebRTC data channels between browsers. GitHub Pages keeps hosting the game; nothing runs
  on a server.
- **Signalling** (the one-time exchange of connection details):
  - *No server at all:* the host clicks *Host game* and gets an invite code (the WebRTC offer, deflated and
    base64url-encoded like the `SG1:` ship codes). The guest pastes it and sends an answer code back.
  - *Optional tiny relay:* a ~50-line Cloudflare Worker (free tier) that matches room codes ("join ABCD") and
    can relay traffic for the ~10–20 % of networks where a direct connection fails — the only case that
    truly needs a server.
- **Topology:** for 2–4 players a host star. The host owns the room and forwards traffic; guests connect
  only to the host (one invite code per guest). The host has no authority over the simulation; it routes
  messages and fixes the start settings.

## 2. What gets sent

### a) Once, at match start (a few kB)

| Item | Notes |
|---|---|
| Protocol version, game version | Refuse to start on mismatch |
| Core catalogue version and hash | Already in the export format |
| Scenario or arena | Scenario id + hash, or the full JSON for custom ones |
| Each player's fleet | Existing export bundle with dependencies (self-contained, compressible) |
| Seed, team and slot assignment, start tick | Chosen by the host |
| Settings | Time limit, pause allowed or not |

Every peer computes a **setup hash** and confirms it before tick 0 (this also re-checks fleet budgets).

### b) During play: input frames

Same idea as `InputStream`: a frame says "from tick T, ship S does X"; most ticks nothing changes, so only
changes are sent.

| Field | Encoding |
|---|---|
| Thrust x/y, rotate | 2 bits each (keys are digital −1 / 0 / +1) |
| Face angle (mouse) | 16-bit angle, only when it changes |
| Aim point | two 16-bit ints (0.5 m steps), relative to the ship |
| Trigger, selected groups | 1 + 9 bits |

One-shot **commands** with their own ids: speed kill, launch one / salvo, drone one / all, eject part(s),
target, group mode and group settings, power priority, radiators, PD vs ships, ally order
(follow / attack / hold), switching ships (Tab).

Packet: `[type][tick: u32][slot: u8][frames…]`, about 10–40 bytes, only on change. Four players: well under
2 kB/s.

### c) Periodically: sync checks

Every 60 ticks each peer sends `world.hash()` for that tick (32 bytes; the hashing exists for the golden
tests). A mismatch shows "desync at tick N" and stops or resynchronises (section 4).

## 3. The lockstep loop

1. **Input delay:** a key pressed at local tick T is scheduled for tick T + D, with D = 4–6 ticks
   (≈ 70–100 ms). The local player gets immediate cosmetic feedback (crosshair, HUD, camera).
2. A peer simulates tick T only when it has inputs for T from every player; idle slots send a small
   "no change up to T" heartbeat. Missing input → wait (a slow peer slows everyone; normal for lockstep).
3. Reliable, ordered data channels: lost packets are resent, no gap handling. Packets may repeat the last
   few frames to smooth jitter.
4. **Adaptive delay:** measure round-trip time from heartbeats; raise or lower D (3–10 ticks) when the game
   stalls too often.
5. **Pause / time scale:** time-scale keys disabled in multiplayer; pause is a command that takes effect for
   everyone at an agreed tick.

Rollback (predict and re-simulate, as fighting games do) is not worth it for a tactical game: it would need
fast save/restore of the whole Planck physics world.

## 4. Late join, reconnect, replays

Every peer keeps the full input log from tick 0. A reconnecting player or a spectator receives the setup
plus the log and replays it at full speed with `InputPlayer` (headless runs reach ≥ 20× real time). Saving
the same log gives match replays for free. A snapshot transfer (full world state) is only needed to recover
from a desync, so it can come later.

## 5. Prerequisites in the code

1. **Command layer.** The UI currently writes to the simulation directly in about 19 places
   (`pdEngageShips`, radiators, group modes, power priority, drone launches, AI orders, `setAi` / `clearAi`
   on Tab, eject requests, …). All of these must become commands scheduled for a tick and applied
   identically on every peer (and recorded in the replay log). Single player then becomes one local player
   with zero delay.
2. **Cross-browser determinism (main risk).** Basic float maths is identical across browsers, but
   `Math.sin/cos/atan2/exp/pow` are not guaranteed bit-identical between engines (V8 vs SpiderMonkey). The
   simulation uses them in 11 files and Planck.js itself calls `sin`/`cos` in 8 places. Options: v1 limited
   to Chromium-based browsers with the hash check catching problems; better, a small deterministic maths
   module for `src/sim`, Planck's few call sites patched, a lint rule like the `Math.random` ban, and the
   golden tests also run on Firefox in CI.
3. Everything that is not input stays local: camera, overlays, theme, HUD toggles, the on-screen group
   selection.

## 6. Cheating and trust

No hidden information to protect (the spec is perfect-information; every peer has the full state). Each peer
accepts input frames only for the sender's own ships and re-checks fleet budgets at setup. A modified client
cannot change what others see without breaking the hash.

## 7. Suggested order of work

1. Command layer (no networking; single player uses it).
2. Input log and replay files.
3. Lockstep scheduler with two local "peers" in one tab (delay, stalls, hash checks).
4. WebRTC with copy-paste invite codes, two players.
5. Host star for 3–4 players; optional Cloudflare relay.
6. Deterministic maths; Firefox golden-test job.
7. Reconnect by log replay; spectators.
