/**
 * REDIRECIONADOR DE GRUPOS — /g
 *
 * O botão da landing aponta para cá. Esta função escolhe o grupo, conta a entrada,
 * registra de qual ANÚNCIO ela veio, e redireciona. Tudo em UMA ida ao Redis.
 *
 * ┌─ POR QUE ESTA FUNÇÃO EXISTE ────────────────────────────────────────────────┐
 * │ O botão apontava direto para um redirecionador de TERCEIRO. Funcionava, mas  │
 * │ jogava fora a única informação que o teste de anúncios precisa: QUAL anúncio │
 * │ trouxe a pessoa. Agora a atribuição chega aqui na URL e é gravada.           │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * ── A REGRA NÚMERO 1: NUNCA FICAR SEM REDIRECIONAR ──────────────────────────────
 *
 * "não podemos ficar sem redirecionar" (2026-09-02). Então o visitante SEMPRE sai
 * daqui com um destino, em todos os cenários:
 *
 *   Redis fora do ar          → LINK_RESERVA (constante abaixo, não depende de nada)
 *   nenhum grupo cadastrado   → LINK_RESERVA
 *   todos os grupos lotados   → o último da fila mesmo assim + aviso no Telegram
 *   erro inesperado           → LINK_RESERVA
 *
 * Nenhum caminho mostra página de erro. O aviso é para o OPERADOR, nunca para quem
 * clicou no anúncio — quem clicou não tem culpa e não tem o que fazer com um erro.
 *
 * ── O CONTADOR É AUTÔNOMO, E ISSO É DE PROPÓSITO ────────────────────────────────
 *
 * Pergunta dele: "se nosso sistema não conseguir informar a quantidade atual, ele vai
 * somar 501, 502, 503... até 950 e trocar pro próximo? sem precisar do sistema?"
 *
 * Sim. `HINCRBY` é atômico: 50 cliques no mesmo segundo devolvem 50 números distintos,
 * nenhum grupo passa do teto. O contador NÃO depende do PC dele estar ligado, nem do
 * Postaí aberto, nem da extensão viva, nem do WhatsApp. Roda na borda, sozinho.
 *
 * A extensão é CORRETORA, não motor: quando ela lê o número real do WhatsApp, sobrescreve
 * o contador e a contagem segue dali. Enquanto ela não falar, o aproximado roda.
 *
 * ⚠️ E o aproximado corre NA FRENTE da realidade: conta cliques, e nem todo clique vira
 * entrada (somado a quem sai depois). Ou seja, o grupo troca ANTES de encher de verdade —
 * desperdiça vaga, mas erra para o lado seguro: nunca bate no teto duro de 1.024 do
 * WhatsApp, que é onde o convite pararia de funcionar.
 *
 * ── DADOS NO REDIS ──────────────────────────────────────────────────────────────
 *
 *   g:fila:<faixa>          LIST   ids dos grupos, na ordem de uso
 *   g:grupo:<id>            HASH   { link, teto, contador, ativo, nome }
 *   g:clique:<dia>:<faixa>  HASH   { total, <id do grupo>: n }
 *   g:ultimo                STRING ISO do último clique (a extensão usa para saber se caiu)
 *
 * "faixa" é a fila daquele anúncio. Sem faixa própria, cai na `geral` — então um anúncio
 * novo funciona no primeiro clique, antes de alguém configurar coisa alguma.
 */

/* Último recurso. É o redirecionador que ele já usava: se TUDO falhar, o visitante
   continua chegando no grupo, exatamente como chegava antes desta função existir. */
const LINK_RESERVA = "https://app.lumiofertasinteligentes.com.br/r/nossolareconomico";

const TETO_PADRAO = 950;   /* decidido por ele em 2026-09-02; folga até os 1.024 do WhatsApp */

/**
 * Escolhe o grupo, soma 1 e registra o clique — tudo como UMA operação atômica.
 *
 * Precisa ser atômico e não só rápido: com dois cliques simultâneos, ler-decidir-escrever
 * separado daria o mesmo slot para os dois e deixaria o grupo passar do teto.
 *
 * Devolve { id, link, contador, teto } ou {} quando não há grupo utilizável.
 */
