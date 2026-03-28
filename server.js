const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path   = require('path');
const multer = require('multer');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  maxHttpBufferSize: 50 * 1024 * 1024,
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout:  90000,  // 90s — handles mobile network gaps
  pingInterval: 25000
});

// Keep Render alive
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) setInterval(() => fetch(RENDER_URL).catch(() => {}), 14 * 60 * 1000);

// ─── Config ────────────────────────────────────────────
const GRACE_MS = 40000; // how long we keep session alive after disconnect
const RATE_MAX = 5;     // messages per window
const RATE_WIN = 2000;  // window ms

// ─── State ─────────────────────────────────────────────
// Everything keyed by stable sessionId — survives reconnects
const sessions    = new Map(); // sessionId → sess object
const sockToSess  = new Map(); // socketId  → sessionId (updated on reconnect)

// Queues store sessionIds (stable)
const globalQ    = [];
const interestQs = new Map(); // interest → sessionId[]

// Timers
const graceTmrs  = new Map(); // sessionId → timeout (grace period)
const fallTmrs   = new Map(); // sessionId → timeout (interest→global fallback)
const rateLimits = new Map(); // sessionId → {count, resetAt}

// ─── Uploads ───────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/country', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '').replace('::ffff:', '');
    const r  = await fetch(`http://ip-api.com/json/${ip}?fields=country,countryCode`, { signal: AbortSignal.timeout(3000) });
    const d  = await r.json();
    if (d.countryCode) {
      const flag = d.countryCode.toUpperCase().split('').map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('');
      return res.json({ country: d.country, code: d.countryCode, flag });
    }
  } catch {}
  res.json({ country: '', code: '', flag: '' });
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.filename, mimetype: req.file.mimetype });
});

// ─── Helpers ───────────────────────────────────────────
const ADJ   = ['Swift','Cosmic','Neon','Silent','Wild','Vivid','Lunar','Mystic','Pixel','Frosted','Electric','Amber','Crystal','Shadow','Velvet'];
const NOUNS = ['Fox','Panda','Wolf','Eagle','Comet','Nova','Drift','Spark','Blaze','Storm','Raven','Tiger','Lynx','Hawk','Orca'];
const randName = () => ADJ[Math.floor(Math.random()*ADJ.length)] + NOUNS[Math.floor(Math.random()*NOUNS.length)] + (Math.floor(Math.random()*99)+1);

// Get live socket object for a session
function getSock(sessId) {
  const s = sessions.get(sessId);
  if (!s || !s.sockId) return null;
  return io.sockets.sockets.get(s.sockId) || null;
}

// Emit to a session (by sessionId)
function emitTo(sessId, event, data) {
  const sock = getSock(sessId);
  if (sock) sock.emit(event, data);
}

// Remove sessionId from all queues and cancel fallback timer
function dequeue(sessId) {
  for (let i = globalQ.length - 1; i >= 0; i--)
    if (globalQ[i] === sessId) globalQ.splice(i, 1);
  for (const q of interestQs.values())
    for (let i = q.length - 1; i >= 0; i--)
      if (q[i] === sessId) q.splice(i, 1);
  const t = fallTmrs.get(sessId);
  if (t) { clearTimeout(t); fallTmrs.delete(sessId); }
}

// Remove dead sessions from a queue array
function pruneQ(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    const alive = sessions.has(arr[i]) && getSock(arr[i]);
    if (!alive) arr.splice(i, 1);
  }
}

// Cleanly break a pair
function breakPair(sessId) {
  const s = sessions.get(sessId);
  if (!s || !s.partnerId) return;
  const p = sessions.get(s.partnerId);
  // Delete uploaded files
  for (const m of (s.messages || []))
    if (m.filename) { try { fs.unlinkSync(path.join(UPLOAD_DIR, m.filename)); } catch {} }
  if (p) { p.partnerId = null; p.roomId = null; p.messages = []; }
  s.partnerId = null; s.roomId = null; s.messages = [];
}

