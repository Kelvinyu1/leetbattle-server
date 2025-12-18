const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config();

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✓ MongoDB connected'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

const PORT = process.env.PORT || 3001;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] }
});

const { getRandomProblem } = require('./problems');
const { runSubmission } = require('./judge-run');
const User = require('./models/User');

app.get('/health', (_, res) => res.json({ ok: true }));

/** ---------- In-memory state (MVP) ---------- */
let waiting = null; // { socketId, name, userId }
const userNames = new Map(); // userId -> name
const roomTimers = new Map(); // roomId -> interval
const rematchRequests = new Map(); // roomId -> Set<userId>
const scoreboard = new Map(); // userId -> { name, wins, losses }

/** ---------- Helpers ---------- */
function clearRoomTimer(roomId) {
  const t = roomTimers.get(roomId);
  if (t) {
    clearInterval(t);
    roomTimers.delete(roomId);
  }
}

function startTimer(roomId, secs) {
  clearRoomTimer(roomId);
  let remaining = secs;
  const t = setInterval(() => {
    remaining--;
    io.to(roomId).emit('timer.tick', { remaining });
    if (remaining <= 0) {
      clearInterval(t);
      roomTimers.delete(roomId);
      io.to(roomId).emit('match.over', { winnerId: null, reason: 'time' });
    }
  }, 1000);
  roomTimers.set(roomId, t);
}

function safeProblem(problem) {
  return {
    slug: problem.slug,
    title: problem.title,
    difficulty: problem.difficulty,
    statement: problem.statement,
    url: problem.url || null,
    starter_code: problem.starter_code
  };
}

async function broadcastScoreboard() {
  try {
    // Get top users from database
    const topUsers = await User.find()
      .sort({ wins: -1, losses: 1 })    // Sort by descending wins, ascending losses for tie
      .limit(50)
      .select('username wins losses _id');

    const list = topUsers.map(user => ({
      userId: user._id.toString(),
      name: user.username,
      wins: user.wins,
      losses: user.losses
    }));

    io.emit('scoreboard.update', list);
  } catch (err) {
    console.error('Error fetching scoreboard:', err);
  }
}

async function startRound(roomId, countdownSeconds = 900) {
  // pick one problem WITH tests and stash per socket
  const sockets = [...(io.sockets.adapter.rooms.get(roomId) || [])]
    .map(id => io.sockets.sockets.get(id))
    .filter(Boolean);

  if (sockets.length < 2) return; // need 2 players

  const problem = await getRandomProblem(true);
  sockets.forEach(s => (s.data.__problem = problem));

  const players = sockets.map(s => ({ id: s.data.userId, name: userNames.get(s.data.userId) || 'Player' }));
  const payload = {
    matchId: nanoid(),
    roomId,
    players,
    problem: safeProblem(problem),
    countdownSeconds
  };

  io.to(roomId).emit('match.start', payload);
  startTimer(roomId, countdownSeconds);
}

