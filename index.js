const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { generateKeywords } = require('./add_keywords');
const { initializeRAG, searchSimilarQuestions, refreshRAG } = require('./rag_handler');
const { createChat, continueChat, getChat } = require('./chat_bot');
require('dotenv').config();
const https = require('https');
const app = express();
const PORT = 3456;
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

// Middleware برای پارس کردن JSON
app.use(express.json());
const cors = require('cors');
app.use(cors());

const config = {
  key: fsSync.readFileSync("/etc/letsencrypt/live/srv1.sallamschool.org/privkey.pem"),
  cert: fsSync.readFileSync("/etc/letsencrypt/live/srv1.sallamschool.org/fullchain.pem")
}

/**
 * خواندن فایل سوالات
 */
async function readQuestions() {
  try {
    const data = await fs.readFile(QUESTIONS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('خطا در خواندن فایل سوالات:', error);
    throw error;
  }
}

/**
 * نوشتن فایل سوالات
 */
async function writeQuestions(questions) {
  try {
    await fs.writeFile(QUESTIONS_FILE, JSON.stringify(questions, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('خطا در نوشتن فایل سوالات:', error);
    throw error;
  }
}

/**
 * GET /questions - دریافت لیست همه سوالات
 */
app.get('/questions', async (req, res) => {
  try {
    const questions = await readQuestions();
    res.json({
      success: true,
      count: questions.length,
      data: questions
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'خطا در دریافت سوالات',
      message: error.message
    });
  }
});

/**
 * GET /questions/:id - دریافت یک سوال خاص
 */
app.get('/questions/:id', async (req, res) => {
  try {
    const questions = await readQuestions();
    const id = parseInt(req.params.id);

    if (isNaN(id) || id < 0 || id >= questions.length) {
      return res.status(404).json({
        success: false,
        error: 'سوال یافت نشد'
      });
    }

    res.json({
      success: true,
      data: questions[id]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'خطا در دریافت سوال',
      message: error.message
    });
  }
});

/**
 * POST /questions - افزودن سوال جدید
 */
app.post('/questions', async (req, res) => {
  try {
    const { question, answer, category, audience } = req.body;

    // اعتبارسنجی ورودی‌ها
    if (!question || !answer) {
      return res.status(400).json({
        success: false,
        error: 'سوال و جواب الزامی است'
      });
    }

    if (!category || !audience) {
      return res.status(400).json({
        success: false,
        error: 'دسته‌بندی و مخاطب الزامی است'
      });
    }

    // تولید کلمات کلیدی
    console.log('🔄 در حال تولید کلمات کلیدی برای سوال جدید...');
    let keywords;
    try {
      keywords = await generateKeywords(question, answer);
      console.log('✅ کلمات کلیدی تولید شد:', keywords);
    } catch (error) {
      console.error('❌ خطا در تولید کلمات کلیدی:', error);
      return res.status(500).json({
        success: false,
        error: 'خطا در تولید کلمات کلیدی',
        message: error.message
      });
    }

    // خواندن سوالات موجود
    const questions = await readQuestions();

    // ایجاد سوال جدید
    const newQuestion = {
      question: question.trim(),
      answer: answer.trim(),
      category: category.trim(),
      audience: audience.trim(),
      keywords: keywords
    };

    // افزودن به لیست
    questions.push(newQuestion);

    // ذخیره در فایل
    await writeQuestions(questions);

    // به‌روزرسانی RAG
    try {
      await refreshRAG();
    } catch (ragError) {
      console.error('⚠️ خطا در به‌روزرسانی RAG:', ragError);
    }

    console.log(`✅ سوال جدید با موفقیت افزوده شد (شماره: ${questions.length - 1})`);

    res.status(201).json({
      success: true,
      message: 'سوال با موفقیت افزوده شد',
      data: {
        id: questions.length - 1,
        ...newQuestion
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'خطا در افزودن سوال',
      message: error.message
    });
  }
});

/**
 * PUT /questions/:id - ویرایش سوال موجود
 */
app.put('/questions/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { question, answer, category, audience } = req.body;

    // خواندن سوالات موجود
    const questions = await readQuestions();

    // بررسی وجود سوال
    if (isNaN(id) || id < 0 || id >= questions.length) {
      return res.status(404).json({
        success: false,
        error: 'سوال یافت نشد'
      });
    }

    // اعتبارسنجی ورودی‌ها
    if (!question || !answer) {
      return res.status(400).json({
        success: false,
        error: 'سوال و جواب الزامی است'
      });
    }

    if (!category || !audience) {
      return res.status(400).json({
        success: false,
        error: 'دسته‌بندی و مخاطب الزامی است'
      });
    }

    // بررسی تغییرات برای تولید مجدد کلمات کلیدی
    const oldQuestion = questions[id];
    const questionChanged = oldQuestion.question !== question.trim();
    const answerChanged = oldQuestion.answer !== answer.trim();

    let keywords = oldQuestion.keywords;

    // اگر سوال یا جواب تغییر کرده باشد، کلمات کلیدی را مجدد تولید می‌کنیم
    if (questionChanged || answerChanged) {
      console.log('🔄 در حال تولید مجدد کلمات کلیدی...');
      try {
        keywords = await generateKeywords(question, answer);
        console.log('✅ کلمات کلیدی جدید تولید شد:', keywords);
      } catch (error) {
        console.error('❌ خطا در تولید کلمات کلیدی:', error);
        return res.status(500).json({
          success: false,
          error: 'خطا در تولید کلمات کلیدی',
          message: error.message
        });
      }
    }

    // به‌روزرسانی سوال
    questions[id] = {
      question: question.trim(),
      answer: answer.trim(),
      category: category.trim(),
      audience: audience.trim(),
      keywords: keywords
    };

    // ذخیره در فایل
    await writeQuestions(questions);

    // به‌روزرسانی RAG
    try {
      await refreshRAG();
    } catch (ragError) {
      console.error('⚠️ خطا در به‌روزرسانی RAG:', ragError);
    }

    console.log(`✅ سوال شماره ${id} با موفقیت ویرایش شد`);

    res.json({
      success: true,
      message: 'سوال با موفقیت ویرایش شد',
      data: {
        id: id,
        ...questions[id]
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'خطا در ویرایش سوال',
      message: error.message
    });
  }
});

/**
 * DELETE /questions/:id - حذف سوال
 */
app.delete('/questions/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // خواندن سوالات موجود
    const questions = await readQuestions();

    // بررسی وجود سوال
    if (isNaN(id) || id < 0 || id >= questions.length) {
      return res.status(404).json({
        success: false,
        error: 'سوال یافت نشد'
      });
    }

    // حذف سوال
    const deletedQuestion = questions.splice(id, 1)[0];

    // ذخیره در فایل
    await writeQuestions(questions);

    // به‌روزرسانی RAG
    try {
      await refreshRAG();
    } catch (ragError) {
      console.error('⚠️ خطا در به‌روزرسانی RAG:', ragError);
    }

    console.log(`✅ سوال شماره ${id} با موفقیت حذف شد`);

    res.json({
      success: true,
      message: 'سوال با موفقیت حذف شد',
      data: deletedQuestion
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'خطا در حذف سوال',
      message: error.message
    });
  }
});

/**
 * POST /search - جستجوی سوالات مرتبط با استفاده از RAG
 */
app.post('/search', async (req, res) => {
  try {
    const { question, topK } = req.body;

    // اعتبارسنجی ورودی
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'سوال الزامی است و باید یک رشته غیر خالی باشد'
      });
    }

    // تعداد نتایج (پیش‌فرض: 10)
    const limit = topK && !isNaN(parseInt(topK)) && parseInt(topK) > 0
      ? Math.min(parseInt(topK), 50) // حداکثر 50 نتیجه
      : 10;

    // جستجوی سوالات مرتبط
    const similarQuestions = await searchSimilarQuestions(question.trim(), limit);

    res.json({
      success: true,
      query: question.trim(),
      count: similarQuestions.length,
      data: similarQuestions
    });
  } catch (error) {
    console.error('❌ خطا در جستجو:', error);
    res.status(500).json({
      success: false,
      error: 'خطا در جستجوی سوالات',
      message: error.message
    });
  }
});