// Connect two sessions
function joinPair(sA, sB) {
  const roomId = [sA.sessId, sB.sessId].sort().join('::');
  const msgs   = [];
  sA.partnerId = sB.sessId; sB.partnerId = sA.sessId;
  sA.roomId    = roomId;    sB.roomId    = roomId;
  sA.messages  = msgs;      sB.messages  = msgs;
  const sockA = getSock(sA.sessId), sockB = getSock(sB.sessId);
  if (sockA) sockA.join(roomId);
  if (sockB) sockB.join(roomId);
  const shared = (sA.interests || []).filter(t => (sB.interests || []).includes(t));
  if (sockA) sockA.emit('connected', { partnerName: sB.name, myName: sA.name, partnerCountry: sB.country || {}, sharedInterests: shared });
  if (sockB) sockB.emit('connected', { partnerName: sA.name, myName: sB.name, partnerCountry: sA.country || {}, sharedInterests: shared });
}

// ─── Matchmaking ────────────────────────────────────────
function findMatch(sessId) {
  dequeue(sessId);
  const s = sessions.get(sessId);
  if (!s || !getSock(sessId)) return; // not connected, abort

  const interests = s.interests || [];

  if (interests.length > 0) {
    // Scan interest queues for a compatible match
    for (const interest of interests) {
      const q = interestQs.get(interest) || [];
      pruneQ(q);
      for (let i = 0; i < q.length; i++) {
        const cid = q[i];
        if (cid === sessId) continue;
        if (!sessions.has(cid) || !getSock(cid)) continue;
        // Match found — remove from queues and connect
        q.splice(i, 1);
        dequeue(cid);
        joinPair(s, sessions.get(cid));
        return;
      }
    }
    // No match yet — add to interest queues and wait up to 5s then go global
    for (const interest of interests) {
      if (!interestQs.has(interest)) interestQs.set(interest, []);
      const q = interestQs.get(interest);
      if (!q.includes(sessId)) q.push(sessId);
    }
    emitTo(sessId, 'searching', { mode: 'interest', timeout: 5 });
    fallTmrs.set(sessId, setTimeout(() => {
      fallTmrs.delete(sessId);
      findMatchGlobal(sessId);
    }, 5000));
    return;
  }

  findMatchGlobal(sessId);
}

function findMatchGlobal(sessId) {
  dequeue(sessId);
  const s = sessions.get(sessId);
  if (!s || !getSock(sessId)) return;
  pruneQ(globalQ);
  for (let i = 0; i < globalQ.length; i++) {
    const cid = globalQ[i];
    if (cid === sessId) continue;
    if (!sessions.has(cid) || !getSock(cid)) continue;
    globalQ.splice(i, 1);
    dequeue(cid);
    joinPair(s, sessions.get(cid));
    return;
  }
  globalQ.push(sessId);
  emitTo(sessId, 'searching', { mode: 'global' });
}

// ─── Rate limit ─────────────────────────────────────────
function rateOk(sessId) {
  const now = Date.now();
  const r   = rateLimits.get(sessId) || { count: 0, resetAt: now + RATE_WIN };
  if (now > r.resetAt) { r.count = 0; r.resetAt = now + RATE_WIN; }
  r.count++;
  rateLimits.set(sessId, r);
  return r.count <= RATE_MAX;
}

