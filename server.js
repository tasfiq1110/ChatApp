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

const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => { fetch(RENDER_URL).catch(() => {}); }, 14 * 60 * 1000);
}

const waitingQueue = [];
const activePairs = new Map();
const userNames = new Map();
const userCountries = new Map();
const chatMessages = new Map();
const userRooms = new Map();
const userWarnings = new Map();

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

app.get('/api/country', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '').replace('::ffff:','');
    const response = await fetch(`http://ip-api.com/json/${ip}?fields=country,countryCode`, { signal: AbortSignal.timeout(3000) });
    const data = await response.json();
    if (data.countryCode) {
      const flag = data.countryCode.toUpperCase().split('').map(c => String.fromCodePoint(0x1F1E6 - 65 + c.charCodeAt(0))).join('');
      res.json({ country: data.country, code: data.countryCode, flag });
    } else {
      res.json({ country: 'Unknown', code: 'XX', flag: '🌍' });
    }
  } catch (e) {
    res.json({ country: 'Unknown', code: 'XX', flag: '🌍' });
  }
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.filename, mimetype: req.file.mimetype });
});

const adj = ['Swift','Cosmic','Neon','Silent','Wild','Vivid','Lunar','Mystic','Pixel','Frosted','Electric','Amber','Crystal','Shadow','Velvet'];
const nouns = ['Fox','Panda','Wolf','Eagle','Comet','Nova','Drift','Spark','Blaze','Storm','Raven','Tiger','Lynx','Hawk','Orca'];
function randomName() {
  return adj[Math.floor(Math.random()*adj.length)] + nouns[Math.floor(Math.random()*nouns.length)] + Math.floor(Math.random()*99+1);
}

function getRoomId(a, b) { return [a, b].sort().join('::'); }

function cleanupRoom(roomId) {
  const msgs = chatMessages.get(roomId) || [];
  msgs.forEach(m => { if (m.filename) { const fp = path.join(UPLOAD_DIR, m.filename); if (fs.existsSync(fp)) fs.unlink(fp, () => {}); } });
  chatMessages.delete(roomId);
}

function disconnectPair(socketId) {
  const partnerId = activePairs.get(socketId);
  if (partnerId) {
    const roomId = userRooms.get(socketId);
    cleanupRoom(roomId);
    activePairs.delete(socketId); activePairs.delete(partnerId);
    userRooms.delete(socketId); userRooms.delete(partnerId);
    return partnerId;
  }
  return null;
}

const BAD_WORDS = [
  'fuck','shit','bitch','dick','pussy','cock','cunt','nigger','nigga','whore','slut','bastard',
  'motherfucker','asshole','faggot','retard','rape','porn','nude','naked','fck','fuk','sh1t',
  'magi','chudi','choda','baler','madarchod','bokachoda','khanki','harami','hijra','shala','sala',
  'kutir','kutti','gandu','randi','lavda','lauda','bhosdi','choot',
  'kuss','sharmouta','ahba','zebi',
  'puta','pendejo','cabron','maricon','verga','culo','joder','mierda',
  'chutiya','gaandu','bhadwa','haramzada','behenchod',
  'putain','merde','salope','connard','batard',
  'porra','caralho','buceta','viado',
  'blyad','pizda','khuy','mudak','suka',
  'ficken','hurensohn','wichser',
  'anjing','bangsat','kontol','memek','bajingan','goblok',
  'orospu','siktir','pezevenk',
  'putangina','gago','tangina','leche'
];

function checkBadWords(text) {
  const norm = text.toLowerCase().replace(/[@4][s$5]/g,'as').replace(/[1!|]/g,'i').replace(/0/g,'o').replace(/3/g,'e');
  return BAD_WORDS.some(w => norm.includes(w));
}

function censorText(text) {
  let r = text;
  BAD_WORDS.forEach(w => {
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi');
    r = r.replace(re, m => m[0] + '*'.repeat(Math.max(m.length-2,1)) + (m.length>1 ? m[m.length-1] : ''));
  });
  return r;
}

