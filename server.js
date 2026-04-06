require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =============================================
// CONFIGURAÇÃO
// =============================================
const BASE_URL = 'https://escola.agendaedu.com';
const REFRESH_INTERVAL_MS = 60 * 1000; // 60 segundos
const SLA_LIMIT_MIN = 240;       // SLA: 4 horas
const LONG_WAIT_LIMIT_MIN = 120; // Alerta crítico: 2 horas sem resposta

// Mapeamento completo de canais (ID → Nome)
const CHANNEL_NAMES = {
  '87276': 'T2 Integral - COC Horto',
  '86772': '5º ANO - COC Lauro de Freitas',
  '86771': '4º ANO - COC Lauro de Freitas',
  '86770': '3º ANO - COC Lauro de Freitas',
  '86769': '2º ANO - COC Lauro de Freitas',
  '86768': '1º ANO - COC Lauro de Freitas',
  '86767': 'Grupo 5 - COC Lauro de Freitas',
  '86766': 'Grupo 4 - COC Lauro de Freitas',
  '86765': 'Grupo 3 - COC Lauro de Freitas',
  '86763': 'Grupo 2 - COC Lauro de Freitas',
  '86674': 'Alimentação I Integral PINK KITCHEN',
  '86384': 'NIP - Inclusão e Psicologia | COC Lauro de Freitas',
  '86269': 'T2 Integral (2) - COC Horto',
  '86268': 'T1 Integral - COC Horto',
  '86266': '5º ano EFAI - COC Horto',
  '86265': '4º ano EFAI - COC Horto',
  '86264': '3º ano EFAI - COC Horto',
  '86263': '2º ano EFAI - COC Horto',
  '86262': '1º ano EFAI - COC Horto',
  '86261': 'Grupo 5 - COC Horto',
  '86260': 'Grupo 4 - COC Horto',
  '86259': 'Grupo 3 - COC Horto',
  '86258': 'Grupo 2 - COC Horto',
  '86023': 'Atendimento / Matrículas | COC Lauro de Freitas',
  '86022': 'Professores Ensino Médio - COC Horto',
  '86021': 'Professores Fund. Anos Finais - COC Horto',
  '85982': 'Suporte Aplicativo | COC Lauro de Freitas',
  '85688': 'Suporte Aplicativo | COC Horto Florestal',
  '85675': 'Atendimento / Matrículas | COC Horto Florestal',
  '85667': 'Coordenação Fund. Finais e EM - COC Horto',
  '85664': 'Coordenação Ed. Infantil e Fund. Iniciais - COC Horto',
  '85662': 'Financeiro - COC Horto Florestal',
  '85661': 'Financeiro - COC Lauro de Freitas',
  '85644': 'Coordenação Fund. Finais e EM - COC Lauro de Freitas',
  '85641': 'Coordenação Ed. Infantil e Fund. Iniciais'
};

// =============================================
// AUTENTICAÇÃO — TOKEN OFICIAL (prioritário) ou COOKIE (fallback)
// =============================================

// Prioridade 1: AGENDAEDU_SCHOOL_TOKEN — token oficial da API, não expira
// Prioridade 2: SESSION_COOKIE — cookie de sessão manual (expira, use só se não tiver token)
function getRequestHeaders() {
  const schoolToken  = process.env.AGENDAEDU_SCHOOL_TOKEN;
  const sessionCookie = process.env.SESSION_COOKIE;

  if (schoolToken) {
    // Autenticação via token oficial — estável e sem expiração
    return {
      'Accept':          'application/json, text/plain, */*',
      'Authorization':   `Token token=${schoolToken}`,
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer':         `${BASE_URL}/schools/messages`
    };
  }

  if (sessionCookie) {
    // Fallback: cookie de sessão manual (renova periodicamente no Railway)
    return {
      'Accept':           'application/json, text/plain, */*',
      'Cookie':           `agendakids_session=${sessionCookie}`,
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer':          `${BASE_URL}/schools/messages`
    };
  }

  throw new Error('Nenhuma autenticação configurada. Adicione AGENDAEDU_SCHOOL_TOKEN no Railway.');
}

// =============================================
// CACHE DE DADOS
// =============================================

// Cache de famílias/membros por canal
let familyCache = {
  channels: {},      // channelId → array de membros
  lastUpdated: null,
  isLoading: false,
  error: null
};

let dataCache = {
  tickets: [],
  lastUpdated: null,
  isLoading: false,
  error: null,
  refreshCount: 0,
  avgQualityScore: null
};

// =============================================
// BUSCA DE TICKETS POR CANAL
// =============================================

