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

// ── TOKEN ─────────────────────────────
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

    if (!amount) {
      return res.status(400).json({ error: 'Monto inválido' });
    }

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

    // Guardar orden
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

// ── CAPTURE ORDER (VALIDACIÓN ANTES DE COBRAR) ─────────────────────────────
router.post('/capture-order', optionalAuth, async (req, res) => {
  try {
    const { orderId, templateId } = req.body;

    if (!orderId || !templateId) {
      return res.status(400).json({ error: 'orderId y templateId requeridos' });
    }

    // ─────────────────────────────────────────
    // 🔒 VALIDACIÓN ANTES DE COBRAR
    // ─────────────────────────────────────────

    const { data: template, error } = await supabase
      .from('templates')
      .select('id, title, file_path, file_url')
      .eq('id', templateId)
      .single();

    if (error || !template) {
      return res.status(400).json({ error: 'Plantilla no existe' });
    }

    let downloadUrl = null;

    // ✔ URL directa
    if (template.file_url) {
      downloadUrl = template.file_url;
    }

    // ✔ Verificar archivo en storage
    if (!downloadUrl && template.file_path) {
      const filePath = `templates/${template.file_path}`;

      console.log('📂 Verificando archivo:', filePath);

      const { data: signed } = await supabaseStorage
        .from('templates')
        .createSignedUrl(filePath, 60);

      if (signed?.signedUrl) {
        downloadUrl = signed.signedUrl;
      }
    }

    if (!downloadUrl) {
      return res.status(400).json({
        error: 'Archivo no disponible, no se puede procesar el pago',
      });
    }

    console.log('✅ Validación OK → se puede cobrar');

    // ─────────────────────────────────────────
    // 💰 AHORA SÍ COBRAR
    // ─────────────────────────────────────────

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
      throw new Error('Pago no completado');
    }

    const captureId =
      capture.purchase_units?.[0]?.payments?.captures?.[0]?.id;

    const amount =
      capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;

    const currency =
      capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.currency_code;

    // Guardar pago
    await supabase
      .from('paypal_orders')
      .update({
        status: 'COMPLETED',
        capture_id: captureId,
      })
      .eq('order_id', orderId);

    // Crear acceso descarga
    const downloadToken = uuidv4();

    await supabase.from('download_access').insert({
      token: downloadToken,
      template_id: templateId,
      remaining_downloads: 2,
    });

    // RESPUESTA FINAL
    res.json({
      success: true,
      captureId,
      amount,
      currency,
      downloadUrl,
      title: template.title,
      downloadToken,
    });

  } catch (err) {
    console.error('❌ capture-order:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;