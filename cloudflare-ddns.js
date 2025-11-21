const fs = require('fs');
const path = require('path');

// Thời gian đợi network sẵn sàng khi khởi động (giây)
const STARTUP_DELAY_SECONDS = 60;

// Số lần thử lại khi khởi động nếu không lấy được IP
const STARTUP_RETRIES = 5;

// Thời gian kiểm tra IP định kỳ (giây)
const CHECK_INTERVAL_SECONDS = 60; // 1 phút

// Config variables (sẽ được load từ config.json)
let TELEGRAM_BOT_TOKEN;
let TELEGRAM_CHAT_ID;
let DOMAINS = [];

// Load configuration from config.json
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');

  if (!fs.existsSync(configPath)) {
    console.error(`[${new Date().toISOString()}] ❌ File config.json không tồn tại!`);
    console.error('Vui lòng tạo file config.json từ config.example.json:');
    console.error('Sau đó chỉnh sửa config.json với thông tin của bạn.');
    process.exit(1);
  }

  console.log(`[${new Date().toISOString()}] 📄 Đọc cấu hình từ config.json`);
  try {
    const configData = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configData);

    // Telegram config (optional)
    if (config.telegram) {
      TELEGRAM_BOT_TOKEN = config.telegram.botToken;
      TELEGRAM_CHAT_ID = config.telegram.chatId;
    }

    // Defaults
    const defaults = config.defaults || {};
    const defaultApiToken = defaults.apiToken;
    const defaultTtl = defaults.ttl || 60;
    const defaultProxied = defaults.proxied || false;

    // Domains
    if (config.domains && Array.isArray(config.domains)) {
      DOMAINS = config.domains
        .filter(d => d.name && d.zoneId) // Chỉ lấy domain có name và zoneId hợp lệ
        .map(d => ({
          name: d.name,
          zoneId: d.zoneId,
          apiToken: d.apiToken || defaultApiToken, // Override hoặc dùng default
          ttl: d.ttl !== undefined ? d.ttl : defaultTtl,
          proxied: d.proxied !== undefined ? d.proxied : defaultProxied
        }));
    }

    return true;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Lỗi đọc config.json: ${error.message}`);
    if (error instanceof SyntaxError) {
      console.error('File config.json có lỗi cú pháp JSON. Vui lòng kiểm tra lại.');
    }
    process.exit(1);
  }
}

// Load config ngay khi khởi động
loadConfig();

// Validate cấu hình
function validateConfig() {
  const errors = [];

  if (DOMAINS.length === 0) {
    errors.push('Không tìm thấy domain nào');
  }

  // Kiểm tra từng domain
  DOMAINS.forEach((domain, index) => {
    if (!domain.name) {
      errors.push(`Domain #${index + 1}: thiếu tên domain`);
    }
    if (!domain.zoneId) {
      errors.push(`Domain "${domain.name || index + 1}": thiếu zoneId`);
    }
    if (!domain.apiToken || domain.apiToken.trim() === '') {
      errors.push(`Domain "${domain.name || index + 1}": thiếu apiToken`);
    }
  });

  if (errors.length > 0) {
    console.error(`[${new Date().toISOString()}] ❌ Lỗi cấu hình:`);
    errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }

  // Warning cho Telegram (optional)
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn(`[${new Date().toISOString()}] ⚠️  Telegram không được cấu hình - thông báo sẽ bị tắt`);
  }

  console.log(`[${new Date().toISOString()}] ✅ Cấu hình hợp lệ: ${DOMAINS.length} domain(s)`);
  DOMAINS.forEach(d => {
    const tokenPreview = d.apiToken ? `${d.apiToken.substring(0, 10)}...` : 'N/A';
    console.log(`  - ${d.name} (Zone: ${d.zoneId.substring(0, 8)}..., Token: ${tokenPreview}, TTL: ${d.ttl}s, Proxied: ${d.proxied})`);
  });
}

// Flag để tránh race condition
let isRunning = false;