async function fetchTicketsFromChannel(channelId) {
  const allTickets = [];
  const includedMap = {}; // cache de schoolUsers incluídos
  let page = 1;
  const perPage = 50;

  while (true) {
    const url = `${BASE_URL}/schools/messages/channels/${channelId}/tickets?page[size]=${perPage}&page[number]=${page}`;

    let response;
    try {
      response = await axios.get(url, {
        headers: getRequestHeaders(),
        timeout: 15000
      });
    } catch (error) {
      const status = error.response?.status;

      // Sessão expirada — precisa renovar o cookie manualmente
      if (status === 401 || status === 403 || status === 302) {
        console.error(`🔑 Cookie expirado no canal ${channelId}! Acesse o DevTools e atualize SESSION_COOKIE no Railway.`);
        dataCache.error = 'Cookie de sessão expirado. Atualize SESSION_COOKIE no Railway.';
        break;
      } else {
        console.error(`❌ Erro canal ${channelId} pág.${page}: ${status} ${error.message}`);
        break;
      }
    }

    const data = response.data;
    const tickets = data.data || [];

    // Mapeia usuários incluídos (atendentes, solicitantes, etc.)
    (data.included || []).forEach(item => {
      if (item.type === 'schoolUser') {
        includedMap[item.id] = item.attributes?.name || `Usuário #${item.id}`;
      }
    });

    const channelName = CHANNEL_NAMES[String(channelId)] || `Canal ${channelId}`;

    tickets.forEach(ticket => {
      // Resolve nome do atendente via relationships → included
      const attendantId = ticket.relationships?.currentAttendant?.data?.id;
      const attendantName = attendantId
        ? (includedMap[attendantId] || `Atendente #${attendantId}`)
        : null;

      allTickets.push({
        id: ticket.id,
        _channelId: channelId,
        _channelName: channelName,
        _attendantId: attendantId || null,
        _attendantName: attendantName,
        attributes: ticket.attributes || {}
      });
    });

    const totalPages = data.meta?.totalPages || 1;
    if (page >= totalPages || tickets.length < perPage) break;
    page++;
  }

  return allTickets;
}

// =============================================
// BUSCA DE MEMBROS/FAMÍLIAS POR CANAL
// =============================================

async function fetchChannelMembers(channelId) {
  const allMembers = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = `${BASE_URL}/schools/messages/channels/${channelId}/members?page[size]=${perPage}&page[number]=${page}`;

    let response;
    try {
      response = await axios.get(url, {
        headers: getRequestHeaders(),
        timeout: 15000
      });
    } catch (error) {
      const status = error.response?.status;
      if (status === 401 || status === 403 || status === 302) {
        console.error(`🔑 Cookie expirado ao buscar membros do canal ${channelId}`);
        familyCache.error = 'Cookie de sessão expirado. Atualize SESSION_COOKIE no Railway.';
      } else {
        console.error(`❌ Erro membros canal ${channelId} pág.${page}: ${status} ${error.message}`);
      }
      break;
    }

    const data = response.data;
    const members = data.data || [];
    const channelName = CHANNEL_NAMES[String(channelId)] || `Canal ${channelId}`;

    members.forEach(member => {
      const attrs = member.attributes || {};
      // Normaliza atributos — a API pode usar snake_case ou camelCase
      const joinedAt   = attrs.joinedAt   || attrs.joined_at   || attrs.acceptedAt || attrs.accepted_at || null;
      const lastSeenAt = attrs.lastSeenAt || attrs.last_seen_at || attrs.lastReadAt || attrs.last_read_at || null;
      const invitedAt  = attrs.invitedAt  || attrs.invited_at  || attrs.createdAt  || attrs.created_at  || null;
      const name       = attrs.name || attrs.fullName || attrs.full_name || attrs.guardianName || `Responsável #${member.id}`;
      const studentName = attrs.studentName || attrs.student_name || null;
      const status     = attrs.status || 'unknown';
      const hasApp     = attrs.hasApp ?? attrs.has_app ?? null;

      allMembers.push({
        id: member.id,
        channelId: String(channelId),
        channelName,
        name,
        studentName,
        status,
        joinedAt,
        lastSeenAt,
        invitedAt,
        hasApp
      });
    });

    const totalPages = data.meta?.totalPages || data.meta?.total_pages || 1;
    if (page >= totalPages || members.length < perPage) break;
    page++;
  }

  return allMembers;
}

// =============================================
// REFRESH DE FAMÍLIAS
// =============================================

