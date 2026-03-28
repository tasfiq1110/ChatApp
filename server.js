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

// Client reports a blocked nudity attempt — file was already uploaded then flagged
app.post('/report-nudity', express.json(), (req, res) => {
  const { filename, url, sessId } = req.body;
  const sess = sessId ? [...sessions.values()].find(s => s.sessId === sessId) : null;
  const ip   = (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '').replace('::ffff:','');
  logViolation('nudity', sess, ip, filename, filename, url);
  res.json({ ok: true });
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

// Cleanly break a pair — does NOT delete files (admin reviews them, midnight cleanup handles it)
function breakPair(sessId) {
  const s = sessions.get(sessId);
  if (!s || !s.partnerId) return;
  const p = sessions.get(s.partnerId);
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
  stats.totalChats++; incDay('chats'); saveStats();
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

// ─── Admin config ──────────────────────────────────────
const ADMIN_PASS   = process.env.ADMIN_PASSWORD || 'zapp_admin_2025';
const adminTokens  = new Set();

// ─── Persistent stats ─────────────────────────────────
const STATS_FILE = path.join(__dirname, 'stats.json');
function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch {}
  return { totalChats:0, totalMessages:0, totalUsers:0, dailyStats:{}, bannedSessions:[], bannedIPs:[], violations:[], customBadWords:[], customNudityWords:[] };
}
function saveStats() { try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats,null,2)); } catch {} }
let stats = loadStats();
if (!stats.violations)       stats.violations = [];
if (!stats.customBadWords)   stats.customBadWords = [];
if (!stats.customNudityWords) stats.customNudityWords = [];

const bannedSessions = new Set(stats.bannedSessions || []);
const bannedIPs      = new Set(stats.bannedIPs || []);

// Violation logger
function logViolation(type, sess, ip, content, filename, url) {
  const entry = {
    id: uuidv4(), ts: Date.now(), type,
    name: sess?.name||'Unknown', country: sess?.country?.name||'', flag: sess?.country?.flag||'',
    sessId: sess?.sessId||'', ip: ip||'', content: content||'', filename: filename||'', url: url||''
  };
  stats.violations.unshift(entry);
  if (stats.violations.length > 500) stats.violations = stats.violations.slice(0, 500);
  saveStats();
  return entry;
}

// Get real IP from socket
function getIP(socket) {
  return (socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
          socket.handshake.address || '').replace('::ffff:', '');
}

// ─── DAU tracking ──────────────────────────────────────
const todayKey   = () => new Date().toISOString().slice(0,10);
const dailyUsers = new Set();
let   dailyDate  = todayKey();
function trackDAU(sessId) {
  const today = todayKey();
  if (today !== dailyDate) {
    stats.dailyStats[dailyDate] = { ...(stats.dailyStats[dailyDate]||{}), users: dailyUsers.size };
    dailyUsers.clear(); dailyDate = today; saveStats();
  }
  dailyUsers.add(sessId);
}
function incDay(key) {
  const t = todayKey();
  if (!stats.dailyStats[t]) stats.dailyStats[t] = { users:0, chats:0, messages:0 };
  stats.dailyStats[t][key] = (stats.dailyStats[t][key]||0)+1;
}

// ─── Midnight auto-cleanup ─────────────────────────────
function scheduleCleanup() {
  const now = new Date();
  const next = new Date(now); next.setHours(24,0,5,0);
  setTimeout(() => {
    try {
      const files = fs.readdirSync(UPLOAD_DIR);
      let deleted = 0;
      files.forEach(f => { try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); deleted++; } catch {} });
      console.log(`[Midnight cleanup] Deleted ${deleted} files`);
    } catch(e) { console.error('[Cleanup error]', e.message); }
    scheduleCleanup();
  }, next - now);
}
scheduleCleanup();

// ─── Admin config ──────────────────────────────────────

function adminAuth(req,res,next){
  const tok = req.headers['x-admin-token']||req.query.token;
  if(adminTokens.has(tok)) return next();
  res.status(401).json({error:'Unauthorized'});
}

app.post('/admin/login', express.json(), (req,res)=>{
  if(req.body.password===ADMIN_PASS){
    const tok=uuidv4(); adminTokens.add(tok);
    setTimeout(()=>adminTokens.delete(tok), 24*60*60*1000);
    res.json({token:tok});
  } else res.status(401).json({error:'Wrong password'});
});