// Helper function để retry cho Cloudflare API
async function retryCloudflareAPI(fn, context, { retries = 3, initialDelayMs = 1000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLast = attempt === retries;
      const delay = Math.min(initialDelayMs * Math.pow(2, attempt - 1), 10000);

      if (isLast) {
        console.error(`[${new Date().toISOString()}] ${context} thất bại sau ${retries} lần thử: ${error.message}`);
        throw error;
      } else {
        console.warn(`[${new Date().toISOString()}] ${context} (lần ${attempt}/${retries}): ${error.message}. Thử lại sau ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
}

async function getPublicIp() {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.ip;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Lỗi khi lấy IP công khai: ${error.message}`);
    return null;
  }
}

async function getARecord(domainConfig) {
  const { name, zoneId, apiToken } = domainConfig;
  try {
    return await retryCloudflareAPI(async () => {
      const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=A&name=${name}`, {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.success && data.result.length > 0) {
        return { ip: data.result[0].content, recordId: data.result[0].id };
      }
      console.error(`[${new Date().toISOString()}] Không tìm thấy A record cho ${name}`);
      return null;
    }, `Lấy A record cho ${name}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Lỗi khi lấy A record cho ${name}: ${error.message}`);
    return null;
  }
}

async function sendTelegramMessage(message, { retries = 5, initialDelayMs = 500, timeoutMs = 10000 } = {}) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn(`[${new Date().toISOString()}] Bỏ qua gửi Telegram vì thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID.`);
    return false;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'Markdown'
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
      }

      const data = await response.json();
      if (!data.ok) throw new Error(data.description || 'Telegram API returned ok=false.');

      console.log(`[${new Date().toISOString()}] Đã gửi thông báo Telegram: ${message}`);
      return true;
    } catch (error) {
      const isLast = attempt === retries;
      const delay = Math.min(initialDelayMs * Math.pow(2, attempt - 1), 15000) + Math.floor(Math.random() * 300); // jitter

      if (isLast) {
        console.error(`[${new Date().toISOString()}] Lỗi gửi thông báo Telegram sau ${retries} lần thử: ${error.message}`);
        return false;
      } else {
        console.warn(`[${new Date().toISOString()}] Lỗi gửi Telegram (lần ${attempt}/${retries}): ${error.message}. Sẽ thử lại sau ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  return false;
}


async function updateARecord(domainConfig, recordId, newIp, oldIp) {
  const { name, zoneId, apiToken, ttl, proxied } = domainConfig;
  try {
    const success = await retryCloudflareAPI(async () => {
      const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'A',
          name: name,
          content: newIp,
          ttl: ttl,
          proxied: proxied
        })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.success) {
        return true;
      } else {
        throw new Error(`Cloudflare API error: ${JSON.stringify(data.errors)}`);
      }
    }, `Cập nhật A record cho ${name}`);

    if (success) {
      console.log(`[${new Date().toISOString()}] Đã cập nhật A record cho ${name} thành ${newIp} (TTL: ${ttl}s, Proxied: ${proxied})`);
      const message = `🌐 *Cập nhật DNS thành công* 🌐\n` +
                      `📍 *Domain*: ${name}\n` +
                      `🔄 *IP cũ*: ${oldIp}\n` +
                      `✅ *IP mới*: ${newIp}\n` +
                      `⚙️ *TTL*: ${ttl}s\n` +
                      `☁️ *Proxied*: ${proxied ? 'Yes' : 'No'}\n` +
                      `🕒 *Thời gian*: ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;
      await sendTelegramMessage(message);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Lỗi khi cập nhật A record cho ${name}: ${error.message}`);
  }
}

async function checkAndUpdate() {
  // Tránh race condition - nếu đang chạy thì bỏ qua
  if (isRunning) {
    console.warn(`[${new Date().toISOString()}] ⚠️  checkAndUpdate đang chạy, bỏ qua lần này`);
    return;
  }

  isRunning = true;
  try {
    const publicIp = await getPublicIp();
    if (!publicIp) {
      console.error(`[${new Date().toISOString()}] Không lấy được IP công khai, bỏ qua lần này.`);
      return;
    }

    for (const domainConfig of DOMAINS) {
      const record = await getARecord(domainConfig);
      if (!record) continue;

      if (record.ip === publicIp) {
        console.log(`[${new Date().toISOString()}] A record cho ${domainConfig.name} đã khớp (${publicIp}), bỏ qua.`);
      } else {
        console.log(`[${new Date().toISOString()}] A record cho ${domainConfig.name} khác (${record.ip} vs ${publicIp}), đang cập nhật...`);
        await updateARecord(domainConfig, record.recordId, publicIp, record.ip);
      }
    }
  } finally {
    isRunning = false;
  }
}

// Biến để quản lý timer
let timer = null;
let isShuttingDown = false;

// Hàm startup với retry - đảm bảo lần kiểm tra đầu tiên thành công
async function startupWithRetry() {
  console.log(`[${new Date().toISOString()}] 🔄 Đợi ${STARTUP_DELAY_SECONDS}s để network sẵn sàng...`);
  await new Promise(r => setTimeout(r, STARTUP_DELAY_SECONDS * 1000));

  for (let attempt = 1; attempt <= STARTUP_RETRIES; attempt++) {
    console.log(`[${new Date().toISOString()}] 🚀 Thử kiểm tra startup (lần ${attempt}/${STARTUP_RETRIES})...`);

    const publicIp = await getPublicIp();
    if (publicIp) {
      console.log(`[${new Date().toISOString()}] ✅ Network sẵn sàng, IP hiện tại: ${publicIp}`);
      await checkAndUpdate();
      return true;
    }

    if (attempt < STARTUP_RETRIES) {
      const delay = Math.min(5000 * attempt, 30000); // 5s, 10s, 15s, ...
      console.warn(`[${new Date().toISOString()}] ⚠️  Chưa lấy được IP, thử lại sau ${delay/1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.error(`[${new Date().toISOString()}] ❌ Không thể lấy IP sau ${STARTUP_RETRIES} lần thử. Sẽ tiếp tục thử theo chu kỳ thông thường...`);
  return false;
}

// Hàm lặp với setTimeout đệ quy (tránh race condition)
function scheduleNextCheck() {
  if (isShuttingDown) return;
  timer = setTimeout(async () => {
    await checkAndUpdate();
    scheduleNextCheck(); // Đệ quy sau khi hoàn thành
  }, CHECK_INTERVAL_SECONDS * 1000);
}

// Graceful shutdown handler
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[${new Date().toISOString()}] 🛑 Nhận tín hiệu ${signal}, đang dừng...`);

  if (timer) {
    clearTimeout(timer);
    console.log(`[${new Date().toISOString()}] ✅ Đã hủy timer`);
  }

  if (isRunning) {
    console.log(`[${new Date().toISOString()}] ⏳ Đang đợi checkAndUpdate() hoàn thành...`);
    const checkInterval = setInterval(() => {
      if (!isRunning) {
        clearInterval(checkInterval);
        console.log(`[${new Date().toISOString()}] ✅ Script đã dừng an toàn`);
        process.exit(0);
      }
    }, 100);

    // Timeout sau 30 giây
    setTimeout(() => {
      console.log(`[${new Date().toISOString()}] ⚠️  Timeout, thoát cưỡng bức`);
      process.exit(1);
    }, 30000);
  } else {
    console.log(`[${new Date().toISOString()}] ✅ Script đã dừng an toàn`);
    process.exit(0);
  }
}

// Đăng ký signal handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Khởi động
console.log(`[${new Date().toISOString()}] 🚀 Bắt đầu script Dynamic DNS...`);
validateConfig();
console.log(`[${new Date().toISOString()}] ⚙️  Startup delay: ${STARTUP_DELAY_SECONDS}s, Startup retries: ${STARTUP_RETRIES}, Check interval: ${CHECK_INTERVAL_SECONDS}s`);

startupWithRetry().then(() => {
  console.log(`[${new Date().toISOString()}] ⏰ Lập lịch kiểm tra tiếp theo sau ${CHECK_INTERVAL_SECONDS} giây...`);
  scheduleNextCheck();
});
