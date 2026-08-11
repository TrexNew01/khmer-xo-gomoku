// server.js
// Backend for Khmer XO Gomoku Telegram Mini App.
// Express serves the static frontend; Socket.io drives real-time multiplayer.
// The server is authoritative: it owns board state, turn order, and win checks.
// Clients only ever send an intended move; they never write board state directly.

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const GRID_SIZE = 20;
const CELLS_TO_WIN = 5;
const ROOM_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours of inactivity -> room is garbage collected
const RECONNECT_GRACE_MS = 30 * 1000;   // how long a slot is held open after a disconnect

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // Telegram loads this in an in-app browser/webview; keep permissive
});

/**
 * In-memory room store. No database - rooms are cheap and ephemeral.
 * room = {
 *   id, board: Map<'r_c', 'X'|'O'>, currentPlayer, gameActive,
 *   movesCount, winnerCells, score: {X,O},
 *   players: { X: { userId, name, socketId, connected }, O: {...} },
 *   createdAt, lastActivity, disconnectTimers: { X: Timeout|null, O: Timeout|null }
 * }
 */
const rooms = new Map();

function makeEmptyRoom(roomId) {
  return {
    id: roomId,
    board: new Map(),
    currentPlayer: 'X',
    gameActive: true,
    movesCount: 0,
    winnerCells: null,
    lastMove: null,
    turnStartedAt: Date.now(),
    score: { X: 0, O: 0 },
    players: { X: null, O: null },
    createdAt: Date.now(),
    lastActivity: Date.now(),
    disconnectTimers: { X: null, O: null }
  };
}

function getOrCreateRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = makeEmptyRoom(roomId);
    rooms.set(roomId, room);
  }
  return room;
}

function publicRoomState(room) {
  return {
    id: room.id,
    board: Object.fromEntries(room.board),
    currentPlayer: room.currentPlayer,
    gameActive: room.gameActive,
    movesCount: room.movesCount,
    winnerCells: room.winnerCells,
    lastMove: room.lastMove,
    turnStartedAt: room.turnStartedAt,
    score: room.score,
    players: {
      X: room.players.X ? { name: room.players.X.name, photo: room.players.X.photo || null, connected: room.players.X.connected } : null,
      O: room.players.O ? { name: room.players.O.name, photo: room.players.O.photo || null, connected: room.players.O.connected } : null
    },
    bothJoined: !!(room.players.X && room.players.O)
  };
}

function broadcastRoom(room) {
  io.to(room.id).emit('room:state', publicRoomState(room));
}

// ---- Win detection (server-authoritative) ----
function computeWin(board, row, col, player) {
  const directions = [
    [[0, 1], [0, -1]],
    [[1, 0], [-1, 0]],
    [[1, 1], [-1, -1]],
    [[1, -1], [-1, 1]]
  ];
  for (const [d1, d2] of directions) {
    let count = 1;
    const cells = [[row, col]];
    for (const [dr, dc] of [d1, d2]) {
      let r = row + dr;
      let c = col + dc;
      while (
        r >= 0 && r < GRID_SIZE && c >= 0 && c < GRID_SIZE &&
        board.get(`${r}_${c}`) === player
      ) {
        count++;
        cells.push([r, c]);
        if (count >= CELLS_TO_WIN) return cells;
        r += dr;
        c += dc;
      }
    }
  }
  return null;
}

function resetBoard(room) {
  room.board = new Map();
  room.currentPlayer = 'X';
  room.gameActive = true;
  room.movesCount = 0;
  room.winnerCells = null;
  room.lastMove = null;
  room.turnStartedAt = Date.now();
}

// ---- Room cleanup: drop rooms that have been inactive for too long ----
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(id);
    }
  }
}, 60 * 1000).unref();