app.get('/admin', (_,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));

app.get('/admin/api/stats', adminAuth, (req,res)=>{
  const paired  = [...sessions.values()].filter(s=>s.partnerId).length/2;
  const waiting = globalQ.length + [...interestQs.values()].reduce((a,q)=>a+q.length,0);
  const online  = [...sessions.values()].filter(s=>s.sockId).length;
  let mediaFiles=[];
  try{ mediaFiles=fs.readdirSync(UPLOAD_DIR).map(f=>{const fp=path.join(UPLOAD_DIR,f);const st=fs.statSync(fp);return{filename:f,size:st.size,created:st.birthtime};}).sort((a,b)=>new Date(b.created)-new Date(a.created)); }catch{}
  res.json({ online, activePairs:Math.floor(paired), waiting, totalSessions:sessions.size,
    bannedCount:bannedSessions.size, bannedIPCount:bannedIPs.size,
    totalChats:stats.totalChats, totalMessages:stats.totalMessages,
    totalUsers:stats.totalUsers, todayDAU:dailyUsers.size, dailyStats:stats.dailyStats,
    mediaFiles, violationCount:stats.violations.length });
});

app.get('/admin/api/sessions', adminAuth, (req,res)=>{
  res.json([...sessions.values()].map(s=>({
    sessId:s.sessId, name:s.name, country:s.country?.name||'', flag:s.country?.flag||'',
    interests:s.interests||[], online:!!s.sockId, inChat:!!s.partnerId,
    warnings:s.warnings||0, banned:bannedSessions.has(s.sessId), msgCount:(s.messages||[]).length, ip:s.ip||''
  })));
});

app.get('/admin/api/chat/:sessId', adminAuth, (req,res)=>{
  const s=sessions.get(req.params.sessId); if(!s) return res.status(404).json({error:'Not found'});
  const p=s.partnerId?sessions.get(s.partnerId):null;
  res.json({ session:{name:s.name,country:s.country?.name||'',interests:s.interests,ip:s.ip||''},
    partner:p?{name:p.name,country:p.country?.name||''}:null,
    messages:(s.messages||[]).map(m=>({id:m.id,type:m.type,text:m.text,url:m.url,gif:m.gif,
      timestamp:m.timestamp,unsent:m.unsent,fromName:m.sessId===s.sessId?s.name:(p?.name||'Partner')})) });
});

app.post('/admin/api/ban/:sessId', adminAuth, (req,res)=>{
  const id=req.params.sessId; bannedSessions.add(id);
  stats.bannedSessions=[...bannedSessions]; saveStats();
  const s=sessions.get(id);
  if(s){ const sock=getSock(id); if(sock){sock.emit('banned');setTimeout(()=>sock.disconnect(),500);}
    if(s.partnerId){emitTo(s.partnerId,'partner_left');breakPair(id);} sessions.delete(id); }
  res.json({ok:true});
});

app.post('/admin/api/unban/:sessId', adminAuth, (req,res)=>{
  bannedSessions.delete(req.params.sessId); stats.bannedSessions=[...bannedSessions]; saveStats();
  res.json({ok:true});
});

app.post('/admin/api/kick/:sessId', adminAuth, (req,res)=>{
  const sock=getSock(req.params.sessId); if(sock) sock.disconnect();
  res.json({ok:true});
});

// ─── IP ban routes ─────────────────────────────────────
app.get('/admin/api/banned-ips', adminAuth, (req,res)=>res.json([...bannedIPs]));

app.post('/admin/api/ban-ip', adminAuth, express.json(), (req,res)=>{
  const {ip}=req.body; if(!ip) return res.status(400).json({error:'No IP'});
  bannedIPs.add(ip); stats.bannedIPs=[...bannedIPs]; saveStats();
  let kicked=0;
  for(const [sid,s] of sessions){
    if(s.ip===ip){
      const sock=getSock(sid); if(sock){sock.emit('banned');setTimeout(()=>sock.disconnect(),500);}
      if(s.partnerId){emitTo(s.partnerId,'partner_left');breakPair(sid);}
      sessions.delete(sid); kicked++;
    }
  }
  res.json({ok:true,kicked});
});

app.post('/admin/api/unban-ip', adminAuth, express.json(), (req,res)=>{
  const {ip}=req.body; if(!ip) return res.status(400).json({error:'No IP'});
  bannedIPs.delete(ip); stats.bannedIPs=[...bannedIPs]; saveStats();
  res.json({ok:true});
});

