const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const GRID_SIZE = 20;
const CELLS_TO_WIN = 5;
const TOTAL_CELLS = GRID_SIZE * GRID_SIZE;

app.use(express.static(path.join(__dirname, '/')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ===== Room storage (in-memory) =====
// rooms[roomId] = {
//   board: { "r_c": "X" | "O" },
//   currentPlayer: "X" | "O",
//   gameActive: bool,
//   movesCount: number,
//   score: { X: number, O: number },
//   winnerCells: [[r,c], ...] | null,
//   lastMove: { row, col } | null,
//   players: {
//     X: { socketId, userId, name, photo, connected },
//     O: { socketId, userId, name, photo, connected }
//   },
//   disconnectTimers: { X: timeout|null, O: timeout|null }
// }
const rooms = {};
const GRACE_PERIOD_MS = 30000; // ពេលវេលារង់ចាំសម្រាប់ភ្ជាប់ត្រឡប់វិញ មុននឹងលុប room

function createRoom() {
  return {
    board: {},
    currentPlayer: 'X',
    gameActive: true,
    movesCount: 0,
    score: { X: 0, O: 0 },
    winnerCells: null,
    lastMove: null,
    players: { X: null, O: null },
    disconnectTimers: { X: null, O: null }
  };
}

function publicState(room) {
  return {
    board: room.board,
    currentPlayer: room.currentPlayer,
    gameActive: room.gameActive,
    movesCount: room.movesCount,
    score: room.score,
    winnerCells: room.winnerCells,
    lastMove: room.lastMove,
    bothJoined: !!(room.players.X && room.players.O),
    players: {
      X: room.players.X ? { name: room.players.X.name, photo: room.players.X.photo, connected: room.players.X.connected } : null,
      O: room.players.O ? { name: room.players.O.name, photo: room.players.O.photo, connected: room.players.O.connected } : null
    }
  };
}

function broadcastState(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('room:state', publicState(room));
}

function checkWin(room, row, col) {
  const player = room.board[`${row}_${col}`];
  const directions = [[[0, 1], [0, -1]], [[1, 0], [-1, 0]], [[1, 1], [-1, -1]], [[1, -1], [-1, 1]]];

  for (const dirPair of directions) {
    let count = 1;
    let cells = [[row, col]];
    for (const [dr, dc] of dirPair) {
      let r = row + dr, c = col + dc;
      while (r >= 0 && r < GRID_SIZE && c >= 0 && c < GRID_SIZE && room.board[`${r}_${c}`] === player) {
        count++;
        cells.push([r, c]);
        if (count >= CELLS_TO_WIN) return cells;
        r += dr; c += dc;
      }
    }
  }
  return null;
}

function findSymbolBySocket(room, socketId) {
  if (room.players.X && room.players.X.socketId === socketId) return 'X';
  if (room.players.O && room.players.O.socketId === socketId) return 'O';
  return null;
}

function clearDisconnectTimer(room, symbol) {
  if (room.disconnectTimers[symbol]) {
    clearTimeout(room.disconnectTimers[symbol]);
    room.disconnectTimers[symbol] = null;
  }
}

io.on('connection', (socket) => {
  socket.on('room:join', ({ roomId, userId, name, photo }, callback) => {
    if (!roomId || typeof roomId !== 'string') {
      return callback && callback({ ok: false, error: 'invalid_room' });
    }

    if (!rooms[roomId]) rooms[roomId] = createRoom();
    const room = rooms[roomId];

    // ភ្ជាប់ត្រឡប់វិញ - តើ userId នេះធ្លាប់ជាអ្នកលេងក្នុង room នេះរួចទេ?
    let mySymbol = null;
    if (room.players.X && room.players.X.userId === userId) mySymbol = 'X';
    else if (room.players.O && room.players.O.userId === userId) mySymbol = 'O';

    if (!mySymbol) {
      // អ្នកលេងថ្មី - ចាត់ចូល slot ទំនេរ
      if (!room.players.X) mySymbol = 'X';
      else if (!room.players.O) mySymbol = 'O';
      else {
        return callback && callback({ ok: false, error: 'room_full' });
      }
    }

    clearDisconnectTimer(room, mySymbol);
    room.players[mySymbol] = {
      socketId: socket.id,
      userId: userId || socket.id,
      name: name || (mySymbol === 'X' ? 'អ្នកលេង X' : 'អ្នកលេង O'),
      photo: photo || null,
      connected: true
    };

    socket.data.roomId = roomId;
    socket.data.symbol = mySymbol;
    socket.join(roomId);

    callback && callback({ ok: true, symbol: mySymbol, state: publicState(room) });

    // ប្រាប់អ្នកលេងផ្សេងទៀតក្នុង room ថាមានការផ្លាស់ប្តូរ (join/ភ្ជាប់ត្រឡប់)
    socket.to(roomId).emit('room:state', publicState(room));
  });

  socket.on('move:make', ({ row, col }, callback) => {
    const roomId = socket.data.roomId;
    const symbol = socket.data.symbol;
    const room = roomId && rooms[roomId];
    if (!room) return callback && callback({ ok: false, error: 'no_room' });
    if (!room.players.X || !room.players.O) return callback && callback({ ok: false, error: 'not_both_joined' });
    if (!room.gameActive) return callback && callback({ ok: false, error: 'game_over' });
    if (room.currentPlayer !== symbol) return callback && callback({ ok: false, error: 'not_your_turn' });
    if (row < 0 || row >= GRID_SIZE || col < 0 || col >= GRID_SIZE) {
      return callback && callback({ ok: false, error: 'out_of_bounds' });
    }
    const key = `${row}_${col}`;
    if (room.board[key]) return callback && callback({ ok: false, error: 'cell_taken' });

    room.board[key] = symbol;
    room.movesCount++;
    room.lastMove = { row, col };

    const winCells = checkWin(room, row, col);
    if (winCells) {
      room.gameActive = false;
      room.winnerCells = winCells;
      room.score[symbol] = (room.score[symbol] || 0) + 1;
    } else if (room.movesCount >= TOTAL_CELLS) {
      room.gameActive = false;
      room.winnerCells = null;
    } else {
      room.currentPlayer = symbol === 'X' ? 'O' : 'X';
    }

    callback && callback({ ok: true });
    broadcastState(roomId);
  });

  socket.on('move:skip', (_data, callback) => {
    const roomId = socket.data.roomId;
    const symbol = socket.data.symbol;
    const room = roomId && rooms[roomId];
    if (!room) return callback && callback({ ok: false, error: 'no_room' });
    if (!room.gameActive) return callback && callback({ ok: false, error: 'game_over' });
    if (room.currentPlayer !== symbol) return callback && callback({ ok: false, error: 'not_your_turn' });

    room.currentPlayer = symbol === 'X' ? 'O' : 'X';
    callback && callback({ ok: true });
    broadcastState(roomId);
  });

  socket.on('room:rematch', () => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms[roomId];
    if (!room) return;

    room.board = {};
    room.currentPlayer = 'X';
    room.gameActive = true;
    room.movesCount = 0;
    room.winnerCells = null;
    room.lastMove = null;
    // score និង players (ព័ត៌មាន join) ត្រូវរក្សាទុកដដែល
    broadcastState(roomId);
  });

  socket.on('room:leave', () => {
    handleLeave(socket);
  });

  socket.on('disconnect', () => {
    handleLeave(socket, true);
  });

  function handleLeave(socket, isDisconnect = false) {
    const roomId = socket.data.roomId;
    const symbol = socket.data.symbol;
    const room = roomId && rooms[roomId];
    if (!room || !symbol) return;

    if (room.players[symbol] && room.players[symbol].socketId === socket.id) {
      room.players[symbol].connected = false;
    }
    socket.leave(roomId);

    if (isDisconnect) {
      // ផ្តល់ grace period ដើម្បីភ្ជាប់ត្រឡប់វិញ មុននឹងលុប player ចេញ room ជាស្ថាពរ
      clearDisconnectTimer(room, symbol);
      room.disconnectTimers[symbol] = setTimeout(() => {
        if (room.players[symbol] && !room.players[symbol].connected) {
          room.players[symbol] = null;
        }
        if (!room.players.X && !room.players.O) {
          delete rooms[roomId];
        } else {
          broadcastState(roomId);
        }
      }, GRACE_PERIOD_MS);
      broadcastState(roomId);
    } else {
      // ចាកចេញដោយចេតនា - លុបចេញភ្លាមៗ
      room.players[symbol] = null;
      socket.data.roomId = null;
      socket.data.symbol = null;
      if (!room.players.X && !room.players.O) {
        delete rooms[roomId];
      } else {
        broadcastState(roomId);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
