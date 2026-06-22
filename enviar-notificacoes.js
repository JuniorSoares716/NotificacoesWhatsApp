/**
 * Envia avisos de contas a vencer pelo WhatsApp (CallMeBot).
 * Roda pelo GitHub Actions (agendado). Lê os dados do Firestore com uma chave de serviço.
 *
 * Variáveis de ambiente (definidas como "secrets" no GitHub):
 *   SERVICE_ACCOUNT    -> conteúdo JSON da chave de serviço do Firebase
 *   APP_EMAIL          -> e-mail de login do app (para achar o usuário)
 *   JANELA_DIAS        -> (opcional) quantos dias à frente contam como "vencendo em breve".
 *                         Padrão: "5" (vence em até 5 dias). As que vencem hoje têm seção própria.
 */

const admin = require('firebase-admin');

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const TZ = 'America/Sao_Paulo';
const JANELA_DIAS = parseInt(process.env.JANELA_DIAS || '5', 10);

const moeda = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Divide uma mensagem longa em partes seguras (evita corte por limite de URL do CallMeBot)
function dividirMensagem(texto, maxLen = 900) {
  const partes = [];
  let atual = '';
  const push = () => { if (atual) { partes.push(atual); atual = ''; } };
  for (const bloco of texto.split('\n\n')) {
    if (bloco.length > maxLen) {
      push();
      let sub = '';
      for (const linha of bloco.split('\n')) {
        if (sub && (sub + '\n' + linha).length > maxLen) { partes.push(sub); sub = linha; }
        else sub = sub ? sub + '\n' + linha : linha;
      }
      if (sub) atual = sub;
    } else if (atual && (atual + '\n\n' + bloco).length > maxLen) {
      push(); atual = bloco;
    } else {
      atual = atual ? atual + '\n\n' + bloco : bloco;
    }
  }
  push();
  return partes;
}

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

  const cfg = database.appSettings || database['__settings__'] || {};
  const contatos = (cfg.whatsappContacts || []).filter((c) => c.number && c.apikey);

  // MODO TESTE: envia uma mensagem de verificação e encerra (ignora vencimentos)
  if (process.env.MODO_TESTE === 'true' || process.env.MODO_TESTE === '1') {
    if (contatos.length === 0) { console.log('TESTE: nenhum contato com número + apikey cadastrado.'); return; }
    const teste = '✅ *Teste — Controle Financeiro PRO*\n\nSe você recebeu esta mensagem, as notificações de WhatsApp estão funcionando! 🎉';
    for (const c of contatos) {
      try {
        const r = await enviarCallMeBot(c.number, c.apikey, teste);
        console.log(`TESTE enviado para ${c.name} (${c.number}): status ${r.status} | resposta: ${r.body}`);
      } catch (err) {
        console.error(`TESTE falhou para ${c.name}:`, err.message);
      }
      await sleep(4000);
    }
    console.log('TESTE concluído.');
    return;
  }

  const { ano, mesIndex, dia } = hojeSaoPaulo();
  const anoKey = String(ano);
  const mesNome = MESES[mesIndex];
  const detalhes = database?.[anoKey]?.monthlyDetails?.[mesNome];
  const despesas = (detalhes && detalhes.expenses) || [];

  const emBreve = [];
  const hoje = [];
  const vencidas = [];
  const pagas = [];
  for (const e of despesas) {
    const venc = parseInt(e.due, 10);
    if (e.paid) {
      pagas.push({ e, venc: isNaN(venc) ? null : venc });
      continue;
    }
    if (!venc || isNaN(venc)) continue;
    const diff = venc - dia;
    if (diff < 0) vencidas.push({ e, venc });
    else if (diff === 0) hoje.push({ e, venc });
    else if (diff <= JANELA_DIAS) emBreve.push({ e, venc, diff });
  }

  if (emBreve.length === 0 && hoje.length === 0 && vencidas.length === 0) {
    console.log('Nada a vencer (em breve/hoje) nem vencido. Nada será enviado.');
    return;
  }

  let msg = `🔔 *Lembrete de contas* — ${mesNome}/${ano}\n`;

  if (emBreve.length) {
    msg += `\n*Vencendo em breve:*\n`;
    emBreve.sort((a, b) => a.diff - b.diff);
    for (const { e, venc, diff } of emBreve) {
      const quando = diff === 1 ? `vence amanhã (dia ${venc})` : `faltam ${diff} dias (vence dia ${venc})`;
      msg += `• ${e.name} — ${moeda(e.value)} — ${quando}\n`;
    }
  }
  if (hoje.length) {
    msg += `\n*Vencendo hoje:*\n`;
    for (const { e, venc } of hoje) {
      msg += `• ${e.name} — ${moeda(e.value)} — vence hoje (dia ${venc})\n`;
    }
  }
  if (vencidas.length) {
    msg += `\n*Vencidas (não pagas):*\n`;
    vencidas.sort((a, b) => a.venc - b.venc);
    for (const { e, venc } of vencidas) {
      const atraso = dia - venc;
      const txtAtraso = atraso === 1 ? 'atrasada há 1 dia' : `atrasada há ${atraso} dias`;
      msg += `• ${e.name} — ${moeda(e.value)} — venceu dia ${venc} (${txtAtraso})\n`;
    }
  }
  if (pagas.length) {
    msg += `\n*Pagas:*\n`;
    pagas.sort((a, b) => (a.venc || 0) - (b.venc || 0));
    for (const { e } of pagas) {
      msg += `• ${e.name} — ${moeda(e.value)}\n`;
    }
  }

  const totalAVencer = emBreve.reduce((s, x) => s + (x.e.value || 0), 0);
  const totalHoje = hoje.reduce((s, x) => s + (x.e.value || 0), 0);
  const totalVencidas = vencidas.reduce((s, x) => s + (x.e.value || 0), 0);
  const totalPago = pagas.reduce((s, x) => s + (x.e.value || 0), 0);
  if (emBreve.length) msg += `\n*Total a vencer:* ${moeda(totalAVencer)}`;
  if (hoje.length) msg += `\n*Total vencendo hoje:* ${moeda(totalHoje)}`;
  if (vencidas.length) msg += `\n*Total em atraso:* ${moeda(totalVencidas)}`;
  if (pagas.length) msg += `\n*Total pago:* ${moeda(totalPago)}`;

  // ORÇAMENTOS do mês (vem junto com as notificações de despesas)
  const budgets = database?.[anoKey]?.budgets || [];
  const categorias = database?.[anoKey]?.expenseCategories || [];
  const nomeCat = (id) => ((categorias.find((c) => c.id === id) || {}).name) || 'Categoria';
  const LIMITE_APERTADO = 80; // a partir de 80% do limite, consideramos "apertado"

  msg += `\n\n*Orçamentos do mês:*`;
  if (budgets.length === 0) {
    msg += `\n_Nenhum orçamento cadastrado._`;
  } else {
    const dentro = [], apertado = [], estourado = [];
    for (const b of budgets) {
      if (!b.limit || b.limit <= 0) continue;
      const gasto = despesas.filter((e) => e.categoryId === b.categoryId).reduce((s, e) => s + (e.value || 0), 0);
      const pct = Math.round((gasto / b.limit) * 100);
      const item = { nome: nomeCat(b.categoryId), gasto, limit: b.limit, pct };
      if (gasto > b.limit) estourado.push(item);
      else if (pct >= LIMITE_APERTADO) apertado.push(item);
      else dentro.push(item);
    }
    const linhaOk = (it) => `• ${it.nome}: ${moeda(it.gasto)} de ${moeda(it.limit)} — ${it.pct}% já utilizado.\n  Pode utilizar ${moeda(it.limit - it.gasto)}.`;
    const linhaEstourou = (it) => `• ${it.nome}: ${moeda(it.gasto)} de ${moeda(it.limit)} — ${it.pct}% já utilizado.\n  Você estourou ${moeda(it.gasto - it.limit)} a mais do cadastrado.`;
    const bloco = (titulo, itens, fmt) => `\n\n_${titulo}:_` + (itens.length ? '\n' + itens.map(fmt).join('\n') : `\n_Sem orçamento nessa situação._`);
    msg += bloco('Dentro da margem', dentro, linhaOk);
    msg += bloco('Apertado (perto do limite)', apertado, linhaOk);
    msg += bloco('Estourado', estourado, linhaEstourou);
  }

  msg += `\n\n_Controle Financeiro PRO_`;

  if (contatos.length === 0) { console.log('Nenhum contato com número + apikey. Nada enviado.'); return; }

  const partes = dividirMensagem(msg, 900);
  for (const c of contatos) {
    for (let i = 0; i < partes.length; i++) {
      const texto = partes.length > 1 ? `(${i + 1}/${partes.length})\n${partes[i]}` : partes[i];
      try {
        const r = await enviarCallMeBot(c.number, c.apikey, texto);
        console.log(`Enviado para ${c.name} (${c.number}) parte ${i + 1}/${partes.length}: status ${r.status}`);
      } catch (err) {
        console.error(`Falha ao enviar para ${c.name} (parte ${i + 1}):`, err.message);
      }
      await sleep(4000); // respeita o limite do CallMeBot
    }
  }
  console.log('Concluído.');
}

main().catch((err) => { console.error('Erro:', err.message); process.exit(1); });
