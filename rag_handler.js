const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const QUESTIONS_FILE = path.join(__dirname, 'questions.json');
const VECTORS_CACHE_FILE = path.join(__dirname, 'vectors_cache.json');
const QUESTIONS_HASH_FILE = path.join(__dirname, 'questions_hash.txt');
const QUESTIONS_INDICES_HASH_FILE = path.join(__dirname, 'questions_indices_hash.json');

// کلید API OpenAI - باید از متغیر محیطی یا فایل config خوانده شود
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

let ragApp = null;
let questionsData = null;
let isInitialized = false;
// Map برای نگهداری metadata بر اساس محتوای chunk
const chunkMetadataMap = new Map();

// یک vector database ساده در-memory با قابلیت ذخیره و بارگذاری
class SimpleMemoryVectorDatabase {
    constructor() {
        this.vectors = [];
        this.dimensions = null;
    }

    async init({ dimensions }) {
        // فقط dimensions را به‌روزرسانی می‌کنیم، vectors را پاک نمی‌کنیم
        // چون ممکن است از cache بارگذاری شده باشند
        const existingVectors = this.vectors.length;
        this.dimensions = dimensions;
        // اگر vectors از قبل وجود دارند (از cache)، آنها را نگه می‌داریم
        // vectors را reset نمی‌کنیم تا cache حفظ شود
        if (existingVectors === 0) {
            this.vectors = [];
        }
        // در غیر این صورت، vectors موجود را نگه می‌داریم
    }
    
    // بارگذاری vectors از فایل
    async loadFromFile(filePath) {
        try {
            const data = await fs.readFile(filePath, 'utf8');
            const cache = JSON.parse(data);
            this.vectors = cache.vectors || [];
            this.dimensions = cache.dimensions || null;
            console.log(`✅ ${this.vectors.length} vector از cache بارگذاری شد`);
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('ℹ️ فایل cache یافت نشد، embeddings جدید ایجاد می‌شود');
                return false;
            }
            console.error('⚠️ خطا در بارگذاری cache:', error.message);
            return false;
        }
    }
    
    // ذخیره vectors در فایل
    async saveToFile(filePath) {
        try {
            const cache = {
                vectors: this.vectors,
                dimensions: this.dimensions,
                savedAt: new Date().toISOString()
            };
            await fs.writeFile(filePath, JSON.stringify(cache, null, 2), 'utf8');
            console.log(`✅ ${this.vectors.length} vector در cache ذخیره شد`);
            return true;
        } catch (error) {
            console.error('⚠️ خطا در ذخیره cache:', error.message);
            return false;
        }
    }

    async insertChunks(chunks) {
        chunks.forEach(chunk => {
            this.vectors.push({
                pageContent: chunk.pageContent,
                vector: chunk.vector,
                metadata: chunk.metadata
            });
        });
        return chunks.length;
    }
    
    // بررسی اینکه آیا vectors از قبل بارگذاری شده‌اند
    hasVectors() {
        return this.vectors.length > 0;
    }

    async similaritySearch(queryVector, topK) {
        // محاسبه similarity با cosine similarity
        const results = this.vectors.map(item => {
            const score = this.cosineSimilarity(queryVector, item.vector);
            return {
                pageContent: item.pageContent,
                metadata: item.metadata,
                score: score
            };
        });

        // مرتب‌سازی بر اساس score و برگرداندن topK نتیجه
        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }

    cosineSimilarity(vecA, vecB) {
        if (vecA.length !== vecB.length) return 0;
        
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        
        if (normA === 0 || normB === 0) return 0;
        
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    async getVectorCount() {
        return this.vectors.length;
    }

    async reset() {
        this.vectors = [];
    }

    async deleteKeys(prefix) {
        const beforeLength = this.vectors.length;
        this.vectors = this.vectors.filter(v => {
            const id = v.metadata?.id || '';
            return !id.startsWith(prefix);
        });
        return beforeLength - this.vectors.length;
    }
    
    // حذف vectors مربوط به یک سوال خاص (بر اساس index)
    async deleteVectorsByIndex(index) {
        const beforeLength = this.vectors.length;
        this.vectors = this.vectors.filter(v => {
            // بررسی metadata برای پیدا کردن vectors مربوط به این index
            const pageContent = v.pageContent || '';
            const indexMatch = pageContent.match(/\[INDEX:(\d+)\]/);
            if (indexMatch) {
                const vectorIndex = parseInt(indexMatch[1]);
                return vectorIndex !== index;
            }
            // اگر metadata index نداشت، بررسی metadata object
            if (v.metadata && v.metadata.index !== undefined) {
                return v.metadata.index !== index;
            }
            return true; // نگه داشتن vector اگر index مشخص نباشد
        });
        return beforeLength - this.vectors.length;
    }
    
    // دریافت تعداد vectors مربوط به یک index خاص
    getVectorCountByIndex(index) {
        return this.vectors.filter(v => {
            const pageContent = v.pageContent || '';
            const indexMatch = pageContent.match(/\[INDEX:(\d+)\]/);
            if (indexMatch) {
                return parseInt(indexMatch[1]) === index;
            }
            if (v.metadata && v.metadata.index !== undefined) {
                return v.metadata.index === index;
            }
            return false;
        }).length;
    }
}

