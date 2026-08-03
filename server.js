const path = require('path');
const express = require('express');
const { createClient } = require('redis');

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// The whole leaderboard lives in this one Sorted Set key.
// member = player name, score = total points.
const KEY = 'leaderboard';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// One client for the whole process, reused by every request.
// Opening a connection per request would be slow and would exhaust Redis.
const client = createClient({ url: REDIS_URL });
client.on('error', (err) => console.error('Redis client error:', err.message));

// POST /score  { name, points }
// Adds `points` to this player's running total.
app.post('/score', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const points = Number(req.body?.points);

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!Number.isFinite(points)) {
    return res.status(400).json({ error: 'points must be a number' });
  }

  try {
    // ZINCRBY leaderboard <points> <name>
    // Sorted Set: adds <points> to the member's existing score, creating the
    // member at that score if it doesn't exist yet. Returns the NEW total.
    // This is why we never need a read-modify-write round trip — Redis does
    // the increment atomically, so two simultaneous submits can't clobber
    // each other. O(log N).
    const total = await client.zIncrBy(KEY, points, name);

    res.json({ name, points: total });
  } catch (err) {
    console.error('POST /score failed:', err.message);
    res.status(500).json({ error: 'could not record score' });
  }
});

// GET /leaderboard?top=10
// Highest scores first.
app.get('/leaderboard', async (req, res) => {
  // Clamp so a stray ?top=999999 can't ask Redis for the entire set.
  const requested = parseInt(req.query.top, 10);
  const top = Math.min(Math.max(Number.isNaN(requested) ? 10 : requested, 1), 100);

  try {
    // ZRANGE leaderboard 0 <top-1> REV WITHSCORES
    // (this is the modern spelling of ZREVRANGE, which is deprecated in
    // Redis 6.2+ — REV on ZRANGE does the same job)
    // Sorted Sets are always stored low→high, so REV walks from the top
    // instead. WITHSCORES asks for the scores alongside the members, which
    // node-redis hands back as [{ value, score }]. Indexes are inclusive,
    // hence top-1. O(log N + M), where M is the number of rows returned.
    const rows = await client.zRangeWithScores(KEY, 0, top - 1, { REV: true });

    // Rank comes from position in the reversed range: index 0 is rank 1.
    res.json(
      rows.map((row, i) => ({
        rank: i + 1,
        name: row.value,
        points: row.score,
      }))
    );
  } catch (err) {
    console.error('GET /leaderboard failed:', err.message);
    res.status(500).json({ error: 'could not read leaderboard' });
  }
});

// POST /reset — wipe the board.
app.post('/reset', async (req, res) => {
  try {
    // DEL leaderboard
    // Removes the whole key. Returns 1 if it existed, 0 if it was already
    // gone — deleting a missing key is not an error in Redis. O(M) for a
    // Sorted Set, since every member has to be freed.
    await client.del(KEY);

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /reset failed:', err.message);
    res.status(500).json({ error: 'could not reset leaderboard' });
  }
});

async function start() {
  // node-redis v4+ does not connect on construction — you have to await this.
  await client.connect();
  console.log(`Connected to Redis at ${REDIS_URL}`);

  app.listen(PORT, () => {
    console.log(`Leaderboard running at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
