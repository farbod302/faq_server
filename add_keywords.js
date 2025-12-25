const https = require('https');

/**
 * تولید 3 کلمه کلیدی برای سوال و جواب با استفاده از OpenAI API
 * @param {string} question - متن سوال
 * @param {string} answer - متن جواب
 * @param {string} apiKey - کلید API OpenAI
 * @returns {Promise<string[]>} آرایه‌ای از 3 کلمه کلیدی
 */
const apiKey = process.env.OPENAI_API_KEY;
async function generateKeywords(question, answer) {
  return new Promise((resolve, reject) => {
    const prompt = `برای سوال و جواب زیر، دقیقاً 3 کلمه کلیدی فارسی مناسب تولید کن. هر کلمه کلیدی باید در یک خط جداگانه باشد و فقط کلمه کلیدی باشد (بدون شماره، بدون توضیح، بدون ویرگول).

سوال: ${question}

جواب: ${answer}

فقط 3 کلمه کلیدی را برگردان. هر کلمه در یک خط جداگانه:`;

    const data = JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "شما یک دستیار هوشمند هستید که کلمات کلیدی مناسب برای سوالات و جواب‌های فارسی تولید می‌کنید. فقط کلمات کلیدی را برگردانید، بدون توضیح اضافی."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.7,
      max_tokens: 50
    });

    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
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

          const keywordsText = jsonResponse.choices[0].message.content.trim();
          
          // تبدیل متن به آرایه کلمات کلیدی
          // ابتدا سعی می‌کنیم با خط جدید جدا کنیم
          let keywords = keywordsText
            .split('\n')
            .map(k => k.trim())
            .filter(k => k.length > 0)
            // حذف شماره‌ها و علائم از ابتدای هر خط
            .map(k => k.replace(/^[\d\-\.\)\)\s]+/, '').trim())
            // حذف علائم اضافی مانند ":" از انتهای کلمات
            .map(k => k.replace(/[:：]\s*.*$/, '').trim())
            .filter(k => k.length > 0);

          // اگر کلمات با ویرگول آمده باشند، آنها را جدا می‌کنیم
          if (keywords.length === 1 && keywords[0].includes('،')) {
            keywords = keywords[0]
              .split('،')
              .map(k => k.trim())
              .filter(k => k.length > 0);
          }
          
          // اگر هنوز با ویرگول انگلیسی آمده باشد
          if (keywords.length === 1 && keywords[0].includes(',')) {
            keywords = keywords[0]
              .split(',')
              .map(k => k.trim())
              .filter(k => k.length > 0);
          }

          // فقط 3 کلمه اول را برمی‌گردانیم
          keywords = keywords.slice(0, 3);

          if (keywords.length === 0) {
            reject(new Error('هیچ کلمه کلیدی تولید نشد'));
            return;
          }

          resolve(keywords);
        } catch (error) {
          reject(new Error(`خطا در پردازش پاسخ: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`خطا در ارتباط با API: ${error.message}`));
    });

    req.write(data);
    req.end();
  });
}

module.exports = { generateKeywords };

