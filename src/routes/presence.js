import { Router } from 'express';
import jwt from 'jsonwebtoken';

const router = Router();

// Mapa en memoria: sessionId -> { username, user_id, ip, page, last_seen, joined_at }
const activeSessions = new Map();

// Clientes SSE conectados: Set de { res, userId }
const sseClients = new Set();

// Limpiar sesiones inactivas cada 30s
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [key, val] of activeSessions.entries()) {
    if (now - val.last_seen > 90000) {
      activeSessions.delete(key);
      changed = true;
    }
  }
  if (changed) broadcastOnlineUsers();
}, 30000);

function getOnlineData() {
  const now = Date.now();
  const users = Array.from(activeSessions.values()).map(u => ({
    session_id: u.session_id,
    user_id: u.user_id,
    username: u.username,
    page: u.page,
    ip: u.ip,
    is_logged_in: !!u.user_id,
    last_seen: new Date(u.last_seen).toISOString(),
    minutes_online: Math.floor((now - u.joined_at) / 60000),
  }));
  return {
    count: users.length,
    logged_in: users.filter(u => u.is_logged_in).length,
    visitors: users.filter(u => !u.is_logged_in).length,
    users,
  };
}

function broadcastOnlineUsers() {
  if (sseClients.size === 0) return;
  const data = JSON.stringify(getOnlineData());
  for (const client of sseClients) {
    try {
      client.res.write(`event: online-users\ndata: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ── POST /api/presence/ping ───────────────────────────────────────────────
router.post('/ping', (req, res) => {
  const { session_id, user_id, username, page } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id requerido' });

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0].trim();

  activeSessions.set(session_id, {
    session_id,
    user_id: user_id || null,
    username: username || 'Visitante',
    page: page || '/',
    ip,
    last_seen: Date.now(),
    joined_at: activeSessions.get(session_id)?.joined_at || Date.now(),
  });

  broadcastOnlineUsers();
  res.json({ ok: true, online: activeSessions.size });
});

// ── DELETE /api/presence/leave ────────────────────────────────────────────
router.delete('/leave', (req, res) => {
  const { session_id } = req.body;
  if (session_id) {
    activeSessions.delete(session_id);
    broadcastOnlineUsers();
  }
  res.json({ ok: true });
});

// ── GET /api/presence/online — solo admin, consulta directa ──────────────
router.get('/online', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Autenticación requerida' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
  res.json(getOnlineData());
});

// ── GET /api/presence/online/stream — SSE solo admin ─────────────────────
router.get('/online/stream', (req, res) => {
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Autenticación requerida' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }

  // Configurar SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Enviar estado actual inmediatamente
  const data = JSON.stringify(getOnlineData());
  res.write(`event: online-users\ndata: ${data}\n\n`);

  // Registrar cliente
  const client = { res };
  sseClients.add(client);

  // Ping cada 20s para mantener conexión viva
  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(keepAlive); }
  }, 20000);

  // Limpiar al desconectar
  req.on('close', () => {
    sseClients.delete(client);
    clearInterval(keepAlive);
  });
});

// ── GET /api/presence/count — público, solo el número ────────────────────
router.get('/count', (req, res) => {
  res.json({ online: activeSessions.size });
});

export default router;