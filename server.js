const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 50 * 1024 * 1024,
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Keep-alive: prevent Render free tier from sleeping
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => {
    fetch(RENDER_URL).catch(() => {});
  }, 14 * 60 * 1000); // ping every 14 minutes
}

// In-memory stores (no persistent DB)
const waitingQueue = [];
const activePairs = new Map(); // socketId -> partnerId
const userNames = new Map(); // socketId -> name
const chatMessages = new Map(); // roomId -> [messages]
const userRooms = new Map(); // socketId -> roomId

// Temp upload dir - cleaned after chat ends
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.filename, mimetype: req.file.mimetype });
});

// Random name generator
const adj = ['Swift','Cosmic','Neon','Silent','Wild','Vivid','Lunar','Mystic','Pixel','Frosted','Electric','Amber','Crystal','Shadow','Velvet'];
const nouns = ['Fox','Panda','Wolf','Eagle','Comet','Nova','Drift','Spark','Blaze','Storm','Raven','Tiger','Lynx','Hawk','Orca'];
function randomName() {
  return adj[Math.floor(Math.random()*adj.length)] + nouns[Math.floor(Math.random()*nouns.length)] + Math.floor(Math.random()*99+1);
}

function getRoomId(a, b) {
  return [a, b].sort().join('::');
}

function cleanupRoom(roomId) {
  const msgs = chatMessages.get(roomId) || [];
  // Delete uploaded files
  msgs.forEach(m => {
    if (m.filename) {
      const fp = path.join(UPLOAD_DIR, m.filename);
      if (fs.existsSync(fp)) fs.unlink(fp, () => {});
    }
  });
  chatMessages.delete(roomId);
}

function disconnectPair(socketId) {
  const partnerId = activePairs.get(socketId);
  if (partnerId) {
    const roomId = userRooms.get(socketId);
    cleanupRoom(roomId);
    activePairs.delete(socketId);
    activePairs.delete(partnerId);
    userRooms.delete(socketId);
    userRooms.delete(partnerId);
    return partnerId;
  }
  return null;
}

io.on('connection', (socket) => {
  const name = randomName();
  userNames.set(socket.id, name);
  socket.emit('assigned_name', name);

  socket.on('find_partner', () => {
    // Remove from waiting if already there
    const wi = waitingQueue.indexOf(socket.id);
    if (wi > -1) waitingQueue.splice(wi, 1);

    // Disconnect existing pair
    const oldPartner = disconnectPair(socket.id);
    if (oldPartner) {
      io.to(oldPartner).emit('partner_left');
    }

    if (waitingQueue.length > 0) {
      const partnerId = waitingQueue.shift();
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (!partnerSocket) {
        // Partner disconnected, try again
        socket.emit('searching');
        waitingQueue.push(socket.id);
        return;
      }

      const roomId = getRoomId(socket.id, partnerId);
      activePairs.set(socket.id, partnerId);
      activePairs.set(partnerId, socket.id);
      userRooms.set(socket.id, roomId);
      userRooms.set(partnerId, roomId);
      chatMessages.set(roomId, []);

      socket.join(roomId);
      partnerSocket.join(roomId);

      const myName = userNames.get(socket.id);
      const partnerName = userNames.get(partnerId);

      socket.emit('connected', { partnerName, myName });
      partnerSocket.emit('connected', { partnerName: myName, myName: partnerName });
    } else {
      waitingQueue.push(socket.id);
      socket.emit('searching');
    }
  });

  socket.on('send_message', (data) => {
    const partnerId = activePairs.get(socket.id);
    if (!partnerId) return;
    const roomId = userRooms.get(socket.id);
    const msg = {
      id: uuidv4(),
      from: socket.id,
      name: userNames.get(socket.id),
      type: data.type || 'text',
      text: data.text || '',
      url: data.url || null,
      filename: data.filename || null,
      mimetype: data.mimetype || null,
      emoji: data.emoji || null,
      gif: data.gif || null,
      timestamp: Date.now()
    };
    const msgs = chatMessages.get(roomId) || [];
    msgs.push(msg);
    chatMessages.set(roomId, msgs);
    io.to(roomId).emit('new_message', msg);
  });

  socket.on('typing', (isTyping) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('partner_typing', isTyping);
  });

  socket.on('skip', () => {
    const partnerId = disconnectPair(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('partner_left');
    }
    // Re-search
    const wi = waitingQueue.indexOf(socket.id);
    if (wi > -1) waitingQueue.splice(wi, 1);
    waitingQueue.push(socket.id);
    socket.emit('searching');
  });

  socket.on('end_chat', () => {
    const partnerId = disconnectPair(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('partner_left');
    }
    socket.emit('chat_ended');
  });

  socket.on('disconnect', () => {
    const wi = waitingQueue.indexOf(socket.id);
    if (wi > -1) waitingQueue.splice(wi, 1);
    const partnerId = disconnectPair(socket.id);
    if (partnerId) {
      io.to(partnerId).emit('partner_left');
    }
    userNames.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
