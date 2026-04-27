import { Router } from 'express';
import multer from 'multer';
import { supabase, supabaseStorage } from '../lib/supabase.js';
import { authenticate } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// Límite 150MB para video
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 150 * 1024 * 1024 },
});

async function uploadToStorage(bucket, filename, buffer, mimetype) {
  const { error } = await supabaseStorage.storage
    .from(bucket)
    .upload(filename, buffer, { contentType: mimetype, upsert: true });

  if (error) {
    if (error.message?.toLowerCase().includes('bucket') || error.statusCode === 404) {
      console.log(`⚠️  Creando bucket '${bucket}'...`);
      try { await supabaseStorage.storage.createBucket(bucket, { public: true }); } catch {}
      const { error: re } = await supabaseStorage.storage
        .from(bucket)
        .upload(filename, buffer, { contentType: mimetype, upsert: true });
      if (re) {
        console.error('Reintento fallido:', re.message);
        return null;
      }
    } else {
      console.error(`Storage error [${bucket}]:`, error.message);
      return null;
    }
  }

  const { data: pub } = supabaseStorage.storage.from(bucket).getPublicUrl(filename);
  if (pub?.publicUrl && !pub.publicUrl.includes('undefined')) return pub.publicUrl;

  const { data: signed } = await supabaseStorage.storage
    .from(bucket)
    .createSignedUrl(filename, 31536000);

  return signed?.signedUrl || null;
}

function parseFeatures(features, fallback = []) {
  if (features === undefined || features === null) return fallback;
  try {
    return Array.isArray(features) ? features : JSON.parse(features);
  } catch {
    return String(features)
      .split('\n')
      .map(f => f.trim())
      .filter(Boolean);
  }
}