io.on('connection', (socket) => {
  let joinedRoomId = null;
  let mySymbol = null;

  socket.on('room:join', ({ roomId, userId, name, photo }, ack) => {
    try {
      if (!roomId || !userId) {
        return ack && ack({ ok: false, error: 'ត្រូវការ roomId និង userId' });
      }
      const room = getOrCreateRoom(String(roomId));
      room.lastActivity = Date.now();

      // Same user reconnecting into a slot they already occupy
      const existingSlot = ['X', 'O'].find(
        (sym) => room.players[sym] && room.players[sym].userId === String(userId)
      );

      let symbol;
      if (existingSlot) {
        symbol = existingSlot;
        const slot = room.players[symbol];
        slot.socketId = socket.id;
        slot.connected = true;
        slot.name = name || slot.name;
        slot.photo = photo || slot.photo || null;
        if (room.disconnectTimers[symbol]) {
          clearTimeout(room.disconnectTimers[symbol]);
          room.disconnectTimers[symbol] = null;
        }
      } else if (!room.players.X) {
        symbol = 'X';
        room.players.X = { userId: String(userId), name: name || 'Player X', photo: photo || null, socketId: socket.id, connected: true };
      } else if (!room.players.O) {
        symbol = 'O';
        room.players.O = { userId: String(userId), name: name || 'Player O', photo: photo || null, socketId: socket.id, connected: true };
      } else {
        // Room already has two distinct occupants - this caller is a spectator
        return ack && ack({ ok: false, error: 'room_full' });
      }

      joinedRoomId = room.id;
      mySymbol = symbol;
      socket.join(room.id);

      ack && ack({ ok: true, symbol, state: publicRoomState(room) });
      broadcastRoom(room);
    } catch (err) {
      console.error('room:join error', err);
      ack && ack({ ok: false, error: 'server_error' });
    }
  });

  socket.on('move:make', ({ row, col }, ack) => {
    try {
      if (!joinedRoomId || !mySymbol) return ack && ack({ ok: false, error: 'not_in_room' });
      const room = rooms.get(joinedRoomId);
      if (!room) return ack && ack({ ok: false, error: 'room_gone' });

      if (!room.players.X || !room.players.O) {
        return ack && ack({ ok: false, error: 'waiting_for_opponent' });
      }
      if (!room.gameActive) return ack && ack({ ok: false, error: 'game_over' });
      if (room.currentPlayer !== mySymbol) return ack && ack({ ok: false, error: 'not_your_turn' });
      if (
        typeof row !== 'number' || typeof col !== 'number' ||
        row < 0 || row >= GRID_SIZE || col < 0 || col >= GRID_SIZE
      ) {
        return ack && ack({ ok: false, error: 'invalid_cell' });
      }
      const key = `${row}_${col}`;
      if (room.board.has(key)) return ack && ack({ ok: false, error: 'cell_taken' });

      room.board.set(key, mySymbol);
      room.movesCount++;
      room.lastActivity = Date.now();
      room.lastMove = { row, col };

      const win = computeWin(room.board, row, col, mySymbol);
      if (win) {
        room.gameActive = false;
        room.winnerCells = win;
        room.score[mySymbol] = (room.score[mySymbol] || 0) + 1;
      } else if (room.movesCount >= GRID_SIZE * GRID_SIZE) {
        room.gameActive = false;
        room.winnerCells = null;
      } else {
        room.currentPlayer = mySymbol === 'X' ? 'O' : 'X';
        room.turnStartedAt = Date.now();
      }

      ack && ack({ ok: true });
      broadcastRoom(room);
    } catch (err) {
      console.error('move:make error', err);
      ack && ack({ ok: false, error: 'server_error' });
    }
  });

  socket.on('move:skip', (_payload, ack) => {
    try {
      if (!joinedRoomId || !mySymbol) return ack && ack({ ok: false, error: 'not_in_room' });
      const room = rooms.get(joinedRoomId);
      if (!room) return ack && ack({ ok: false, error: 'room_gone' });
      if (!room.players.X || !room.players.O) {
        return ack && ack({ ok: false, error: 'waiting_for_opponent' });
      }
      if (!room.gameActive) return ack && ack({ ok: false, error: 'game_over' });
      if (room.currentPlayer !== mySymbol) return ack && ack({ ok: false, error: 'not_your_turn' });

      // ខកខានវេន (អស់ពេល) - ប្តូរទៅភាគីម្ខាងទៀតដោយមិនដាក់សញ្ញា
      room.currentPlayer = mySymbol === 'X' ? 'O' : 'X';
      room.turnStartedAt = Date.now();
      room.lastActivity = Date.now();

      ack && ack({ ok: true });
      broadcastRoom(room);
    } catch (err) {
      console.error('move:skip error', err);
      ack && ack({ ok: false, error: 'server_error' });
    }
  });

  socket.on('room:rematch', (_payload, ack) => {
    try {
      if (!joinedRoomId) return ack && ack({ ok: false, error: 'not_in_room' });
      const room = rooms.get(joinedRoomId);
      if (!room) return ack && ack({ ok: false, error: 'room_gone' });
      resetBoard(room);
      room.lastActivity = Date.now();
      ack && ack({ ok: true });
      broadcastRoom(room);
    } catch (err) {
      console.error('room:rematch error', err);
      ack && ack({ ok: false, error: 'server_error' });
    }
  });

  socket.on('room:leave', () => {
    handleLeave();
  });

  socket.on('disconnect', () => {
    handleLeave(true);
  });

  function handleLeave(isDisconnect = false) {
    if (!joinedRoomId || !mySymbol) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;

    const slot = room.players[mySymbol];
    if (slot && slot.socketId === socket.id) {
      slot.connected = false;
      broadcastRoom(room);

      // Give the player a grace window to reconnect before freeing their seat.
      room.disconnectTimers[mySymbol] = setTimeout(() => {
        const current = rooms.get(joinedRoomId);
        if (!current) return;
        const s = current.players[mySymbol];
        if (s && !s.connected) {
          current.players[mySymbol] = null;
          broadcastRoom(current);
        }
      }, RECONNECT_GRACE_MS);
    }

    socket.leave(joinedRoomId);
    joinedRoomId = null;
    mySymbol = null;
  }
});

server.listen(PORT, () => {
  console.log(`Khmer XO Gomoku server running on port ${PORT}`);
});