async function refreshFamilyData() {
  if (familyCache.isLoading) {
    console.log('⏳ Atualização de famílias já em andamento...');
    return;
  }

  const channelIds = (process.env.CHANNEL_IDS || '')
    .split(',').map(id => id.trim()).filter(Boolean);

  if (channelIds.length === 0) return;
  if (!process.env.AGENDAEDU_SCHOOL_TOKEN && !process.env.SESSION_COOKIE) return;

  familyCache.isLoading = true;
  familyCache.error = null;

  try {
    console.log(`👨‍👩‍👧 [${new Date().toLocaleTimeString('pt-BR')}] Buscando membros de ${channelIds.length} canais...`);

    const chunkSize = 3;
    const channelsData = {};

    for (let i = 0; i < channelIds.length; i += chunkSize) {
      const chunk = channelIds.slice(i, i + chunkSize);
      const results = await Promise.all(chunk.map(id => fetchChannelMembers(id)));
      chunk.forEach((channelId, idx) => {
        channelsData[channelId] = results[idx];
      });
    }

    familyCache.channels = channelsData;
    familyCache.lastUpdated = new Date().toISOString();

    const total = Object.values(channelsData).reduce((s, m) => s + m.length, 0);
    console.log(`✅ [${new Date().toLocaleTimeString('pt-BR')}] ${total} membros/famílias carregados`);

  } catch (error) {
    familyCache.error = error.message;
    console.error(`❌ Erro famílias: ${error.message}`);
  } finally {
    familyCache.isLoading = false;
  }
}

// =============================================
// PROCESSAMENTO DE MÉTRICAS DE FAMÍLIAS
// =============================================

function processFamilyMetrics() {
  const now = Date.now();
  const WEEK_MS  = 7  * 24 * 60 * 60 * 1000;
  const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

  let allMembers = [];
  const channelStats = [];

  Object.entries(familyCache.channels).forEach(([channelId, members]) => {
    const channelName = CHANNEL_NAMES[channelId] || `Canal ${channelId}`;
    let joined = 0, neverOpened = 0, activeWeek = 0, activeMonth = 0;

    members.forEach(m => {
      // Considera que aderiu se: tem joinedAt OU tem lastSeenAt OU status é 'active'
      const hasJoined   = !!(m.joinedAt || m.lastSeenAt || m.status === 'active');
      const lastSeen    = m.lastSeenAt ? new Date(m.lastSeenAt) : null;
      const lastSeenMs  = lastSeen ? now - lastSeen.getTime() : Infinity;

      if (hasJoined)    joined++;
      if (!m.lastSeenAt) neverOpened++;
      if (lastSeenMs < WEEK_MS)  activeWeek++;
      if (lastSeenMs < MONTH_MS) activeMonth++;

      allMembers.push({ ...m, hasJoined, lastSeenDate: lastSeen });
    });

    channelStats.push({
      id: channelId,
      name: channelName,
      total: members.length,
      joined,
      notJoined:   members.length - joined,
      opened:      members.length - neverOpened,
      neverOpened,
      activeWeek,
      activeMonth,
      joinedRate:  members.length > 0 ? Math.round((joined / members.length) * 100) : 0,
      openedRate:  members.length > 0 ? Math.round(((members.length - neverOpened) / members.length) * 100) : 0
    });
  });

  const total            = allMembers.length;
  const totalJoined      = allMembers.filter(m => m.hasJoined).length;
  const totalNeverOpened = allMembers.filter(m => !m.lastSeenAt).length;
  const totalActiveWeek  = allMembers.filter(m => m.lastSeenDate && (now - m.lastSeenDate) < WEEK_MS).length;
  const totalActiveMonth = allMembers.filter(m => m.lastSeenDate && (now - m.lastSeenDate) < MONTH_MS).length;

  // Top canais com menor engajamento (prioridade de ação)
  const lowEngagement = [...channelStats]
    .filter(c => c.total > 0)
    .sort((a, b) => a.openedRate - b.openedRate)
    .slice(0, 10);

  // Famílias que nunca abriram (para ação da coordenação)
  const neverOpenedList = allMembers
    .filter(m => !m.lastSeenAt)
    .sort((a, b) => (b.invitedAt || '').localeCompare(a.invitedAt || ''))
    .slice(0, 100)
    .map(m => ({
      name:        m.name,
      studentName: m.studentName,
      channelName: m.channelName,
      invitedAt:   m.invitedAt,
      hasJoined:   m.hasJoined
    }));

  // Famílias mais engajadas (ranking)
  const engagementRanking = allMembers
    .filter(m => m.lastSeenDate)
    .sort((a, b) => (b.lastSeenDate?.getTime() || 0) - (a.lastSeenDate?.getTime() || 0))
    .slice(0, 50)
    .map(m => ({
      name:        m.name,
      studentName: m.studentName,
      channelName: m.channelName,
      lastSeenAt:  m.lastSeenAt,
      hasJoined:   m.hasJoined
    }));

  return {
    summary: {
      total,
      joined:          totalJoined,
      notJoined:       total - totalJoined,
      joinedRate:      total > 0 ? Math.round((totalJoined / total) * 100) : 0,
      opened:          total - totalNeverOpened,
      neverOpened:     totalNeverOpened,
      openedRate:      total > 0 ? Math.round(((total - totalNeverOpened) / total) * 100) : 0,
      activeWeek:      totalActiveWeek,
      activeWeekRate:  total > 0 ? Math.round((totalActiveWeek / total) * 100) : 0,
      activeMonth:     totalActiveMonth,
      activeMonthRate: total > 0 ? Math.round((totalActiveMonth / total) * 100) : 0
    },
    channelStats:      channelStats.sort((a, b) => b.total - a.total),
    lowEngagement,
    neverOpenedList,
    engagementRanking,
    lastUpdated:   familyCache.lastUpdated,
    isLoading:     familyCache.isLoading,
    error:         familyCache.error
  };
}