// ─────────────────────────────────────────────
// CREAR PLANTILLA
// ─────────────────────────────────────────────
router.post('/template', authenticate, upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'file',  maxCount: 1 },
  { name: 'video', maxCount: 1 },
]), async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const {
      title, description, category, type, price, features,
      fileUrl, imageUrl: imageUrlParam, videoUrl: videoUrlParam
    } = req.body;

    if (!title?.trim())       return res.status(400).json({ error: 'El título es requerido' });
    if (!description?.trim()) return res.status(400).json({ error: 'La descripción es requerida' });
    if (!req.files?.file?.[0] && !fileUrl?.trim())
      return res.status(400).json({ error: 'Debes subir un archivo HTML' });

    // Usuarios normales SIEMPRE gratis, precio ignorado
    const templateType = (isAdmin && type === 'vip') ? 'vip' : 'gratis';
    const templatePrice = (isAdmin && templateType === 'vip' && price) ? parseFloat(price) : null;

    // Video solo permitido para admin
    if (req.files?.video?.[0] && !isAdmin) {
      return res.status(403).json({ error: 'Solo el administrador puede subir videos' });
    }

    const slug = title.trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      + '-' + Date.now().toString(36);

    let imageUrl = imageUrlParam?.trim() || null;
    let filePath = null;
    let filePublicUrl = fileUrl?.trim() || null;
    let videoUrl = null;

    // Subir imagen
    if (req.files?.image?.[0]) {
      const f = req.files.image[0];
      const ext = f.originalname.split('.').pop()?.toLowerCase() || 'jpg';
      const url = await uploadToStorage('previews', `${uuidv4()}.${ext}`, f.buffer, f.mimetype);
      if (url) imageUrl = url;
    }

    // Subir HTML
    if (req.files?.file?.[0]) {
      const f = req.files.file[0];
      const ext = f.originalname.split('.').pop()?.toLowerCase() || 'html';
      const filename = `${uuidv4()}.${ext}`;
      const url = await uploadToStorage('templates', filename, f.buffer, f.mimetype || 'text/html');
      if (url) {
        filePath = filename;
        filePublicUrl = url;
      } else {
        return res.status(500).json({
          error: 'No se pudo subir el archivo HTML. En Supabase: Storage → Buckets → crear "templates" y "previews" como públicos.'
        });
      }
    }

    // Subir video (solo admin)
    if (isAdmin && req.files?.video?.[0]) {
      const f = req.files.video[0];
      const origExt = f.originalname.split('.').pop()?.toLowerCase() || 'mp4';
      const ext = ['mp4', 'webm', 'ogg', 'mov', 'quicktime'].includes(origExt) ? origExt : 'mp4';
      const mimeMap = { mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', mov: 'video/mp4', quicktime: 'video/mp4' };
      const forcedMime = mimeMap[ext] || 'video/mp4';
      const filename = `${uuidv4()}.mp4`;
      const url = await uploadToStorage('videos', filename, f.buffer, forcedMime);
      if (url) videoUrl = url;
    }

    // Si no subieron archivo de video pero enviaron URL
    if (!videoUrl && isAdmin && videoUrlParam && String(videoUrlParam).trim()) {
      videoUrl = String(videoUrlParam).trim();
    }

    const parsedFeatures = parseFeatures(features, []);

    const { data: template, error: dbError } = await supabase
      .from('templates')
      .insert({
        title: title.trim(),
        slug,
        description: description.trim(),
        category: category || 'otro',
        type: templateType,
        price: templatePrice,
        features: parsedFeatures,
        image_url: imageUrl,
        file_path: filePath,
        file_url: filePublicUrl,
        video_url: videoUrl,
        user_id: req.user?.id || null,
        published: true,
        views: 0,
        downloads: 0,
        likes: 0,
      })
      .select()
      .single();

    if (dbError) {
      console.error('DB error:', dbError.message);

      if (dbError.message.includes('column "video_url" of relation "templates" does not exist')) {
        const { data: t2, error: e2 } = await supabase
          .from('templates')
          .insert({
            title: title.trim(),
            slug,
            description: description.trim(),
            category: category || 'otro',
            type: templateType,
            price: templatePrice,
            features: parsedFeatures,
            image_url: imageUrl,
            file_path: filePath,
            file_url: filePublicUrl,
            user_id: req.user?.id || null,
            published: true,
            views: 0,
            downloads: 0,
            likes: 0,
          })
          .select()
          .single();

        if (e2) return res.status(500).json({ error: 'Error en base de datos: ' + e2.message });
        return res.status(201).json({ template: t2, message: '¡Plantilla publicada!' });
      }

      if (dbError.message.includes('does not exist'))
        return res.status(500).json({ error: 'Tablas no creadas. Ejecuta EJECUTAR-EN-SUPABASE.sql en Supabase.' });
      if (dbError.message.includes('row-level security'))
        return res.status(500).json({ error: 'Error RLS. Ejecuta el SQL de permisos en Supabase.' });
      if (dbError.message.includes('duplicate') || dbError.message.includes('unique'))
        return res.status(400).json({ error: 'Ya existe una plantilla con ese nombre. Cambia el título.' });

      return res.status(500).json({ error: 'Error en base de datos: ' + dbError.message });
    }

    return res.status(201).json({ template, message: '¡Plantilla publicada!' });
  } catch (err) {
    console.error('Upload error:', err.message);
    return res.status(500).json({ error: err.message || 'Error interno al subir' });
  }
});

