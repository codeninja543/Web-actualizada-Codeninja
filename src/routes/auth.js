import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET no está configurado en el archivo .env del backend');
  return secret;
}

// ✅ Ahora consulta el role real desde Supabase, no del token
async function verifyAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (!auth) return res.status(401).json({ error: 'Autenticación requerida' });
    const decoded = jwt.verify(auth, getJwtSecret());

    const { data: dbUser } = await supabase
      .from('users')
      .select('id, role')
      .eq('id', decoded.id)
      .maybeSingle();

    if (!dbUser) return res.status(401).json({ error: 'Usuario no encontrado' });
    if (dbUser.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador puede realizar esta acción' });

    req.admin = { ...decoded, role: dbUser.role };
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { username, fullName, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Usuario, email y contraseña son requeridos' });
    if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    if (username.length < 3) return res.status(400).json({ error: 'El usuario debe tener al menos 3 caracteres' });

    const { data: existingEmail } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
    if (existingEmail) return res.status(409).json({ error: 'Este email ya está registrado' });

    const { data: existingUser } = await supabase.from('users').select('id').eq('username', username).maybeSingle();
    if (existingUser) return res.status(409).json({ error: 'Este nombre de usuario ya está en uso' });

    const hashedPassword = await bcrypt.hash(password, 12);
    const { data: user, error } = await supabase
      .from('users')
      .insert({ username, full_name: fullName || username, email, password_hash: hashedPassword, role: 'user', is_member: false })
      .select('id, username, full_name, email, role, avatar_url, is_member, created_at')
      .single();

    if (error) { console.error('Insert error:', error); throw error; }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, getJwtSecret(), { expiresIn: '7d' });
    res.status(201).json({ user, token });
  } catch (err) {
    res.status(500).json({ error: 'Error al registrar: ' + err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña son requeridos' });

    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, full_name, email, password_hash, role, avatar_url, is_member, created_at')
      .eq('email', email.trim().toLowerCase())
      .maybeSingle();

    if (error) return res.status(500).json({ error: 'Error de base de datos: ' + error.message });
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });
    if (!user.password_hash) return res.status(401).json({ error: 'Esta cuenta usa inicio de sesión con Google. Por favor usa esa opción.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, getJwtSecret(), { expiresIn: '7d' });
    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser, token });
  } catch (err) {
    res.status(500).json({ error: 'Error al iniciar sesión: ' + err.message });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, full_name, email, role, avatar_url, is_member, created_at')
      .eq('id', req.user.id)
      .maybeSingle();
    if (error || !user) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Error en el servidor: ' + err.message });
  }
});

// POST /api/auth/make-admin
router.post('/make-admin', authenticate, async (req, res) => {
  try {
    const { adminSecret } = req.body;
    if (adminSecret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Clave incorrecta' });
    const { data, error } = await supabase
      .from('users').update({ role: 'admin' }).eq('id', req.user.id)
      .select('id, username, email, role').single();
    if (error) throw error;
    res.json({ message: '¡Ahora eres administrador!', user: data });
  } catch (err) {
    res.status(500).json({ error: 'Error en el servidor: ' + err.message });
  }
});

// GET /api/auth/admin/users
router.get('/admin/users', verifyAdmin, async (req, res) => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('id, username, full_name, email, role, is_member, created_at, avatar_url')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ users: users || [], total: users?.length || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuarios: ' + err.message });
  }
});

// DELETE /api/auth/admin/users/:id
router.delete('/admin/users/:id', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (id === req.admin.id) return res.status(400).json({ error: 'No puedes eliminarte a ti mismo' });
    const { error } = await supabase.from('users').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true, message: 'Usuario eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar usuario: ' + err.message });
  }
});

// PATCH /api/auth/admin/users/:id/role
router.patch('/admin/users/:id/role', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    if (!['user', 'admin', 'member'].includes(role)) return res.status(400).json({ error: 'Rol inválido' });
    const { data, error } = await supabase
      .from('users').update({ role }).eq('id', id)
      .select('id, username, email, role').single();
    if (error) throw error;
    res.json({ success: true, user: data });
  } catch (err) {
    res.status(500).json({ error: 'Error al cambiar rol: ' + err.message });
  }
});

export default router;