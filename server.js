/**
 * Express HTTP server — NursePrep API.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { processDocument } = require('./src/process-document.js');
const { generateQuestions } = require('./src/generate-questions.js');

const anthropic = new Anthropic({ apiKey: (process.env.ANTHROPIC_API_KEY || '').trim() });

const app = express();

app.use(cors());
app.use(express.json());

function requireApiKey(req, res, next) {
  const key = req.get('x-api-key');
  if (key === process.env.API_KEY) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/process-document', requireApiKey, async (req, res) => {
  const { document_id } = req.body;
  if (!document_id) {
    return res.status(400).json({ error: 'document_id is required' });
  }

  console.log(`Processing document: ${document_id}`);

  try {
    await processDocument(document_id);
    res.status(200).json({ success: true, document_id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/ai-review', requireApiKey, async (req, res) => {
  const { scores_by_topic, total_score, weak_topics, strong_topics } = req.body;
  if (total_score === undefined) {
    return res.status(400).json({ error: 'total_score is required' });
  }

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 512,
      system: 'You are an encouraging nursing education coach. Give honest, specific, actionable study feedback.',
      messages: [
        {
          role: 'user',
          content: `A nursing student just completed a practice quiz. Total score: ${total_score}%. Strong topics: ${Array.isArray(strong_topics) ? strong_topics.join(', ') || 'none' : strong_topics || 'none'}. Weak topics: ${Array.isArray(weak_topics) ? weak_topics.join(', ') || 'none' : weak_topics || 'none'}. Write a personalized 3-4 sentence study recommendation. Be encouraging but honest about what needs work.`,
        },
      ],
    });

    const review = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    res.json({ review });
  } catch (error) {
    console.error('ai-review error:', error);
    res.status(500).json({ error: 'Failed to generate AI review. Please try again.' });
  }
});

app.post('/generate-questions', requireApiKey, async (req, res) => {
  const { document_id } = req.body;
  if (!document_id) {
    return res.status(400).json({ error: 'document_id is required' });
  }

  console.log(`Generating questions for document: ${document_id}`);

  try {
    const result = await generateQuestions(document_id);
    res.status(200).json({
      success: true,
      document_id,
      questions_generated: result,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`NursePrep backend running on port ${PORT}`);
});

module.exports = { app };
