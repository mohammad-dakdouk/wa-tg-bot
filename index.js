require('dotenv').config();
// منع إغلاق البوت عند حدوث أخطاء غير ممسوكة من Puppeteer
process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err.message);
});
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const { TG_TOKEN, TG_CHAT_ID, WA_CHAT_ID } = process.env;
const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

// دوّر على Chrome المنصّب بالجهاز
const chromePaths = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
];
const executablePath = chromePaths.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('❌ Google Chrome not found. Install it and restart.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// الطابور: رسالة ورا رسالة بنفس الترتيب
let queue = Promise.resolve();
function enqueue(task) {
  queue = queue
    .then(task)
    .catch((err) => console.error('❌ Forwarding error:', err.stack || err.message))
    .then(() => sleep(400));
}

// طلب لتلغرام مع إعادة المحاولة إذا طلب ننتظر (429)
async function tgRequest(method, makeBody, headers) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`${TG_API}/${method}`, {
        method: 'POST',
        headers,
        body: makeBody(),
      });
      if (res.ok) {
        console.log(`✅ Telegram ${method} OK`);
        return true;
      }

      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        const wait = (data.parameters?.retry_after || 5) + 1;
        console.log(`⏳ Telegram rate limit, waiting ${wait}s...`);
        await sleep(wait * 1000);
        continue;
      }
      console.error(`❌ Telegram ${method} error:`, JSON.stringify(data));
      return false;
    } catch (err) {
      console.error(`❌ Telegram ${method} request failed:`, err.message);
      await sleep(2000);
    }
  }
  return false;
}

function sendText(text) {
  return tgRequest(
    'sendMessage',
    () => JSON.stringify({ chat_id: TG_CHAT_ID, text }),
    { 'Content-Type': 'application/json' }
  );
}

function sendFile(method, field, media, caption, fileName) {
  const buffer = Buffer.from(media.data, 'base64');
  return tgRequest(method, () => {
    const form = new FormData();
    form.append('chat_id', TG_CHAT_ID);
    if (caption) form.append('caption', caption.slice(0, 1024));
    form.append(field, new Blob([buffer], { type: media.mimetype }), fileName);
    return form;
  });
}

// نوع الرسالة بواتساب => طريقة تلغرام
const routes = {
  image:    ['sendPhoto',    'photo'],
  video:    ['sendVideo',    'video'],
  ptt:      ['sendVoice',    'voice'],
  audio:    ['sendAudio',    'audio'],
  sticker:  ['sendSticker',  'sticker'],
  document: ['sendDocument', 'document'],
};

function getExt(mimetype) {
  return (mimetype || 'application/octet-stream').split('/')[1].split(';')[0] || 'bin';
}

// تحميل الميديا مع 3 محاولات
async function downloadWithRetry(msg) {
  for (let i = 1; i <= 3; i++) {
    try {
      const media = await msg.downloadMedia();
      if (media && media.data) return media;
      console.log(`⚠️ downloadMedia returned empty (attempt ${i}/3)`);
    } catch (err) {
      console.log(`⚠️ downloadMedia threw (attempt ${i}/3):`, err.message);
    }
    await sleep(2000);
  }
  return null;
}

async function forwardMedia(msg) {
  const media = await downloadWithRetry(msg);
  if (!media) {
    console.error(`❌ Could not download media (type: ${msg.type})`);
    return;
  }

  const sizeMB = (media.data.length * 0.75) / 1024 / 1024;
  console.log(`📦 Downloaded ${msg.type}, mimetype=${media.mimetype}, ~${sizeMB.toFixed(2)} MB`);

  const caption = msg.body || '';
  const fileName = media.filename || `${msg.type}.${getExt(media.mimetype)}`;
  const [method, field] = routes[msg.type] || ['sendDocument', 'document'];

  const ok = await sendFile(method, field, media, caption, fileName);
  if (!ok && method !== 'sendDocument') {
    console.log('↩️ Retrying as a regular document...');
    await sendFile('sendDocument', 'document', media, caption, fileName);
  }
}

// ---------- واتساب ----------
//   const client = new Client({
//    authStrategy: new LocalAuth(),
//     puppeteer: { executablePath, args: ['--no-sandbox'] },
//    });

// ---------- واتساب ----------
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { 
    executablePath, 
    headless: true, // أو اجعلها false إذا أردت رؤية المتصفح يفتح أمامك
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-extensions'
    ],
  },
});



client.on('qr', (qr) => {
  console.log('📱 Scan this QR code with WhatsApp (Linked Devices):');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('🔐 Authenticated'));
client.on('auth_failure', (m) => console.error('❌ Auth failure:', m));
client.on('disconnected', (r) => console.error('⚠️ Disconnected:', r));

client.on('ready', () => {
  console.log('✅ WhatsApp ready');
  if (!WA_CHAT_ID) console.log('Send a message in your group to print its ID');
});

client.on('message_create', (msg) => {
  const chatId = msg.fromMe ? msg.to : msg.from;

  // وضع اكتشاف الـ ID
  if (!WA_CHAT_ID) {
    console.log(chatId.endsWith('@g.us') ? 'GROUP =>' : 'PRIVATE =>', chatId);
    return;
  }

  if (chatId !== WA_CHAT_ID) return;

  console.log(`📨 New message: type=${msg.type}, hasMedia=${msg.hasMedia}`);

  enqueue(async () => {
    if (msg.hasMedia) await forwardMedia(msg);
    else if (msg.body) await sendText(msg.body);
  });
});

client.initialize();