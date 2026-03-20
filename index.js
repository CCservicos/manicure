const functions = require('firebase-functions');
const admin = require('firebase-admin');
const twilioLib = require('twilio');

admin.initializeApp();

function safeFunctionsConfig() {
  try {
    // eslint-disable-next-line no-undef
    return typeof functions.config === 'function' ? functions.config() : {};
  } catch (e) {
    return {};
  }
}

function getEnv(name) {
  return process.env[name];
}

function getAllowedEmails() {
  const fc = safeFunctionsConfig();
  const appCfg = fc && fc.app ? fc.app : {};
  const raw = getEnv('ADMIN_EMAILS') || appCfg.admin_emails || '';
  return raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function getTwilioSecrets() {
  const fc = safeFunctionsConfig();
  const twilioCfg = fc && fc.twilio ? fc.twilio : {};

  const accountSid = getEnv('TWILIO_ACCOUNT_SID') || twilioCfg.account_sid;
  const authToken = getEnv('TWILIO_AUTH_TOKEN') || twilioCfg.auth_token;
  const from = getEnv('TWILIO_FROM_WHATSAPP') || twilioCfg.from_whatsapp;

  const missing = [];
  if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!authToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!from) missing.push('TWILIO_FROM_WHATSAPP');
  if (missing.length) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'Faltando variáveis de ambiente: ' + missing.join(', ')
    );
  }

  return { accountSid, authToken, from };
}

function getTwilioClient() {
  const { accountSid, authToken } = getTwilioSecrets();
  return twilioLib(accountSid, authToken);
}

function onlyDigits(s) {
  return String(s || '').replace(/\D/g, '');
}

function formatDate(ds) {
  // ds: yyyy-mm-dd
  const parts = String(ds || '').split('-');
  if (parts.length !== 3) return String(ds || '');
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

function fmtNum(n) {
  const v = Number(n);
  if (Number.isNaN(v)) return '0.00';
  return v.toFixed(2);
}

function formatProcs(procs, services) {
  if (!Array.isArray(procs) || procs.length === 0) return '-';
  return procs.map(id => {
    const s = (services || []).find(x => String(x.id) === String(id));
    return s ? s.name : id;
  }).join(', ');
}

function buildAdminNewRequestText(appt, services) {
  const procsTxt = formatProcs(appt.procs, services);
  const totalTxt = appt.total ? ' | R$ ' + fmtNum(appt.total) : '';

  const lines = [
    'Novo Agendamento - Rita Cassia Manicure',
    '',
    'Cliente: ' + (appt.name || ''),
    'Data: ' + formatDate(appt.date),
    'Horario: ' + (appt.time || ''),
    'Servicos: ' + procsTxt + totalTxt,
    appt.wa ? 'WhatsApp cliente: ' + appt.wa : '',
    appt.obs ? 'Obs: ' + appt.obs : '',
    '',
    'Status: Pendente de confirmacao'
  ].filter(l => l !== '');

  return lines.join('\n');
}

function buildClientConfirmText(appt, services) {
  const procsTxt = formatProcs(appt.procs, services);
  const totalTxt = appt.total ? 'Valor: R$ ' + fmtNum(appt.total) : '';

  const lines = [
    'Ola, ' + (appt.name || '') + '!',
    '',
    'Seu agendamento esta CONFIRMADO!',
    '',
    'Data: ' + formatDate(appt.date),
    'Horario: ' + (appt.time || ''),
    'Servicos: ' + procsTxt,
    totalTxt,
    '',
    'Te esperamos! -- Rita Cassia Manicure'
  ].filter(l => l !== '');

  return lines.join('\n');
}

exports.sendWhatsApp = functions.https.onRequest(async (req, res) => {
  // CORS: permite chamadas do GitHub Pages/qualquer domínio.
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    const type = String(req.body?.type || '').trim();
    const apptId = String(req.body?.apptId || '').trim();

    if (!type || !apptId) {
      res.status(400).json({ ok: false, error: 'Parâmetros inválidos (type/apptId).' });
      return;
    }
    if (type !== 'confirm' && type !== 'new_request') {
      res.status(400).json({ ok: false, error: 'Tipo de mensagem inválido.' });
      return;
    }

    // Autenticação: obrigatória (cliente pode ser anônimo, mas precisa ter idToken).
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
    if (!token) {
      res.status(401).json({ ok: false, error: 'Login obrigatório.' });
      return;
    }

    const decoded = await admin.auth().verifyIdToken(token);
    const email = String(decoded.email || '').toLowerCase();

    // Confirmação do cliente: somente admin pode disparar.
    if (type === 'confirm') {
      const allowed = getAllowedEmails();
      if (allowed.length > 0 && !allowed.includes(email)) {
        res.status(403).json({ ok: false, error: 'Sem permissão para enviar mensagens.' });
        return;
      }
    }

    // Idempotência + montagem do texto a partir do agendamento real
    const sentRef = admin.database().ref(`waSent/${type}/${apptId}`);
    const sentSnap = await sentRef.once('value');
    if (sentSnap.exists()) {
      res.status(200).json({ ok: true, already: true });
      return;
    }

    const { accountSid, authToken, from } = getTwilioSecrets();
    const client = twilioLib(accountSid, authToken);

    // Carrega dados do agendamento e da configuração (para nomes dos serviços)
    const [apptSnap, cfgSnap, metaSnap] = await Promise.all([
      admin.database().ref(`appts/${apptId}`).once('value'),
      admin.database().ref('cfg').once('value'),
      type === 'new_request' ? admin.database().ref('meta/waNum').once('value') : Promise.resolve({ val: () => null })
    ]);

    const appt = apptSnap.val();
    if (!appt) {
      res.status(404).json({ ok: false, error: 'Agendamento não encontrado para apptId.' });
      return;
    }

    const cfg = cfgSnap.val() || {};
    const services = Array.isArray(cfg.services) ? cfg.services : [];

    let toDigits = '';
    let body = '';

    if (type === 'new_request') {
      const waNum = metaSnap && metaSnap.val ? metaSnap.val() : null;
      toDigits = onlyDigits(waNum);
      if (!toDigits) {
        res.status(400).json({ ok: false, error: 'meta/waNum não configurado no Realtime Database.' });
        return;
      }
      body = buildAdminNewRequestText(appt, services);
    } else {
      // confirm
      toDigits = onlyDigits(appt.wa);
      if (!toDigits) {
        res.status(400).json({ ok: false, error: 'WhatsApp do cliente ausente (appt.wa).' });
        return;
      }
      body = buildClientConfirmText(appt, services);
    }

    const to = `whatsapp:+55${toDigits}`;
    await client.messages.create({ from, to, body });
    await sentRef.set(admin.database.ServerValue.TIMESTAMP);
    res.status(200).json({ ok: true, already: false });
  } catch (e) {
    console.error('sendWhatsApp error:', e);
    res.status(500).json({ ok: false, error: 'internal', message: e?.message || String(e) });
  }
});

