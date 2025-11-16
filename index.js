const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const dotenv = require('dotenv');

dotenv.config();

const PORT = process.env.PORT || 3001;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] }
});

const { getRandomProblem } = require('./problems');
const { runSubmission } = require('./judge-run');

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

function broadcastScoreboard() {
  // sort by wins desc, then losses asc
  const list = [...scoreboard.entries()]
    .map(([userId, v]) => ({ userId, ...v }))
    .sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses))
    .slice(0, 50);
  io.emit('scoreboard.update', list);
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

/** ---------- Socket handlers ---------- */
io.on('connection', (socket) => {
  socket.data.userId = nanoid();
  socket.emit('session', { userId: socket.data.userId }); // let client know "who am I"

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

        // Update scoreboard
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
        broadcastScoreboard();

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