io.on('connection', (socket) => {
  const name = randomName();
  userNames.set(socket.id, name);
  userWarnings.set(socket.id, 0);
  socket.emit('assigned_name', name);

  socket.on('set_country', (data) => { userCountries.set(socket.id, data); });

  socket.on('find_partner', () => {
    const wi = waitingQueue.indexOf(socket.id);
    if (wi > -1) waitingQueue.splice(wi, 1);
    const oldPartner = disconnectPair(socket.id);
    if (oldPartner) io.to(oldPartner).emit('partner_left');

    if (waitingQueue.length > 0) {
      const partnerId = waitingQueue.shift();
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (!partnerSocket) { waitingQueue.push(socket.id); socket.emit('searching'); return; }

      const roomId = getRoomId(socket.id, partnerId);
      activePairs.set(socket.id, partnerId); activePairs.set(partnerId, socket.id);
      userRooms.set(socket.id, roomId); userRooms.set(partnerId, roomId);
      chatMessages.set(roomId, []);
      socket.join(roomId); partnerSocket.join(roomId);

      const myName = userNames.get(socket.id);
      const partnerName = userNames.get(partnerId);
      const myCountry = userCountries.get(socket.id) || { flag:'🌍', country:'Unknown', code:'XX' };
      const partnerCountry = userCountries.get(partnerId) || { flag:'🌍', country:'Unknown', code:'XX' };

      socket.emit('connected', { partnerName, myName, partnerCountry, myCountry });
      partnerSocket.emit('connected', { partnerName: myName, myName: partnerName, partnerCountry: myCountry, myCountry: partnerCountry });
    } else {
      waitingQueue.push(socket.id);
      socket.emit('searching');
    }
  });

  socket.on('send_message', (data) => {
    const partnerId = activePairs.get(socket.id);
    if (!partnerId) return;
    const roomId = userRooms.get(socket.id);

    if (data.type === 'text' && data.text) {
      if (checkBadWords(data.text)) {
        const warns = (userWarnings.get(socket.id) || 0) + 1;
        userWarnings.set(socket.id, warns);
        socket.emit('content_warning', { warns, max: 3 });
        if (warns >= 3) { socket.emit('banned'); setTimeout(() => socket.disconnect(), 1000); return; }
        data.text = censorText(data.text);
      }
    }

    const msg = {
      id: uuidv4(), from: socket.id, name: userNames.get(socket.id),
      type: data.type || 'text', text: data.text || '',
      url: data.url || null, filename: data.filename || null, mimetype: data.mimetype || null,
      gif: data.gif || null, timestamp: Date.now()
    };
    const msgs = chatMessages.get(roomId) || [];
    msgs.push(msg);
    chatMessages.set(roomId, msgs);
    io.to(roomId).emit('new_message', msg);
  });

  socket.on('typing', (isTyping) => { const p = activePairs.get(socket.id); if (p) io.to(p).emit('partner_typing', isTyping); });

  socket.on('unsend_message', ({ msgId }) => {
    const roomId = userRooms.get(socket.id);
    if (!roomId) return;
    const msgs = chatMessages.get(roomId) || [];
    const msg = msgs.find(m => m.id === msgId && m.from === socket.id);
    if (!msg) return;
    // Delete uploaded file if any
    if (msg.filename) {
      const fp = path.join(UPLOAD_DIR, msg.filename);
      if (fs.existsSync(fp)) fs.unlink(fp, () => {});
    }
    msg.unsent = true; msg.text = ''; msg.url = null; msg.gif = null;
    io.to(roomId).emit('message_unsent', { msgId });
  });

  socket.on('edit_message', ({ msgId, newText }) => {
    const roomId = userRooms.get(socket.id);
    if (!roomId || !newText?.trim()) return;
    const msgs = chatMessages.get(roomId) || [];
    const msg = msgs.find(m => m.id === msgId && m.from === socket.id && m.type === 'text' && !m.unsent);
    if (!msg) return;
    if (checkBadWords(newText)) { socket.emit('content_warning', { warns: (userWarnings.get(socket.id)||0)+1, max:3 }); return; }
    msg.text = newText; msg.edited = true;
    io.to(roomId).emit('message_edited', { msgId, newText, edited: true });
  });

  socket.on('add_reaction', ({ msgId, emoji }) => {
    const roomId = userRooms.get(socket.id);
    if (!roomId) return;
    const msgs = chatMessages.get(roomId) || [];
    const msg = msgs.find(m => m.id === msgId);
    if (!msg) return;
    if (!msg.reactions) msg.reactions = {};
    // Toggle: if same user reacted with same emoji, remove it
    const key = emoji;
    if (!msg.reactions[key]) msg.reactions[key] = [];
    const idx = msg.reactions[key].indexOf(socket.id);
    if (idx > -1) msg.reactions[key].splice(idx, 1);
    else msg.reactions[key].push(socket.id);
    if (msg.reactions[key].length === 0) delete msg.reactions[key];
    io.to(roomId).emit('reaction_updated', { msgId, reactions: msg.reactions });
  });

  socket.on('skip', () => {
    const p = disconnectPair(socket.id); if (p) io.to(p).emit('partner_left');
    const wi = waitingQueue.indexOf(socket.id); if (wi > -1) waitingQueue.splice(wi, 1);
    waitingQueue.push(socket.id); socket.emit('searching');
  });
  socket.on('end_chat', () => { const p = disconnectPair(socket.id); if (p) io.to(p).emit('partner_left'); socket.emit('chat_ended'); });
  socket.on('disconnect', () => {
    const wi = waitingQueue.indexOf(socket.id); if (wi > -1) waitingQueue.splice(wi, 1);
    const p = disconnectPair(socket.id); if (p) io.to(p).emit('partner_left');
    userNames.delete(socket.id); userCountries.delete(socket.id); userWarnings.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