// =============================================
// ANÁLISE DE QUALIDADE DE ESCRITA
// =============================================

function analyzeTextQuality(text) {
  if (!text || typeof text !== 'string') return { score: 100, issues: [] };

  const issues = [];
  let penaltyPoints = 0;

  const informalAbbrevs = ['pq', 'vc', ' q ', 'tb', 'pf', 'oq', 'msm', 'hj', ' mt ', 'kk', 'rs', 'flw', 'vlw'];
  const lowerText = text.toLowerCase();
  informalAbbrevs.forEach(abbr => {
    if (lowerText.includes(abbr)) {
      issues.push({ type: 'informal', text: abbr });
      penaltyPoints += 10;
    }
  });

  if (text.length > 100 && !text.match(/[.!?]/)) {
    issues.push({ type: 'punctuation', text: 'Falta pontuação' });
    penaltyPoints += 5;
  }

  const capsRatio = (text.match(/[A-ZÁÀÂÃÉÈÊÍÏÓÔÕÚÇ]/g) || []).length / text.length;
  if (capsRatio > 0.4 && text.length > 20) {
    issues.push({ type: 'caps', text: 'Excesso de maiúsculas' });
    penaltyPoints += 15;
  }

  if (text.match(/[!?]{3,}/)) {
    issues.push({ type: 'emphasis', text: 'Excesso de !!! ou ???' });
    penaltyPoints += 10;
  }

  const words = text.toLowerCase().split(/\s+/);
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i].length > 3 && words[i] === words[i + 1]) {
      issues.push({ type: 'repetition', text: `Palavra repetida: "${words[i]}"` });
      penaltyPoints += 10;
      break;
    }
  }

  return { score: Math.max(0, 100 - penaltyPoints), issues };
}

// =============================================
// ANÁLISE DE SENTIMENTO DOS PAIS
// =============================================

const SENTIMENTO_KEYWORDS = {
  muito_positivo:    ['excelente', 'maravilhoso', 'perfeito', 'parabéns', 'incrível', 'fantástico', 'adorei', 'muito bom', 'muito obrigado', 'muito obrigada'],
  positivo:          ['bom', 'obrigado', 'obrigada', 'grato', 'grata', 'agradeço', 'satisfeito', 'satisfeita', 'resolvido', 'funcionou', 'ok', 'tudo bem'],
  misto:             ['porém', 'mas ', 'entretanto', 'no entanto', 'embora', 'apesar', 'ainda assim', 'contudo', 'todavia', 'mesmo assim'],
  levemente_negativo:['demora', 'demorou', 'aguardando', 'esperando', 'falta', 'faltando', 'não recebi', 'não chegou', 'problema', 'dificuldade', 'não funciona', 'não está'],
  negativo:          ['absurdo', 'inadmissível', 'péssimo', 'terrível', 'horrível', 'inaceitável', 'ridículo', 'vergonha', 'revoltante', 'decepcionante', 'furioso', 'furiosa', 'indignado', 'indignada', 'processo', 'procon', 'advogado', 'vai responder']
};

function analyzeSentiment(text) {
  if (!text || typeof text !== 'string') return { sentiment: 'neutro' };
  const lower = text.toLowerCase();
  const order = ['negativo', 'levemente_negativo', 'misto', 'positivo', 'muito_positivo'];
  for (const sentiment of order) {
    for (const kw of SENTIMENTO_KEYWORDS[sentiment]) {
      if (lower.includes(kw)) return { sentiment };
    }
  }
  return { sentiment: 'neutro' };
}

// =============================================
// CLASSIFICAÇÃO DE DEMANDAS
// =============================================