const ESCOLHER = `
local faixa = ARGV[1]
local dia   = ARGV[2]
local agora = ARGV[3]

-- 🔴 REGISTRAR SEMPRE, inclusive quando não há grupo nenhum.
--
-- A primeira versão só registrava quando ACHAVA um grupo. Com a fila ainda vazia (que é o
-- estado do primeiro dia, antes da extensão existir), o clique saía para o link reserva
-- CALADO — e os anúncios já estavam rodando. Ou seja: a atribuição, que é a razão inteira
-- desta função existir, estava indo para o lixo justamente na janela em que ele mais
-- precisa dela. Dado de anúncio não volta depois.
--
-- Agora o clique é contado nos três desfechos, e o "destino" diz qual foi: o id do grupo,
-- ou 'reserva'. Assim dá para distinguir "atendi" de "não tinha grupo" no relatório, em
-- vez de os dois virarem o mesmo silêncio ([[gotcha-falha-indistinguivel-de-sucesso]]).
local function registrar(destino)
  local k = 'g:clique:' .. dia .. ':' .. faixa
  redis.call('HINCRBY', k, 'total', 1)
  redis.call('HINCRBY', k, destino, 1)
  redis.call('EXPIRE', k, 7776000)
  redis.call('SADD', 'g:faixas', faixa)
  redis.call('SET', 'g:ultimo', agora)
end

local fila = redis.call('LRANGE', 'g:fila:' .. faixa, 0, -1)
if #fila == 0 then
  fila = redis.call('LRANGE', 'g:fila:geral', 0, -1)
end

local ultimo_id, ultimo_link
for i = 1, #fila do
  local id = fila[i]
  local h  = 'g:grupo:' .. id
  local link = redis.call('HGET', h, 'link')
  if link and link ~= '' then
    ultimo_id, ultimo_link = id, link
    if redis.call('HGET', h, 'ativo') ~= '0' then
      local teto = tonumber(redis.call('HGET', h, 'teto') or '${TETO_PADRAO}')
      local n    = tonumber(redis.call('HGET', h, 'contador') or '0')
      if n < teto then
        local novo = redis.call('HINCRBY', h, 'contador', 1)
        registrar(id)
        return { id, link, tostring(novo), tostring(teto) }
      end
    end
  end
end

-- Todos lotados. Manda para o ÚLTIMO assim mesmo: um grupo cheio ainda aceita gente
-- (o teto real do WhatsApp é 1.024, o nosso é 950), e um link morto não aceita ninguém.
if ultimo_link then
  registrar(ultimo_id)
  return { ultimo_id, ultimo_link, 'LOTADO', 'LOTADO' }
end

-- Nenhum grupo cadastrado ainda: vai para o reserva, mas o clique NÃO se perde.
registrar('reserva')
return {}
`;

/** Aviso no Telegram — para ELE, no celular. Nunca trava o redirect. */
async function avisar(env, chave, texto) {

  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;

  if (!token || !chat) return;

  try {

    /* Trava de repetição: o mesmo aviso não volta antes de 1 h. Sem isto, um Redis fora
       do ar por 10 minutos manda 400 mensagens e ele para de ler os avisos — que é o
       jeito mais rápido de um sistema de alerta deixar de existir. */
    const url = env.UPSTASH_REDIS_REST_URL;
    const tk = env.UPSTASH_REDIS_REST_TOKEN;

    if (url && tk && chave) {
      const r = await fetch(`${url}/set/g:avisado:${chave}/1?nx=true&ex=3600`, {
        headers: { Authorization: `Bearer ${tk}` }
      });
      const j = await r.json().catch(() => null);
      if (!j || j.result === null) return;   /* já avisou há menos de 1 h */
    }

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true })
    });

  } catch (e) {
    /* Avisar é best-effort. Falhar aqui não pode derrubar o redirect. */
    console.log("[grupo] aviso falhou:", String(e));
  }
}

/** 302 sem cache. O destino MUDA a cada clique — cachear mandaria todo mundo pro mesmo. */
function mandar(destino) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: destino,
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
    }
  });
}

