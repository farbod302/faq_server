const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const { searchSimilarQuestions } = require('./rag_handler');

const CHAT_HISTORY_FILE = path.join(__dirname, 'chat_history.json');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * خواندن تاریخچه چت‌ها از فایل
 */
async function readChatHistory() {
  try {
    const data = await fs.readFile(CHAT_HISTORY_FILE, 'utf8');
    const history = JSON.parse(data);
    return history || {};
  } catch (error) {
    // اگر فایل وجود نداشت یا خالی بود، یک object خالی برمی‌گردانیم
    if (error.code === 'ENOENT') {
      return {};
    }
    console.error('خطا در خواندن تاریخچه چت:', error);
    return {};
  }
}

/**
 * ذخیره تاریخچه چت‌ها در فایل
 */
async function saveChatHistory(history) {
  try {
    await fs.writeFile(CHAT_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('خطا در ذخیره تاریخچه چت:', error);
    throw error;
  }
}

/**
 * تولید ID یکتا برای چت
 */
function generateChatId() {
  return `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * دریافت کانتکست مرتبط با استفاده از RAG
 */
async function getRelevantContext(userQuestion, topK = 5) {
  try {
    const similarQuestions = await searchSimilarQuestions(userQuestion, topK);
    
    // ساخت کانتکست از سوالات و جواب‌های مرتبط
    const contextParts = similarQuestions.map((item, idx) => {
      return `سوال ${idx + 1}: ${item.question}\nجواب ${idx + 1}: ${item.answer}`;
    });
    
    return contextParts.join('\n\n');
  } catch (error) {
    console.error('❌ خطا در دریافت کانتکست از RAG:', error);
    return '';
  }
}

/**
 * ارسال درخواست به OpenAI API
 */
async function callOpenAI(messages) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: messages,
      temperature: 0.7,
      max_tokens: 1000
    });

    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const jsonResponse = JSON.parse(responseData);
          
          if (jsonResponse.error) {
            reject(new Error(jsonResponse.error.message || 'خطا در API OpenAI'));
            return;
          }

          if (!jsonResponse.choices || !jsonResponse.choices[0] || !jsonResponse.choices[0].message) {
            reject(new Error('پاسخ نامعتبر از API'));
            return;
          }

          const assistantMessage = jsonResponse.choices[0].message.content.trim();
          resolve(assistantMessage);
        } catch (parseError) {
          reject(new Error(`خطا در پارس پاسخ: ${parseError.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`خطا در درخواست: ${error.message}`));
    });

    req.write(data);
    req.end();
  });
}

/**
 * ساخت پیام‌های سیستم برای OpenAI
 */
function buildSystemMessage(context) {
  let systemMessage = `شما یک دستیار هوشمند فارسی هستید که به سوالات کاربران پاسخ می‌دهید. 
از اطلاعات زیر به عنوان مرجع استفاده کنید، اما اگر سوال کاربر خارج از این اطلاعات باشد، 
از دانش عمومی خود استفاده کنید و پاسخ مفید و دقیق بدهید.

اطلاعات مرجع:
${context}

لطفاً پاسخ‌های خود را به فارسی و به صورت واضح و مفصل ارائه دهید.`;

  return systemMessage;
}

/**
 * ایجاد چت جدید
 * @param {string} userName - نام کاربر
 * @param {string} firstQuestion - سوال اولیه کاربر
 * @returns {Promise<Object>} اطلاعات چت ایجاد شده
 */
