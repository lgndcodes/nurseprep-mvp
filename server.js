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
  const { total_score, strong_topics, weak_topics, scores_by_topic } = req.body;

  if (total_score === undefined) {
    return res.status(400).json({ error: 'total_score is required' });
  }

  const strongList = Array.isArray(strong_topics) ? strong_topics.join(', ') || 'none' : strong_topics || 'none';
  const weakList   = Array.isArray(weak_topics)   ? weak_topics.join(', ')   || 'none' : weak_topics   || 'none';

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      system: 'You are an encouraging nursing education coach. Give honest, specific, actionable study feedback. Always respond with valid JSON only — no prose, no markdown, no code fences.',
      messages: [
        {
          role: 'user',
          content: `A nursing student scored ${total_score}%. Strong topics: ${strongList}. Weak topics: ${weakList}.

Return ONLY this JSON structure (no other text):
{
  "overall": "one encouraging sentence about overall performance",
  "strong_areas": ["topic 1", "topic 2"],
  "weak_areas": ["topic 1", "topic 2"],
  "focus_tips": [
    { "topic": "topic name", "tip": "specific 1 sentence study tip for this topic" }
  ],
  "next_steps": "one specific actionable sentence about what to study next"
}`,
        },
      ],
    });

    const raw = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    let review;
    try {
      review = JSON.parse(raw.replace(/```json\n?|```\n?/g, '').trim());
    } catch {
      // If Claude doesn't return valid JSON, surface the raw text so the client
      // still gets something useful rather than a silent 500
      console.warn('ai-review: Claude response was not valid JSON, returning raw text');
      review = { overall: raw, strong_areas: [], weak_areas: [], focus_tips: [], next_steps: '' };
    }

    res.json({ review });
  } catch (error) {
    console.error('ai-review error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/generate-questions', requireApiKey, async (req, res) => {
  const { document_id, question_count, quiz_style } = req.body;
  if (!document_id) {
    return res.status(400).json({ error: 'document_id is required' });
  }

  // question_count is optional; must be a positive integer when supplied
  const questionCount =
    Number.isInteger(question_count) && question_count > 0 ? question_count : null;

  // quiz_style defaults to 'nclex'; only 'lecture' is the other valid value
  const quizStyle = quiz_style === 'lecture' ? 'lecture' : 'nclex';

  console.log(
    `Generating questions for document: ${document_id}` +
    (questionCount ? ` (target: ${questionCount} questions)` : ' (all concepts)') +
    ` [style: ${quizStyle}]`
  );

  try {
    const result = await generateQuestions(document_id, questionCount, quizStyle);
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
