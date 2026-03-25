import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('\n❌ ERROR: Faltan variables en backend/.env');
  console.error('   SUPABASE_URL=https://TU-PROYECTO.supabase.co');
  console.error('   SUPABASE_SERVICE_KEY=eyJhbGci... (service_role key)\n');
  process.exit(1);
}

// Safety check: ensure the configured key is the service_role key (starts with eyJ...),
// not the public anon key that starts with sb_. Using the public key will cause RLS errors.
if (supabaseServiceKey && String(supabaseServiceKey).startsWith('sb_')) {
  console.error('\n❌ ERROR: SUPABASE_SERVICE_KEY parece ser la key pública (prefijo "sb_").');
  console.error('   Debes usar la Service Role Key (empieza por "eyJ...") en backend/.env');
  console.error('   Ve a Supabase Dashboard → Settings → API → Service Role Key y pégala en backend/.env');
  process.exit(1);
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  db: { schema: 'public' },
});

export async function ensureBuckets() {
  const bucketConfig = {
    previews:  { public: true, fileSizeLimit: 10  * 1024 * 1024 },
    templates: { public: true, fileSizeLimit: 50  * 1024 * 1024 },
    videos:    { public: true, fileSizeLimit: 150 * 1024 * 1024 }, // sin restricción de mime
  };

  const { data: existing } = await supabase.storage.listBuckets();
  const existingNames = (existing || []).map(b => b.name);

  for (const [name, config] of Object.entries(bucketConfig)) {
    try {
      if (!existingNames.includes(name)) {
        await supabase.storage.createBucket(name, config);
        console.log(`✅ Bucket '${name}' creado`);
      } else {
        // Actualizar config por si tiene restricciones de mime que bloqueen
        await supabase.storage.updateBucket(name, config);
        console.log(`✅ Bucket '${name}' OK`);
      }
    } catch (e) {
      console.warn(`⚠️  Bucket '${name}': ${e.message}`);
    }
  }
}

export async function verifyTables() {
  const { error } = await supabase.from('templates').select('id').limit(1);
  if (error?.message?.includes('does not exist')) {
    console.error('❌ TABLAS NO CREADAS — Ejecuta EJECUTAR-EN-SUPABASE.sql en Supabase → SQL Editor');
  } else if (!error) {
    console.log('✅ Tablas de base de datos OK');
  }
}

console.log('✅ Supabase conectado:', supabaseUrl);
