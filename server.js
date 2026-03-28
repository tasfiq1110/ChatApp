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
if (RENDER_URL) setInterval(() => fetch(RENDER_URL).catch(() => {}), 14 * 60 * 1000);

// ── Constants ─────────────────────────────────────────
const GRACE_PERIOD   = 30000; // ms to wait for reconnect before ending the session
const MSG_LIMIT      = 5;
const MSG_WINDOW     = 2000;

// ── State ─────────────────────────────────────────────
const interestQueues = new Map(); // interest -> socketId[]
const globalQueue    = [];
const interestTimers = new Map(); // socketId -> timeoutId

// Active pairs use socket IDs (changes on reconnect)
const activePairs    = new Map(); // socketId -> partnerId (current socket)
const userRooms      = new Map(); // socketId -> roomId

// Session data — keyed by SESSION TOKEN, survives reconnects
// { name, country, interests, warnings, partnerId (session), roomId, messages }
const sessions       = new Map(); // sessionToken -> sessionData
const tokenToSocket  = new Map(); // sessionToken -> current socketId
const socketToToken  = new Map(); // socketId -> sessionToken

// Grace period: when a user disconnects, we keep their session for GRACE_PERIOD ms
const graceTimers    = new Map(); // sessionToken -> timeoutId
// When a user is in grace period, partner is put in "waiting" state
const waitingFor     = new Map(); // partnerSessionToken -> partnerSocketId (who is waiting)

const msgRates       = new Map(); // socketId -> {count, resetAt}

