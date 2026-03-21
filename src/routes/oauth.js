import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const router = Router();

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const FRONTEND_URL         = process.env.FRONTEND_URL || 'http://localhost:5173';
const BACKEND_URL          = process.env.BACKEND_URL  || 'http://localhost:3001';

const GOOGLE_CALLBACK = process.env.GOOGLE_CALLBACK;

function makeJWT(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}
console.log("CALLBACK QUE SE ENVÍA:", GOOGLE_CALLBACK);
async function upsertSocialUser({ email, fullName, avatarUrl, provider }) {
  if (!email) throw new Error(`${provider} no proporcionó un email.`);

  let { data: user, error: selectErr } = await supabase
    .from('users')
    .select('id, username, full_name, email, role, avatar_url, is_member, created_at')
    .eq('email', email.toLowerCase().trim())
    .maybeSingle();

  if (selectErr) throw new Error('Error consultando la base de datos: ' + selectErr.message);

  if (user) {
    if (avatarUrl && !user.avatar_url) {
      await supabase.from('users').update({ avatar_url: avatarUrl }).eq('id', user.id);
      user.avatar_url = avatarUrl;
    }
    console.log(`[${provider}]  Usuario existente: ${user.email}`);
    return user;
  }

  const baseUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 16);
  const suffix = Date.now().toString(36).slice(-4);
  const username = `${baseUsername}_${suffix}`;
  const dummyHash = await bcrypt.hash(Math.random().toString(36) + Date.now(), 8);

  const { data: newUser, error: insertErr } = await supabase
    .from('users')
    .insert({
      username,
      full_name: fullName || username,
      email: email.toLowerCase().trim(),
      password_hash: dummyHash,
      role: 'user',
      is_member: false,
      avatar_url: avatarUrl || null,
    })
    .select('id, username, full_name, email, role, avatar_url, is_member, created_at')
    .single();

  if (insertErr) {
    if (insertErr.message.includes('duplicate') || insertErr.message.includes('unique')) {
      const { data: retry } = await supabase
        .from('users')
        .select('id, username, full_name, email, role, avatar_url, is_member, created_at')
        .eq('email', email.toLowerCase().trim())
        .maybeSingle();
      if (retry) return retry;
    }
    throw new Error('Error creando usuario: ' + insertErr.message);
  }

  console.log(`[${provider}] Nuevo usuario: ${newUser.email}`);
  return newUser;
}

function popupSuccess(token) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Autenticando...</title>
  <style>
    body { font-family: sans-serif; display:flex; align-items:center; justify-content:center;
           height:100vh; margin:0; background:#f0fdfa; }
    .box { text-align:center; padding:2rem; }
    .icon { font-size:3rem; }
    p { color:#0f766e; margin-top:.5rem; font-size:.9rem; font-weight:600; }
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">✅</div>
    <p>¡Sesión iniciada! Cerrando...</p>
  </div>
  <script>
    (function() {
      var token = ${JSON.stringify(token)};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage({ token: token }, '*');
        }
      } catch(e) {}
      setTimeout(function() { window.close(); }, 800);
    })();
  </script>
</body>
</html>`;
}

function popupError(msg) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Error</title>
</head>
<body>
  <h2 style="color:red;text-align:center;">${msg}</h2>
  <script>
    setTimeout(() => window.close(), 2000);
  </script>
</body>
</html>`;
}

router.get('/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.send(popupError('Google OAuth no configurado'));
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_CALLBACK, 
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// 🔵 CALLBACK GOOGLE
router.get('/google/callback', async (req, res) => {
  const { code } = req.query;

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_CALLBACK, 
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json();

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const profile = await profileRes.json();

    const user = await upsertSocialUser({
      email: profile.email,
      fullName: profile.name,
      avatarUrl: profile.picture,
      provider: 'google',
    });

    const token = makeJWT(user);

   res.redirect(`${FRONTEND_URL}/auth/success?token=${token}`);

  } catch (err) {
  console.error("ERROR GOOGLE:", err);
  res.send(popupError(err.message || 'Error en autenticación'));
}
});

export default router;