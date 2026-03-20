## Firebase Function: envio automático WhatsApp (Twilio)

Esta pasta contém um `sendWhatsApp` via **Firebase Functions** (Callable) para disparar mensagem no WhatsApp 100% automático.

### 1) Configurar variáveis no Firebase Functions
O backend lê as configurações de 2 formas:

#### Opção A) Environment variables (process.env)
- `ADMIN_EMAILS` (ex: `alissonh26@gmail.com`)
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_WHATSAPP` (formato `whatsapp:+1415xxxxxx`)

#### Opção B) `firebase functions:config:set` (lido no backend)
- `twilio.account_sid`
- `twilio.auth_token`
- `twilio.from_whatsapp`
- `app.admin_emails`

### 2) Deploy
Na pasta raiz do projeto Firebase (onde fica seu `firebase.json`):
- `firebase deploy --only functions:sendWhatsApp`

Se quiser forçar o projeto:
- `firebase deploy --only functions:sendWhatsApp --project manicure-bba02`

### 3) Como o front-end chama
O `index.html` chama a função callable `sendWhatsApp` enviando:
- `apptId`: id do agendamento (para idempotência)
- `type`: tipo da mensagem (ex: `confirm`)

Para `type: confirm`, o backend envia para `appt.wa`.
Para `type: new_request`, o backend envia para `meta/waNum`.