/**
 * محاسبه hash از محتوای یک سوال خاص
 */
function calculateQuestionHash(questionObj) {
  const content = JSON.stringify({
    question: questionObj.question,
    answer: questionObj.answer,
    category: questionObj.category || '',
    audience: questionObj.audience || '',
    keywords: (questionObj.keywords || []).sort().join(',')
  });
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * محاسبه hash از محتوای سوالات برای بررسی تغییرات کلی
 */
async function calculateQuestionsHash() {
  try {
    const data = await fs.readFile(QUESTIONS_FILE, 'utf8');
    const hash = crypto.createHash('md5').update(data).digest('hex');
    return hash;
  } catch (error) {
    console.error('خطا در محاسبه hash:', error);
    return null;
  }
}

/**
 * محاسبه hash برای هر سوال به صورت جداگانه
 */
async function calculateQuestionsIndicesHash() {
  try {
    const questions = await loadQuestions();
    const indicesHash = {};
    
    questions.forEach((question, index) => {
      indicesHash[index] = calculateQuestionHash(question);
    });
    
    return indicesHash;
  } catch (error) {
    console.error('خطا در محاسبه hash سوالات:', error);
    return {};
  }
}

/**
 * خواندن hash ذخیره شده
 */
async function getStoredHash() {
  try {
    const hash = await fs.readFile(QUESTIONS_HASH_FILE, 'utf8');
    return hash.trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

/**
 * خواندن hash سوالات ذخیره شده
 */
async function getStoredIndicesHash() {
  try {
    const data = await fs.readFile(QUESTIONS_INDICES_HASH_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    return {};
  }
}

/**
 * ذخیره hash
 */
async function saveHash(hash) {
  try {
    await fs.writeFile(QUESTIONS_HASH_FILE, hash, 'utf8');
  } catch (error) {
    console.error('خطا در ذخیره hash:', error);
  }
}

/**
 * ذخیره hash سوالات
 */
async function saveIndicesHash(indicesHash) {
  try {
    await fs.writeFile(QUESTIONS_INDICES_HASH_FILE, JSON.stringify(indicesHash, null, 2), 'utf8');
  } catch (error) {
    console.error('خطا در ذخیره hash سوالات:', error);
  }
}

/**
 * بررسی اینکه آیا سوالات تغییر کرده‌اند
 */
async function hasQuestionsChanged() {
  const currentHash = await calculateQuestionsHash();
  const storedHash = await getStoredHash();
  
  if (!storedHash) {
    return true; // اگر hash ذخیره شده وجود نداشته باشد، یعنی باید embeddings انجام شود
  }
  
  return currentHash !== storedHash;
}

/**
 * پیدا کردن سوالات تغییر یافته، جدید و حذف شده
 */
async function findChangedQuestions() {
  const currentIndicesHash = await calculateQuestionsIndicesHash();
  const storedIndicesHash = await getStoredIndicesHash();
  
  console.log(`📊 تعداد hash‌های فعلی: ${Object.keys(currentIndicesHash).length}`);
  console.log(`📊 تعداد hash‌های ذخیره شده: ${Object.keys(storedIndicesHash).length}`);
  
  const changed = [];
  const newIndices = [];
  const deletedIndices = [];
  
  // پیدا کردن سوالات تغییر یافته و جدید
  Object.keys(currentIndicesHash).forEach(index => {
    const indexNum = parseInt(index);
    if (!storedIndicesHash[index] || storedIndicesHash[index] !== currentIndicesHash[index]) {
      if (storedIndicesHash[index]) {
        changed.push(indexNum);
      } else {
        newIndices.push(indexNum);
      }
    }
  });
  
  // پیدا کردن سوالات حذف شده
  Object.keys(storedIndicesHash).forEach(index => {
    const indexNum = parseInt(index);
    if (!currentIndicesHash[index]) {
      deletedIndices.push(indexNum);
    }
  });
  
  return {
    changed,
    newIndices,
    deletedIndices,
    allChanged: [...changed, ...newIndices]
  };
}

/**
 * خواندن سوالات از فایل JSON
 */
async function loadQuestions() {
  try {
    const data = await fs.readFile(QUESTIONS_FILE, 'utf8');
    questionsData = JSON.parse(data);
    return questionsData;
  } catch (error) {
    console.error('خطا در خواندن فایل سوالات:', error);
    throw error;
  }
}

/**
 * ایجاد متن قابل جستجو از سوال
 * شامل سوال، keywords و دسته‌بندی
 */
function createSearchableText(questionObj) {
  const parts = [
    questionObj.question,
    ...(questionObj.keywords || []),
    questionObj.category || '',
    questionObj.audience || ''
  ].filter(Boolean);
  
  return parts.join(' ');
}

/**
 * مقداردهی اولیه سیستم RAG
 */
async function initializeRAG() {
  if (isInitialized) {
    return;
  }

  try {
    console.log('🔄 در حال مقداردهی اولیه سیستم RAG...');
    
    // بارگذاری سوالات
    await loadQuestions();
   
    
    // Dynamic import برای ES modules
    const { RAGApplicationBuilder, TextLoader } = await import('@llm-tools/embedjs');
    const { OpenAiEmbeddings } = await import('@llm-tools/embedjs-openai');
    
    // ایجاد vector database
    const vectorDatabase = new SimpleMemoryVectorDatabase();
    
    // تلاش برای بارگذاری vectors از cache
    const cacheLoaded = await vectorDatabase.loadFromFile(VECTORS_CACHE_FILE);
    const vectorCountBeforeBuild = vectorDatabase.vectors.length;
    console.log(`📊 تعداد vectors قبل از build: ${vectorCountBeforeBuild}`);
    
    // ایجاد embeddings model
    const embeddingsModel = new OpenAiEmbeddings({ openAIApiKey: OPENAI_API_KEY, model: "text-embedding-3-small" });
    
    // ایجاد RAG application
    ragApp = await new RAGApplicationBuilder()
      .setEmbeddingModel(embeddingsModel)
      .setVectorDatabase(vectorDatabase)
      .build();
    
    const vectorCountAfterBuild = vectorDatabase.vectors.length;
    console.log(`📊 تعداد vectors بعد از build: ${vectorCountAfterBuild}`);
    
    // اگر بعد از build، vectors پاک شدند، دوباره از cache بارگذاری می‌کنیم
    if (cacheLoaded && vectorCountBeforeBuild > 0 && vectorCountAfterBuild === 0) {
      console.log('⚠️ Vectors بعد از build پاک شدند - دوباره از cache بارگذاری می‌شوند');
      await vectorDatabase.loadFromFile(VECTORS_CACHE_FILE);
      console.log(`✅ ${vectorDatabase.vectors.length} vector دوباره بارگذاری شد`);
    }
    
    if (cacheLoaded && vectorDatabase.hasVectors()) {
      // اگر cache وجود دارد، بررسی می‌کنیم که آیا تغییراتی وجود دارد
      console.log('🔍 بررسی تغییرات در سوالات...');
      const changes = await findChangedQuestions();
      console.log(`📊 تغییرات یافت شده: ${changes.changed.length} ویرایش شده، ${changes.newIndices.length} جدید، ${changes.deletedIndices.length} حذف شده`);
      
      if (changes.allChanged.length === 0 && changes.deletedIndices.length === 0) {
        // هیچ تغییری وجود ندارد - استفاده کامل از cache
        console.log('✅ استفاده از cache موجود - هیچ تغییری یافت نشد');
        
        // بارگذاری metadata برای استفاده در جستجو
        for (let i = 0; i < questionsData.length; i++) {
          const question = questionsData[i];
          const metadata = {
            index: i,
            question: question.question,
            answer: question.answer,
            category: question.category || '',
            audience: question.audience || '',
            keywords: question.keywords || []
          };
          const metadataKey = `question_${i}`;
          chunkMetadataMap.set(metadataKey, metadata);
        }
        
        isInitialized = true;
        console.log(`✅ سیستم RAG با استفاده از cache مقداردهی شد (${vectorDatabase.vectors.length} vector موجود)`);
        
        // ذخیره hash سوالات
        const currentIndicesHash = await calculateQuestionsIndicesHash();
        await saveIndicesHash(currentIndicesHash);
        const currentHash = await calculateQuestionsHash();
        if (currentHash) {
          await saveHash(currentHash);
        }
        
        return;
      }
      
      // تغییراتی وجود دارد - به‌روزرسانی تدریجی
      console.log(`🔄 تغییرات یافت شد:`);
      console.log(`   - ${changes.changed.length} سوال ویرایش شده`);
      console.log(`   - ${changes.newIndices.length} سوال جدید`);
      console.log(`   - ${changes.deletedIndices.length} سوال حذف شده`);
      
      // حذف vectors مربوط به سوالات حذف شده
      for (const deletedIndex of changes.deletedIndices) {
        const deletedCount = await vectorDatabase.deleteVectorsByIndex(deletedIndex);
        console.log(`🗑️ ${deletedCount} vector مربوط به سوال ${deletedIndex} حذف شد`);
      }
      
      // حذف vectors مربوط به سوالات تغییر یافته (برای جایگزینی با نسخه جدید)
      for (const changedIndex of changes.changed) {
        const deletedCount = await vectorDatabase.deleteVectorsByIndex(changedIndex);
        console.log(`🔄 ${deletedCount} vector قدیمی مربوط به سوال ${changedIndex} حذف شد`);
      }
      
      // Embed کردن سوالات تغییر یافته و جدید
      const indicesToProcess = [...changes.changed, ...changes.newIndices].sort((a, b) => a - b);
      
      if (indicesToProcess.length > 0) {
        console.log(`📚 در حال پردازش ${indicesToProcess.length} سوال...`);
        
        for (const i of indicesToProcess) {
          const question = questionsData[i];
          const searchableText = createSearchableText(question);
          
          // ایجاد TextLoader برای سوال
          const textWithMetadata = `[INDEX:${i}][QUESTION:${question.question}][ANSWER:${question.answer}][CATEGORY:${question.category || ''}][AUDIENCE:${question.audience || ''}][KEYWORDS:${(question.keywords || []).join(',')}]\n\n${searchableText}`;
          
          // ذخیره metadata
          const metadata = {
            index: i,
            question: question.question,
            answer: question.answer,
            category: question.category || '',
            audience: question.audience || '',
            keywords: question.keywords || []
          };
          
          const metadataKey = `question_${i}`;
          chunkMetadataMap.set(metadataKey, metadata);
          
          const textLoader = new TextLoader({
            text: textWithMetadata,
            chunkSize: 1000,
            chunkOverlap: 100
          });
          
          // اضافه کردن loader به RAG
          await ragApp.addLoader(textLoader, false);
          console.log(`✅ سوال ${i} پردازش شد`);
        }
      }
      
      // بارگذاری metadata برای همه سوالات
      for (let i = 0; i < questionsData.length; i++) {
        const question = questionsData[i];
        const metadata = {
          index: i,
          question: question.question,
          answer: question.answer,
          category: question.category || '',
          audience: question.audience || '',
          keywords: question.keywords || []
        };
        const metadataKey = `question_${i}`;
        chunkMetadataMap.set(metadataKey, metadata);
      }
      
      // ذخیره cache به‌روز شده
      await vectorDatabase.saveToFile(VECTORS_CACHE_FILE);
      
      // ذخیره hash سوالات
      const currentIndicesHash = await calculateQuestionsIndicesHash();
      await saveIndicesHash(currentIndicesHash);
      const currentHash = await calculateQuestionsHash();
      if (currentHash) {
        await saveHash(currentHash);
      }
      
      isInitialized = true;
      console.log(`✅ سیستم RAG با به‌روزرسانی تدریجی مقداردهی شد (${vectorDatabase.vectors.length} vector موجود)`);
      return;
    }
    
    // اگر cache وجود نداشت، embeddings کامل ایجاد می‌کنیم
    console.log('⚠️ cache یافت نشد - embeddings کامل ایجاد می‌شود');
    
    // ایجاد RAG application با OpenAI embeddings و vector database
    ragApp = await new RAGApplicationBuilder()
      .setEmbeddingModel(new OpenAiEmbeddings({ openAIApiKey: OPENAI_API_KEY, model: "text-embedding-3-small" }))
      .setVectorDatabase(vectorDatabase)
      .build();

    // اضافه کردن سوالات به vector store
    console.log(`📚 در حال اضافه کردن ${questionsData.length} سوال به vector store...`);
    
    for (let i = 0; i < questionsData.length; i++) {
      const question = questionsData[i];
      const searchableText = createSearchableText(question);
      
      // ایجاد TextLoader برای هر سوال با metadata در متن
      // metadata را در متن جاسازی می‌کنیم تا بتوانیم بعداً آن را استخراج کنیم
      const textWithMetadata = `[INDEX:${i}][QUESTION:${question.question}][ANSWER:${question.answer}][CATEGORY:${question.category || ''}][AUDIENCE:${question.audience || ''}][KEYWORDS:${(question.keywords || []).join(',')}]\n\n${searchableText}`;
      
      // ذخیره metadata برای استفاده بعدی
      const metadata = {
        index: i,
        question: question.question,
        answer: question.answer,
        category: question.category || '',
        audience: question.audience || '',
        keywords: question.keywords || []
      };
      
      // ذخیره metadata با استفاده از یک کلید منحصر به فرد
      const metadataKey = `question_${i}`;
      chunkMetadataMap.set(metadataKey, metadata);
      
      const textLoader = new TextLoader({
        text: textWithMetadata,
        chunkSize: 1000,  // افزایش chunkSize تا metadata در همه chunks باشد
        chunkOverlap: 100
      });
      
      // اضافه کردن loader به RAG
      await ragApp.addLoader(textLoader, false);
      if ((i + 1) % 10 === 0 || i === questionsData.length - 1) {
        console.log(`✅ ${i + 1}/${questionsData.length} سوال پردازش شد`);
      }
    }

    // ذخیره vectors در cache
    await vectorDatabase.saveToFile(VECTORS_CACHE_FILE);
    
    // ذخیره hash سوالات
    const currentIndicesHash = await calculateQuestionsIndicesHash();
    await saveIndicesHash(currentIndicesHash);
    const currentHash = await calculateQuestionsHash();
    if (currentHash) {
      await saveHash(currentHash);
    }

    isInitialized = true;
    console.log('✅ سیستم RAG با موفقیت مقداردهی شد');
  } catch (error) {
    console.error('❌ خطا در مقداردهی اولیه RAG:', error);
    throw error;
  }
}

/**
 * جستجوی سوالات مرتبط با استفاده از RAG
 * @param {string} userQuestion - سوال کاربر
 * @param {number} topK - تعداد سوالات مرتبط برای برگرداندن (پیش‌فرض: 10)
 * @returns {Promise<Array>} آرایه‌ای از سوالات مرتبط با امتیاز similarity
 */
async function searchSimilarQuestions(userQuestion, topK = 10) {
  try {
    // اطمینان از مقداردهی اولیه
    if (!isInitialized) {
      await initializeRAG();
    }

    // جستجو در vector store
    console.log(`🔍 در حال جستجوی سوالات مرتبط برای: "${userQuestion}"`);
    
    const results = await ragApp.search(userQuestion);
    
    // محدود کردن نتایج به topK
    const limitedResults = results.slice(0, topK);

    // تبدیل نتایج به فرمت مورد نظر
    const similarQuestions = limitedResults.map((result, idx) => {
      // استخراج metadata از pageContent
      const pageContent = result.pageContent || '';
      let index = null;
      let question = '';
      let answer = '';
      let category = '';
      let audience = '';
      let keywords = [];
      
      // استخراج INDEX از متن
      const indexMatch = pageContent.match(/\[INDEX:(\d+)\]/);
      if (indexMatch) {
        index = parseInt(indexMatch[1]);
        const originalQuestion = questionsData[index];
        if (originalQuestion) {
          question = originalQuestion.question;
          answer = originalQuestion.answer;
          category = originalQuestion.category || '';
          audience = originalQuestion.audience || '';
          keywords = originalQuestion.keywords || [];
        }
      } else {
        // اگر metadata در متن پیدا نشد، سعی می‌کنیم از metadata object استفاده کنیم
        const metadata = result.metadata || {};
        if (metadata.index !== undefined) {
          index = metadata.index;
          const originalQuestion = questionsData[index];
          if (originalQuestion) {
            question = originalQuestion.question;
            answer = originalQuestion.answer;
            category = originalQuestion.category || '';
            audience = originalQuestion.audience || '';
            keywords = originalQuestion.keywords || [];
          }
        } else {
          // اگر هنوز پیدا نشد، سعی می‌کنیم از chunkMetadataMap استفاده کنیم
          // جستجو در map بر اساس محتوای chunk
          for (const [key, meta] of chunkMetadataMap.entries()) {
            if (pageContent.includes(meta.question) || pageContent.includes(meta.answer)) {
              index = meta.index;
              question = meta.question;
              answer = meta.answer;
              category = meta.category;
              audience = meta.audience;
              keywords = meta.keywords;
              break;
            }
          }
        }
      }
      
      return {
        index: index,
        question: question,
        answer: answer,
        category: category,
        audience: audience,
        keywords: keywords,
        similarity: result.score || 0,
        rank: idx + 1
      };
    });

    console.log(`✅ ${similarQuestions.length} سوال مرتبط یافت شد`);
    
    return similarQuestions;
  } catch (error) {
    console.error('❌ خطا در جستجوی سوالات:', error);
    throw error;
  }
}

/**
 * به‌روزرسانی vector store پس از تغییر در سوالات
 * این تابع از به‌روزرسانی تدریجی استفاده می‌کند
 */
async function refreshRAG() {
  try {
    console.log('🔄 در حال به‌روزرسانی سیستم RAG...');
    
    // Reset کردن flag initialization برای اجرای مجدد initializeRAG
    isInitialized = false;
    
    // initializeRAG به صورت خودکار تغییرات را تشخیص می‌دهد و به‌روزرسانی تدریجی انجام می‌دهد
    await initializeRAG();
    console.log('✅ سیستم RAG با موفقیت به‌روزرسانی شد');
  } catch (error) {
    console.error('❌ خطا در به‌روزرسانی RAG:', error);
    throw error;
  }
}

module.exports = {
  initializeRAG,
  searchSimilarQuestions,
  refreshRAG,
  loadQuestions
};

