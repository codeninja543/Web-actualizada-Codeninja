import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_STORAGE_URL;
const key = process.env.SUPABASE_STORAGE_SERVICE_KEY;
console.log('URL:', url ? url : '<missing>');
console.log('Key present:', !!key);

if (!url || !key) process.exit(1);

const c = createClient(url, key);
try {
  const r = await c.storage.listBuckets();
  console.log('listBuckets result:', JSON.stringify(r, null, 2));
} catch (err) {
  console.error('Storage listBuckets error:', err);
}