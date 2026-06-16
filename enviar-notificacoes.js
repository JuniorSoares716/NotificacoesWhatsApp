/**
 * Envia avisos de contas a vencer pelo WhatsApp (CallMeBot).
 * Roda pelo GitHub Actions (agendado). Lê os dados do Firestore com uma chave de serviço.
 *
 * Variáveis de ambiente (definidas como "secrets" no GitHub):
 *   SERVICE_ACCOUNT    -> conteúdo JSON da chave de serviço do Firebase
 *   APP_EMAIL          -> e-mail de login do app (para achar o usuário)
 *   DIAS_AVISO         -> (opcional) marcos de aviso, em dias antes do vencimento.
 *                         Padrão: "3,2,1" (avisa faltando 3, 2 e 1 dia).
 *                         Ex.: "3,2,1,0" também avisa no dia do vencimento.
 */

const admin = require('firebase-admin');

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const TZ = 'America/Sao_Paulo';
const DIAS_AVISO = (process.env.DIAS_AVISO || '3,2,1')
  .split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));

const moeda = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hojeSaoPaulo() {
  const now = new Date();
  const get = (opt) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opt }).format(now));
  return { ano: get({ year: 'numeric' }), mesIndex: get({ month: 'numeric' }) - 1, dia: get({ day: 'numeric' }) };
}

async function enviarCallMeBot(number, apikey, text) {
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(number)}`
    + `&apikey=${encodeURIComponent(apikey)}&text=${encodeURIComponent(text)}`;
  const resp = await fetch(url, { method: 'GET' });
  const body = await resp.text();
  return { ok: resp.ok, status: resp.status, body: body.slice(0, 200) };
}

async function main() {
  if (!process.env.SERVICE_ACCOUNT) throw new Error('Falta o secret SERVICE_ACCOUNT.');
  if (!process.env.APP_EMAIL) throw new Error('Falta o secret APP_EMAIL.');

  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.SERVICE_ACCOUNT)) });

  const user = await admin.auth().getUserByEmail(process.env.APP_EMAIL);
  const snap = await admin.firestore().collection('users').doc(user.uid).get();
  if (!snap.exists) { console.log('Documento do usuário não encontrado. Nada a fazer.'); return; }
  const database = snap.data();

  const { ano, mesIndex, dia } = hojeSaoPaulo();
  const anoKey = String(ano);
  const mesNome = MESES[mesIndex];
  const detalhes = database?.[anoKey]?.monthlyDetails?.[mesNome];
  const despesas = (detalhes && detalhes.expenses) || [];

  const aVencer = [];
  const vencidas = [];
  for (const e of despesas) {
    if (e.paid) continue;
    const venc = parseInt(e.due, 10);
    if (!venc || isNaN(venc)) continue;
    const diff = venc - dia;
    if (diff < 0) vencidas.push({ e, venc });
    else if (DIAS_AVISO.includes(diff)) aVencer.push({ e, venc, diff });
  }

  if (aVencer.length === 0 && vencidas.length === 0) {
    console.log('Nenhuma conta a vencer/vencida hoje. Nada será enviado.');
    return;
  }

  let msg = `🔔 *Lembrete de contas* — ${mesNome}/${ano}\n`;
  if (aVencer.length) {
    msg += `\n*Vencendo em breve:*\n`;
    aVencer.sort((a, b) => a.diff - b.diff);
    for (const { e, venc, diff } of aVencer) {
      const quando = diff === 0 ? 'vence hoje'
        : diff === 1 ? `vence amanhã (dia ${venc})`
        : `faltam ${diff} dias (vence dia ${venc})`;
      msg += `• ${e.name} — ${moeda(e.value)} — ${quando}\n`;
    }
  }
  if (vencidas.length) {
    msg += `\n*Vencidas (não pagas):*\n`;
    vencidas.sort((a, b) => a.venc - b.venc);
    for (const { e, venc } of vencidas) {
      msg += `• ${e.name} — ${moeda(e.value)} — venceu dia ${venc}\n`;
    }
  }
  msg += `\n_Controle Financeiro PRO_`;

  const contatos = (database.__settings__ && database.__settings__.whatsappContacts) || [];
  const validos = contatos.filter((c) => c.number && c.apikey);
  if (validos.length === 0) { console.log('Nenhum contato com número + apikey. Nada enviado.'); return; }

  for (const c of validos) {
    try {
      const r = await enviarCallMeBot(c.number, c.apikey, msg);
      console.log(`Enviado para ${c.name} (${c.number}): status ${r.status}`);
    } catch (err) {
      console.error(`Falha ao enviar para ${c.name}:`, err.message);
    }
    await sleep(4000); // respeita o limite do CallMeBot
  }
  console.log('Concluído.');
}

main().catch((err) => { console.error('Erro:', err.message); process.exit(1); });
