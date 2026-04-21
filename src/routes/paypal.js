import { Router } from 'express';
import { supabase, supabaseStorage } from '../lib/supabase.js';
import { optionalAuth } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// ── PAYPAL BASE ─────────────────────────────
function getPayPalBase() {
  const env = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase().trim();

  return env === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

// ── GET TOKEN ─────────────────────────────
async function getPayPalToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !secret) {
    throw new Error('Credenciales PayPal no configuradas');
  }

  const res = await fetch(`${getPayPalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('❌ PayPal error:', data);
    throw new Error('Error autenticando con PayPal');
  }

  return data.access_token;
}

// ── CREATE ORDER ─────────────────────────────
router.post('/create-order', optionalAuth, async (req, res) => {
  try {
    const { amount, currency = 'USD', templateId } = req.body;

    if (!amount) return res.status(400).json({ error: 'Monto inválido' });

    const token = await getPayPalToken();

    const orderRes = await fetch(`${getPayPalBase()}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: currency,
            value: parseFloat(amount).toFixed(2),
          },
          custom_id: templateId || 'donation',
        }],
      }),
    });

    const order = await orderRes.json();

    if (!orderRes.ok) throw new Error(JSON.stringify(order));

    // ✅ GUARDAR ORDEN SIEMPRE
    await supabase.from('paypal_orders').insert({
      order_id: order.id,
      template_id: templateId || null,
      user_id: req.user?.id || null,
      amount: parseFloat(amount),
      currency,
      status: 'CREATED',
    });

    res.json({ orderId: order.id });

  } catch (err) {
    console.error('❌ create-order:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CAPTURE ORDER ─────────────────────────────
router.post('/capture-order', optionalAuth, async (req, res) => {
  try {
    const { orderId, templateId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'orderId requerido' });
    }

    const token = await getPayPalToken();

    const captureRes = await fetch(
      `${getPayPalBase()}/v2/checkout/orders/${orderId}/capture`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const capture = await captureRes.json();

    if (!captureRes.ok) throw new Error(JSON.stringify(capture));
    if (capture.status !== 'COMPLETED') {
      throw new Error(`Pago no completado`);
    }

    const captureId =
      capture.purchase_units?.[0]?.payments?.captures?.[0]?.id;

    const amount =
      capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;

    const currency =
      capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.currency_code;

    // 🔥 ACTUALIZAR PAGO (SIEMPRE)
    await supabase
      .from('paypal_orders')
      .update({
        status: 'COMPLETED',
        capture_id: captureId,
      })
      .eq('order_id', orderId);

    console.log('💰 Pago guardado correctamente');

    // ── DESCARGA (NO CRÍTICO) ─────────────────
    let downloadUrl = null;
    let title = null;

    try {
      const finalTemplateId = templateId;

      if (finalTemplateId) {
        const { data: template } = await supabase
          .from('templates')
          .select('id, title, file_path, file_url')
          .eq('id', finalTemplateId)
          .single();

        if (template) {
          title = template.title;

          // ✔ URL directa
          if (template.file_url) {
            downloadUrl = template.file_url;
          }

          // ✔ Storage
          if (!downloadUrl && template.file_path) {
            const filePath = `templates/${template.file_path}`;

            console.log('📂 PATH:', filePath);

            const { data: signed } = await supabaseStorage
              .from('templates')
              .createSignedUrl(filePath, 3600);

            downloadUrl = signed?.signedUrl;
          }

          // ✔ Crear acceso descarga
          await supabase.from('download_access').insert({
            token: uuidv4(),
            template_id: finalTemplateId,
            remaining_downloads: 2,
          });
        }
      }
    } catch (e) {
      console.warn('⚠️ Error generando descarga:', e.message);
    }

    // ✅ RESPUESTA FINAL (NUNCA FALLA)
    res.json({
      success: true,
      captureId,
      amount,
      currency,
      downloadUrl, // puede ser null, pero no rompe
      title,
    });

  } catch (err) {
    console.error('❌ capture-order:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;