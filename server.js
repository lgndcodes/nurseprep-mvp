/**
 * Express HTTP server — NursePrep API.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { processDocument } = require('./src/process-document.js');
const { generateQuestions } = require('./src/generate-questions.js');

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
