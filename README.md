# 📊 Dashboard de Performance — Agenda Edu

Dashboard em tempo real para monitoramento de atendimentos via API do Agenda Edu.

---

## 🚀 Como Rodar

### 1. Pré-requisitos
- [Node.js 18+](https://nodejs.org/) instalado
- Credenciais da API Agenda Edu

### 2. Configurar credenciais

Copie o arquivo de exemplo e preencha com suas credenciais:

```bash
cp .env.example .env
```

Abra o arquivo `.env` e preencha:

```
API_TOKEN=      → UID da escola (escola.agendaedu.com → Editar conta → Informações de API → UID)
X_SCHOOL_TOKEN= → Token Escola (mesma tela acima → TOKEN ESCOLA)
CHANNEL_IDS=    → IDs dos canais (ver lista completa no .env.example)
```

> **Como encontrar o CHANNEL_ID?**
> Acesse o Agenda Edu → Módulo de Atendimento → Canais de Atendimento → ID do canal na URL

### 3. Instalar dependências

```bash
npm install
```

### 4. Iniciar o servidor

```bash
npm start
```

Acesse: **http://localhost:3000**

---

## 📊 Métricas do Dashboard

| Métrica | Descrição |
|---------|-----------|
| Total de Tickets | Todos os tickets dos últimos 30 dias |
| Tickets Hoje | Abertas no dia atual |
| Aguardando Atendimento | Tickets sem atendente |
| Tempo Médio de Resolução | Média de tempo entre abertura e conclusão |
| Violações de SLA | Tickets aguardando há mais de 30 minutos |
| Qualidade de Escrita | Análise de informalidades nas mensagens |
| Taxa de Avaliação | % de tickets com feedback dos clientes |
| Ranking de Atendentes | Volume, tempo médio, taxa de conclusão |

---

## ☁️ Deploy na Nuvem (Railway)

1. Crie uma conta em [railway.app](https://railway.app)
2. Crie um novo projeto > Deploy from GitHub
3. Configure as variáveis de ambiente no painel
4. Deploy automático!

---

## 🔧 Personalização

### Mudar o intervalo de atualização (padrão: 60s)
No `server.js`, linha: `const REFRESH_INTERVAL_MS = 60 * 1000;`

### Mudar o limite de SLA (padrão: 30 min)
No `server.js`, linha: `const SLA_LIMIT_MIN = 30;`

### Monitorar mais canais
Adicione os IDs separados por vírgula no `.env`:
```
CHANNEL_IDS=2862,2863,2864
```

---

## 📞 Suporte
- Documentação Agenda Edu: https://agendaedu.dev/
- Suporte API: atendimento@agendaedu.com