export default async (request, context) => {

  const env =
    context?.env ||
    (typeof Deno !== "undefined" && Deno.env?.toObject?.()) ||
    {};

  try {

    const url = new URL(request.url);
    const q = url.searchParams;

    /* ── DE QUAL ANÚNCIO VEIO ──────────────────────────────────────────────────
       O Meta preenche sozinho quando a URL do anúncio traz parâmetros dinâmicos
       (ex.: ?ad={{ad.id}}). `utm_content` e `utm_campaign` entram como alternativa
       para tráfego que não vem do Meta. Sem nada, a faixa é `geral`. */
    /* 🔴 A MACRO QUE NÃO EXPANDIU VIRAVA UM ANÚNCIO DE MENTIRA (achado em 2026-09-04).
     *
     * O Upstash dele tinha a faixa literal `ad.id`, com um clique:
     *   g:clique:2026-09-04:ad.id -> { reserva: 1, total: 1 }
     *
     * Não existe anúncio chamado "ad.id". É a macro `{{ad.id}}` chegando SEM o Meta ter
     * substituído (clique de prévia, link compartilhado à mão, ou o parâmetro posto num campo
     * onde o Meta não expande) — e a limpeza abaixo remove `{` e `}`, então `{{ad.id}}` sai
     * daqui como `ad.id`. Reproduzido: a mesma linha transforma `{{campaign.id}}` em
     * `campaign.id` e `{{adset.id}}` em `adset.id`.
     *
     * O estrago é de LEITURA, não de rota: uma fila inexistente já cai na `geral` sozinha (a
     * busca no Lua faz esse recuo). Mas no relatório de atribuição — que é a razão inteira de
     * esta função existir — "não sei de qual anúncio veio" aparecia como um anúncio de verdade,
     * com nome e tudo. Falha indistinguível de sucesso, na forma mais cara: dado de anúncio não
     * volta depois.
     *
     * ⚠️ A faixa vira `macro_nao_expandida`, que NÃO é `geral` de propósito: `geral` é o
     * tráfego legítimo sem faixa própria, e misturar os dois esconderia o problema numa contagem
     * que parece saudável. Do ponto de vista do redirect nada muda — fila vazia recua para
     * `geral` do mesmo jeito. E o aviso sai, porque macro que não expande é a atribuição dele
     * quebrada em silêncio. */
    const faixaCrua = q.get("ad") || q.get("utm_content") || q.get("utm_campaign") || "geral";
    const macroNaoExpandiu = /[{}]/.test(faixaCrua);

    const faixa = macroNaoExpandiu
      ? "macro_nao_expandida"
      : (faixaCrua.toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 48) || "geral");

    if (macroNaoExpandiu) {
      await avisar(env, "macro-nao-expandida",
        `⚠️ Um clique chegou com a macro do anúncio SEM expandir (${faixaCrua.slice(0, 60)}). ` +
        `O visitante foi para o grupo normalmente, mas esse clique não conta para nenhum ` +
        `anúncio. Confira se o link do anúncio está com o parâmetro dinâmico no campo certo.`);
    }

    const REDIS_URL = env.UPSTASH_REDIS_REST_URL;
    const REDIS_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;

    if (!REDIS_URL || !REDIS_TOKEN) {
      await avisar(env, "sem-env", "⚠️ Redirecionador: faltam as variáveis do Upstash. Está no link reserva.");
      return mandar(LINK_RESERVA);
    }

    const agora = new Date();
    const dia = agora.toISOString().slice(0, 10);

    /* Uma chamada: escolhe + soma + registra. */
    const res = await fetch(`${REDIS_URL}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(["EVAL", ESCOLHER, "0", faixa, dia, agora.toISOString()])
    });

    if (!res.ok) {
      await avisar(env, "redis-fora",
        `⚠️ Redirecionador: o Upstash respondeu ${res.status}. Está mandando pro link reserva — ninguém ficou sem grupo, mas a contagem parou.`);
      return mandar(LINK_RESERVA);
    }

    const body = await res.json().catch(() => null);
    const r = body && body.result;

    if (!Array.isArray(r) || r.length < 2 || !r[1]) {
      await avisar(env, "sem-grupo",
        "⚠️ Redirecionador: nenhum grupo cadastrado no Upstash. Está no link reserva — configure a fila pela extensão.");
      return mandar(LINK_RESERVA);
    }

    const [id, link, contador, teto] = r;

    if (contador === "LOTADO") {
      await avisar(env, "todos-lotados",
        `🔴 Redirecionador: TODOS os grupos passaram do teto. Ainda estou mandando pro "${id}", mas crie o próximo grupo e cadastre o link.`);
    } else {
      const n = parseInt(contador, 10);
      const t = parseInt(teto, 10);
      if (t > 0 && n >= Math.floor(t * 0.94)) {
        await avisar(env, `quase-${id}`,
          `⚠️ Grupo "${id}" em ${n} de ${t}. Vale criar o próximo antes de lotar.`);
      }
    }

    return mandar(link);

  } catch (e) {

    /* Qualquer coisa inesperada: o visitante ainda chega no grupo. */
    console.log("[grupo] erro:", String(e));
    await avisar(env, "erro", `⚠️ Redirecionador quebrou: ${String(e).slice(0, 180)}. Está no link reserva.`);
    return mandar(LINK_RESERVA);
  }
};