const TOPICOS_DEMANDAS = {
  financeiro:   ['boleto', 'mensalidade', 'pagamento', 'financeiro', 'cobrança', 'débito', 'parcela', 'desconto', 'bolsa', 'taxa', 'inadimplência', 'valor'],
  matricula:    ['matrícula', 'matricula', 'rematricula', 'rematrícula', 'inscrição', 'inscricao', 'vagas', 'transferência', 'transferencia'],
  academico:    ['nota', 'boletim', 'prova', 'avaliação', 'avaliacao', 'tarefa', 'lição', 'licao', 'dever', 'atividade', 'professor', 'aula', 'conteúdo', 'reprovação', 'reprovado'],
  horario:      ['horário', 'horario', 'agenda', 'calendário', 'calendario', 'turno', 'turma', 'escala'],
  comunicacao:  ['comunicado', 'aviso', 'informação', 'informacao', 'circular', 'recado', 'notícia'],
  transporte:   ['transporte', 'van', 'ônibus', 'onibus', 'fretado', 'motorista', 'rota'],
  alimentacao:  ['alimentação', 'alimentacao', 'lanche', 'merenda', 'refeição', 'refeicao', 'cardápio', 'cardapio', 'dieta'],
  uniforme:     ['uniforme', 'roupa', 'fardamento', 'farda'],
  aplicativo:   ['aplicativo', 'app', 'sistema', 'login', 'senha', 'acesso', 'plataforma'],
  eventos:      ['evento', 'festa', 'apresentação', 'apresentacao', 'formatura', 'passeio', 'excursão', 'excursao'],
  saude:        ['saúde', 'saude', 'médico', 'medico', 'medicação', 'medicacao', 'doença', 'doenca', 'atestado', 'enfermaria'],
  psicologico:  ['psicólogo', 'psicologo', 'psicologia', 'emocional', 'comportamento', 'bullying', 'ansiedade', 'tdah', 'laudo']
};

function categorizarDemanda(text) {
  if (!text || typeof text !== 'string') return 'outros';
  const lower = text.toLowerCase();
  for (const [topico, keywords] of Object.entries(TOPICOS_DEMANDAS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return topico;
    }
  }
  return 'outros';
}

// =============================================
// REFRESH DE DADOS
// =============================================

async function refreshData() {
  if (dataCache.isLoading) {
    console.log('⏳ Atualização já em andamento...');
    return;
  }

  const channelIds = (process.env.CHANNEL_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  if (channelIds.length === 0) {
    dataCache.error = 'Nenhum CHANNEL_ID configurado no .env';
    return;
  }

  // Verifica se há autenticação configurada
  if (!process.env.AGENDAEDU_SCHOOL_TOKEN && !process.env.SESSION_COOKIE) {
    dataCache.error = 'Autenticação não configurada. Adicione AGENDAEDU_SCHOOL_TOKEN no Railway.';
    console.error(`❌ ${dataCache.error}`);
    return;
  }

  dataCache.isLoading = true;
  dataCache.error = null;

  try {
    console.log(`🔄 [${new Date().toLocaleTimeString('pt-BR')}] Buscando ${channelIds.length} canais...`);

    let allTickets = [];

    // Busca em paralelo (máx 3 canais por vez para não sobrecarregar)
    const chunkSize = 3;
    for (let i = 0; i < channelIds.length; i += chunkSize) {
      const chunk = channelIds.slice(i, i + chunkSize);
      const results = await Promise.all(
        chunk.map(channelId => fetchTicketsFromChannel(channelId))
      );
      results.forEach(tickets => {
        allTickets = allTickets.concat(tickets);
      });
    }

    // Análise de qualidade (amostra dos 50 mais recentes)
    const qualityScores = allTickets
      .slice(0, 50)
      .filter(t => t.attributes?.description)
      .map(t => analyzeTextQuality(t.attributes.description).score);

    dataCache.tickets = allTickets;
    dataCache.avgQualityScore = qualityScores.length > 0
      ? Math.round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length)
      : null;
    dataCache.lastUpdated = new Date().toISOString();
    dataCache.refreshCount++;

    console.log(`✅ [${new Date().toLocaleTimeString('pt-BR')}] ${allTickets.length} tickets | Qualidade: ${dataCache.avgQualityScore ?? 'N/A'}%`);

  } catch (error) {
    dataCache.error = error.message;
    console.error(`❌ Erro no refresh: ${error.message}`);
  } finally {
    dataCache.isLoading = false;
  }
}

// =============================================
// PROCESSAMENTO DE MÉTRICAS
// =============================================