/**
 * POST /chat/create - ایجاد چت جدید
 */
app.post('/chat/create', async (req, res) => {
  try {
    const { userName, question } = req.body;

    // اعتبارسنجی ورودی‌ها
    if (!userName || typeof userName !== 'string' || userName.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'نام کاربر الزامی است'
      });
    }

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'سوال الزامی است'
      });
    }

    // ایجاد چت جدید
    const chatResult = await createChat(userName.trim(), question.trim());

    res.status(201).json({
      success: true,
      message: 'چت با موفقیت ایجاد شد',
      data: chatResult
    });
  } catch (error) {
    console.error('❌ خطا در ایجاد چت:', error);
    res.status(500).json({
      success: false,
      error: 'خطا در ایجاد چت',
      message: error.message
    });
  }
});

/**
 * POST /chat/continue - ادامه دادن به چت موجود
 */
app.post('/chat/continue', async (req, res) => {
  try {
    const { chatId, question } = req.body;

    // اعتبارسنجی ورودی‌ها
    if (!chatId || typeof chatId !== 'string' || chatId.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'شناسه چت الزامی است'
      });
    }

    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'سوال الزامی است'
      });
    }

    // ادامه دادن به چت
    const chatResult = await continueChat(chatId.trim(), question.trim());

    res.json({
      success: true,
      message: 'پاسخ با موفقیت دریافت شد',
      data: chatResult
    });
  } catch (error) {
    console.error('❌ خطا در ادامه چت:', error);

    // اگر چت یافت نشد، خطای 404 برگردان
    if (error.message === 'چت یافت نشد') {
      return res.status(404).json({
        success: false,
        error: error.message
      });
    }

    res.status(500).json({
      success: false,
      error: 'خطا در ادامه چت',
      message: error.message
    });
  }
});

/**
 * GET /chat/:chatId - دریافت اطلاعات یک چت
 */
app.get('/chat/:chatId', async (req, res) => {
  try {
    const { chatId } = req.params;

    if (!chatId || chatId.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'شناسه چت الزامی است'
      });
    }

    const chat = await getChat(chatId.trim());

    res.json({
      success: true,
      data: chat
    });
  } catch (error) {
    console.error('❌ خطا در دریافت چت:', error);

    if (error.message === 'چت یافت نشد') {
      return res.status(404).json({
        success: false,
        error: error.message
      });
    }

    res.status(500).json({
      success: false,
      error: 'خطا در دریافت چت',
      message: error.message
    });
  }
});

// راه‌اندازی سرور
https.createServer(config, app).listen(PORT, async () => {
  console.log(` سرور در حال اجرا است روی پورت ${PORT}`);

  // مقداردهی اولیه RAG در پس‌زمینه
  try {
    await initializeRAG();
  } catch (error) {
    console.error('⚠️ خطا در مقداردهی اولیه RAG:', error);
    console.log('⚠️ سیستم RAG در دسترس نیست، اما سایر API ها کار می‌کنند');
  }
});

module.exports = app;

