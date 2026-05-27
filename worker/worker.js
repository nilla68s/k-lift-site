// worker.js — Cloudflare Worker para Conversions API do Facebook
// Recebe webhook nativo do Kiwify e dispara evento equivalente no Facebook CAPI
// Versão 2026-05-26: suporte Kiwify nativo + Purchase/InitiateCheckout + dedup

const FACEBOOK_PIXEL_ID = '968856079448203';

// ─── Mapeamento de eventos Kiwify → Facebook ───
const KIWIFY_TO_FB_EVENT = {
  order_approved: 'Purchase',
  pix_created: 'InitiateCheckout',
  billet_created: 'InitiateCheckout',
  boleto_gerado: 'InitiateCheckout',
  pix_gerado: 'InitiateCheckout',
  compra_aprovada: 'Purchase',
};

async function hashSHA256(str) {
  if (!str) return undefined;
  const encoder = new TextEncoder();
  const data = encoder.encode(String(str).trim().toLowerCase());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Normaliza payload do Kiwify pra um formato interno ───
function normalizeKiwifyPayload(body) {
  // Kiwify nativo tem Customer, Commissions, TrackingParameters
  const isKiwifyNative = !!(body.Customer || body.Commissions || body.webhook_event_type);

  if (!isKiwifyNative) {
    // Formato simples (legado) — usa como veio
    return body;
  }

  const customer = body.Customer || {};
  const product = body.Product || {};
  const commissions = body.Commissions || {};
  const tracking = body.TrackingParameters || {};

  // Estratégia: passamos via LP os params na URL → Kiwify captura como UTMs
  // utm_term  = event_id (pra dedup com pixel browser)
  // utm_content = "fbp|fbc" (concatenado)
  // src = event_id (fallback alternativo)
  const eventId = tracking.utm_term || tracking.src || null;
  let fbp, fbc;
  if (tracking.utm_content && tracking.utm_content.includes('|')) {
    const parts = tracking.utm_content.split('|');
    fbp = parts[0] || undefined;
    fbc = parts[1] || undefined;
  }

  return {
    _kiwify_native: true,
    webhook_event_type: body.webhook_event_type,
    order_status: body.order_status,
    transaction_id: body.order_id || body.order_ref,
    email: customer.email,
    phone: customer.mobile,
    name: customer.full_name,
    first_name: customer.first_name,
    cpf: customer.CPF,
    customer_ip: customer.ip,
    value: commissions.charge_amount || commissions.product_base_price,
    currency: commissions.currency || 'BRL',
    product_id: product.product_id,
    product_name: product.product_name,
    event_time: body.approved_date || body.created_at,
    event_id: eventId ? `kiwify_${eventId}` : `kiwify_${body.order_id || Date.now()}`,
    fbp,
    fbc,
    utm_source: tracking.utm_source,
    utm_medium: tracking.utm_medium,
    utm_campaign: tracking.utm_campaign,
  };
}

async function sendConversionToFacebook(eventData, env) {
  const accessToken = env.FACEBOOK_ACCESS_TOKEN;
  const pixelId = FACEBOOK_PIXEL_ID;

  // Decide nome do evento Facebook
  const fbEventName =
    KIWIFY_TO_FB_EVENT[eventData.webhook_event_type] ||
    KIWIFY_TO_FB_EVENT[eventData.order_status] ||
    eventData.event_name ||
    'Purchase';

  // Hash dados pessoais
  const [emailHash, phoneHash, fnHash, lnHash, externalIdHash] = await Promise.all([
    eventData.email ? hashSHA256(eventData.email) : undefined,
    eventData.phone ? hashSHA256(String(eventData.phone).replace(/\D/g, '')) : undefined,
    eventData.first_name
      ? hashSHA256(eventData.first_name)
      : eventData.name
      ? hashSHA256(eventData.name.split(/\s+/)[0])
      : undefined,
    eventData.name && eventData.name.split(/\s+/).length > 1
      ? hashSHA256(eventData.name.split(/\s+/).slice(-1)[0])
      : undefined,
    eventData.cpf
      ? hashSHA256(eventData.cpf.replace(/\D/g, ''))
      : eventData.external_id
      ? hashSHA256(String(eventData.external_id))
      : undefined,
  ]);

  const userData = {
    em: emailHash ? [emailHash] : undefined,
    ph: phoneHash ? [phoneHash] : undefined,
    fn: fnHash ? [fnHash] : undefined,
    ln: lnHash ? [lnHash] : undefined,
    external_id: externalIdHash ? [externalIdHash] : undefined,
    client_ip_address: eventData.customer_ip || eventData.ip,
    client_user_agent: eventData.user_agent,
    fbp: eventData.fbp || undefined,
    fbc: eventData.fbc || undefined,
    country: eventData.country ? [await hashSHA256(eventData.country)] : undefined,
  };
  Object.keys(userData).forEach(k => userData[k] === undefined && delete userData[k]);

  const eventTime = eventData.event_time
    ? Math.floor(new Date(eventData.event_time).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const payload = {
    data: [
      {
        event_name: fbEventName,
        event_time: eventTime,
        event_id: eventData.event_id || `klift_${Date.now()}`,
        action_source: 'website',
        event_source_url: eventData.event_source_url || 'https://k-lift.pages.dev/',
        user_data: userData,
        custom_data: {
          value: parseFloat(eventData.value || 27.90).toFixed(2),
          currency: eventData.currency || 'BRL',
          content_name: eventData.product_name || 'K-LIFT Metodo Coreano 21 Dias',
          content_type: 'product',
          content_ids: [eventData.product_id || 'k-lift-21d'],
          order_id: eventData.transaction_id || undefined,
        },
      },
    ],
  };

  const url = `https://graph.facebook.com/v18.0/${pixelId}/events?access_token=${accessToken}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  return {
    status: response.status,
    fb_event_name: fbEventName,
    facebook_response: result,
    sent_payload: payload,
  };
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({ ok: true, message: 'K-LIFT Conversions Worker ativo' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid JSON body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    try {
      // Normaliza payload (detecta Kiwify nativo automaticamente)
      const eventData = {
        ...normalizeKiwifyPayload(body),
        ip: request.headers.get('cf-connecting-ip'),
        user_agent: request.headers.get('user-agent'),
        country: request.headers.get('cf-ipcountry'),
      };

      // Se nao tem email, retorna 200 mas nao envia pro FB (evita poluir)
      if (!eventData.email) {
        return new Response(
          JSON.stringify({
            success: true,
            sent_to_facebook: false,
            reason: 'No email in payload (test webhook?)',
            received: body,
            normalized: eventData,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const fbResult = await sendConversionToFacebook(eventData, env);

      console.log('[K-LIFT CAPI]', JSON.stringify({
        kiwify_event: eventData.webhook_event_type,
        fb_event: fbResult.fb_event_name,
        order_id: eventData.transaction_id,
        fb_status: fbResult.status,
        fb_response: fbResult.facebook_response,
      }));

      return new Response(
        JSON.stringify({
          success: true,
          sent_to_facebook: true,
          fb_event_name: fbResult.fb_event_name,
          order_id: eventData.transaction_id,
          facebook_response: fbResult.facebook_response,
          dedup_event_id: eventData.event_id,
          had_fbp: !!eventData.fbp,
          had_fbc: !!eventData.fbc,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } catch (error) {
      console.error('[K-LIFT CAPI] ERROR:', error.message, error.stack);
      return new Response(
        JSON.stringify({
          success: false,
          error: error.message,
          received: body,
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  },
};
