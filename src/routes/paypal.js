import { Router } from 'express';
import { supabase, supabaseStorage } from '../lib/supabase.js';
import { optionalAuth } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// ── Helpers PayPal ──────────────────────────────────────────
function getPayPalBase() {
  const env = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase().trim();

  return env === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

async function getPayPalToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !secret) {
    throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET no configurados');
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
    console.error('❌ PayPal Token Error:', data);
    throw new Error('No se pudo obtener token PayPal');
  }

  return data.access_token;
}

// ── CLIENT TOKEN ───────────────────────────────────────────
router.get('/client-token', async (req, res) => {
  try {
    const token = await getPayPalToken();

    const resp = await fetch(`${getPayPalBase()}/v1/identity/generate-token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await resp.json();

    if (!resp.ok) throw new Error(JSON.stringify(data));

    res.json({
      clientToken: data.client_token,
      clientId: process.env.PAYPAL_CLIENT_ID,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CREATE ORDER ───────────────────────────────────────────
router.post('/create-order', optionalAuth, async (req, res) => {
  try {
    const { amount, currency = 'USD', templateId, type = 'purchase' } = req.body;

    if (!amount || isNaN(parseFloat(amount))) {
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
        purchase_units: [
          {
            amount: {
              currency_code: currency,
              value: parseFloat(amount).toFixed(2),
            },
            custom_id: templateId || 'donation',
          },
        ],
      }),
    });

    const order = await orderRes.json();

    if (!orderRes.ok) throw new Error(JSON.stringify(order));

    res.json({ orderId: order.id });
  } catch (err) {
    console.error('Create order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CAPTURE ORDER ──────────────────────────────────────────
router.post('/capture-order', optionalAuth, async (req, res) => {
  try {
    const { orderId } = req.body;

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
      throw new Error(`Pago no completado: ${capture.status}`);
    }

    const captureId =
      capture.purchase_units?.[0]?.payments?.captures?.[0]?.id;

    const amount =
      capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value;

    const currency =
      capture.purchase_units?.[0]?.payments?.captures?.[0]?.amount
        ?.currency_code;

    // 🔥 Obtener templateId correctamente desde PayPal
    const templateId =
      capture.purchase_units?.[0]?.custom_id;

    console.log('🧠 TEMPLATE ID:', templateId);

    if (!templateId || templateId === 'donation') {
      return res.json({
        success: true,
        captureId,
        amount,
        currency,
      });
    }

    // 🔍 Buscar plantilla
    const { data: template, error: templateError } = await supabase
      .from('templates')
      .select('id, title, file_path, file_url')
      .eq('id', templateId)
      .single();

    if (templateError || !template) {
      console.error('❌ Template no encontrado:', templateError);
      throw new Error('Plantilla no encontrada');
    }

    console.log('🧠 TEMPLATE:', template);

    let downloadUrl = null;

    // ✔ PRIORIDAD 1: URL directa
    if (template.file_url) {
      downloadUrl = template.file_url;
    }

    // ✔ PRIORIDAD 2: generar URL desde storage
    if (!downloadUrl && template.file_path) {
      try {
        const { data: signed, error } = await supabaseStorage
          .from('templates')
          .createSignedUrl(template.file_path, 3600);

        if (error) {
          console.error('❌ Error signed URL:', error);
        } else {
          downloadUrl = signed?.signedUrl;
        }
      } catch (e) {
        console.error('❌ Error creando URL:', e.message);
      }
    }

    // ❌ VALIDACIÓN FINAL
    if (!downloadUrl) {
      throw new Error('No se obtuvo URL de descarga');
    }

    // Crear token descarga
    const downloadToken = uuidv4();

    await supabase.from('download_access').insert({
      token: downloadToken,
      template_id: templateId,
      remaining_downloads: 2,
    });

    return res.json({
      success: true,
      captureId,
      amount,
      currency,
      downloadUrl,
      title: template.title,
      downloadToken,
    });

  } catch (err) {
    console.error('❌ Capture error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;