async function createChat(userName, firstQuestion) {
  try {
    // خواندن تاریخچه موجود
    const history = await readChatHistory();
    
    // تولید ID یکتا برای چت
    const chatId = generateChatId();
    
    // دریافت کانتکست مرتبط با استفاده از RAG
    console.log(`🔍 در حال دریافت کانتکست برای سوال: "${firstQuestion}"`);
    const context = await getRelevantContext(firstQuestion);
    
    // ساخت پیام سیستم با کانتکست
    const systemMessage = buildSystemMessage(context);
    
    // ساخت آرایه پیام‌ها برای OpenAI
    const messages = [
      {
        role: "system",
        content: systemMessage
      },
      {
        role: "user",
        content: firstQuestion
      }
    ];
    
    // دریافت پاسخ از OpenAI
    console.log(`🤖 در حال دریافت پاسخ از OpenAI...`);
    const assistantResponse = await callOpenAI(messages);
    
    // ذخیره چت در تاریخچه
    const userTimestamp = new Date().toISOString();
    const assistantTimestamp = new Date().toISOString();
    const createdAt = userTimestamp;
    
    const chat = {
      chatId: chatId,
      userName: userName,
      messages: [
        {
          role: "user",
          content: firstQuestion,
          timestamp: userTimestamp
        },
        {
          role: "assistant",
          content: assistantResponse,
          timestamp: assistantTimestamp
        }
      ],
      createdAt: createdAt,
      updatedAt: assistantTimestamp,
      context: context // ذخیره کانتکست برای استفاده بعدی
    };
    
    history[chatId] = chat;
    await saveChatHistory(history);
    
    console.log(`✅ چت جدید با ID ${chatId} ایجاد شد`);
    
    return {
      chatId: chatId,
      userName: userName,
      userMessage: firstQuestion,
      assistantMessage: assistantResponse,
      timestamp: assistantTimestamp
    };
  } catch (error) {
    console.error('❌ خطا در ایجاد چت:', error);
    throw error;
  }
}

/**
 * ادامه دادن به چت موجود
 * @param {string} chatId - شناسه چت
 * @param {string} userQuestion - سوال جدید کاربر
 * @returns {Promise<Object>} پاسخ ربات
 */
async function continueChat(chatId, userQuestion) {
  try {
    // خواندن تاریخچه موجود
    const history = await readChatHistory();
    
    // بررسی وجود چت
    if (!history[chatId]) {
      throw new Error('چت یافت نشد');
    }
    
    const chat = history[chatId];
    
    // دریافت کانتکست جدید برای سوال جدید
    console.log(`🔍 در حال دریافت کانتکست برای سوال: "${userQuestion}"`);
    const context = await getRelevantContext(userQuestion);
    
    // ساخت پیام سیستم با کانتکست جدید
    const systemMessage = buildSystemMessage(context);
    
    // ساخت آرایه پیام‌ها شامل تاریخچه قبلی
    const messages = [
      {
        role: "system",
        content: systemMessage
      }
    ];
    
    // اضافه کردن تاریخچه قبلی (فقط محتوای پیام‌ها)
    chat.messages.forEach(msg => {
      messages.push({
        role: msg.role,
        content: msg.content
      });
    });
    
    // اضافه کردن سوال جدید کاربر
    messages.push({
      role: "user",
      content: userQuestion
    });
    
    // دریافت پاسخ از OpenAI
    console.log(`🤖 در حال دریافت پاسخ از OpenAI...`);
    const assistantResponse = await callOpenAI(messages);
    
    // به‌روزرسانی چت
    const timestamp = new Date().toISOString();
    chat.messages.push({
      role: "user",
      content: userQuestion,
      timestamp: timestamp
    });
    chat.messages.push({
      role: "assistant",
      content: assistantResponse,
      timestamp: timestamp
    });
    chat.updatedAt = timestamp;
    chat.context = context; // به‌روزرسانی کانتکست
    
    // ذخیره تاریخچه به‌روز شده
    history[chatId] = chat;
    await saveChatHistory(history);
    
    console.log(`✅ چت ${chatId} به‌روزرسانی شد`);
    
    return {
      chatId: chatId,
      userMessage: userQuestion,
      assistantMessage: assistantResponse,
      timestamp: timestamp
    };
  } catch (error) {
    console.error('❌ خطا در ادامه چت:', error);
    throw error;
  }
}

/**
 * دریافت اطلاعات یک چت
 * @param {string} chatId - شناسه چت
 * @returns {Promise<Object>} اطلاعات چت
 */
async function getChat(chatId) {
  try {
    const history = await readChatHistory();
    
    if (!history[chatId]) {
      throw new Error('چت یافت نشد');
    }
    
    return history[chatId];
  } catch (error) {
    console.error('❌ خطا در دریافت چت:', error);
    throw error;
  }
}

module.exports = {
  createChat,
  continueChat,
  getChat,
  readChatHistory
};

