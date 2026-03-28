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

// Keep Render alive
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) setInterval(() => fetch(RENDER_URL).catch(() => {}), 14 * 60 * 1000);

// ── State ──────────────────────────────────────────────
const interestQueues = new Map(); // interest -> socketId[]
const globalQueue    = [];        // fallback queue
const interestTimers = new Map(); // socketId -> timeoutId

const activePairs   = new Map(); // socketId -> partnerId
const userNames     = new Map();
const userCountries = new Map();
const userInterests = new Map(); // socketId -> string[]
const chatMessages  = new Map(); // roomId -> msg[]
const userRooms     = new Map();
const userWarnings  = new Map();
const msgRates      = new Map(); // socketId -> {count, resetAt}

const MSG_LIMIT  = 5;    // max messages per window
const MSG_WINDOW = 2000; // ms

// ── File uploads ──────────────────────────────────────
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

// Country detection via server-side IP
app.get('/api/country', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '').replace('::ffff:', '');
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=country,countryCode`, { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    if (d.countryCode) {
      const flag = d.countryCode.toUpperCase().split('').map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('');
      res.json({ country: d.country, code: d.countryCode, flag });
    } else res.json({ country: '', code: '', flag: '' });
  } catch { res.json({ country: '', code: '', flag: '' }); }
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.filename, mimetype: req.file.mimetype });
});

// ── Helpers ───────────────────────────────────────────
const adj   = ['Swift','Cosmic','Neon','Silent','Wild','Vivid','Lunar','Mystic','Pixel','Frosted','Electric','Amber','Crystal','Shadow','Velvet'];
const nouns = ['Fox','Panda','Wolf','Eagle','Comet','Nova','Drift','Spark','Blaze','Storm','Raven','Tiger','Lynx','Hawk','Orca'];
function randomName() { return adj[Math.floor(Math.random()*adj.length)] + nouns[Math.floor(Math.random()*nouns.length)] + Math.floor(Math.random()*99+1); }
function getRoomId(a, b) { return [a,b].sort().join('::'); }

function removeFromAllQueues(socketId) {
  for (let i = globalQueue.length-1; i >= 0; i--) if (globalQueue[i]===socketId) globalQueue.splice(i,1);
  for (const [,q] of interestQueues) for (let i=q.length-1; i>=0; i--) if(q[i]===socketId) q.splice(i,1);
  if (interestTimers.has(socketId)) { clearTimeout(interestTimers.get(socketId)); interestTimers.delete(socketId); }
}

function cleanArr(arr) {
  for (let i=arr.length-1; i>=0; i--) if(!io.sockets.sockets.get(arr[i])) arr.splice(i,1);
}

function disconnectPair(socketId) {
  const partnerId = activePairs.get(socketId);
  if (!partnerId) return null;
  const roomId = userRooms.get(socketId);
  if (roomId) {
    (chatMessages.get(roomId)||[]).forEach(m => {
      if (m.filename) { const fp=path.join(UPLOAD_DIR,m.filename); if(fs.existsSync(fp)) fs.unlink(fp,()=>{}); }
    });
    chatMessages.delete(roomId);
  }
  activePairs.delete(socketId); activePairs.delete(partnerId);
  userRooms.delete(socketId); userRooms.delete(partnerId);
  msgRates.delete(socketId);
  return partnerId;
}

function connectPair(sockA, sockB) {
  const roomId = getRoomId(sockA.id, sockB.id);
  activePairs.set(sockA.id, sockB.id); activePairs.set(sockB.id, sockA.id);
  userRooms.set(sockA.id, roomId); userRooms.set(sockB.id, roomId);
  chatMessages.set(roomId, []);
  sockA.join(roomId); sockB.join(roomId);

  const nameA = userNames.get(sockA.id), nameB = userNames.get(sockB.id);
  const ctryA = userCountries.get(sockA.id)||{flag:'',name:'',code:''};
  const ctryB = userCountries.get(sockB.id)||{flag:'',name:'',code:''};
  const iA = userInterests.get(sockA.id)||[], iB = userInterests.get(sockB.id)||[];
  const shared = iA.filter(t => iB.includes(t));

  sockA.emit('connected', { partnerName:nameB, myName:nameA, partnerCountry:ctryB, sharedInterests:shared });
  sockB.emit('connected', { partnerName:nameA, myName:nameB, partnerCountry:ctryA, sharedInterests:shared });
}

// ── Interest-based matching ───────────────────────────
function matchWithInterests(socket) {
  removeFromAllQueues(socket.id);
  cleanArr(globalQueue);

  const myInterests = userInterests.get(socket.id) || [];

  if (myInterests.length > 0) {
    // Try each interest queue
    for (const interest of myInterests) {
      const q = interestQueues.get(interest) || [];
      cleanArr(q);
      while (q.length > 0) {
        const pid = q.shift();
        if (pid === socket.id) continue;
        const ps = io.sockets.sockets.get(pid);
        if (!ps) continue;
        removeFromAllQueues(pid);
        connectPair(socket, ps);
        return;
      }
    }
    // No match — join interest queues, set 5s fallback timer
    for (const interest of myInterests) {
      if (!interestQueues.has(interest)) interestQueues.set(interest, []);
      interestQueues.get(interest).push(socket.id);
    }
    socket.emit('searching', { mode:'interest', timeout:5 });
    const timer = setTimeout(() => {
      removeFromAllQueues(socket.id);
      matchGlobal(socket);
    }, 5000);
    interestTimers.set(socket.id, timer);
    return;
  }

  matchGlobal(socket);
}

function matchGlobal(socket) {
  removeFromAllQueues(socket.id);
  cleanArr(globalQueue);
  while (globalQueue.length > 0) {
    const pid = globalQueue.shift();
    if (pid === socket.id) continue;
    const ps = io.sockets.sockets.get(pid);
    if (!ps) continue;
    removeFromAllQueues(pid);
    connectPair(socket, ps);
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
  userNames.set(socket.id, randomName());
  userWarnings.set(socket.id, 0);
  socket.emit('assigned_name', userNames.get(socket.id));

  socket.on('set_country',   (d) => userCountries.set(socket.id, d));
  socket.on('set_interests', (d) => userInterests.set(socket.id, Array.isArray(d) ? d.slice(0,5) : []));

  socket.on('find_partner', () => {
    const old = disconnectPair(socket.id);
    if (old) io.to(old).emit('partner_left');
    matchWithInterests(socket);
  });

  socket.on('skip', () => {
    const old = disconnectPair(socket.id);
    if (old) io.to(old).emit('partner_left');
    matchWithInterests(socket);
  });

  socket.on('end_chat', () => {
    const old = disconnectPair(socket.id);
    if (old) io.to(old).emit('partner_left');
    removeFromAllQueues(socket.id);
    socket.emit('chat_ended');
  });

  socket.on('send_message', (data) => {
    const partnerId = activePairs.get(socket.id); if (!partnerId) return;
    if (isRateLimited(socket.id)) { socket.emit('rate_limited'); return; }
    const roomId = userRooms.get(socket.id);
    if (data.type==='text' && data.text) {
      if (checkBadWords(data.text)) {
        const warns=(userWarnings.get(socket.id)||0)+1; userWarnings.set(socket.id,warns);
        socket.emit('content_warning',{warns,max:3});
        if(warns>=3){socket.emit('banned');setTimeout(()=>socket.disconnect(),1000);return;}
        data.text=censorText(data.text);
      }
    }
    const msg = {
      id:uuidv4(), from:socket.id,
      type:data.type||'text', text:data.text||'',
      url:data.url||null, filename:data.filename||null, mimetype:data.mimetype||null,
      gif:data.gif||null, reactions:{},
      replyTo:data.replyTo||null, // {msgId, previewText, previewType}
      timestamp:Date.now(), read:false
    };
    const msgs=chatMessages.get(roomId)||[]; msgs.push(msg); chatMessages.set(roomId,msgs);
    io.to(roomId).emit('new_message', msg);
  });

  socket.on('typing', (v) => { const p=activePairs.get(socket.id); if(p) io.to(p).emit('partner_typing',v); });

  // Read receipts
  socket.on('messages_read', () => {
    const roomId=userRooms.get(socket.id); if(!roomId) return;
    const msgs=chatMessages.get(roomId)||[];
    // Mark all partner messages as read
    msgs.forEach(m => { if(m.from!==socket.id) m.read=true; });
    const p=activePairs.get(socket.id);
    if(p) io.to(p).emit('partner_read');
  });

  socket.on('unsend_message', ({ msgId }) => {
    const roomId=userRooms.get(socket.id); if(!roomId) return;
    const msg=(chatMessages.get(roomId)||[]).find(m=>m.id===msgId&&m.from===socket.id);
    if(!msg) return;
    if(msg.filename){const fp=path.join(UPLOAD_DIR,msg.filename);if(fs.existsSync(fp))fs.unlink(fp,()=>{});}
    msg.unsent=true; msg.text=''; msg.url=null; msg.gif=null;
    io.to(roomId).emit('message_unsent',{msgId});
  });

  socket.on('edit_message', ({ msgId, newText }) => {
    const roomId=userRooms.get(socket.id); if(!roomId||!newText?.trim()) return;
    const msg=(chatMessages.get(roomId)||[]).find(m=>m.id===msgId&&m.from===socket.id&&m.type==='text'&&!m.unsent);
    if(!msg) return;
    if(checkBadWords(newText)){const w=(userWarnings.get(socket.id)||0)+1;userWarnings.set(socket.id,w);socket.emit('content_warning',{warns:w,max:3});return;}
    msg.text=newText; msg.edited=true;
    io.to(roomId).emit('message_edited',{msgId,newText});
  });

  socket.on('add_reaction', ({ msgId, emoji }) => {
    const roomId=userRooms.get(socket.id); if(!roomId) return;
    const msg=(chatMessages.get(roomId)||[]).find(m=>m.id===msgId); if(!msg) return;
    if(!msg.reactions) msg.reactions={};
    if(!msg.reactions[emoji]) msg.reactions[emoji]=[];
    const idx=msg.reactions[emoji].indexOf(socket.id);
    if(idx>-1) msg.reactions[emoji].splice(idx,1); else msg.reactions[emoji].push(socket.id);
    if(!msg.reactions[emoji].length) delete msg.reactions[emoji];
    io.to(roomId).emit('reaction_updated',{msgId,reactions:msg.reactions});
  });

  socket.on('disconnect', () => {
    removeFromAllQueues(socket.id);
    const old=disconnectPair(socket.id);
    if(old) io.to(old).emit('partner_left');
    userNames.delete(socket.id); userCountries.delete(socket.id);
    userInterests.delete(socket.id); userWarnings.delete(socket.id); msgRates.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Zapp running on port ${PORT}`));
