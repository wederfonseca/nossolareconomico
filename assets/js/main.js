let locked = false;

/* ================= UTIL ================= */

function generateEventId() {

  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2);

}

function readCookie(name) {

  const match = document.cookie.match(
    '(^|;)\\s*' + name + '\\s*=\\s*([^;]+)'
  );

  return match ? decodeURIComponent(match.pop()) : null;

}

async function sendEvent(payload) {

  try {

    await fetch('/collect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-capi-signature': 'v1'
      },
      body: payload,
      keepalive: true,
      signal: AbortSignal.timeout(4000)
    });

  } catch {

    // silently ignore — fire-and-forget analytics request

  }

}

/* ================= MAIN ================= */

document.addEventListener('DOMContentLoaded', () => {

  /* ================= VISITA (2026-09-19) =================
   *
   * Conta quem CHEGOU, nao quem clicou. E o degrau que faltava entre o clique no anuncio
   * (Meta) e o clique no botao (`g:clique:<dia>`) — sem ele nao da para separar "nao chegou na
   * pagina" de "chegou e o Lead nao disparou". Ver o bloco VISITA em `collect.js`.
   *
   * `keepalive`: se ela sair da pagina em seguida, o pedido ainda vai. Falha nao faz nada: e
   * medicao, nunca pode atrapalhar quem esta entrando no grupo. */
  try {
    fetch('/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-capi-signature': 'v1' },
      body: JSON.stringify({ event_id: 'visita-' + generateEventId(), evento: 'visita' }),
      keepalive: true
    }).catch(() => {});
  } catch { /* sem fetch: segue */ }

  /* ================= CTA ================= */

  const button = document.querySelector('.cta-button');

  if (button) {

    button.addEventListener('click', async (ev) => {

      ev.preventDefault();

      if (locked) return;

      locked = true;

      const targetUrl = button.href;

      if (sessionStorage.getItem('lead_sent')) {

        window.location.href = targetUrl;
        return;

      }

      /* ================= FEEDBACK VISUAL ================= */

      button.textContent = 'Abrindo...';
      button.style.opacity = '0.75';

      /* ================= IDs ================= */

      const eventId = generateEventId();

      sessionStorage.setItem('lead_sent', eventId);

      /* ================= SERVER EVENT ================= */

      const payload = JSON.stringify({

        event_id: eventId,

        event_source_url: window.location.href,

        fbp: readCookie('_fbp'),
        fbc: readCookie('_fbc'),

        custom_data: {
          destination: 'whatsapp_group',
          brand: 'Nosso Lar Econômico',
          group_name: 'NossoLarEconomico'
        }

      });

      sendEvent(payload);

      /* ================= BROWSER EVENT + REDIRECT =================
       *
       * 2026-09-19 — O REDIRECT DEIXOU DE ESPERAR. Antes: `preventDefault` + 500 ms de
       * "Abrindo..." antes de sair. Meio segundo parado, no navegador de dentro do Instagram,
       * e desistencia que ninguem mede — e a espera nao comprava nada: quem REGISTRA o Lead com
       * certeza e o CAPI do servidor (`/collect`, ja enviado acima com `keepalive`), nao o
       * `fbq` do navegador, que nem sempre termina antes da navegacao de qualquer jeito.
       *
       * O `fbq` continua sendo disparado, com o MESMO `eventID` do CAPI: quando ele chega, a
       * Meta deduplica; quando nao chega, o servidor ja contou. Nao ha aposta nos dois lados. */
      fbq(
        'track',
        'Lead',
        {
          group_name: 'NossoLarEconomico'
        },
        {
          eventID: eventId
        }
      );

      window.location.href = targetUrl;

    });

  }

  /* ================= 2026-09-19 — O POPUP SAIU =================
   *
   * Ele: "retire o popup da landing, nao quero nem o original".
   *
   * O que havia aqui: um aviso "Fulana entrou no grupo" com nome sorteado de uma lista fixa de
   * 25 nomes, a cada 9 segundos, e um contador de "vagas restantes hoje" que nascia de
   * `Math.random()` entre 30 e 40 e ia caindo junto. Nenhum dos dois olhava dado nenhum.
   *
   * O numero REAL existe e e melhor: 11 grupos, teto de 950 cada, e a contagem de membros que a
   * extensao sincroniza no Upstash a cada 30 min. Se algum dia voltar a mostrar vaga ou entrada
   * nesta pagina, que venha de la — decisao dele, e ate la a pagina nao afirma nada que nao
   * possa provar. */
});

/* ================= PAGE BACK FIX ================= */

window.addEventListener('pageshow', function(event) {

  if (event.persisted) {
    locked = false;
  }

});