// ── File uploads ─────────────────────────────────────
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
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=country,countryCode`, { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    if (d.countryCode) {
      const flag = d.countryCode.toUpperCase().split('').map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('');
      res.json({ country: d.country, code: d.countryCode, flag });
    } else res.json({ country:'', code:'', flag:'' });
  } catch { res.json({ country:'', code:'', flag:'' }); }
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error:'No file' });
  res.json({ url:`/uploads/${req.file.filename}`, filename:req.file.filename, mimetype:req.file.mimetype });
});

// ── Name generator ────────────────────────────────────
const adj   = ['Swift','Cosmic','Neon','Silent','Wild','Vivid','Lunar','Mystic','Pixel','Frosted','Electric','Amber','Crystal','Shadow','Velvet'];
const nouns = ['Fox','Panda','Wolf','Eagle','Comet','Nova','Drift','Spark','Blaze','Storm','Raven','Tiger','Lynx','Hawk','Orca'];
function randomName() { return adj[Math.floor(Math.random()*adj.length)] + nouns[Math.floor(Math.random()*nouns.length)] + Math.floor(Math.random()*99+1); }
function getRoomId(a, b) { return [a,b].sort().join('::'); }

// ── Queue helpers ─────────────────────────────────────
function removeFromAllQueues(socketId) {
  for (let i=globalQueue.length-1; i>=0; i--) if (globalQueue[i]===socketId) globalQueue.splice(i,1);
  for (const [,q] of interestQueues) for (let i=q.length-1; i>=0; i--) if (q[i]===socketId) q.splice(i,1);
  if (interestTimers.has(socketId)) { clearTimeout(interestTimers.get(socketId)); interestTimers.delete(socketId); }
}
function cleanArr(arr) {
  for (let i=arr.length-1; i>=0; i--) if (!io.sockets.sockets.get(arr[i])) arr.splice(i,1);
}

// ── Session helpers ───────────────────────────────────
function getSession(token) { return sessions.get(token); }
function getSocketId(token) { return tokenToSocket.get(token); }
function getToken(socketId) { return socketToToken.get(socketId); }

function endSession(token) {
  const sess = sessions.get(token);
  if (!sess) return;

  // Delete uploaded files from this session's messages
  if (sess.roomId) {
    const msgs = sess.messages || [];
    msgs.forEach(m => {
      if (m.filename) { const fp=path.join(UPLOAD_DIR,m.filename); if(fs.existsSync(fp)) fs.unlink(fp,()=>{}); }
    });
  }

  // Clean up partner linkage
  if (sess.partnerToken) {
    const partnerSess = sessions.get(sess.partnerToken);
    if (partnerSess) partnerSess.partnerToken = null;
  }

  sessions.delete(token);
  const sid = tokenToSocket.get(token);
  if (sid) { socketToToken.delete(sid); tokenToSocket.delete(token); }
  activePairs.delete(tokenToSocket.get(token));
  waitingFor.delete(token);
}

// ── Pair connection using sessions ────────────────────
function connectPair(sockA, sessA, sockB, sessB) {
  const roomId = getRoomId(sessA.token, sessB.token);

  // Link sessions to each other
  sessA.partnerToken = sessB.token;
  sessB.partnerToken = sessA.token;
  sessA.roomId = roomId;
  sessB.roomId = roomId;
  sessA.messages = [];
  sessB.messages = sessA.messages; // shared reference

  // Link socket IDs
  activePairs.set(sockA.id, sockB.id);
  activePairs.set(sockB.id, sockA.id);
  userRooms.set(sockA.id, roomId);
  userRooms.set(sockB.id, roomId);

  sockA.join(roomId); sockB.join(roomId);

  const shared = (sessA.interests||[]).filter(t => (sessB.interests||[]).includes(t));

  sockA.emit('connected', { partnerName:sessB.name, myName:sessA.name, partnerCountry:sessB.country||{}, sharedInterests:shared });
  sockB.emit('connected', { partnerName:sessA.name, myName:sessB.name, partnerCountry:sessA.country||{}, sharedInterests:shared });
}

// ── Matchmaking ───────────────────────────────────────
function matchWithInterests(socket) {
  removeFromAllQueues(socket.id);
  cleanArr(globalQueue);

  const sess = getSession(getToken(socket.id));
  const myInterests = sess?.interests || [];

  if (myInterests.length > 0) {
    for (const interest of myInterests) {
      const q = interestQueues.get(interest) || [];
      cleanArr(q);
      while (q.length > 0) {
        const pid = q.shift();
        if (pid === socket.id) continue;
        const ps = io.sockets.sockets.get(pid);
        if (!ps) continue;
        const pSess = getSession(getToken(pid));
        if (!pSess) continue;
        removeFromAllQueues(pid);
        connectPair(socket, sess, ps, pSess);
        return;
      }
    }
    for (const interest of myInterests) {
      if (!interestQueues.has(interest)) interestQueues.set(interest, []);
      interestQueues.get(interest).push(socket.id);
    }
    socket.emit('searching', { mode:'interest', timeout:5 });
    const timer = setTimeout(() => { removeFromAllQueues(socket.id); matchGlobal(socket); }, 5000);
    interestTimers.set(socket.id, timer);
    return;
  }
  matchGlobal(socket);
}

function matchGlobal(socket) {
  removeFromAllQueues(socket.id);
  cleanArr(globalQueue);
  const sess = getSession(getToken(socket.id));

  while (globalQueue.length > 0) {
    const pid = globalQueue.shift();
    if (pid === socket.id) continue;
    const ps = io.sockets.sockets.get(pid);
    if (!ps) continue;
    const pSess = getSession(getToken(pid));
    if (!pSess) continue;
    removeFromAllQueues(pid);
    connectPair(socket, sess, ps, pSess);
    return;
  }
  globalQueue.push(socket.id);
  socket.emit('searching', { mode:'global' });
}

// ── Rate limiting ─────────────────────────────────────
function isRateLimited(socketId) {
  const now = Date.now();
  const r = msgRates.get(socketId) || { count:0, resetAt:now+MSG_WINDOW };
  if (now > r.resetAt) { r.count=0; r.resetAt=now+MSG_WINDOW; }
  r.count++;
  msgRates.set(socketId, r);
  return r.count > MSG_LIMIT;
}

// ── Profanity ─────────────────────────────────────────
const BAD_WORDS = ['fuck','shit','bitch','dick','pussy','cock','cunt','nigger','nigga','whore','slut','bastard','motherfucker','asshole','faggot','rape','porn','nude','naked','fck','fuk','magi','chudi','choda','madarchod','bokachoda','khanki','harami','shala','sala','gandu','randi','lavda','lauda','bhosdi','choot','bhenchod','chutiya','bhadwa','haramzada','behenchod','kuss','sharmouta','puta','pendejo','cabron','maricon','verga','joder','mierda','putain','merde','salope','connard','blyad','pizda','khuy','mudak','hurensohn','wichser','anjing','bangsat','kontol','memek','bajingan','orospu','siktir','putangina','gago','tangina'];
function checkBadWords(t) { const n=t.toLowerCase().replace(/[@4]/g,'a').replace(/[1!|]/g,'i').replace(/0/g,'o').replace(/3/g,'e').replace(/\$/g,'s'); return BAD_WORDS.some(w=>n.includes(w)); }
function censorText(t) { let r=t; BAD_WORDS.forEach(w=>{const re=new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi');r=r.replace(re,m=>m[0]+'*'.repeat(Math.max(m.length-2,1))+(m.length>1?m[m.length-1]:''));}); return r; }

// ── Socket.IO ─────────────────────────────────────────
io.on('connection', (socket) => {

  // Client sends their session token on every connection
  // If no token exists, a new session is created
  socket.on('init_session', (token) => {
    let sess;
    let isReconnect = false;

    if (token && sessions.has(token)) {
      // ─ RECONNECT: existing session found ─
      sess = sessions.get(token);
      isReconnect = true;

      // Cancel the grace period timer — they made it back in time
      if (graceTimers.has(token)) {
        clearTimeout(graceTimers.get(token));
        graceTimers.delete(token);
      }

      // Update socket mapping
      const oldSocketId = tokenToSocket.get(token);
      if (oldSocketId) {
        socketToToken.delete(oldSocketId);
        activePairs.delete(oldSocketId);
        userRooms.delete(oldSocketId);
      }
      tokenToSocket.set(token, socket.id);
      socketToToken.set(socket.id, token);

      // Send back their name etc
      socket.emit('assigned_name', sess.name);
      socket.emit('session_restored', { name: sess.name });

      // Check if they were in a chat
      if (sess.partnerToken && sessions.has(sess.partnerToken)) {
        const partnerSess = sessions.get(sess.partnerToken);
        const partnerSocketId = tokenToSocket.get(sess.partnerToken);
        const partnerSocket = partnerSocketId ? io.sockets.sockets.get(partnerSocketId) : null;

        if (partnerSocket) {
          // Partner is online — restore the room
          const roomId = sess.roomId;
          activePairs.set(socket.id, partnerSocket.id);
          activePairs.set(partnerSocket.id, socket.id);
          userRooms.set(socket.id, roomId);
          userRooms.set(partnerSocket.id, roomId);
          socket.join(roomId);

          // Send all missed messages to the reconnecting user
          const messages = sess.messages || [];
          socket.emit('chat_restored', {
            partnerName: partnerSess.name,
            myName: sess.name,
            partnerCountry: partnerSess.country || {},
            messages: messages
          });

          // Tell partner they're back
          partnerSocket.emit('partner_reconnected', { partnerName: sess.name });

          // Remove partner from waiting state
          waitingFor.delete(sess.partnerToken);
        } else {
          // Partner is also disconnected (both lost connection)
          // Check if partner is still in grace period
          if (graceTimers.has(sess.partnerToken)) {
            // Partner hasn't given up yet — wait for them
            socket.emit('chat_restored', {
              partnerName: partnerSess.name,
              myName: sess.name,
              partnerCountry: partnerSess.country || {},
              messages: sess.messages || []
            });
            socket.emit('partner_reconnecting'); // show "partner reconnecting..." state
            waitingFor.set(sess.partnerToken, socket.id);
          } else {
            // Partner's grace period expired — they gave up
            sess.partnerToken = null;
            sess.roomId = null;
            sess.messages = [];
            socket.emit('partner_gave_up');
          }
        }
      } else {
        // Was not in a chat — just restore name
        sess.partnerToken = null;
      }

    } else {
      // ─ NEW SESSION ─
      const newToken = uuidv4();
      sess = {
        token: newToken,
        name: randomName(),
        country: null,
        interests: [],
        warnings: 0,
        partnerToken: null,
        roomId: null,
        messages: []
      };
      sessions.set(newToken, sess);
      tokenToSocket.set(newToken, socket.id);
      socketToToken.set(socket.id, newToken);

      socket.emit('assigned_name', sess.name);
      socket.emit('session_token', newToken); // client stores this in localStorage
    }
  });

  socket.on('set_country',   (d) => { const s=getSession(getToken(socket.id)); if(s) s.country=d; });
  socket.on('set_interests', (d) => { const s=getSession(getToken(socket.id)); if(s) s.interests=Array.isArray(d)?d.slice(0,5):[]; });

  socket.on('find_partner', () => {
    const token = getToken(socket.id);
    const sess = getSession(token);
    if (!sess) return;
    // End any existing chat
    if (sess.partnerToken) {
      const pSess = sessions.get(sess.partnerToken);
      const pSid  = tokenToSocket.get(sess.partnerToken);
      if (pSid) io.to(pSid).emit('partner_left');
      if (pSess) { pSess.partnerToken=null; pSess.roomId=null; }
      sess.partnerToken=null; sess.roomId=null; sess.messages=[];
    }
    const oldSid = socket.id;
    activePairs.delete(oldSid);
    const oldRoom = userRooms.get(oldSid);
    if (oldRoom) socket.leave(oldRoom);
    userRooms.delete(oldSid);
    matchWithInterests(socket);
  });

  socket.on('skip', () => {
    const token = getToken(socket.id);
    const sess = getSession(token);
    if (!sess) return;
    if (sess.partnerToken) {
      const pSid = tokenToSocket.get(sess.partnerToken);
      if (pSid) io.to(pSid).emit('partner_left');
      const pSess = sessions.get(sess.partnerToken);
      if (pSess) { pSess.partnerToken=null; pSess.roomId=null; }
      sess.partnerToken=null; sess.roomId=null; sess.messages=[];
    }
    activePairs.delete(socket.id);
    const oldRoom = userRooms.get(socket.id);
    if (oldRoom) socket.leave(oldRoom);
    userRooms.delete(socket.id);
    matchWithInterests(socket);
  });

  socket.on('end_chat', () => {
    const token = getToken(socket.id);
    const sess = getSession(token);
    if (sess) {
      if (sess.partnerToken) {
        const pSid = tokenToSocket.get(sess.partnerToken);
        if (pSid) io.to(pSid).emit('partner_left');
        const pSess = sessions.get(sess.partnerToken);
        if (pSess) { pSess.partnerToken=null; pSess.roomId=null; pSess.messages=[]; }
        sess.partnerToken=null; sess.roomId=null; sess.messages=[];
      }
    }
    removeFromAllQueues(socket.id);
    activePairs.delete(socket.id);
    userRooms.delete(socket.id);
    socket.emit('chat_ended');
  });

  socket.on('send_message', (data) => {
    const token = getToken(socket.id);
    const sess  = getSession(token);
    if (!sess || !sess.partnerToken) return;
    if (isRateLimited(socket.id)) { socket.emit('rate_limited'); return; }

    const roomId = sess.roomId;
    if (!roomId) return;

    if (data.type==='text' && data.text) {
      if (checkBadWords(data.text)) {
        sess.warnings = (sess.warnings||0)+1;
        socket.emit('content_warning', { warns:sess.warnings, max:3 });
        if (sess.warnings>=3) { socket.emit('banned'); setTimeout(()=>socket.disconnect(),1000); return; }
        data.text = censorText(data.text);
      }
    }

    const msg = {
      id:uuidv4(), from:token, // use token as sender ID (stable across reconnects)
      type:data.type||'text', text:data.text||'',
      url:data.url||null, filename:data.filename||null, mimetype:data.mimetype||null,
      gif:data.gif||null, reactions:{},
      replyTo:data.replyTo||null,
      timestamp:Date.now(), read:false
    };

    // Store in session (survives reconnect)
    if (!sess.messages) sess.messages = [];
    sess.messages.push(msg);

    // Emit to the room — but use socket ID for isMe check compatibility
    // Add sender socket id for client-side isMe detection
    const msgToSend = { ...msg, fromSocket: socket.id };
    io.to(roomId).emit('new_message', msgToSend);
  });

  socket.on('typing', (v) => {
    const p = activePairs.get(socket.id);
    if (p) io.to(p).emit('partner_typing', v);
  });

  socket.on('messages_read', () => {
    const token = getToken(socket.id);
    const sess  = getSession(token);
    if (!sess?.messages) return;
    sess.messages.forEach(m => { if(m.from!==token) m.read=true; });
    const p = activePairs.get(socket.id);
    if (p) io.to(p).emit('partner_read');
  });

  socket.on('unsend_message', ({ msgId }) => {
    const token = getToken(socket.id);
    const sess  = getSession(token);
    if (!sess?.messages) return;
    const msg = sess.messages.find(m=>m.id===msgId && m.from===token);
    if (!msg) return;
    if (msg.filename) { const fp=path.join(UPLOAD_DIR,msg.filename); if(fs.existsSync(fp)) fs.unlink(fp,()=>{}); }
    msg.unsent=true; msg.text=''; msg.url=null; msg.gif=null;
    io.to(sess.roomId).emit('message_unsent', { msgId });
  });

  socket.on('edit_message', ({ msgId, newText }) => {
    const token = getToken(socket.id);
    const sess  = getSession(token);
    if (!sess?.messages || !newText?.trim()) return;
    const msg = sess.messages.find(m=>m.id===msgId && m.from===token && m.type==='text' && !m.unsent);
    if (!msg) return;
    if (checkBadWords(newText)) { sess.warnings=(sess.warnings||0)+1; socket.emit('content_warning',{warns:sess.warnings,max:3}); return; }
    msg.text=newText; msg.edited=true;
    io.to(sess.roomId).emit('message_edited', { msgId, newText });
  });

  socket.on('add_reaction', ({ msgId, emoji }) => {
    const token = getToken(socket.id);
    const sess  = getSession(token);
    if (!sess?.messages) return;
    const msg = sess.messages.find(m=>m.id===msgId); if(!msg) return;
    if (!msg.reactions) msg.reactions={};
    if (!msg.reactions[emoji]) msg.reactions[emoji]=[];
    const idx = msg.reactions[emoji].indexOf(token);
    if (idx>-1) msg.reactions[emoji].splice(idx,1); else msg.reactions[emoji].push(token);
    if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
    io.to(sess.roomId).emit('reaction_updated', { msgId, reactions:msg.reactions });
  });

  socket.on('disconnect', () => {
    const token = getToken(socket.id);
    removeFromAllQueues(socket.id);
    activePairs.delete(socket.id);
    msgRates.delete(socket.id);

    if (!token) return;
    const sess = getSession(token);
    if (!sess) return;

    // Don't delete the session immediately — start grace period
    // During grace period the user can reconnect and resume their chat
    if (sess.partnerToken) {
      // Notify partner that this user lost connection
      const pSid = tokenToSocket.get(sess.partnerToken);
      if (pSid) {
        io.to(pSid).emit('partner_disconnected', {
          graceSeconds: Math.floor(GRACE_PERIOD / 1000)
        });
        // Track that partner is waiting for this token to reconnect
        waitingFor.set(token, pSid);
      }
    }

    // Start grace period timer
    const timer = setTimeout(() => {
      // Grace period expired — session is dead
      graceTimers.delete(token);
      const s = sessions.get(token);
      if (s) {
        // Notify partner that user is gone for good
        const pSid = tokenToSocket.get(s.partnerToken);
        if (pSid) io.to(pSid).emit('partner_left');
        endSession(token);
      }
    }, GRACE_PERIOD);

    graceTimers.set(token, timer);
    // Don't delete session data yet — keep it for reconnect
    tokenToSocket.delete(token); // socket is gone, token mapping cleared
    socketToToken.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Zapp running on port ${PORT}`));
