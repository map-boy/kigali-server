const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_ROOMS = 200;
const rooms = new Map();

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do {
    c = '';
    for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
  } while (rooms.has(c));
  return c;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function peerOf(ws) {
  const r = ws.room;
  if (!r) return null;
  return r.clients[ws.seat === 0 ? 1 : 0];
}

function leave(ws) {
  const r = ws.room;
  if (!r) return;
  const other = peerOf(ws);
  r.clients[ws.seat] = null;
  ws.room = null;
  ws.seat = -1;
  if (other) {
    send(other, { t: 'left' });
    other.room = null;
    other.seat = -1;
  }
  rooms.delete(r.code);
}

function startRace(r) {
  r.started = true;
  r.again = [false, false];
  const msg = { t: 'start', track: r.track };
  send(r.clients[0], msg);
  send(r.clients[1], msg);
}

// plain HTTP answer: health check and "wake up" call from the game page
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('kigali-gp relay ok, rooms=' + rooms.size);
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.seat = -1;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    const text = data.toString();
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'create') {
      leave(ws);
      if (rooms.size >= MAX_ROOMS) { send(ws, { t: 'error', msg: 'server busy, try again' }); return; }
      const r = { code: makeCode(), clients: [ws, null], track: Math.max(0, Math.floor(Number(m.track) || 0)), started: false, again: [false, false] };
      rooms.set(r.code, r);
      ws.room = r;
      ws.seat = 0;
      send(ws, { t: 'created', code: r.code, seat: 0, track: r.track });
    } else if (m.t === 'join') {
      leave(ws);
      const r = rooms.get(String(m.code || '').toUpperCase());
      if (!r) { send(ws, { t: 'error', msg: 'no such room' }); return; }
      if (r.clients[1]) { send(ws, { t: 'error', msg: 'room is full' }); return; }
      r.clients[1] = ws;
      ws.room = r;
      ws.seat = 1;
      send(ws, { t: 'joined', code: r.code, seat: 1, track: r.track });
      startRace(r);
    } else if (m.t === 'again') {
      const r = ws.room;
      if (!r || !r.clients[0] || !r.clients[1]) return;
      r.again[ws.seat] = true;
      if (r.again[0] && r.again[1]) startRace(r);
      else send(peerOf(ws), { t: 'again' });
    } else if (m.t === 's' || m.t === 'fin') {
      const o = peerOf(ws);
      if (o && o.readyState === 1) o.send(text);
    }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

server.listen(PORT, () => console.log('kigali-gp relay listening on ' + PORT));