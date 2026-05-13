/**
 * Embedding helpers — OpenAI vectors for semantic search / RAG.
 */

require('dotenv').config();
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const EMBEDDING_MODEL = 'text-embedding-3-small';

async function embedText(text) {
  try {
    console.log('Generating embedding for text chunk...');

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
    });

    const embedding = response.data[0]?.embedding;
    if (!embedding) {
      throw new Error('OpenAI embeddings response missing embedding vector');
    }

    return embedding;
  } catch (err) {
    console.error(err);
    throw err;
  }
}

async function embedTexts(texts) {
  try {
    const n = texts.length;
    console.log(`Embedding ${n} chunks...`);

    const embeddings = [];
    for (let i = 0; i < texts.length; i += 1) {
      embeddings.push(await embedText(texts[i]));
    }

    return embeddings;
  } catch (err) {
    console.error(err);
    throw err;
  }
}

module.exports = {
  embedText,
  embedTexts,
};
