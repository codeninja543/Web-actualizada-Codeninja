import { Router } from 'express';
import { supabase } from '../lib/supabase.js';

const router = Router();

const activeUsers = new Map();
const TIMEOUT_MS = 30_000;

function cleanup() {
  const now = Date.now();
  for (const [sid, data] of activeUsers.entries()) {
    if (now - data.lastSeen > TIMEOUT_MS) activeUsers.delete(sid);
  }
}
setInterval(cleanup, 15_000);

function parseJwt(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
  
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '=='.slice((base64.length % 4) || 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null; 
  }
}

router.post('/ping', async (req, res) => {
  try {
    const { sessionId, page } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId requerido' });

    let userId = null;
    let username = 'Visitante';

    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (auth) {
      const payload = parseJwt(auth);
      if (payload?.id) {
        try {
          const { data } = await supabase
            .from('users')
            .select('id, username')
            .eq('id', payload.id)
            .maybeSingle();
          if (data) { userId = data.id; username = data.username; }
        } catch { /* ignorar error de BD */ }
      }
    }

    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .split(',')[0].trim();

    activeUsers.set(sessionId, {
      sessionId,
      ip,
      page: page || '/',
      userAgent: req.headers['user-agent'] || '',
      userId,
      username,
      lastSeen: Date.now(),
      joinedAt: activeUsers.get(sessionId)?.joinedAt || Date.now(),
    });

    res.json({ ok: true, online: activeUsers.size });
  } catch (err) {
    console.error('[presence/ping]', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.delete('/leave', (req, res) => {
  try {
    const { sessionId } = req.body;
    if (sessionId) activeUsers.delete(sessionId);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

// ── GET /api/presence/admin ────────────────────────────────────────────────
router.get('/admin', async (req, res) => {
  try {
    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (!auth) return res.status(401).json({ error: 'Autenticación requerida' });

    const payload = parseJwt(auth);
    if (!payload?.id) return res.status(401).json({ error: 'Token inválido' });

    const { data: dbUser } = await supabase
      .from('users').select('role').eq('id', payload.id).maybeSingle();

    if (!dbUser || dbUser.role !== 'admin')
      return res.status(403).json({ error: 'Solo administradores' });

    cleanup();

    const users = [...activeUsers.values()].map(u => ({
      sessionId: u.sessionId,
      page: u.page,
      ip: u.ip,
      username: u.username,
      userId: u.userId,
      isLoggedIn: !!u.userId,
      userAgent: u.userAgent,
      lastSeen: new Date(u.lastSeen).toISOString(),
      joinedAt: new Date(u.joinedAt).toISOString(),
      secondsOnline: Math.floor((Date.now() - u.joinedAt) / 1000),
    }));

    res.json({
      total: users.length,
      loggedIn: users.filter(u => u.isLoggedIn).length,
      visitors: users.filter(u => !u.isLoggedIn).length,
      users,
    });
  } catch (err) {
    console.error('[presence/admin]', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

router.get('/count', (req, res) => {
  cleanup();
  res.json({ online: activeUsers.size });
});

export default router;