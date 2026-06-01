import { Router } from 'express';
import jwt from 'jsonwebtoken';
import xss from 'xss';
import { supabase } from '../lib/supabase.js';

const router = Router();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

// Validar y sanitizar texto
function sanitize(str, maxLen = 300) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) return null;
  return xss(trimmed); // elimina HTML/scripts maliciosos
}

// ─── GET /api/ideas ───────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('idea_messages')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[ideas GET] Supabase error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error('[ideas GET] unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/ideas ──────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  // Validar y sanitizar inputs
  const rawContent  = req.body?.content;
  const rawUsername = req.body?.username;

  const content = sanitize(rawContent, 300);
  if (!content) return res.status(400).json({ error: 'Mensaje inválido o vacío (máx 300 caracteres)' });

  // Auth opcional
  const authHeader = req.headers.authorization;
  let decoded = null;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      decoded = jwt.verify(authHeader.replace('Bearer ', ''), process.env.JWT_SECRET);
    } catch {
      decoded = null;
    }
  }

  const tokenUserId = decoded?.id || decoded?.user_id || decoded?.sub || null;
  const safeUsername = sanitize(
    decoded?.username || decoded?.email?.split('@')[0] || rawUsername || 'Anónimo',
    50
  ) || 'Anónimo';

  const insertPayload = { user_id: tokenUserId, username: safeUsername, content };

  try {
    // Verificar que el user_id exista en la tabla users
    if (insertPayload.user_id) {
      const { data: dbUser } = await supabase
        .from('users').select('id, username').eq('id', insertPayload.user_id).maybeSingle();

      if (!dbUser && decoded?.email) {
        const { data: byEmail } = await supabase
          .from('users').select('id, username').eq('email', decoded.email).maybeSingle();

        if (byEmail) {
          insertPayload.user_id = byEmail.id;
          insertPayload.username = byEmail.username || safeUsername;
        } else {
          insertPayload.user_id = null;
          insertPayload.username = decoded.email === ADMIN_EMAIL ? 'Administrador' : safeUsername;
        }
      } else if (dbUser) {
        insertPayload.username = dbUser.username || safeUsername;
      } else {
        insertPayload.user_id = null;
      }
    }

    let { data, error } = await supabase.from('idea_messages').insert(insertPayload).select().single();

    // Si hay error de FK, reintentar sin user_id
    if (error) {
      const isFk = String(error.code) === '23503' || String(error.message).toLowerCase().includes('foreign key');
      if (isFk) {
        const { data: fallback, error: fallbackErr } = await supabase
          .from('idea_messages').insert({ ...insertPayload, user_id: null }).select().single();
        if (fallbackErr) return res.status(500).json({ error: fallbackErr.message });
        return res.json(fallback);
      }
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error('[ideas POST] unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /api/ideas/:id ────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.email !== ADMIN_EMAIL) {
      return res.status(403).json({ error: 'Solo el administrador puede eliminar' });
    }
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }

  // Validar que el id sea un UUID válido
  const { id } = req.params;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) return res.status(400).json({ error: 'ID inválido' });

  const { error } = await supabase.from('idea_messages').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true });
});

export default router;