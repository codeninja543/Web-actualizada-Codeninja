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
    console.error('❌ PayPal auth error:', data);
    throw new Error('Error autenticando con PayPal');
  }

  return data.access_token;
}

// ── CREATE ORDER ─────────────────────────────
// El precio se lee de la base de datos, NUNCA del cliente.
router.post('/create-order', optionalAuth, async (req, res) => {
  try {
    const { templateId } = req.body;

    if (!templateId) {
      return res.status(400).json({ error: 'templateId requerido' });
    }

    const { data: template, error: tErr } = await supabase
      .from('templates')
      .select('id, title, price')
      .eq('id', templateId)
      .single();

    if (tErr || !template) {
      return res.status(400).json({ error: 'Plantilla no existe' });
    }

    const price = Number(template.price);

    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'Precio inválido' });
    }

    const currency = 'USD';
    const value = price.toFixed(2);

    const token = await getPayPalToken();

    console.log('🟡 Creando orden PayPal:', {
      templateId: template.id,
      value,
      currency,
      env: process.env.PAYPAL_ENV,
    });

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
              value,
            },
            custom_id: String(template.id),
            description: (template.title || 'Plantilla').slice(0, 127),
          },
        ],
        application_context: {
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          brand_name: 'CodeNinja5',
        },
      }),
    });

    const order = await orderRes.json();

    if (!orderRes.ok) {
      console.error(
        '❌ PayPal CREATE ORDER ERROR:',
        JSON.stringify(
          {
            status: orderRes.status,
            response: order,
            value,
            currency,
            templateId: template.id,
            env: process.env.PAYPAL_ENV,
          },
          null,
          2
        )
      );

      return res.status(orderRes.status).json({
        error: 'PayPal rechazó la creación de la orden',
        paypal: order,
      });
    }

    // Guardar orden
    const { error: insertErr } = await supabase.from('paypal_orders').insert({
      order_id: order.id,
      template_id: template.id,
      user_id: req.user?.id || null,
      amount: price,
      currency,
      status: 'CREATED',
    });

    if (insertErr) {
      console.error('❌ No se pudo guardar la orden:', insertErr.message);
      return res.status(500).json({ error: 'No se pudo registrar la orden' });
    }

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
    // 🔒 La orden debe existir, ser de ESTA plantilla y no estar usada
    // ─────────────────────────────────────────

    const { data: savedOrder, error: orderErr } = await supabase
      .from('paypal_orders')
      .select('order_id, template_id, status')
      .eq('order_id', orderId)
      .single();

    if (orderErr || !savedOrder) {
      return res.status(400).json({ error: 'Orden no encontrada' });
    }

    if (String(savedOrder.template_id) !== String(templateId)) {
      return res.status(400).json({ error: 'La orden no corresponde a esta plantilla' });
    }

    if (savedOrder.status === 'COMPLETED') {
      return res.status(400).json({ error: 'Esta orden ya fue procesada' });
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
        .storage
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

    const captureData = capture.purchase_units?.[0]?.payments?.captures?.[0];
    const captureId = captureData?.id;
    const amount = captureData?.amount?.value;
    const currency = captureData?.amount?.currency_code;

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