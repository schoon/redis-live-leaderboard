# redis-leaderboard

A live leaderboard backed by Redis. Small, single-purpose learning project — a
Node/Express API over a Redis Sorted Set, with a plain HTML/JS page that polls it.

## Stack

- **Backend:** Node.js + Express
- **Redis client:** the official [`redis`](https://github.com/redis/node-redis) npm package (node-redis v4+)
- **Frontend:** plain HTML + vanilla JS. No framework, no build step, no bundler.
- **Redis:** `redis://localhost:6379`

## Commands

```bash
npm start        # runs the Express server (the only command you need)
```

Redis is expected to already be running at `redis://localhost:6379`. If it isn't,
`docker run -p 6379:6379 redis` is enough.

## Conventions

**Keep it simple.** This is a learning project, not production. Prefer the
obvious, boring solution over the clever one. Don't add abstraction layers,
dependency injection, repository patterns, or service classes. A route handler
that calls Redis directly is the right amount of structure here.

**No auth.** No login, no sessions, no API keys, no rate limiting. Anyone can
post a score. Don't add auth "just to be safe" — if a feature seems to need it,
say so and let me decide.

**Comment every Redis call.** This is the most important convention in the repo.
Each Redis command gets a comment naming the actual Redis command and what it
does, so I can learn the commands by reading the code. Not "add the score" —
name the command, its arguments, and its Big-O if it's interesting:

```js
// ZINCRBY leaderboard <points> <player>
// Sorted Set: adds <points> to the member's score, creating it if absent.
// Returns the new total. Atomic, so two simultaneous submits can't clobber
// each other — no read-modify-write needed. O(log N).
const total = await client.zIncrBy('leaderboard', points, player);

// ZRANGE leaderboard 0 9 REV WITHSCORES
// Sorted Sets are stored low→high, so REV reads from the top. WITHSCORES
// returns scores alongside members. Indexes are inclusive. O(log N + M).
const top = await client.zRangeWithScores('leaderboard', 0, 9, { REV: true });

// DEL leaderboard
// Drops the whole key. Returns 0 if it was already gone, which is not an
// error in Redis. O(M) for a Sorted Set — every member has to be freed.
await client.del('leaderboard');
```

Don't leave Redis calls bare, and don't strip these comments when refactoring.

**Minimal dependencies.** `express` and `redis` are the whole dependency list.
Ask before adding anything else.

**Errors:** let them surface. Log to console, return a plain JSON `{ error }`
with a sensible status. No custom error classes or error middleware hierarchies.

## Redis data model

One Sorted Set is the entire leaderboard — score is the sort key, member is the
player name. Sorted Sets are exactly the right structure here, so resist the
urge to mirror state into a Hash or a List.

- `leaderboard` — Sorted Set. member = player name, score = cumulative points.

Scores are **running totals**, not personal bests: `POST /score` adds to the
existing score via `ZINCRBY`, so posting 10 twice leaves the player on 20.
Negative points subtract. Rank is never stored — it's the member's position in a
`REV` range, so nothing needs sorting in JavaScript.

If player metadata (avatar, joined-at) is ever needed, add `player:<name>` as a
Hash and use colon-separated key names to match.

## Layout

```
server.js        # Express app + Redis client + routes, all in one file
public/
  index.html     # the whole frontend: markup, styles and JS in one file
```

Keep it at this size. The frontend is deliberately a single self-contained
`index.html` — don't split the CSS or JS out into separate files. If `server.js`
genuinely outgrows one file, split routes out, but don't pre-split it.

## Client setup notes

node-redis v4+ requires an explicit `connect()`, and its command methods are
camelCase versions of the Redis commands (`zIncrBy` → `ZINCRBY`,
`zRangeWithScores` → `ZRANGE ... WITHSCORES`). Create **one** client at startup
and reuse it across requests — don't open a connection per request.

`ZREVRANGE` is deprecated as of Redis 6.2; use `ZRANGE ... REV` instead, which
is what `{ REV: true }` compiles to.

## Frontend

Polling on an interval is fine and intended — it keeps the code readable. Don't
reach for WebSockets, SSE, or Redis Pub/Sub unless I ask for them.
