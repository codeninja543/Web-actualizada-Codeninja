import https from 'https';
import http from 'http';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import authRoutes from './routes/auth.js';
import oauthRoutes from './routes/oauth.js';
import templateRoutes from './routes/templates.js';
import uploadRoutes from './routes/upload.js';
import donationRoutes from './routes/donations.js';
import paypalRoutes from './routes/paypal.js';
import presenceRoutes from './routes/presence.js';
import ideasRoutes from './routes/ideas.js';
import { ensureBuckets, verifyTables } from './lib/supabase.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  next();
});

const corsOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(s => s.trim()).filter(Boolean)
  : [];

const isProduction = process.env.NODE_ENV === 'production';

app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      ...corsOrigins,
    ];
    if (!origin || allowed.includes(origin)) return callback(null, true);
    if (isProduction) return callback(new Error('CORS not allowed'));
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

app.use('/api/auth',      authRoutes);
app.use('/api/auth',      oauthRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/upload',    uploadRoutes);
app.use('/api/donations', donationRoutes);
app.use('/api/paypal',    paypalRoutes);
app.use('/api/presence',  presenceRoutes);
app.use('/api/ideas',     ideasRoutes);

const frontendDist = process.env.FRONTEND_DIST
  ? path.resolve(process.env.FRONTEND_DIST)
  : path.resolve(__dirname, '../dist');

if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// ─── VIEW PROXY ───────────────────────────────────────────────────────────────
app.get('/api/view-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('<p>URL requerida</p>');

  try {
    const decodedUrl = decodeURIComponent(url);
    const response = await fetch(decodedUrl, {
      headers: { 'Accept': 'text/html,*/*' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    // Leer como buffer para preservar encoding original
    const rawBuffer = Buffer.from(await response.arrayBuffer());
    let html = rawBuffer.toString('utf-8');

    // Si el HTML está vacío, mostrar error claro
    if (!html || html.trim().length === 0) {
      return res.status(200).send(`
        <html><body style="font-family:sans-serif;padding:2rem;text-align:center">
          <h2 style="color:#ef4444">⚠️ Archivo vacío</h2>
          <p>El archivo HTML no tiene contenido. Intenta subirlo de nuevo.</p>
        </body></html>
      `);
    }

    const baseUrl = decodedUrl.substring(0, decodedUrl.lastIndexOf('/') + 1);

    // Convertir src/href relativos a absolutos
    html = html.replace(
      /(src|href|action)=(["'])(?!https?:\/\/)(?!data:)(?!#)(?!mailto:)([^"']+)\2/gi,
      (match, attr, quote, p) => {
        if (p.startsWith('//')) return `${attr}=${quote}https:${p}${quote}`;
        const absolute = p.startsWith('/') ? new URL(p, decodedUrl).href : baseUrl + p;
        return `${attr}=${quote}${absolute}${quote}`;
      }
    );

    // Convertir url() en CSS a absolutos
    html = html.replace(
      /url\((['"]?)(?!https?:\/\/)(?!data:)([^'")]+)\1\)/gi,
      (match, quote, p) => {
        if (p.startsWith('//')) return `url(${quote}https:${p}${quote})`;
        const absolute = p.startsWith('/') ? new URL(p, decodedUrl).href : baseUrl + p;
        return `url(${quote}${absolute}${quote})`;
      }
    );

    const baseTag    = `<base href="${baseUrl}" target="_blank">`;
    const faviconTag = `<link rel="icon" type="image/png" href="https://i.postimg.cc/8zGk67y3/FB-IMG-8408596291127656794.jpg" />`;

    if (html.includes('<head>')) {
      html = html
        .replace(/<link[^>]*rel=["'](?:icon|shortcut icon)["'][^>]*>/gi, '')
        .replace('<head>', `<head>\n  ${baseTag}\n  ${faviconTag}`);
    } else if (html.match(/<html/i)) {
      html = html.replace(/<html[^>]*>/i, m => `${m}\n<head>${baseTag}${faviconTag}</head>`);
    } else {
      html = `<head>${baseTag}${faviconTag}</head>\n` + html;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', '');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(html);

  } catch (err) {
    res.status(500).send(`
      <html><body style="font-family:sans-serif;padding:2rem;color:red">
        <h2>Error al cargar el archivo</h2><p>${err.message}</p>
      </body></html>
    `);
  }
});

// ─── DOWNLOAD PROXY ───────────────────────────────────────────────────────────
app.get('/api/download-proxy', async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error: 'URL requerida' });
  try {
    const decodedUrl = decodeURIComponent(url);
    const response = await fetch(decodedUrl, {
      headers: { 'Accept': 'text/html,*/*', 'Cache-Control': 'no-cache' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    if (!buffer || buffer.length === 0) {
      return res.status(500).send('<html><body>El archivo está vacío.</body></html>');
    }

    const safeFilename = (filename || 'archivo').toString().replace(/[^a-zA-Z0-9._\- ]/g, '') + '.html';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'No se pudo descargar: ' + err.message });
  }
});

// ─── VIDEO PROXY ──────────────────────────────────────────────────────────────
app.get('/api/video-proxy', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL requerida');
  const decodedUrl = decodeURIComponent(url);
  const range = req.headers['range'];
  const parsedUrl = new URL(decodedUrl);
  const lib = parsedUrl.protocol === 'https:' ? https : http;
  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', ...(range ? { 'Range': range } : {}) },
  };
  const proxyReq = lib.request(options, (proxyRes) => {
    const status = proxyRes.statusCode || 200;
    const headers = {
      'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
      'Accept-Ranges': proxyRes.headers['accept-ranges'] || 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=7200',
    };
    if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length'];
    if (proxyRes.headers['content-range'])  headers['Content-Range']  = proxyRes.headers['content-range'];
    res.writeHead(status, headers);
    proxyRes.pipe(res);
    proxyRes.on('error', () => res.end());
  });
  proxyReq.on('error', () => { if (!res.headersSent) res.status(502).send('Error al cargar video'); });
  req.on('close', () => proxyReq.destroy());
  proxyReq.end();
});

app.get('/api/debug/video/:slug', async (req, res) => {
  const { supabase } = await import('./lib/supabase.js');
  const { data } = await supabase.from('templates').select('id, title, video_url, file_url, file_path').eq('slug', req.params.slug).maybeSingle();
  res.json(data || { error: 'No encontrado' });
});

app.get('/api/health', async (req, res) => {
  const { supabase, supabaseStorage } = await import('./lib/supabase.js');
  const db = await supabase.from('templates').select('id').limit(1);
  const { data: buckets } = await supabaseStorage.storage.listBuckets();
  res.json({
    status: 'ok',
    database: db.error ? '❌ ' + db.error.message : '✅ OK',
    buckets: buckets?.map(b => b.name).join(', ') || '❌ sin buckets',
  });
});

app.use((req, res) => res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` }));
app.use((err, req, res, _next) => res.status(500).json({ error: err.message || 'Error interno' }));

app.listen(PORT, async () => {
  console.log(`\n✅ Backend en http://localhost:${PORT}`);
  await ensureBuckets();
  await verifyTables();
  console.log('✅ Backend listo\n');
});