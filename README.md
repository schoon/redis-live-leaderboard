# redis-live-leaderboard

A live leaderboard backed by Redis Sorted Sets. Node + Express API, plain HTML/JS
frontend that polls it every 2 seconds.

Two boards, shown side by side: an **all-time** board that never expires, and a
**weekly** board keyed by ISO week (`leaderboard:2026-W32`) that expires 8 days
after its last write, so old weeks clean themselves up. Every score counts
toward both.

Built as a learning project for Redis Sorted Sets — every Redis call in the
source is commented with the command it issues and its complexity.

## Requirements

- Node.js 18 or newer
- A Redis server reachable at `redis://localhost:6379`

If you don't have Redis running:

```bash
docker run -d -p 6379:6379 --name redis redis
# or, with Homebrew:  brew services start redis
```

Check it's up with `redis-cli ping` — it should answer `PONG`.

## Setup

```bash
npm install
```

## Run

```bash
npm start
```

Then open <http://localhost:3000>.

Both settings can be overridden by environment variable:

```bash
PORT=4000 REDIS_URL=redis://localhost:6380 npm start
```

## API

| Method | Route                          | Body / query        | Description |
| ------ | ------------------------------ | ------------------- | ----------- |
| `POST` | `/score`                       | `{ name, points }`  | Adds `points` to that player's total on **both** boards. Returns both new totals. |
| `GET`  | `/leaderboard?top=10`          | `top` (1–100, default 10) | Top N all-time, highest first. |
| `GET`  | `/leaderboard/weekly?top=10`   | `top` (1–100, default 10) | Top N for the current ISO week, plus the week label. |
| `GET`  | `/rank/:name`                  | —                   | One player's all-time rank (1-based) and score. `404` if they aren't on the board. |
| `POST` | `/reset`                       | —                   | Clears the all-time board and the current week's board. |

`points` may be negative, which subtracts.

The two read routes return different shapes — the weekly one wraps its rows so
it can also tell you which week you're looking at:

```bash
curl -X POST localhost:3000/score \
  -H 'Content-Type: application/json' \
  -d '{"name":"ada","points":50}'
# {"name":"ada","points":50,"weekly":{"week":"2026-W32","points":50}}

curl 'localhost:3000/leaderboard?top=5'
# [{"rank":1,"name":"ada","points":50}]

curl 'localhost:3000/leaderboard/weekly?top=5'
# {"week":"2026-W32","players":[{"rank":1,"name":"ada","points":50}]}

curl localhost:3000/rank/ada
# {"found":true,"name":"ada","rank":1,"outOf":1,"points":50}

curl localhost:3000/rank/nobody
# 404  {"found":false,"name":"nobody","message":"nobody isn't on the board yet."}

curl -X POST localhost:3000/reset
# {"ok":true,"keysDeleted":2}
```

Names are matched exactly, so `/rank/Ada` will not find a player stored as
`ada`. Leading and trailing whitespace is trimmed, matching `POST /score`.

## How the Redis part works

There are two Sorted Sets. In both, each member is a player name and its score
is that player's point total:

| Key | Holds | Expires |
| --- | ----- | ------- |
| `leaderboard` | all-time totals | never |
| `leaderboard:2026-W32` | totals for one ISO week | 8 days after its last write |

A score submission writes to both, in a single transaction:

- **`MULTI` / `EXEC`** — wraps the three writes below so they run as one unit.
  Redis executes a transaction without interleaving other clients' commands, so
  nobody can observe one board updated and not the other, and the two can't
  drift apart if the process dies mid-request. It's also one round trip instead
  of three.
- **`ZINCRBY leaderboard <points> <name>`** — adds to a player's score,
  creating them if they're new. Atomic, so concurrent submissions can't
  overwrite each other. Returns the new total. O(log N).
- **`ZINCRBY leaderboard:<week> <points> <name>`** — same again against this
  week's key, which Redis creates on first write. There's no "create the key"
  step; writing to a missing Sorted Set makes it.
