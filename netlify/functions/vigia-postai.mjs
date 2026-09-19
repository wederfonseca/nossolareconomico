/* 2026-09-19 — O VIGIA QUE MORA FORA DA MAQUINA DELE.
 *
 * Ele: "tem como fazer disparar um aviso no telegram quando o computador estiver desligado?".
 *
 * Tem — mas nao de dentro do Postai. Maquina desligada nao manda aviso sobre si mesma, e todo
 * alarme que depende do proprio vigiado tem esse buraco no centro. Entao quem cobra roda AQUI,
 * na nuvem, e olha um carimbo que o Postai renova de 5 em 5 minutos (`g:postai:vivo`, escrito
 * pelo laco do vigia da extensao em `api/routers/grupos.py`). Carimbo velho = a maquina caiu,
 * a internet caiu, ou o app parou — e os tres tem o mesmo primeiro gesto da parte dele.
 *
 * ⚠️ O cron da Netlify e em UTC. `0 * * * *` = de hora em hora, cheia.
 *
 * ⚠️ Trava de 1 h pela mesma chave dos outros avisos (`g:avisado:*`): um PC desligado a noite
 * inteira manda UMA mensagem, nao doze. E o SET com `nx` e atomico, entao duas execucoes
 * simultaneas nao viram duas mensagens.
 *
 * ⚠️ Nao avisa quando o carimbo NUNCA existiu. Chave ausente e o estado de antes da primeira
 * subida do Postai com esta versao — acusar "caiu" ali seria dar susto no dia do deploy, que e
 * exatamente quando ele nao pode duvidar do alarme.
 */

const MINUTOS_ATE_ACUSAR = 30;

async function redis(comando) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(comando)
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j ? j.result : null;
}

async function avisar(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;

  const pode = await redis(['SET', 'g:avisado:postai-caiu', '1', 'NX', 'EX', '3600']);
  if (pode === null) return false;

  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: texto })
  });
  return r.ok;
}

export default async () => {
  const carimbo = await redis(['GET', 'g:postai:vivo']);

  if (!carimbo) {
    /* Nunca existiu, ou expirou faz tempo (o SET tem validade de 2 h). Sem base para comparar,
       fica calado: ver o ultimo ⚠️ do cabecalho. */
    return new Response(JSON.stringify({ ok: true, estado: 'sem-carimbo' }), { status: 200 });
  }

  const idadeMin = (Date.now() - Date.parse(carimbo)) / 60000;

  if (idadeMin > MINUTOS_ATE_ACUSAR) {
    const quando = new Date(carimbo).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    await avisar(
      '🔴 O Postaí não deu sinal\n\n' +
      `Último contato ${quando}\n` +
      'Esperado a cada 5 min\n\n' +
      'PC desligado, sem internet\nou o app parado.\n\n' +
      'Enquanto isso: sem leitura dos\ngrupos e sem o resumo das 07h.'
    );
    return new Response(JSON.stringify({ ok: true, estado: 'caiu', idade_min: idadeMin }),
                        { status: 200 });
  }

  /* Vivo: solta a trava, para que a proxima queda soe na hora em vez de esperar a hora cheia
     seguinte. E o mesmo desenho do `avisar_mudanca` do Postai — a condicao que se resolve tem
     de poder soar de novo. */
  await redis(['DEL', 'g:avisado:postai-caiu']);
  return new Response(JSON.stringify({ ok: true, estado: 'vivo', idade_min: idadeMin }),
                      { status: 200 });
};

export const config = { schedule: '0 * * * *' };
