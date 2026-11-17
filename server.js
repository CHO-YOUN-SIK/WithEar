const http = require('http');
const fs = require('fs');
const path = require('path');
const { BackendStore } = require('./backend/store');
const { createApiRouter } = require('./backend/router');
const { attachWebSocketServer } = require('./backend/wsServer');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const store = new BackendStore();
let wsBroadcaster = null;

const apiRouter = createApiRouter({
  store,
  broadcastRoom: (roomCode, payload) => {
    if (wsBroadcaster) {
      wsBroadcaster.broadcastRoom(roomCode, payload);
    }
  }
});

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = reqUrl.pathname;

  // Route /api/* requests to the backend REST & SSE router
  if (pathname.startsWith('/api/')) {
    const handled = await apiRouter.handleApiRequest(req, res, pathname, reqUrl.searchParams);
    if (!handled) {
      res.writeHead(404, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ error: 'API endpoint not found' }));
    }
    return;
  }

  if (pathname === '/') {
    pathname = '/index.html';
  }

  const safeRelPath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(PUBLIC_DIR, safeRelPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

wsBroadcaster = attachWebSocketServer({
  server,
  store,
  onRoomUpdated: (room) => {
    const snapshot = store.serializeRoom(room);
    const payload = { type: 'room_state', room: snapshot };
    wsBroadcaster.broadcastRoom(room.code, payload);
    apiRouter.broadcastSse(room.code, payload);
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`WithEar Backend Server (REST + SSE + WebSocket) running on http://localhost:${PORT}`);
  });
}

module.exports = { server, store };