/** ---------- Auth Helpers ---------- */
async function registerUser(username, password) {
  try {
    const existing = await User.findOne({ username });
    if (existing) {
      return { success: false, error: 'Username already taken' };
    }
    
    // Save to DB
    const user = new User({ username, password });
    await user.save();

    return { success: true, user };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function loginUser(username, password) {
  try {
    const user = await User.findOne({ username });
    if (!user) {
      return { success: false, error: 'User not found' };
    }

    const isMatch = user.comparePassword(password); 
    if (!isMatch) {
      return { success: false, error: 'Invalid password' };
    }

    return { success: true, user };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function updateUserStats(userId, didWin) {
  try {
    const user = await User.findById(userId);
    if (!user) return;

    if (didWin) {
      user.wins += 1;
    } else {
      user.losses += 1;
    }

    await user.save();
    return user;
  } catch (err) {
    console.error('Error updating stats:', err);
  }
}

/** ---------- Socket handlers ---------- */
io.on('connection', (socket) => {
  socket.data.userId = nanoid();
  socket.emit('session', { userId: socket.data.userId }); // let client know "who am I"

  // Handle sign up
  socket.on('auth.signup', async ({ username, password }) => {
    const result = await registerUser(username, password);
    if (result.success) {
      socket.data.dbUserId = result.user._id;
      socket.data.userId = result.user._id.toString();
      userNames.set(socket.data.userId, result.user.username);
      socket.emit('auth.success', { user: result.user });
      await broadcastScoreboard();  // Send leaderboard to all 
    } else {
      socket.emit('auth.error', { error: result.error });
    }
  });

  // Handle login
  socket.on('auth.login', async ({ username, password }) => {
    const result = await loginUser(username, password);
    if (result.success) {
      // Store the ID 
      socket.data.dbUserId = result.user._id;
      socket.data.userId = result.user._id.toString();
      userNames.set(socket.data.userId, result.user.username);
      socket.emit('auth.success', { user: result.user });
      await broadcastScoreboard();  // Send leaderboard to all 
    } else {
      socket.emit('auth.error', { error: result.error });
    }
  });

  socket.on('queue.join', async ({ name }) => {
    userNames.set(socket.data.userId, name || 'Player');

    if (!waiting) {
      waiting = { socketId: socket.id, name, userId: socket.data.userId };
      socket.emit('queue.status', { status: 'waiting' });
      return;
    }

    // Pair with the waiting player
    const p1 = waiting; waiting = null;
    const p2 = { socketId: socket.id, name, userId: socket.data.userId };
    const roomId = `room:${nanoid(6)}`;

    [p1.socketId, p2.socketId].forEach((sid) => {
      const s = io.sockets.sockets.get(sid);
      s?.join(roomId);
    });

    // Start first round
    await startRound(roomId);
  });

  socket.on('room.submit', async ({ code, lang }) => {
    // find current room
    const roomId = [...socket.rooms].find(r => r.startsWith('room:'));
    if (!roomId) return;

    const sockets = [...(io.sockets.adapter.rooms.get(roomId) || [])].map(id => io.sockets.sockets.get(id)).filter(Boolean);
    if (sockets.length < 1) return;

    const problem = sockets[0].data.__problem; // already set at round start
    if (!problem) return;

    try {
      const result = await runSubmission({ code, problem, lang });
      io.to(roomId).emit('submission.result', { userId: socket.data.userId, ...result });

      if (result.verdict === 'Accepted') {
        clearRoomTimer(roomId);

        // Determine loser
        const winnerId = socket.data.userId;
        const loserSocket = sockets.find(s => s.data.userId !== winnerId);
        const loserId = loserSocket ? loserSocket.data.userId : null;

        // Update stats in database
        if (socket.data.dbUserId) {
          await updateUserStats(socket.data.dbUserId, true);
        }
        if (loserSocket?.data?.dbUserId) {
          await updateUserStats(loserSocket.data.dbUserId, false);
        }

        // In-memory scoreboard (maybe delete?)
        const wName = userNames.get(winnerId) || 'Player';
        const lName = loserId ? (userNames.get(loserId) || 'Player') : 'Player';

        const wRow = scoreboard.get(winnerId) || { name: wName, wins: 0, losses: 0 };
        wRow.name = wName; wRow.wins += 1;
        scoreboard.set(winnerId, wRow);

        if (loserId) {
          const lRow = scoreboard.get(loserId) || { name: lName, wins: 0, losses: 0 };
          lRow.name = lName; lRow.losses += 1;
          scoreboard.set(loserId, lRow);
        }
        await broadcastScoreboard();

        io.to(roomId).emit('match.over', { winnerId, reason: 'first-accept' });
      }
    } catch (e) {
      io.to(roomId).emit('submission.result', {
        userId: socket.data.userId,
        verdict: 'Runtime/Error',
        passCount: 0,
        total: 0,
        timeMs: 0,
        error: String(e.message || e).slice(0, 200)
      });
    }
  });

  socket.on('rematch.request', async () => {
    const roomId = [...socket.rooms].find(r => r.startsWith('room:'));
    if (!roomId) return;

    let set = rematchRequests.get(roomId);
    if (!set) {
      set = new Set();
      rematchRequests.set(roomId, set);
    }
    set.add(socket.data.userId);

    const sockets = [...(io.sockets.adapter.rooms.get(roomId) || [])].map(id => io.sockets.sockets.get(id)).filter(Boolean);
    const readyCount = [...set].length;
    const total = sockets.length;

    io.to(roomId).emit('rematch.status', { readyCount, total });

    if (readyCount >= 2 && total >= 2) {
      // both (two) players ready → new round
      rematchRequests.delete(roomId);
      await startRound(roomId, 900);
    }
  });

  /// --------- TEST: Auto-win button for quick testing ---------
  socket.on('test.autowin', async () => {
    const roomId = [...socket.rooms].find(r => r.startsWith('room:'));
    if (!roomId) return;

    const sockets = [...(io.sockets.adapter.rooms.get(roomId) || [])].map(id => io.sockets.sockets.get(id)).filter(Boolean);
    if (sockets.length < 2) return;

    clearRoomTimer(roomId);

    const winnerId = socket.data.userId;
    const loserSocket = sockets.find(s => s.data.userId !== winnerId);
    const loserId = loserSocket ? loserSocket.data.userId : null;

    // Update stats in database
    if (socket.data.dbUserId) {
      await updateUserStats(socket.data.dbUserId, true);
    }
    if (loserSocket?.data?.dbUserId) {
      await updateUserStats(loserSocket.data.dbUserId, false);
    }

    // In-memory scoreboard (for backwards compatibility)
    const wName = userNames.get(winnerId) || 'Player';
    const lName = loserId ? (userNames.get(loserId) || 'Player') : 'Player';

    const wRow = scoreboard.get(winnerId) || { name: wName, wins: 0, losses: 0 };
    wRow.name = wName; wRow.wins += 1;
    scoreboard.set(winnerId, wRow);

    if (loserId) {
      const lRow = scoreboard.get(loserId) || { name: lName, wins: 0, losses: 0 };
      lRow.name = lName; lRow.losses += 1;
      scoreboard.set(loserId, lRow);
    }
    await broadcastScoreboard();

    io.to(roomId).emit('match.over', { winnerId, reason: 'test-autowin' });
  });
  /// ---------------------------------------------------------------------------

  socket.on('disconnect', () => {
    // cleanup waiting
    if (waiting?.socketId === socket.id) waiting = null;

    // cleanup rematch if needed
    for (const [roomId, set] of rematchRequests) {
      if (set.has(socket.data.userId)) {
        set.delete(socket.data.userId);
        if (set.size === 0) rematchRequests.delete(roomId);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});

