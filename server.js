const path = require('path');
const express = require('express');
const { createClient } = require('redis');

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// All-time board. One Sorted Set, never expires.
// member = player name, score = total points.
const ALL_TIME_KEY = 'leaderboard';

// Each ISO week gets its own Sorted Set at leaderboard:<year>-W<week>, with a
// TTL so weeks we no longer care about delete themselves. 8 days rather than 7
// gives a day of overlap, so a week is still readable just after it ends.
const WEEK_TTL_SECONDS = 8 * 24 * 60 * 60; // 691200

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// One client for the whole process, reused by every request.
// Opening a connection per request would be slow and would exhaust Redis.
const client = createClient({ url: REDIS_URL });
client.on('error', (err) => console.error('Redis client error:', err.message));

// ISO-8601 week label, e.g. "2026-W32". Computed in UTC so the week rolls over
// at the same instant regardless of the server's timezone.
function isoWeekLabel(now = new Date()) {
  // Date-only UTC copy, so the time of day can't shift which week we land in.
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // ISO weekdays are Mon=1..Sun=7, but getUTCDay() returns Sun=0.
  const isoDay = d.getUTCDay() || 7;

  // Step to the Thursday of this week. ISO-8601 says a week belongs to whatever
  // year its Thursday falls in — that single rule is what makes the weeks
  // straddling New Year come out right.
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);
  const isoYear = d.getUTCFullYear();

  // Week number is how many 7-day blocks that Thursday sits from Jan 1.
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d - jan1) / 86400000 + 1) / 7);

  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function weekKey(label) {
  return `leaderboard:${label}`;
}

// ?top=N, clamped so a stray ?top=999999 can't ask Redis for the entire set.
function parseTop(raw) {
  const requested = parseInt(raw, 10);
  return Math.min(Math.max(Number.isNaN(requested) ? 10 : requested, 1), 100);
}

async function readBoard(key, top) {
  // ZRANGE <key> 0 <top-1> REV WITHSCORES
  // (the modern spelling of ZREVRANGE, which is deprecated in Redis 6.2+ —
  // REV on ZRANGE does the same job)
  // Sorted Sets are always stored low→high, so REV walks from the top instead.
  // WITHSCORES asks for the scores alongside the members, which node-redis
  // hands back as [{ value, score }]. Indexes are inclusive, hence top-1.
  // O(log N + M), where M is the number of rows returned.
  const rows = await client.zRangeWithScores(key, 0, top - 1, { REV: true });

  // Rank comes from position in the reversed range: index 0 is rank 1.
  return rows.map((row, i) => ({
    rank: i + 1,
    name: row.value,
    points: row.score,
  }));
}

// POST /score  { name, points }
// Adds `points` to this player's total on BOTH the all-time and current-week
// boards.
app.post('/score', async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const points = Number(req.body?.points);

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!Number.isFinite(points)) {
    return res.status(400).json({ error: 'points must be a number' });
  }

  const week = isoWeekLabel();
  const weekly = weekKey(week);

  try {
    // MULTI / EXEC — queue the commands, then run them as one unit. Redis
    // executes a transaction without interleaving other clients' commands, so
    // the two boards can't be seen half-updated and can't drift apart if this
    // process dies mid-request. One round trip instead of three, too.
    const replies = await client
      .multi()
      // ZINCRBY leaderboard <points> <name>
      // Adds <points> to the member's score, creating the member if absent.
      // Returns the NEW total. Atomic, so simultaneous submits for the same
      // player can't clobber each other. O(log N).
      .zIncrBy(ALL_TIME_KEY, points, name)
      // ZINCRBY leaderboard:<week> <points> <name>
      // Same again against this week's key, which Redis creates on first write.
      .zIncrBy(weekly, points, name)
      // EXPIRE leaderboard:<week> 691200
      // (Re)sets the TTL to 8 days. Called on every write, so the countdown
      // restarts from the week's LAST submission rather than its first — the
      // key therefore outlives the week by up to 8 idle days, which is fine
      // for cleanup and keeps this to a single unconditional command. O(1).
      .expire(weekly, WEEK_TTL_SECONDS)
      .exec();

    const [allTimeTotal, weeklyTotal] = replies;

    res.json({
      name,
      points: allTimeTotal,
      weekly: { week, points: weeklyTotal },
    });
  } catch (err) {
    console.error('POST /score failed:', err.message);
    res.status(500).json({ error: 'could not record score' });
  }
});

// GET /leaderboard?top=10 — all-time, highest first.
app.get('/leaderboard', async (req, res) => {
  try {
    res.json(await readBoard(ALL_TIME_KEY, parseTop(req.query.top)));
  } catch (err) {
    console.error('GET /leaderboard failed:', err.message);
    res.status(500).json({ error: 'could not read leaderboard' });
  }
});

// GET /leaderboard/weekly?top=10 — the current ISO week, highest first.
// Returns the week label too, so the UI can show which week it is.
app.get('/leaderboard/weekly', async (req, res) => {
  const week = isoWeekLabel();

  try {
    // Reading a key that doesn't exist yet (nobody has scored this week) is
    // not an error — ZRANGE on a missing key just returns an empty array.
    const players = await readBoard(weekKey(week), parseTop(req.query.top));
    res.json({ week, players });
  } catch (err) {
    console.error('GET /leaderboard/weekly failed:', err.message);
    res.status(500).json({ error: 'could not read weekly leaderboard' });
  }
});

// POST /reset — clears the all-time board and the current week's board.
// Earlier weeks are left alone; their TTLs will take care of them.
app.post('/reset', async (req, res) => {
  const week = isoWeekLabel();

  try {
    // DEL leaderboard leaderboard:<week>
    // DEL takes multiple keys and returns how many actually existed, so
    // deleting an already-missing key is not an error. O(M) for a Sorted Set,
    // since every member has to be freed.
    const deleted = await client.del([ALL_TIME_KEY, weekKey(week)]);

    res.json({ ok: true, keysDeleted: deleted });
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
    console.log(`Current week key: ${weekKey(isoWeekLabel())}`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
