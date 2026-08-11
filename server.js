const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '/')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ត្រូវបន្ថែម logic សម្រាប់ room-based multiplayer (join room, ផ្ញើ moves, ។ល។)
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });

  // TODO: បន្ថែម event handlers សម្រាប់ create/join room, moves, rematch ជាដើម
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {  // ត្រូវប្រើ server.listen មិនមែន app.listen ទេ
  console.log(`Server running on port ${PORT}`);
});
