# ⚡ Zapp — Random Chat App

A real-time anonymous chat platform built with Node.js, Socket.IO, and a stunning dark UI.

## Features
- 🎭 **Anonymous** — random name assigned per session (e.g. `CosmicFox42`)
- ⚡ **Instant matching** — paired with another stranger in the queue
- ⏭️ **Skip** — skip to find a new person instantly
- 🖼️ **Images & Video** — drag-and-drop or file picker (up to 50MB)
- 🎞️ **GIFs** — search powered by Tenor
- 😊 **Emoji picker** — 80+ emoji
- 🔒 **Auto-delete** — all messages and uploaded files deleted when chat ends
- 💬 **Typing indicators** — know when your partner is typing
- 📱 **Responsive** — works on mobile and desktop

## Quick Start

### 1. Install Node.js (v16+)
Download from https://nodejs.org

### 2. Install dependencies
```bash
npm install
```

### 3. Start the server
```bash
npm start
# or
node server.js
```

### 4. Open in browser
```
http://localhost:3000
```

To test matching, open two browser tabs/windows and click "Start Chatting" in both.

## Project Structure
```
├── server.js          # Node.js + Socket.IO backend
├── public/
│   └── index.html     # Full frontend (HTML/CSS/JS)
├── uploads/           # Temp file storage (auto-created, auto-cleaned)
└── package.json
```

## How it works
- Users are put in a **waiting queue** when they click "Start Chatting"
- The server pairs the first two people in the queue
- All messages are kept **in memory only** (no database)
- Uploaded files are stored temporarily in `/uploads/`
- When a chat ends (end, skip, or disconnect), all messages + files are **immediately deleted**
- Each reconnect gives a fresh random name

## Customization
- **File size limit**: Change `50 * 1024 * 1024` in `server.js` and `multer` config
- **Port**: Set `PORT` environment variable (default: 3000)
- **Name lists**: Edit `adj` and `nouns` arrays in `server.js`
- **GIF API**: Replace Tenor demo key `LIVDSRZULELA` with your own from https://developers.google.com/tenor

## Deploy to production
For a public server, use a reverse proxy (nginx/Caddy) and a process manager:
```bash
npm install -g pm2
pm2 start server.js --name zapp
```
