import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

// Soporte para proyectos separados: DB vs Storage
const supabaseDbUrl = process.env.SUPABASE_DB_URL || process.env.SUPABASE_URL;
const supabaseDbServiceKey = process.env.SUPABASE_DB_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

const supabaseStorageUrl = process.env.SUPABASE_STORAGE_URL || process.env.SUPABASE_URL;
const supabaseStorageServiceKey = process.env.SUPABASE_STORAGE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY || null;

if (!supabaseDbUrl || !supabaseDbServiceKey) {
  console.error('\n❌ ERROR: Faltan variables en backend/.env para la BD');
  console.error('   SUPABASE_DB_URL=https://TU-PROYECTO-db.supabase.co');
  console.error('   SUPABASE_DB_SERVICE_KEY=sb_secret_... (Secret key)\n');
  process.exit(1);
}

export const supabase = createClient(supabaseDbUrl, supabaseDbServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  db: { schema: 'public' },
});

// Storage client: puede apuntar a otro proyecto
export let supabaseStorage;
if (supabaseStorageUrl && supabaseStorageServiceKey) {
  supabaseStorage = createClient(supabaseStorageUrl, supabaseStorageServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
} else if (supabaseStorageUrl && !supabaseStorageServiceKey) {
  console.warn('⚠️ SUPABASE_STORAGE_SERVICE_KEY no está configurada. Usando cliente DB como fallback para storage.');
  supabaseStorage = supabase; // fallback para evitar crash; configurar la key es lo ideal
} else {
  // Ninguna URL de storage, usar cliente DB
  supabaseStorage = supabase;
}

export async function ensureBuckets() {
  const bucketConfig = {
    previews:  { public: true, fileSizeLimit: 10  * 1024 * 1024 },
    templates: { public: true, fileSizeLimit: 50  * 1024 * 1024 },
    videos:    { public: true, fileSizeLimit: 150 * 1024 * 1024 },
  };

  try {
    const { data: existing } = await supabaseStorage.storage.listBuckets();
    const existingNames = (existing || []).map(b => b.name);

    for (const [name, config] of Object.entries(bucketConfig)) {
      try {
        if (!existingNames.includes(name)) {
          await supabaseStorage.storage.createBucket(name, config);
          console.log(`✅ Bucket '${name}' creado (storage project)`);
        } else {
          await supabaseStorage.storage.updateBucket(name, config);
          console.log(`✅ Bucket '${name}' OK (storage project)`);
        }
      } catch (e) {
        console.warn(`⚠️  Bucket '${name}': ${e.message}`);
      }
    }
  } catch (e) {
    console.warn('⚠️ No se pudo listar/crear buckets en el proyecto de storage:', e.message);
  }
}

export async function verifyTables() {
  const { error } = await supabase.from('templates').select('id').limit(1);
  if (error?.message?.includes('does not exist')) {
    console.error('❌ TABLAS NO CREADAS — Ejecuta SUPABASE.sql en Supabase → SQL Editor');
  } else if (!error) {
    console.log('✅ Tablas de base de datos OK');
  }
}

console.log('✅ Supabase DB conectado:', supabaseDbUrl);
console.log('ℹ️  Supabase Storage apuntando a:', supabaseStorageUrl);