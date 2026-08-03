# redis-live-leaderboard

A live leaderboard backed by a single Redis Sorted Set. Node + Express API,
plain HTML/JS frontend that polls it every 2 seconds.

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

| Method | Route                   | Body / query        | Description |
| ------ | ----------------------- | ------------------- | ----------- |
| `POST` | `/score`                | `{ name, points }`  | Adds `points` to that player's total. Returns the new total. |
| `GET`  | `/leaderboard?top=10`   | `top` (1–100, default 10) | Top N players, highest first. |
| `POST` | `/reset`                | —                   | Clears the leaderboard. |

`points` may be negative, which subtracts.

```bash
curl -X POST localhost:3000/score \
  -H 'Content-Type: application/json' \
  -d '{"name":"ada","points":50}'

curl 'localhost:3000/leaderboard?top=5'

curl -X POST localhost:3000/reset
```

## How the Redis part works

Everything lives in one Sorted Set at the key `leaderboard`, where each member
is a player name and its score is their point total. Three commands cover the
whole app:

- **`ZINCRBY leaderboard <points> <name>`** — adds to a player's score,
  creating them if they're new. Atomic, so concurrent submissions can't
  overwrite each other. O(log N).
- **`ZRANGE leaderboard 0 9 REV WITHSCORES`** — reads the top 10. Sorted Sets
  are stored low→high, so `REV` reads from the top; `WITHSCORES` returns the
  scores too. (`ZREVRANGE` does the same thing but is deprecated as of Redis
  6.2.) O(log N + M).
- **`DEL leaderboard`** — clears the board. O(M).

Ranking is free: the position in that `REV` range *is* the rank, so nothing
needs to be sorted in JavaScript.

You can watch it from the CLI while the app runs:

```bash
redis-cli zrange leaderboard 0 -1 REV WITHSCORES
```

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