// ─── Word list management ──────────────────────────────
// Get all words (built-in + custom)
app.get('/admin/api/words', adminAuth, (req,res)=>{
  res.json({
    builtinBad:    BAD_BUILTIN,
    customBad:     stats.customBadWords || [],
    builtinNudity: NUDITY_BUILTIN,
    customNudity:  stats.customNudityWords || []
  });
});

// Add a custom bad word
app.post('/admin/api/words/bad', adminAuth, express.json(), (req,res)=>{
  const w = (req.body.word||'').trim().toLowerCase();
  if (!w) return res.status(400).json({error:'No word'});
  if (!stats.customBadWords.includes(w)) { stats.customBadWords.push(w); saveStats(); }
  res.json({ok:true, customBad: stats.customBadWords});
});

// Remove a custom bad word
app.delete('/admin/api/words/bad/:word', adminAuth, (req,res)=>{
  const w = req.params.word.toLowerCase();
  stats.customBadWords = stats.customBadWords.filter(x=>x!==w); saveStats();
  res.json({ok:true, customBad: stats.customBadWords});
});

// Add a custom nudity keyword
app.post('/admin/api/words/nudity', adminAuth, express.json(), (req,res)=>{
  const w = (req.body.word||'').trim().toLowerCase();
  if (!w) return res.status(400).json({error:'No word'});
  if (!stats.customNudityWords.includes(w)) { stats.customNudityWords.push(w); saveStats(); }
  res.json({ok:true, customNudity: stats.customNudityWords});
});

// Remove a custom nudity keyword
app.delete('/admin/api/words/nudity/:word', adminAuth, (req,res)=>{
  const w = req.params.word.toLowerCase();
  stats.customNudityWords = stats.customNudityWords.filter(x=>x!==w); saveStats();
  res.json({ok:true, customNudity: stats.customNudityWords});
});

// Public endpoint — client fetches nudity keywords on load
app.get('/api/nudity-words', (req,res)=>{
  res.json([...NUDITY_BUILTIN, ...(stats.customNudityWords||[])]);
});

// Public endpoint — client fetches ALL custom words (no auth needed, no built-ins exposed)
app.get('/admin/api/words/public', (req,res)=>{
  res.json({ customBad: stats.customBadWords||[], customNudity: stats.customNudityWords||[] });
});

// ─── Violations log ────────────────────────────────────
app.get('/admin/api/violations', adminAuth, (req,res)=>{
  const type=req.query.type;
  res.json(type ? stats.violations.filter(v=>v.type===type) : stats.violations);
});

app.delete('/admin/api/violations', adminAuth, (req,res)=>{
  stats.violations=[]; saveStats(); res.json({ok:true});
});

// ─── Media routes ──────────────────────────────────────
app.get('/admin/api/media', adminAuth, (req,res)=>{
  try{
    const files=fs.readdirSync(UPLOAD_DIR).map(f=>{
      const fp=path.join(UPLOAD_DIR,f); const st=fs.statSync(fp);
      const ext=path.extname(f).toLowerCase();
      const violation=stats.violations.find(v=>v.filename===f);
      return{filename:f,url:`/uploads/${f}`,size:st.size,
        isImage:['.jpg','.jpeg','.png','.gif','.webp'].includes(ext),created:st.birthtime,
        flagged:!!violation,violationType:violation?.type||null};
    }).sort((a,b)=>new Date(b.created)-new Date(a.created));
    res.json(files);
  }catch{res.json([]);}
});

app.delete('/admin/api/media/:filename', adminAuth, (req,res)=>{
  const fp=path.join(UPLOAD_DIR, path.basename(req.params.filename));
  try{fs.unlinkSync(fp);res.json({ok:true});}catch{res.status(404).json({error:'Not found'});}
});

app.delete('/admin/api/media', adminAuth, (req,res)=>{
  try{const files=fs.readdirSync(UPLOAD_DIR);files.forEach(f=>{try{fs.unlinkSync(path.join(UPLOAD_DIR,f));}catch{}});res.json({ok:true,deleted:files.length});}
  catch{res.status(500).json({error:'Failed'});}
});

app.post('/admin/api/broadcast', adminAuth, express.json(), (req,res)=>{
  const {message}=req.body; if(!message) return res.status(400).json({error:'No message'});
  io.emit('admin_broadcast',{message}); res.json({ok:true,sent:sessions.size});
});

