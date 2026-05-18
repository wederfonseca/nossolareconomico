export default async (request, context) => {

  try {

    /* ================= ENV ================= */

    const env =
      context?.env ||
      (typeof Deno !== "undefined" && Deno.env?.toObject?.()) ||
      {};

    const META_PIXEL_ID = env.META_PIXEL_ID;
    const META_ACCESS_TOKEN = env.META_ACCESS_TOKEN;

    const REDIS_URL = env.UPSTASH_REDIS_REST_URL;
    const REDIS_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;

    if (
      !META_PIXEL_ID ||
      !META_ACCESS_TOKEN ||
      !REDIS_URL ||
      !REDIS_TOKEN
    ) {

      console.log('[ERR] → missing env vars');

      return new Response(
        'Server Misconfigured',
        { status: 500 }
      );

    }

    /* ================= METHOD ================= */

    if (request.method !== 'POST') {

      return new Response(
        'Method Not Allowed',
        { status: 405 }
      );

    }

    /* ================= SECURITY ================= */

    if (request.headers.get('x-capi-signature') !== 'v1') {

      return new Response(
        'Forbidden',
        { status: 403 }
      );

    }

    /* ================= BODY ================= */

    const body = await request.json().catch(() => null);

    if (!body || !body.event_id) {

      return new Response(
        'Bad Request',
        { status: 400 }
      );

    }

    const shortEventId = body.event_id.slice(0, 8);

    /* ================= REDIS KEYS ================= */

    const dedupeKey = `nle:event:${body.event_id}`;

    const today = new Date()
      .toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
      .split('/')
      .reverse()
      .join('-');

    const counterKey = `nle:counter:${today}`;

    /* ================= DEDUP (atômico) ================= */

    const dedupeRes = await fetch(

      `${REDIS_URL}/set/${dedupeKey}/1?nx=true&ex=172800`,

      {
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`
        }
      }

    );

    const dedupeJson = await dedupeRes.json();

    if (dedupeJson.result === null) {

      console.log(`[DEDUP] ${shortEventId}`);

      return new Response(

        JSON.stringify({ ok: true, deduped: true }),

        { status: 200 }

      );

    }

    /* ================= COUNTER ================= */

    const pipelineRes = await fetch(

      `${REDIS_URL}/pipeline`,

      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([
          ['incr', counterKey],
          ['expire', counterKey, 604800]
        ])
      }

    );

    const pipelineJson = await pipelineRes.json();
    const dailyCount = pipelineJson[0]?.result || 0;

    /* ================= USER DATA ================= */

    const userData = {

      client_ip_address:
        request.headers.get('x-nf-client-connection-ip') ||
        request.headers.get('x-forwarded-for') ||
        null,

      client_user_agent:
        request.headers.get('user-agent') || null

    };

    if (body.fbp) userData.fbp = body.fbp;
    if (body.fbc) userData.fbc = body.fbc;

    /* ================= META PAYLOAD ================= */

    const capiPayload = {

      data: [
        {
          event_name: 'Lead',
          event_time: Math.floor(Date.now() / 1000),
          event_id: body.event_id,
          event_source_url: body.event_source_url,
          action_source: 'website',
          user_data: userData,
          custom_data: {
            destination: body.custom_data?.destination || null,
            brand: body.custom_data?.brand || null,
            group_name: body.custom_data?.group_name || null
          }
        }
      ]

    };

    /* ================= SEND META ================= */

    const metaRes = await fetch(

      `https://graph.facebook.com/v21.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`,

      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(capiPayload)
      }

    );

    /* ================= LOG ================= */

    console.log(`[${dailyCount}] ${shortEventId} → ${metaRes.status}`);

    /* ================= RESPONSE ================= */

    return new Response(

      JSON.stringify({ ok: true }),

      { status: 200 }

    );

  } catch (err) {

    console.log(`[ERR] → ${err.message}`);

    return new Response(
      'Server Error',
      { status: 500 }
    );

  }

};
