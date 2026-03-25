import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase.js';

const router = Router();

const ADMIN_EMAIL = 'codeninja5leandro500@gmail.com';

// GET /api/ideas — obtener todos los mensajes (público)
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

// POST /api/ideas — enviar un mensaje (requiere login)
router.post('/', async (req, res) => {
  // Permitir publicar ideas tanto autenticados como anónimos.
  // Si se proporciona Authorization Bearer token se valida y se asocia el user_id/username,
  // si no, se inserta con user_id = null y username proveniente del body o 'Anónimo'.
  const authHeader = req.headers.authorization;
  let decoded = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '');
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      // Si el token es inválido, ignoramos la autenticación y permitimos publicar como anónimo
      decoded = null;
    }
  }

  const { content, username: bodyUsername } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });

    // Algunos tokens externos pueden usar campos distintos (sub, user_id). Normalizar.
    const tokenUserId = decoded?.id || decoded?.user_id || decoded?.sub || null;
    const suggestedUsername = decoded?.username || decoded?.email?.split('@')[0] || (bodyUsername && String(bodyUsername).trim()) || 'Anónimo';

    const insertPayload = {
      user_id: tokenUserId,
      username: suggestedUsername,
      content: content.trim(),
    };
  try {
    // Si viene un user_id en el token, validar que exista en la tabla users.
    if (insertPayload.user_id) {
      try {
        const { data: dbUser, error: userErr } = await supabase.from('users').select('id, username, email').eq('id', insertPayload.user_id).maybeSingle();
        if (userErr) {
          console.warn('[ideas POST] error verificando user existence by id:', userErr.message || userErr);
          insertPayload.user_id = null;
        } else if (!dbUser) {
          // Try to find by email (token may contain an auth user id not present in public.users)
          if (decoded?.email) {
            const { data: byEmail, error: byEmailErr } = await supabase.from('users').select('id, username, email').eq('email', decoded.email).maybeSingle();
            if (byEmailErr) {
              console.warn('[ideas POST] error verificando user existence by email:', byEmailErr.message || byEmailErr);
              insertPayload.user_id = null;
            } else if (byEmail) {
              insertPayload.user_id = byEmail.id;
              insertPayload.username = byEmail.username || insertPayload.username;
            } else {
              // If the token email is the admin email, allow posting as admin (user_id null but username set)
              if (decoded?.email === ADMIN_EMAIL) {
                console.warn('[ideas POST] admin token detected but no user row; allowing admin post as anonymous user_id');
                insertPayload.user_id = null;
                insertPayload.username = 'Administrador';
              } else {
                console.warn('[ideas POST] token user_id no existe en users table y no se encontró por email, guardando como anónimo:', insertPayload.user_id);
                insertPayload.user_id = null;
              }
            }
          } else {
            console.warn('[ideas POST] token user_id no existe en users table, guardando como anónimo:', insertPayload.user_id);
            insertPayload.user_id = null;
          }
        } else {
          // asegurar username refleje la base de datos
          insertPayload.username = dbUser.username || insertPayload.username;
        }
      } catch (e) {
        console.warn('[ideas POST] fallo al comprobar user en DB:', e);
        insertPayload.user_id = null;
      }
    }

      console.log('[ideas POST] insert payload:', { user_id: insertPayload.user_id ? 'user:' + insertPayload.user_id : null, username: insertPayload.username });

      // Intentar insertar normalmente; si supabase responde con violación FK, reintentar sin user_id
      let { data, error } = await supabase.from('idea_messages').insert(insertPayload).select().single();
      if (error) {
        console.error('[ideas POST] Supabase insert error:', error);
        const fkCodes = ['23503', 'foreign_key_violation'];
        const isFk = (error.code && fkCodes.includes(String(error.code))) || (String(error.message || '').toLowerCase().includes('foreign key'));
        if (isFk) {
          console.warn('[ideas POST] foreign key violation detected, reintentando sin user_id');
          const fallback = { ...insertPayload, user_id: null };
          const { data: fallbackData, error: fallbackErr } = await supabase.from('idea_messages').insert(fallback).select().single();
          if (fallbackErr) {
            console.error('[ideas POST] fallback insert also failed:', fallbackErr);
            return res.status(500).json({ error: fallbackErr.message || 'Insert failed', details: fallbackErr });
          }
          return res.json(fallbackData);
        }
        return res.status(500).json({ error: error.message, details: error });
      }

      res.json(data);
  } catch (err) {
    console.error('[ideas POST] unexpected error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/ideas/:id — eliminar (solo admin)
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

  const { id } = req.params;
  const { error } = await supabase.from('idea_messages').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true });
});

export default router;