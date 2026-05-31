const WAIT_MS = 500;

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

      /* ================= BROWSER EVENT + REDIRECT ================= */

      let redirected = false;

      const redirect = () => {
        if (redirected) return;
        redirected = true;
        window.location.href = targetUrl;
      };

      // fallback: redireciona após WAIT_MS caso o callback não dispare
      setTimeout(redirect, WAIT_MS);

      fbq(
        'track',
        'Lead',
        {
          group_name: 'NossoLarEconomico'
        },
        {
          eventID: eventId
        },
        redirect
      );

    });

  }

  /* ================= CONTADOR + POPUP ================= */

  const femaleNames = [
    "Mariana",
    "Fernanda",
    "Camila",
    "Juliana",
    "Patrícia",
    "Amanda",
    "Bruna",
    "Larissa",
    "Renata",
    "Vanessa",
    "Aline",
    "Gabriela",
    "Paula",
    "Tatiane",
    "Bianca",
    "Débora",
    "Natália",
    "Jéssica",
    "Carla",
    "Beatriz",
    "Cristiane",
    "Michele",
    "Priscila",
    "Elaine",
    "Viviane"
  ];

  const popup = document.getElementById("joinPopup");
  const popupName = document.getElementById("popupName");
  const spotsNumber = document.getElementById("spotsNumber");

  let spots = Math.floor(Math.random() * 11) + 30;

  if (spotsNumber) {
    spotsNumber.textContent = spots;
  }

  function randomName() {

    return femaleNames[
      Math.floor(Math.random() * femaleNames.length)
    ];

  }

  function showPopup() {

    if (!popup || !popupName || !spotsNumber) return;

    if (spots <= 1) return;

    popupName.textContent = randomName();

    spots--;

    spotsNumber.textContent = spots;

    popup.style.display = "flex";

    setTimeout(() => {

      popup.style.opacity = "1";
      popup.style.transform = "translateY(0)";

    }, 50);

    setTimeout(() => {

      popup.style.opacity = "0";
      popup.style.transform = "translateY(10px)";

      setTimeout(() => {

        popup.style.display = "none";

      }, 300);

    }, 4000);

  }

  // primeira exibição
  setTimeout(() => {

    showPopup();

  }, 1500);

  // próximas entradas
  setInterval(() => {

    showPopup();

  }, 9000);

});

/* ================= PAGE BACK FIX ================= */

window.addEventListener('pageshow', function(event) {

  if (event.persisted) {
    locked = false;
  }

});
