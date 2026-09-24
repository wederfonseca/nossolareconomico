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
 * 2026-09-24 — REESCRITO, a pedido dele: "avisar que o computador parou, algo como o servidor
 * nao esta respondendo. um erro especifico pra isso, avisar de hora em hora e avisar quando
 * reestabelecer conexao". A versao anterior tinha tres defeitos que impediam exatamente isso:
 *
 *   1. O carimbo expira em 2 h (SET com EX 7200). Depois disso a chave some e este vigia caia no
 *      ramo "nunca existiu": uma queda longa virava SILENCIO depois da 2a mensagem.
 *   2. Nao havia aviso de "voltou".
 *   3. A trava era de 1 h exata num cron de 1 h exata: a trava gravada as 12:00:05 ainda estava
 *      viva as 13:00:03, e a hora seguinte era PULADA. Insistencia de hora em hora que pula hora.
 *
 * Agora a queda tem estado PROPRIO (`g:postai:queda`, sem validade): nasce na primeira volta que
 * ve o carimbo velho, guarda desde quando, e so morre quando o carimbo volta a andar.
 *
 * ⚠️ HORARIO: insiste das 7h as 22h (hora de Sao Paulo, a mesma janela do vigia da postagem). De
 * madrugada fica calado — PC desligado a noite e normal, e oito mensagens por noite e o jeito mais
 * rapido de ele parar de ler este canal. Se continuar fora, a primeira volta das 7h diz desde
 * quando. E o "voltou" so sai se a queda chegou a ser AVISADA: desligou 23h, ligou 6h50, nada.
 *
 * ⚠️ Nao avisa quando o carimbo NUNCA existiu (sem carimbo e sem queda registrada). E o estado de
 * antes da primeira subida do Postai com esta versao — acusar "caiu" ali seria dar susto no dia
 * do deploy.
 */

const MINUTOS_ATE_ACUSAR = 30;
const JANELA_INICIO = 7;     // hora de Sao Paulo, inclusiva
const JANELA_FIM = 22;       // exclusiva: 21:59 avisa, 22:00 nao
const CHAVE_QUEDA = 'g:postai:queda';

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

async function telegram(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: texto })
  });
  return r.ok;
}

/** Trava CURTA contra duas execucoes simultaneas mandarem a mesma mensagem. Nao e trava de
 *  repeticao: quem espaca as mensagens e o proprio cron de 1 h (ver o defeito 3 do cabecalho). */
async function travar(nome) {
  return (await redis(['SET', `g:avisado:${nome}`, '1', 'NX', 'EX', '600'])) !== null;
}

function horaEmSaoPaulo(data) {
  return Number(new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false
  }).format(data)) % 24;
}

function quando(iso) {
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function duracao(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

function responder(corpo) {
  return new Response(JSON.stringify({ ok: true, ...corpo }), { status: 200 });
}

export default async () => {
  const agora = new Date();
  const carimbo = await redis(['GET', 'g:postai:vivo']);
  const bruta = await redis(['GET', CHAVE_QUEDA]);
  let queda = null;
  try { queda = bruta ? JSON.parse(bruta) : null; } catch { queda = null; }

  const idadeMin = carimbo ? (agora - Date.parse(carimbo)) / 60000 : null;
  const vivo = idadeMin !== null && idadeMin <= MINUTOS_ATE_ACUSAR;

  if (vivo) {
    if (queda) {
      if (queda.avisou && await travar('postai-voltou')) {
        await telegram(
          '✅ O servidor do Postaí voltou a responder\n\n' +
          `Ficou fora ${duracao(agora - Date.parse(queda.desde))}\n` +
          `(desde ${quando(queda.desde)})\n\n` +
          'A leitura dos grupos volta sozinha.'
        );
      }
      await redis(['DEL', CHAVE_QUEDA]);
    }
    return responder({ estado: 'vivo', idade_min: idadeMin });
  }

  // Sem carimbo E sem queda registrada: nunca houve contato com esta versao. Ver o cabecalho.
  if (!carimbo && !queda) return responder({ estado: 'sem-carimbo' });

  // Fora do ar. A queda nasce com a hora do ULTIMO sinal, nao com a hora em que eu percebi.
  if (!queda) {
    queda = { desde: carimbo, avisou: false, avisos: 0 };
    await redis(['SET', CHAVE_QUEDA, JSON.stringify(queda)]);
  }

  const hora = horaEmSaoPaulo(agora);
  if (hora < JANELA_INICIO || hora >= JANELA_FIM) {
    return responder({ estado: 'caiu-calado-noite', desde: queda.desde });
  }
  if (!(await travar('postai-caiu'))) return responder({ estado: 'caiu-ja-avisado-agora' });

  const fora = duracao(agora - Date.parse(queda.desde));
  const texto = queda.avisou
    ? ('⏰ O servidor do Postaí AINDA não está respondendo\n\n' +
       `Fora há ${fora} (desde ${quando(queda.desde)})\n\n` +
       'Aviso de novo em 1 hora enquanto não voltar.')
    : ('🔴 O servidor do Postaí não está respondendo\n\n' +
       `Último sinal ${quando(queda.desde)} (há ${fora})\n` +
       'Esperado a cada 5 min\n\n' +
       'PC desligado, sem internet\nou o app parado.\n\n' +
       'Enquanto isso: sem leitura dos\ngrupos e sem o resumo das 07h.\n\n' +
       'Aviso de hora em hora e quando voltar.');
  const enviou = await telegram(texto);
  if (enviou) {
    queda = { ...queda, avisou: true, avisos: (queda.avisos || 0) + 1 };
    await redis(['SET', CHAVE_QUEDA, JSON.stringify(queda)]);
  }
  return responder({ estado: 'caiu', desde: queda.desde, enviou });
};

export const config = { schedule: '0 * * * *' };
