import { Router } from 'express';
import { supabase, supabaseStorage } from '../lib/supabase.js';
import { optionalAuth } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

function getPayPalBase() {
  const env = process.env.PAYPAL_ENV || 'sandbox';
  return env === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

async function getPayPalToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret   = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET no configurados');

  const res = await fetch(`${getPayPalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });

  const data = await res.json();
  if (!res.ok) throw new Error('No se pudo obtener token PayPal: ' + JSON.stringify(data));
  return data.access_token;
}

// ── GET /api/paypal/client-token ───────────────────────────────────────────
router.get('/client-token', async (req, res) => {
  try {
    const token = await getPayPalToken();
    const resp = await fetch(`${getPayPalBase()}/v1/identity/generate-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(JSON.stringify(data));
    res.json({ clientToken: data.client_token, clientId: process.env.PAYPAL_CLIENT_ID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/paypal/create-order ──────────────────────────────────────────
router.post('/create-order', optionalAuth, async (req, res) => {
  try {
    const { amount, currency = 'USD', templateId, type = 'purchase' } = req.body;
    if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Monto inválido' });

    const token = await getPayPalToken();
    const orderRes = await fetch(`${getPayPalBase()}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: currency, value: parseFloat(amount).toFixed(2) },
          description: type === 'donation' ? 'Donación CodeNinja5' : 'Compra plantilla CodeNinja5',
          custom_id: templateId || 'donation',
        }],
        application_context: {
          brand_name: 'CodeNinja5',
          landing_page: 'BILLING',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
        },
      }),
    });

    const order = await orderRes.json();
    if (!orderRes.ok) throw new Error(JSON.stringify(order));

    try {
      await supabase.from('paypal_orders').insert({
        order_id: order.id,
        template_id: templateId || null,
        user_id: req.user?.id || null,
        amount: parseFloat(amount),
        currency,
        type,
        status: 'CREATED',
      });
    } catch (e) { console.warn('No se pudo guardar orden:', e.message); }

    res.json({ orderId: order.id });
  } catch (err) {
    console.error('Create order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/paypal/capture-order ─────────────────────────────────────────
router.post('/capture-order', optionalAuth, async (req, res) => {
  try {
    const { orderId, templateId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId requerido' });

    const token = await getPayPalToken();
    const captureRes = await fetch(`${getPayPalBase()}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    const capture = await captureRes.json();
    if (!captureRes.ok) throw new Error(JSON.stringify(capture));
    if (capture.status !== 'COMPLETED') throw new Error(`Pago no completado: ${capture.status}`);

    const captureId = capture.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    const amount    = capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;
    const currency  = capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.currency_code;

    // Actualizar orden en DB
    try {
      await supabase.from('paypal_orders').update({ status: 'COMPLETED', capture_id: captureId }).eq('order_id', orderId);
    } catch (e) { console.warn('No se pudo actualizar orden:', e.message); }

    let downloadToken      = null;
    let remainingDownloads = 2;
    let downloadUrl        = null;

    if (templateId) {
      // Registrar compra
      try {
        await supabase.from('purchases').insert({
          user_id: req.user?.id || null,
          template_id: templateId,
          amount: parseFloat(amount),
          method: 'paypal',
          status: 'confirmed',
          paypal_order_id: orderId,
          paypal_capture_id: captureId,
        });
      } catch (e) { console.warn('No se pudo registrar compra:', e.message); }

      // ✅ Crear acceso de descarga (2 usos)
      try {
        if (req.user?.id) {
          // Usuario logueado — verificar si ya tiene acceso
          const { data: existing } = await supabase
            .from('download_access')
            .select('id, remaining_downloads')
            .eq('user_id', req.user.id)
            .eq('template_id', templateId)
            .maybeSingle();

          if (existing) {
            remainingDownloads = (existing.remaining_downloads || 0) + 2;
            await supabase.from('download_access')
              .update({ remaining_downloads: remainingDownloads, updated_at: new Date().toISOString() })
              .eq('id', existing.id);
          } else {
            remainingDownloads = 2;
            await supabase.from('download_access').insert({
              user_id: req.user.id,
              template_id: templateId,
              remaining_downloads: remainingDownloads,
            });
          }
        } else {
          // Usuario anónimo — usar token
          downloadToken = uuidv4();
          remainingDownloads = 2;
          await supabase.from('download_access').insert({
            token: downloadToken,
            template_id: templateId,
            remaining_downloads: remainingDownloads,
          });
        }
      } catch (e) {
        console.warn('No se pudo crear acceso de descarga:', e.message);
      }

      // ✅ Obtener URL de descarga de la plantilla
      const { data: template } = await supabase
        .from('templates')
        .select('id, title, file_path, file_url')
        .eq('id', templateId)
        .maybeSingle();

      if (template) {
        // Primero intentar file_url directo
        if (template.file_url) {
          downloadUrl = template.file_url;
        }

        // Si tiene file_path en storage, generar URL pública
        if (template.file_path) {
          try {
            const { data: pub } = supabaseStorage.storage.from('templates').getPublicUrl(template.file_path);
            if (pub?.publicUrl && !pub.publicUrl.includes('undefined') && !pub.publicUrl.includes('null')) {
              downloadUrl = pub.publicUrl;
            }
          } catch (e) { console.warn('Error obteniendo URL pública:', e.message); }

          // Fallback: URL firmada
          if (!downloadUrl) {
            try {
              const { data: signed } = await supabaseStorage.storage.from('templates').createSignedUrl(template.file_path, 7200);
              if (signed?.signedUrl) downloadUrl = signed.signedUrl;
            } catch (e) { console.warn('Error obteniendo URL firmada:', e.message); }
          }
        }

        // Incrementar contador de descargas
        try { await supabase.rpc('increment_downloads', { template_id: template.id }); } catch {}

        console.log('✅ Captura exitosa. downloadUrl:', downloadUrl ? 'OK' : 'NO ENCONTRADA');

        return res.json({
          success: true,
          captureId,
          amount,
          currency,
          downloadUrl,
          title: template.title,
          downloadToken,
          remainingDownloads,
        });
      }
    }

    // Donación (sin templateId)
    try {
      await supabase.from('donations').insert({
        user_id: req.user?.id || null,
        amount: parseFloat(amount),
        method: 'paypal',
        status: 'completed',
        paypal_order_id: orderId,
        paypal_capture_id: captureId,
      });
    } catch (e) { console.warn('No se pudo registrar donación:', e.message); }

    res.json({ success: true, captureId, amount, currency, downloadToken, remainingDownloads });

  } catch (err) {
    console.error('Capture order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;