// ─────────────────────────────────────────────
// ACTUALIZAR PLANTILLA (REEMPLAZAR HTML DESDE PC)
// ─────────────────────────────────────────────
router.put('/template/:id', authenticate, upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'file',  maxCount: 1 }, // <- HTML nuevo desde PC
  { name: 'video', maxCount: 1 },
]), async (req, res) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const { id } = req.params;

    const {
      title, description, category, type, price, features,
      fileUrl, imageUrl: imageUrlParam, videoUrl: videoUrlParam
    } = req.body;

    // Buscar plantilla actual
    const { data: current, error: findError } = await supabase
      .from('templates')
      .select('*')
      .eq('id', id)
      .single();

    if (findError || !current) {
      return res.status(404).json({ error: 'Plantilla no encontrada' });
    }

    // Permisos: admin o dueño
    const isOwner = current.user_id && req.user?.id && current.user_id === req.user.id;
    if (!isAdmin && !isOwner) {
      return res.status(403).json({ error: 'No tienes permisos para editar esta plantilla' });
    }

    // Mantener valores actuales por defecto
    let imageUrl = imageUrlParam?.trim() || current.image_url || null;
    let filePath = current.file_path || null;
    let filePublicUrl = fileUrl?.trim() || current.file_url || null;
    let videoUrl = current.video_url || null;

    // Imagen nueva desde PC
    if (req.files?.image?.[0]) {
      const f = req.files.image[0];
      const ext = f.originalname.split('.').pop()?.toLowerCase() || 'jpg';
      const url = await uploadToStorage('previews', `${uuidv4()}.${ext}`, f.buffer, f.mimetype);
      if (url) imageUrl = url;
    }

    // HTML nuevo desde PC ✅
    if (req.files?.file?.[0]) {
      const f = req.files.file[0];
      const ext = f.originalname.split('.').pop()?.toLowerCase() || 'html';
      const filename = `${uuidv4()}.${ext}`;
      const url = await uploadToStorage('templates', filename, f.buffer, f.mimetype || 'text/html');

      if (!url) {
        return res.status(500).json({ error: 'No se pudo subir el nuevo archivo HTML.' });
      }

      filePath = filename;
      filePublicUrl = url;
    }

    // Video: solo admin
    if (req.files?.video?.[0] && !isAdmin) {
      return res.status(403).json({ error: 'Solo el administrador puede subir videos' });
    }

    if (isAdmin && req.files?.video?.[0]) {
      const f = req.files.video[0];
      const origExt = f.originalname.split('.').pop()?.toLowerCase() || 'mp4';
      const ext = ['mp4', 'webm', 'ogg', 'mov', 'quicktime'].includes(origExt) ? origExt : 'mp4';
      const mimeMap = { mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', mov: 'video/mp4', quicktime: 'video/mp4' };
      const forcedMime = mimeMap[ext] || 'video/mp4';
      const filename = `${uuidv4()}.mp4`;
      const url = await uploadToStorage('videos', filename, f.buffer, forcedMime);
      if (url) videoUrl = url;
    } else if (isAdmin && videoUrlParam && String(videoUrlParam).trim()) {
      videoUrl = String(videoUrlParam).trim();
    }

    const parsedFeatures = parseFeatures(features, current.features || []);

    // Regla tipo/precio
    const templateType = isAdmin
      ? ((type === 'vip' || type === 'gratis') ? type : (current.type || 'gratis'))
      : (current.type || 'gratis');

    const templatePrice = (isAdmin && templateType === 'vip' && price)
      ? parseFloat(price)
      : (templateType === 'vip' ? (current.price ?? null) : null);

    const payload = {
      title: title?.trim() || current.title,
      description: description?.trim() || current.description,
      category: category || current.category || 'otro',
      type: templateType,
      price: templatePrice,
      features: parsedFeatures,
      image_url: imageUrl,
      file_path: filePath,
      file_url: filePublicUrl,
      video_url: videoUrl,
    };

    const { data: updated, error: updError } = await supabase
      .from('templates')
      .update(payload)
      .eq('id', id)
      .select()
      .single();

    if (updError) {
      console.error('Update DB error:', updError.message);

      if (updError.message.includes('column "video_url" of relation "templates" does not exist')) {
        const { video_url, ...withoutVideo } = payload;
        const { data: t2, error: e2 } = await supabase
          .from('templates')
          .update(withoutVideo)
          .eq('id', id)
          .select()
          .single();

        if (e2) return res.status(500).json({ error: 'Error al actualizar: ' + e2.message });
        return res.status(200).json({ template: t2, message: 'Plantilla actualizada correctamente' });
      }

      if (updError.message.includes('row-level security'))
        return res.status(500).json({ error: 'Error RLS. Ejecuta el SQL de permisos en Supabase.' });

      return res.status(500).json({ error: 'Error al actualizar: ' + updError.message });
    }

    return res.status(200).json({
      template: updated,
      message: 'Plantilla actualizada correctamente',
    });
  } catch (err) {
    console.error('Update template error:', err.message);
    return res.status(500).json({ error: err.message || 'Error interno al actualizar' });
  }
});

export default router;