- **`EXPIRE leaderboard:<week> 691200`** — 8 days, so old weeks delete
  themselves and the keyspace doesn't grow forever. O(1).

Reads use:

- **`ZRANGE <key> 0 9 REV WITHSCORES`** — reads the top 10. Sorted Sets are
  stored low→high, so `REV` reads from the top; `WITHSCORES` returns the scores
  too. (`ZREVRANGE` does the same thing but is deprecated as of Redis 6.2.)
  Reading a week nobody has scored in yet returns an empty array rather than an
  error. O(log N + M).
- **`DEL leaderboard leaderboard:<week>`** — `DEL` takes several keys at once
  and returns how many existed. O(M).

Looking up one player uses another three, again in a single `MULTI` so all three
answers describe the same instant:

- **`ZREVRANK leaderboard <name>`** — the member's position counting down from
  the highest score. **0-based**, so the leader is `0` and the API adds 1 before
  returning it. Returns nil if the member isn't in the set. O(log N).
- **`ZSCORE leaderboard <name>`** — that member's score, or nil if absent. O(1).
- **`ZCARD leaderboard`** — how many members the set holds, so a rank can be
  shown as "3 of 12". O(1).

Note that Redis answers "no such member" with **nil, not an error** — and that a
player sitting at rank 0 with a score of 0 is a perfectly real player. So the
not-found check tests for nil specifically rather than for falsiness; treating `0`
as "missing" would hide the leader and anyone on zero points.

Ranking is free: the position in that `REV` range *is* the rank, so nothing
needs to be sorted in JavaScript.

### Two things to know about the week keys

**The week label is ISO-8601, computed in UTC.** ISO weeks start on Monday, and
a week belongs to whichever year its *Thursday* falls in — which is why
2025-12-29 lives in `leaderboard:2026-W01`, and 2027-01-01 lives in
`leaderboard:2026-W53`. Using UTC means the rollover happens at the same instant
no matter where the server is.

**The TTL restarts on every write, not when the week ends.** `EXPIRE` is called
on each submission, so the countdown runs from the week's *last* score. A week
that stops getting writes on Sunday survives into the following Monday-plus-8.
That still cleans itself up, which is all this needs — the alternative
(`EXPIRE ... NX`, Redis 7.0+, sets a TTL only if there isn't one) would pin the
expiry to the first write but adds a version dependency for no real gain here.

You can watch both boards from the CLI while the app runs:

```bash
redis-cli zrange leaderboard 0 -1 REV WITHSCORES
redis-cli zrange "leaderboard:$(date -u +%G-W%V)" 0 -1 REV WITHSCORES

# which week keys exist, and how long each has left
redis-cli keys 'leaderboard:*'
redis-cli ttl "leaderboard:$(date -u +%G-W%V)"
```

`date -u +%G-W%V` is the shell's own ISO year and week, so it should always
agree with the key the app is writing to.

## Run it on localhost only

**There is no authentication of any kind.** Anyone who can reach the server can
post arbitrary scores, and `POST /reset` deletes the entire leaderboard without
so much as a confirmation. There is no rate limiting either, so a single client
can flood the board.

That is a deliberate choice for a local learning project, and it means this is
**not safe to expose to a network**. Before running it anywhere but your own
machine you would need, at minimum, auth on the write routes, rate limiting, and
a Redis instance that isn't reachable from the internet.

Two things to keep in mind if you do run it beyond localhost:

- Binding Express to `0.0.0.0` (or port-forwarding it) hands the reset endpoint
  to your whole network.
- Redis itself should stay bound to `127.0.0.1`. An open Redis port with no
  password is a well-known target, and this app sets no password.

## Notes

- Scores persist as long as Redis does. `docker run` without a volume means
  the board is lost when the container is removed.
- Player names are used directly as Sorted Set members, so two players with the
  same name share one score.
