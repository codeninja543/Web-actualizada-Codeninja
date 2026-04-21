import { Router } from 'express';
import { supabase, supabaseStorage } from '../lib/supabase.js';
import { optionalAuth } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

// ── Helpers PayPal ──────────────────────────────────────────────────────────
function getPayPalBase() {
  const env = process.env.PAYPAL_ENV || 'sandbox';

  const base =
    env === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';

  console.log('🌐 PayPal ENV:', env);
  console.log('🌐 PayPal BASE:', base);

  return base;
}

async function getPayPalToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !secret) {
    throw new Error('❌ PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET no configurados');
  }

  try {
    const res = await fetch(`${getPayPalBase()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(
          `${clientId}:${secret}`
        ).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('❌ PayPal Token Error:', data);
      throw new Error(
        'No se pudo obtener token PayPal: ' + JSON.stringify(data)
      );
    }

    return data.access_token;
  } catch (error) {
    console.error('❌ Error obteniendo token:', error.message);
    throw error;
  }
}

// ── CLIENT TOKEN ───────────────────────────────────────────────────────────
router.get('/client-token', async (req, res) => {
  try {
    const token = await getPayPalToken();

    const resp = await fetch(
      `${getPayPalBase()}/v1/identity/generate-token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(JSON.stringify(data));
    }

    res.json({
      clientToken: data.client_token,
      clientId: process.env.PAYPAL_CLIENT_ID,
    });
  } catch (err) {
    console.error('❌ client-token error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CREATE ORDER ───────────────────────────────────────────────────────────
router.post('/create-order', optionalAuth, async (req, res) => {
  try {
    const { amount, currency = 'USD', templateId, type = 'purchase' } =
      req.body;

    if (!amount || isNaN(parseFloat(amount))) {
      return res.status(400).json({ error: 'Monto inválido' });
    }

    const token = await getPayPalToken();

    const orderRes = await fetch(
      `${getPayPalBase()}/v2/checkout/orders`,
      {
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
              description:
                type === 'donation'
                  ? 'Donación CodeNinja5'
                  : 'Compra plantilla CodeNinja5',
              custom_id: templateId || 'donation',
            },
          ],
        }),
      }
    );

    const order = await orderRes.json();

    if (!orderRes.ok) {
      console.error('❌ Error creando orden:', order);
      throw new Error(JSON.stringify(order));
    }

    await supabase.from('paypal_orders').insert({
      order_id: order.id,
      template_id: templateId || null,
      user_id: req.user?.id || null,
      amount: parseFloat(amount),
      currency,
      type,
      status: 'CREATED',
    });

    res.json({ orderId: order.id });
  } catch (err) {
    console.error('❌ Create order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CAPTURE ORDER ──────────────────────────────────────────────────────────
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

    if (!captureRes.ok) {
      console.error('❌ Capture error:', capture);
      throw new Error(JSON.stringify(capture));
    }

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

    // Guardar estado
    await supabase
      .from('paypal_orders')
      .update({
        status: 'COMPLETED',
        capture_id: captureId,
      })
      .eq('order_id', orderId);

    return res.json({
      success: true,
      captureId,
      amount,
      currency,
    });
  } catch (err) {
    console.error('❌ Capture order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;