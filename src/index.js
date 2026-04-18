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

// En desarrollo, permitir localhost; en producción, solo FRONTEND_URL
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
    
    if (!origin || allowed.includes(origin)) {
      return callback(null, true);
    }
    
    if (isProduction) {
      return callback(new Error('CORS not allowed'));
    }
    
    // En desarrollo, permite cualquier origin
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/auth', oauthRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/donations', donationRoutes);
app.use('/api/paypal', paypalRoutes);
app.use('/api/presence', presenceRoutes);
app.use('/api/ideas', ideasRoutes);

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

app.get('/api/view-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('<p>URL requerida</p>');
  try {
    const response = await fetch(decodeURIComponent(url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const faviconTag = `<link rel="icon" type="image/png" href="https://i.postimg.cc/8zGk67y3/FB-IMG-8408596291127656794.jpg" />`;
    const modifiedHtml = html.includes('<head>')
      ? html.replace(/<link[^>]*rel=["'](?:icon|shortcut icon)["'][^>]*>/gi, '').replace('<head>', `<head>\n  ${faviconTag}`)
      : html;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', '');
    res.send(modifiedHtml);
  } catch (err) {
    res.status(500).send(`<html><body style="font-family:sans-serif;padding:2rem;color:red"><h2>Error al cargar el archivo</h2><p>${err.message}</p></body></html>`);
  }
});

app.get('/api/download-proxy', async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error: 'URL requerida' });
  try {
    const response = await fetch(decodeURIComponent(url));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const safeFilename = encodeURIComponent(filename || 'archivo.html');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'No se pudo descargar el archivo' });
  }
});

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
  proxyReq.on('error', (err) => { if (!res.headersSent) res.status(502).send('Error al cargar video'); });
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