function processMetrics() {
  const { tickets } = dataCache;

  const statusCount = { waiting: 0, in_attendance: 0, done: 0, pending_ratings: 0 };
  const attendantMap = {};
  const ticketsPerHour = Array.from({ length: 24 }, (_, i) => ({ hour: `${i}h`, count: 0 }));

  // Últimos 7 dias
  const ticketsPerDay = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    ticketsPerDay[key] = 0;
  }

  const resolutionTimesAll = [];
  const today = new Date().toDateString();
  let ticketsToday = 0;
  let ticketsHaveRating = 0;
  let slaBreaches = 0;
  const longWaitTickets = []; // Tickets sem resposta há mais de 2h

  const channelStats = {};

  // Rastreamento de sentimento e demandas
  const sentimentoGlobal = { muito_positivo:0, positivo:0, neutro:0, misto:0, levemente_negativo:0, negativo:0 };
  const sentimentoAtendente = {};
  const topicoCount = {};
  const topicoCountNegativo = {};
  const topicoFrasesNegativas = {};
  const topicoAtendentesNegativos = {}; // atendentes que receberam negativos por tópico
  const topicoKeywordsNegativos = {};   // palavras-chave disparadoras por tópico

  tickets.forEach(ticket => {
    const attrs = ticket.attributes;
    if (!attrs) return;

    const status = attrs.status;
    if (statusCount.hasOwnProperty(status)) statusCount[status]++;

    if (attrs.createdAt && new Date(attrs.createdAt).toDateString() === today) ticketsToday++;
    if (attrs.hasRating) ticketsHaveRating++;

    if (status === 'waiting' && attrs.createdAt) {
      const waitingMin = (Date.now() - new Date(attrs.createdAt)) / 60000;
      if (waitingMin > SLA_LIMIT_MIN) slaBreaches++;

      // Alerta crítico: aguardando SEM resposta há mais de 2 horas
      if (waitingMin > LONG_WAIT_LIMIT_MIN) {
        const hoursWaiting = Math.floor(waitingMin / 60);
        const minutesExtra = Math.round(waitingMin % 60);
        longWaitTickets.push({
          id: ticket.id,
          channelId: ticket._channelId,
          channelName: ticket._channelName || `Canal ${ticket._channelId}`,
          attendantName: ticket._attendantName || 'Não atribuído',
          minutesWaiting: Math.round(waitingMin),
          hoursWaiting,
          minutesExtra,
          createdAt: attrs.createdAt,
          status: 'waiting'
        });
      }
    }

    // Alerta crítico: em atendimento mas sem atividade há mais de 2 horas
    if (status === 'in_attendance' && attrs.updatedAt) {
      const inactiveMin = (Date.now() - new Date(attrs.updatedAt)) / 60000;
      if (inactiveMin > LONG_WAIT_LIMIT_MIN) {
        const hoursWaiting = Math.floor(inactiveMin / 60);
        const minutesExtra = Math.round(inactiveMin % 60);
        longWaitTickets.push({
          id: ticket.id,
          channelId: ticket._channelId,
          channelName: ticket._channelName || `Canal ${ticket._channelId}`,
          attendantName: ticket._attendantName || 'Não atribuído',
          minutesWaiting: Math.round(inactiveMin),
          hoursWaiting,
          minutesExtra,
          createdAt: attrs.createdAt,
          status: 'in_attendance'
        });
      }
    }

    if (attrs.createdAt) {
      const hour = new Date(attrs.createdAt).getHours();
      if (ticketsPerHour[hour]) ticketsPerHour[hour].count++;

      const dayKey = `${String(new Date(attrs.createdAt).getDate()).padStart(2, '0')}/${String(new Date(attrs.createdAt).getMonth() + 1).padStart(2, '0')}`;
      if (ticketsPerDay.hasOwnProperty(dayKey)) ticketsPerDay[dayKey]++;
    }

    // Estatísticas por canal
    const cId = String(ticket._channelId);
    if (!channelStats[cId]) {
      channelStats[cId] = {
        id: cId,
        name: ticket._channelName || CHANNEL_NAMES[cId] || `Canal ${cId}`,
        total: 0, waiting: 0, in_attendance: 0, done: 0, pending_ratings: 0
      };
    }
    channelStats[cId].total++;
    if (statusCount.hasOwnProperty(status)) channelStats[cId][status]++;

    // Estatísticas por atendente
    const attendantId = ticket._attendantId || '__unassigned__';
    const attendantName = ticket._attendantName || 'Não atribuído';

    if (!attendantMap[attendantId]) {
      attendantMap[attendantId] = {
        id: ticket._attendantId || null,
        name: attendantName,
        total: 0, done: 0, waiting: 0, in_attendance: 0, pending_ratings: 0,
        totalResolutionMin: 0, resolutionCount: 0,
        withRating: 0
      };
    }

    const stat = attendantMap[attendantId];
    stat.total++;
    if (stat.hasOwnProperty(status)) stat[status]++;

    if (status === 'done' && attrs.updatedAt && attrs.createdAt) {
      const resMin = (new Date(attrs.updatedAt) - new Date(attrs.createdAt)) / 60000;
      if (resMin >= 0 && resMin < 1440) {
        stat.totalResolutionMin += resMin;
        stat.resolutionCount++;
        resolutionTimesAll.push(resMin);
      }
    }

    if (attrs.hasRating) stat.withRating++;

    // ── Análise de sentimento do pai ──
    const descricao = attrs.description || '';
    const sentPai = analyzeSentiment(descricao);
    const sentKey = sentPai.sentiment;

    sentimentoGlobal[sentKey] = (sentimentoGlobal[sentKey] || 0) + 1;

    if (!sentimentoAtendente[attendantId]) {
      sentimentoAtendente[attendantId] = { muito_positivo:0, positivo:0, neutro:0, misto:0, levemente_negativo:0, negativo:0 };
    }
    sentimentoAtendente[attendantId][sentKey]++;

    // ── Classificação de demanda ──
    const topico = categorizarDemanda(descricao);
    topicoCount[topico] = (topicoCount[topico] || 0) + 1;

    // Coleta frases para análise de sentimentos negativos/mistos
    if (['negativo', 'levemente_negativo', 'misto'].includes(sentKey) && descricao.length > 10) {
      topicoCountNegativo[topico] = (topicoCountNegativo[topico] || 0) + 1;

      if (!topicoFrasesNegativas[topico]) topicoFrasesNegativas[topico] = [];
      if (topicoFrasesNegativas[topico].length < 4) {
        topicoFrasesNegativas[topico].push(descricao.substring(0, 150).trim());
      }

      // Rastreia atendentes que receberam negativos neste tópico
      if (!topicoAtendentesNegativos[topico]) topicoAtendentesNegativos[topico] = {};
      if (ticket._attendantName) {
        topicoAtendentesNegativos[topico][ticket._attendantName] =
          (topicoAtendentesNegativos[topico][ticket._attendantName] || 0) + 1;
      }

      // Rastreia keywords detectadas para este tópico
      if (!topicoKeywordsNegativos[topico]) topicoKeywordsNegativos[topico] = {};
      const lower = descricao.toLowerCase();
      const allKws = SENTIMENTO_KEYWORDS[sentKey] || [];
      allKws.forEach(kw => {
        if (lower.includes(kw)) {
          topicoKeywordsNegativos[topico][kw] = (topicoKeywordsNegativos[topico][kw] || 0) + 1;
        }
      });
    }
  });

  // ── Sentimento predominante por atendente ──
  Object.keys(attendantMap).forEach(attId => {
    const counts = sentimentoAtendente[attId] || {};
    let predominante = 'neutro';
    let maxCount = 0;
    ['negativo', 'levemente_negativo', 'misto', 'neutro', 'positivo', 'muito_positivo'].forEach(sent => {
      if ((counts[sent] || 0) > maxCount) {
        maxCount = counts[sent];
        predominante = sent;
      }
    });
    attendantMap[attId].sentimentoPaisPredominante = predominante;
  });

  // ── Top demandas ──
  const topDemandas = Object.entries(topicoCount)
    .map(([topico, total]) => ({ topico, total }))
    .sort((a, b) => b.total - a.total);

  // ── Plano de ação baseado em sentimentos negativos ──
  const analisePlanoAcao = Object.entries(topicoCountNegativo)
    .map(([topico, count]) => ({
      topico,
      count,
      frases: topicoFrasesNegativas[topico] || [],
      atendentes: Object.entries(topicoAtendentesNegativos[topico] || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([nome, qtd]) => ({ nome, qtd })),
      keywordsDetectadas: Object.entries(topicoKeywordsNegativos[topico] || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([kw]) => kw)
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6); // top 6 tópicos problemáticos

  const ranking = Object.values(attendantMap)
    .filter(s => s.id !== null)
    .map(stat => ({
      ...stat,
      avgResolutionTime: stat.resolutionCount > 0
        ? Math.round(stat.totalResolutionMin / stat.resolutionCount)
        : null,
      ratingRate: stat.total > 0 ? Math.round((stat.withRating / stat.total) * 100) : 0,
      completionRate: stat.total > 0 ? Math.round((stat.done / stat.total) * 100) : 0
    }))
    .sort((a, b) => b.total - a.total);

  const avgResolutionTime = resolutionTimesAll.length > 0
    ? Math.round(resolutionTimesAll.reduce((a, b) => a + b, 0) / resolutionTimesAll.length)
    : null;

  const peakHour = ticketsPerHour.reduce((max, curr) => curr.count > max.count ? curr : max, ticketsPerHour[0]);

  return {
    summary: {
      totalTickets: tickets.length,
      ticketsToday,
      statusCount,
      avgResolutionTime,
      slaBreaches,
      ratingRate: tickets.length > 0 ? Math.round((ticketsHaveRating / tickets.length) * 100) : 0,
      peakHour: peakHour.hour,
      writingQuality: dataCache.avgQualityScore,
      sentimentoPaisGeral: sentimentoGlobal,
      topDemandas,
      analisePlanoAcao,
      longWaitTickets: longWaitTickets.sort((a, b) => b.minutesWaiting - a.minutesWaiting)
    },
    ranking,
    ticketsPerHour,
    ticketsPerDay: Object.entries(ticketsPerDay).map(([day, count]) => ({ day, count })),
    channelStats: Object.values(channelStats).sort((a, b) => b.total - a.total),
    lastUpdated: dataCache.lastUpdated,
    isLoading: dataCache.isLoading,
    refreshCount: dataCache.refreshCount,
    error: dataCache.error
  };
}

// =============================================
// ROTAS DA API
// =============================================

app.get('/api/metrics', (req, res) => {
  if (!dataCache.lastUpdated && !dataCache.error) {
    return res.status(503).json({
      error: 'Sistema inicializando, aguarde alguns segundos...',
      isLoading: true
    });
  }
  res.json(processMetrics());
});

app.get('/api/status', (req, res) => {
  const hasToken  = !!process.env.AGENDAEDU_SCHOOL_TOKEN;
  const hasCookie = !!process.env.SESSION_COOKIE;
  res.json({
    status:      'online',
    configured:  !!(  (hasToken || hasCookie) && process.env.CHANNEL_IDS),
    loggedIn:    hasToken || hasCookie,
    authMode:    hasToken ? 'school-token' : hasCookie ? 'session-cookie' : 'none',
    channels:    (process.env.CHANNEL_IDS || '').split(',').filter(Boolean).length,
    lastUpdated: dataCache.lastUpdated,
    isLoading:   dataCache.isLoading,
    ticketCount: dataCache.tickets.length,
    error:       dataCache.error,
    channelMap:  CHANNEL_NAMES
  });
});

app.post('/api/refresh', async (req, res) => {
  try {
    await refreshData();
    res.json({ success: true, message: 'Dados atualizados com sucesso!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Famílias ──
app.get('/api/familias', async (req, res) => {
  if (!familyCache.lastUpdated && !familyCache.error) {
    return res.status(503).json({
      error: 'Dados de famílias ainda sendo carregados, aguarde...',
      isLoading: true
    });
  }
  res.json(processFamilyMetrics());
});

app.post('/api/familias/refresh', async (req, res) => {
  try {
    await refreshFamilyData();
    res.json({ success: true, message: 'Dados de famílias atualizados!' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// INICIALIZAÇÃO
// =============================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   📊 DASHBOARD AGENDA EDU - PERFORMANCE       ║
╠══════════════════════════════════════════════╣
║  🌐 Acesse: http://localhost:${PORT}             ║
║  🔄 Atualização: a cada ${REFRESH_INTERVAL_MS / 1000}s                  ║
╚══════════════════════════════════════════════╝
  `);

  const hasToken  = !!process.env.AGENDAEDU_SCHOOL_TOKEN;
  const hasCookie = !!process.env.SESSION_COOKIE;
  const hasAuth   = hasToken || hasCookie;

  if (!hasAuth) {
    console.warn('⚠️  ATENÇÃO: Nenhuma autenticação configurada.');
    console.warn('   → Adicione AGENDAEDU_SCHOOL_TOKEN nas variáveis de ambiente do Railway (recomendado)');
    console.warn('   → Ou SESSION_COOKIE como fallback (expira periodicamente)');
  }
  if (!process.env.CHANNEL_IDS) {
    console.warn('⚠️  ATENÇÃO: CHANNEL_IDS não configurado.');
  }
  if (!hasAuth || !process.env.CHANNEL_IDS) return;

  if (hasToken) {
    console.log('🔑 Usando AGENDAEDU_SCHOOL_TOKEN (autenticação oficial, permanente)');
  } else {
    console.log('🍪 Usando SESSION_COOKIE (fallback — renove periodicamente)');
  }
  try {
    await refreshData();
    setInterval(refreshData, REFRESH_INTERVAL_MS);
    console.log(`✅ Sistema iniciado! Auto-refresh a cada ${REFRESH_INTERVAL_MS / 1000}s`);

    // Busca famílias logo após (não bloqueia o boot)
    refreshFamilyData().catch(e => console.error('❌ Erro inicial famílias:', e.message));
    // Refresh de famílias a cada 5 minutos (dados mudam menos)
    setInterval(refreshFamilyData, 5 * 60 * 1000);
    console.log('👨‍👩‍👧 Monitoramento de famílias ativado (refresh a cada 5 min)');
  } catch (error) {
    console.error(`❌ Erro na inicialização: ${error.message}`);
  }
});