app.get('/admin/api/daily', adminAuth, (req,res)=>res.json(stats.dailyStats));

setInterval(()=>{ stats.dailyStats[todayKey()]={...(stats.dailyStats[todayKey()]||{}),users:dailyUsers.size}; saveStats(); }, 5*60*1000);

// ─── Profanity ──────────────────────────────────────────
const BAD_BUILTIN = ['fuck','shit','bitch','dick','pussy','cock','cunt','nigger','nigga','whore','slut','bastard','motherfucker','asshole','faggot','rape','porn','nude','naked','fck','fuk','magi','chudi','choda','madarchod','bokachoda','khanki','harami','shala','sala','gandu','randi','lavda','lauda','bhosdi','choot','bhenchod','chutiya','bhadwa','haramzada','behenchod','kuss','sharmouta','puta','pendejo','cabron','maricon','verga','joder','mierda','putain','merde','salope','connard','blyad','pizda','khuy','mudak','hurensohn','wichser','anjing','bangsat','kontol','memek','bajingan','orospu','siktir','putangina','gago','tangina'];

// Built-in nudity filename keywords (client-side scan)
const NUDITY_BUILTIN = ['nude','naked','nsfw','porn','sex','xxx','adult','boob','dick','onlyfans','lewd'];

// Returns full merged word list (built-in + admin custom words)
function getBadWords()    { return [...BAD_BUILTIN,    ...(stats.customBadWords   || [])]; }
function getNudityWords() { return [...NUDITY_BUILTIN, ...(stats.customNudityWords || [])]; }

function hasBad(t) {
  const n = t.toLowerCase().replace(/[@4]/g,'a').replace(/[1!|]/g,'i').replace(/0/g,'o').replace(/3/g,'e').replace(/\$/g,'s');
  return getBadWords().some(w => n.includes(w.toLowerCase()));
}
function censor(t) {
  let r = t;
  getBadWords().forEach(w => {
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi');
    r = r.replace(re, m => m[0]+'*'.repeat(Math.max(m.length-2,1))+(m.length>1?m[m.length-1]:''));
  });
  return r;
}

// ─── Socket.IO ──────────────────────────────────────────
io.on('connection', socket => {

  // ── INIT ──────────────────────────────────────────────
  // Client sends this immediately on every connect/reconnect.
  // Contains sessionId (null if new), plus current country+interests.
  // Handling everything in ONE event eliminates all ordering race conditions.
  socket.on('init', ({ sessId: clientSessId, country, interests }) => {
    const ip = getIP(socket);

    // Check IP ban immediately
    if (bannedIPs.has(ip)) {
      socket.emit('banned');
      setTimeout(() => socket.disconnect(), 500);
      return;
    }

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
      s.ip = ip; // update IP in case it changed
      trackDAU(clientSessId);

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
        warnings: 0, partnerId: null, roomId: null, messages: [], sockId: socket.id,
        ip, connectedAt: Date.now()
      };
      sessions.set(newId, s);
      sockToSess.set(socket.id, newId);
      stats.totalUsers++; incDay('users'); trackDAU(newId);
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
    // Check if banned
    if (bannedSessions.has(s.sessId)) { socket.emit('banned'); setTimeout(()=>socket.disconnect(),500); return; }
    if (!rateOk(s.sessId)) { socket.emit('rate_limited'); return; }
    if (data.type === 'text' && data.text) {
      if (hasBad(data.text)) {
        s.warnings++;
        logViolation('badword', s, s.ip, data.text, null, null);
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
    stats.totalMessages++; incDay('messages');
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
    // Don't delete file — admin may need to review it
    m.unsent = true; m.text = ''; m.url = null; m.gif = null;
    io.to(s.roomId).emit('message_unsent', { msgId });
  });

  socket.on('edit_message', ({ msgId, newText }) => {
    const s = sessions.get(sockToSess.get(socket.id));
    if (!s?.messages || !newText?.trim() || !s.roomId) return;
    const m = s.messages.find(m => m.id === msgId && m.sessId === s.sessId && m.type === 'text' && !m.unsent);
    if (!m) return;
    if (hasBad(newText)) {
      s.warnings++;
      logViolation('badword', s, s.ip, newText, null, null);
      socket.emit('content_warning', { warns: s.warnings, max: 3 });
      return;
    }
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
server.listen(PORT, () => console.log(`Hello Chat running on ${PORT}`));