// ─── Profanity ──────────────────────────────────────────
const BAD = ['fuck','shit','bitch','dick','pussy','cock','cunt','nigger','nigga','whore','slut','bastard','motherfucker','asshole','faggot','rape','porn','nude','naked','fck','fuk','magi','chudi','choda','madarchod','bokachoda','khanki','harami','shala','sala','gandu','randi','lavda','lauda','bhosdi','choot','bhenchod','chutiya','bhadwa','haramzada','behenchod','kuss','sharmouta','puta','pendejo','cabron','maricon','verga','joder','mierda','putain','merde','salope','connard','blyad','pizda','khuy','mudak','hurensohn','wichser','anjing','bangsat','kontol','memek','bajingan','orospu','siktir','putangina','gago','tangina'];
const hasBad = t => { const n=t.toLowerCase().replace(/[@4]/g,'a').replace(/[1!|]/g,'i').replace(/0/g,'o').replace(/3/g,'e').replace(/\$/g,'s'); return BAD.some(w=>n.includes(w)); };
const censor  = t => { let r=t; BAD.forEach(w=>{const re=new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi');r=r.replace(re,m=>m[0]+'*'.repeat(Math.max(m.length-2,1))+(m.length>1?m[m.length-1]:''));}); return r; };

// ─── Socket.IO ──────────────────────────────────────────
io.on('connection', socket => {

  // ── INIT ──────────────────────────────────────────────
  // Client sends this immediately on every connect/reconnect.
  // Contains sessionId (null if new), plus current country+interests.
  // Handling everything in ONE event eliminates all ordering race conditions.
  socket.on('init', ({ sessId: clientSessId, country, interests }) => {
    let s;

    if (clientSessId && sessions.has(clientSessId)) {
      // ── RECONNECT ──────────────────────────────────────
      s = sessions.get(clientSessId);

      // Cancel grace timer — they're back
      const gt = graceTmrs.get(clientSessId);
      if (gt) { clearTimeout(gt); graceTmrs.delete(clientSessId); }

      // Update socket mapping
      if (s.sockId && s.sockId !== socket.id) sockToSess.delete(s.sockId);
      s.sockId = socket.id;
      sockToSess.set(socket.id, clientSessId);

      // Update profile
      if (country && (country.code || country.flag)) s.country = country;
      if (Array.isArray(interests) && interests.length) s.interests = interests.slice(0, 5);

      // Rejoin room
      if (s.roomId) socket.join(s.roomId);

      // Confirm session restored
      socket.emit('init_ok', { sessId: clientSessId, name: s.name });

      // Handle partner state
      if (s.partnerId && sessions.has(s.partnerId)) {
        const p     = sessions.get(s.partnerId);
        const pSock = getSock(s.partnerId);

        if (pSock) {
          // Partner online — restore immediately
          socket.emit('chat_restored', {
            partnerName: p.name, myName: s.name,
            partnerCountry: p.country || {},
            messages: (s.messages || []).map(m => ({ ...m, isMe: m.sessId === clientSessId }))
          });
          pSock.emit('partner_reconnected', { partnerName: s.name });
        } else if (graceTmrs.has(s.partnerId)) {
          // Partner also dropped, still in grace — show their messages, wait
          socket.emit('chat_restored', {
            partnerName: p.name, myName: s.name,
            partnerCountry: p.country || {},
            messages: (s.messages || []).map(m => ({ ...m, isMe: m.sessId === clientSessId }))
          });
          socket.emit('partner_reconnecting');
        } else {
          // Partner's grace expired — they're gone
          s.partnerId = null; s.roomId = null; s.messages = [];
          socket.emit('partner_gave_up');
        }
      }
      // else: not in a chat, just init_ok is fine

    } else {
      // ── NEW SESSION ────────────────────────────────────
      const newId = uuidv4();
      s = {
        sessId: newId, name: randName(),
        country:   (country && (country.code || country.flag)) ? country : null,
        interests: Array.isArray(interests) ? interests.slice(0, 5) : [],
        warnings: 0, partnerId: null, roomId: null, messages: [], sockId: socket.id
      };
      sessions.set(newId, s);
      sockToSess.set(socket.id, newId);
      socket.emit('init_ok', { sessId: newId, name: s.name });
    }
  });

  // ── PROFILE UPDATES ───────────────────────────────────
  socket.on('set_country', d => {
    const s = sessions.get(sockToSess.get(socket.id));
    if (s && d) s.country = d;
  });
  socket.on('set_interests', arr => {
    const s = sessions.get(sockToSess.get(socket.id));
    if (s) s.interests = Array.isArray(arr) ? arr.slice(0, 5) : [];
  });

  // ── FIND PARTNER ──────────────────────────────────────
  socket.on('find_partner', () => {
    const s = sessions.get(sockToSess.get(socket.id));
    if (!s) return;
    if (s.partnerId) { emitTo(s.partnerId, 'partner_left'); breakPair(s.sessId); }
    dequeue(s.sessId);
    if (s.roomId) { socket.leave(s.roomId); s.roomId = null; }
    findMatch(s.sessId);
  });

  socket.on('skip', () => {
    const s = sessions.get(sockToSess.get(socket.id));
    if (!s) return;
    if (s.partnerId) { emitTo(s.partnerId, 'partner_left'); breakPair(s.sessId); }
    dequeue(s.sessId);
    if (s.roomId) { socket.leave(s.roomId); s.roomId = null; }
    findMatch(s.sessId);
  });

  socket.on('end_chat', () => {
    const s = sessions.get(sockToSess.get(socket.id));
    if (!s) return;
    if (s.partnerId) { emitTo(s.partnerId, 'partner_left'); breakPair(s.sessId); }
    dequeue(s.sessId);
    if (s.roomId) { socket.leave(s.roomId); s.roomId = null; }
    socket.emit('chat_ended');
  });

  // ── MESSAGES ──────────────────────────────────────────
  socket.on('send_message', data => {
    const s = sessions.get(sockToSess.get(socket.id));
    if (!s || !s.partnerId || !s.roomId) return;
    if (!rateOk(s.sessId)) { socket.emit('rate_limited'); return; }
    if (data.type === 'text' && data.text) {
      if (hasBad(data.text)) {
        s.warnings++;
        socket.emit('content_warning', { warns: s.warnings, max: 3 });
        if (s.warnings >= 3) { socket.emit('banned'); setTimeout(() => socket.disconnect(), 500); return; }
        data.text = censor(data.text);
      }
    }
    const msg = {
      id: uuidv4(),
      sessId: s.sessId, // used by client for isMe detection
      type: data.type || 'text', text: data.text || '',
      url: data.url || null, filename: data.filename || null,
      mimetype: data.mimetype || null, gif: data.gif || null,
      reactions: {}, replyTo: data.replyTo || null,
      timestamp: Date.now()
    };
    s.messages.push(msg);
    io.to(s.roomId).emit('new_message', msg);
  });

  socket.on('typing', v => {
    const s = sessions.get(sockToSess.get(socket.id));
    if (s?.partnerId) emitTo(s.partnerId, 'partner_typing', v);
  });

  socket.on('messages_read', () => {
    const s = sessions.get(sockToSess.get(socket.id));
    if (!s?.messages) return;
    s.messages.forEach(m => { if (m.sessId !== s.sessId) m.read = true; });
    emitTo(s.partnerId, 'partner_read');
  });

  socket.on('unsend_message', ({ msgId }) => {
    const s = sessions.get(sockToSess.get(socket.id));
    if (!s?.messages || !s.roomId) return;
    const m = s.messages.find(m => m.id === msgId && m.sessId === s.sessId);
    if (!m) return;
    if (m.filename) try { fs.unlinkSync(path.join(UPLOAD_DIR, m.filename)); } catch {}
    m.unsent = true; m.text = ''; m.url = null; m.gif = null;
    io.to(s.roomId).emit('message_unsent', { msgId });
  });

  socket.on('edit_message', ({ msgId, newText }) => {
    const s = sessions.get(sockToSess.get(socket.id));
    if (!s?.messages || !newText?.trim() || !s.roomId) return;
    const m = s.messages.find(m => m.id === msgId && m.sessId === s.sessId && m.type === 'text' && !m.unsent);
    if (!m) return;
    if (hasBad(newText)) { s.warnings++; socket.emit('content_warning', { warns: s.warnings, max: 3 }); return; }
    m.text = newText; m.edited = true;
    io.to(s.roomId).emit('message_edited', { msgId, newText });
  });

  socket.on('add_reaction', ({ msgId, emoji }) => {
    const s = sessions.get(sockToSess.get(socket.id));
    if (!s?.messages || !s.roomId) return;
    const m = s.messages.find(m => m.id === msgId);
    if (!m) return;
    if (!m.reactions[emoji]) m.reactions[emoji] = [];
    const idx = m.reactions[emoji].indexOf(s.sessId);
    if (idx > -1) m.reactions[emoji].splice(idx, 1);
    else m.reactions[emoji].push(s.sessId);
    if (!m.reactions[emoji].length) delete m.reactions[emoji];
    io.to(s.roomId).emit('reaction_updated', { msgId, reactions: m.reactions });
  });

  // ── DISCONNECT ────────────────────────────────────────
  socket.on('disconnect', () => {
    const sessId = sockToSess.get(socket.id);
    sockToSess.delete(socket.id);
    dequeue(sessId);
    rateLimits.delete(sessId);
    if (!sessId) return;
    const s = sessions.get(sessId);
    if (!s) return;
    s.sockId = null;

    if (s.partnerId) {
      // Tell partner, show countdown
      emitTo(s.partnerId, 'partner_disconnected', { graceSeconds: Math.floor(GRACE_MS / 1000) });
      // Keep session alive for grace period
      graceTmrs.set(sessId, setTimeout(() => {
        graceTmrs.delete(sessId);
        const sv = sessions.get(sessId);
        if (!sv) return;
        emitTo(sv.partnerId, 'partner_left');
        breakPair(sessId);
        sessions.delete(sessId);
      }, GRACE_MS));
    } else {
      sessions.delete(sessId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Zapp running on ${PORT}`));
