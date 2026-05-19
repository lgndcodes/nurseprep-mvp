/**
 * NCLEX-style question generation pipeline using Claude + Supabase.
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('./supabase');
const { embedText } = require('./embeddings');

const MODEL = 'claude-sonnet-4-5';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

function parseClaudeJson(text) {
  const cleaned = String(text)
    .replace(/```json\n?/gi, '')
    .replace(/```\n?/g, '')
    .trim();
  return JSON.parse(cleaned);
}

function getAssistantText(message) {
  if (!message?.content || !Array.isArray(message.content)) return '';
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractConcepts(documentId, chunks) {
  const context = chunks.slice(0, 5).join('\n\n---\n\n');

  const message = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: 'You are an expert nursing educator and NCLEX exam specialist.',
    messages: [
      {
        role: 'user',
        content: `Analyze this nursing study material and extract NCLEX-testable concepts.

Return ONLY a JSON array. Each object must have:
- topic_name (string)
- nclex_category (one of: "Safe and Effective Care", "Health Promotion", "Psychosocial Integrity", "Physiological Integrity")
- importance_score (integer 1-10)

No other text, no markdown. Material:

${context}`,
      },
    ],
  });

  const responseText = getAssistantText(message);
  const concepts = parseClaudeJson(responseText);

  if (!Array.isArray(concepts) || concepts.length === 0) {
    console.log('Extracted 0 concepts from document');
    return [];
  }

  const rows = concepts.map((c) => ({
    document_id: documentId,
    topic_name: c.topic_name,
    nclex_category: c.nclex_category,
    importance_score: c.importance_score,
  }));

  const { data: inserted, error } = await supabase.from('concepts').insert(rows).select();
  if (error) throw error;

  console.log(`Extracted ${inserted.length} concepts from document`);
  return inserted;
}

async function getRelevantChunks(documentId, topicName) {
  const embedding = await embedText(topicName);

  const { data, error } = await supabase.rpc('match_document_chunks', {
    query_embedding: embedding,
    match_document_id: documentId,
    match_count: 5,
  });

  if (error) throw error;
  if (!data || !Array.isArray(data)) return [];

  return data.map((row) => row.chunk_text ?? row.content ?? '').filter(Boolean);
}

/**
 * Post-processing guard: if more than 2 out of 3 MCQ questions share the same
 * correct_answer letter, swap the answer choices on the repeated questions so the
 * correct answer lands on a different letter.  SATA questions are left untouched.
 */
function redistributeAnswers(questions) {
  const LETTERS = ['A', 'B', 'C', 'D'];

  // Count correct_answer occurrences across MCQ questions only
  const counts = {};
  for (const q of questions) {
    if (q.question_type === 'sata') continue;
    const ca = (q.correct_answer || '').toUpperCase();
    counts[ca] = (counts[ca] || 0) + 1;
  }

  // Only intervene when a single letter dominates more than 2 of the 3 questions
  const biasedLetter = Object.keys(counts).find((l) => counts[l] > 2);
  if (!biasedLetter) return questions;

  const replacements = LETTERS.filter((l) => l !== biasedLetter);
  let replacementIdx = 0;
  let firstSeen = false;

  return questions.map((q) => {
    if (q.question_type === 'sata' || q.correct_answer !== biasedLetter) return q;

    // Keep the first occurrence of the biased letter unchanged
    if (!firstSeen) {
      firstSeen = true;
      return q;
    }

    // Pick the next replacement letter (cycle through A/B/C/D minus the biased one)
    const newLetter = replacements[replacementIdx % replacements.length];
    replacementIdx += 1;

    const choices = Array.isArray(q.answer_choices) ? q.answer_choices : [];
    const correctChoice = choices.find((c) => c.letter === biasedLetter);
    const swapChoice    = choices.find((c) => c.letter === newLetter);
    if (!correctChoice || !swapChoice) return q;

    // Swap the two letter labels; keep all other content intact
    const newChoices = choices
      .map((c) => {
        if (c.letter === biasedLetter) return { ...c, letter: newLetter };
        if (c.letter === newLetter)    return { ...c, letter: biasedLetter };
        return c;
      })
      .sort((a, b) => a.letter.localeCompare(b.letter));

    // Remap trap_explanations keys to match the swapped letters
    const oldTraps = q.trap_explanations || {};
    const newTraps = {};
    for (const [k, v] of Object.entries(oldTraps)) {
      if (k === biasedLetter)     newTraps[newLetter]     = v;
      else if (k === newLetter)   newTraps[biasedLetter]  = v;
      else                        newTraps[k]             = v;
    }

    console.log(`[redistributeAnswers] Moved correct answer ${biasedLetter}→${newLetter} for bias correction`);

    return { ...q, answer_choices: newChoices, correct_answer: newLetter, trap_explanations: newTraps };
  });
}

async function generateQuestionsForConcept(concept, relevantChunks) {
  const context = relevantChunks.length
    ? relevantChunks.join('\n\n---\n\n')
    : '(No matching chunks.)';

  const createParams = {
    model: MODEL,
    max_tokens: 12000,
    system:
      'You are an expert NCLEX question writer and nursing educator. You write difficult, clinically realistic questions and complete rationales in one pass.',
    messages: [
      {
        role: 'user',
        content: `Using ONLY the study material below, generate exactly 3 difficult NCLEX-style exam questions about: "${concept.topic_name}".

Requirements:
- Questions must require clinical judgment and application, not memorization.
- Use realistic patient scenarios with clinical context where appropriate.
- For EACH question in the same response: write the question, full rationales, and self-review quality (quality_passes).
- Use ONLY information from the provided material.
- IMPORTANT: Vary the correct answer letter unpredictably across questions. Avoid patterns where the same letter (especially B) is correct more than once in a row or dominates the question set. A student should not be able to guess above 30% by always selecting the same letter. The correct answer should feel genuinely random in its placement.

Return ONLY a JSON array of exactly 3 objects. Each object must have ALL of these fields:
- question_text (string)
- question_type: "mcq" or "sata"
- answer_choices: array of { "letter", "text" }
- correct_answer (string)
- difficulty: integer — use 4 or 5 when quality_passes is true; use 2 when quality_passes is false (lower confidence)
- nclex_framework (string)
- rationale: string, 4-6 sentences of clinical explanation of why the correct answer is correct
- trap_explanations: object whose keys are wrong-answer letters and values explain why each wrong option is tempting
- clinical_pearl: string, one sentence key nursing insight
- quality_passes: boolean — true if the item meets NCLEX quality standards (clear single best answer, clinically realistic, tests judgment not pure recall); false if it has material problems

Study material:
${context}`,
      },
    ],
  };

  let message;
  for (let rateAttempt = 0; rateAttempt < 2; rateAttempt += 1) {
    try {
      message = await anthropic.messages.create(createParams);
      break;
    } catch (err) {
      const isRateLimit =
        err instanceof Anthropic.RateLimitError || err?.status === 429;
      if (isRateLimit && rateAttempt === 0) {
        // Honour the API's own retry-after header; fall back to 60 s
        const rawHeader = err.headers?.['retry-after'];
        const retryAfterSec = rawHeader ? Math.ceil(Number(rawHeader)) : 60;
        const waitMs = (Number.isFinite(retryAfterSec) ? retryAfterSec : 60) * 1000;
        console.log(`Rate limit hit - waiting ${waitMs / 1000}s before retry...`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }

  const responseText = getAssistantText(message);

  let questions;
  try {
    questions = parseClaudeJson(responseText);
  } catch (err) {
    console.warn('generateQuestionsForConcept: failed to parse JSON from Claude:', err);
    return [];
  }

  if (!Array.isArray(questions)) {
    console.warn('generateQuestionsForConcept: response was not a JSON array');
    return [];
  }

  return redistributeAnswers(questions);
}

async function validateAndStore(questions, documentId, conceptId) {
  const rows = questions.map((q) => ({
    document_id: documentId,
    concept_id: conceptId,
    question_text: q.question_text,
    question_type: q.question_type,
    answer_choices: q.answer_choices,
    correct_answer: q.correct_answer,
    difficulty: q.difficulty,
    nclex_framework: q.nclex_framework,
    rationale: q.rationale,
    trap_explanations: q.trap_explanations,
    clinical_pearl: q.clinical_pearl,
  }));

  const { error } = await supabase.from('questions').insert(rows);
  if (error) throw error;

  const { data: conceptRow } = await supabase
    .from('concepts')
    .select('topic_name')
    .eq('id', conceptId)
    .maybeSingle();

  const topicLabel = conceptRow?.topic_name ?? conceptId;
  console.log(`Stored ${rows.length} questions for concept ${topicLabel}`);

  return rows.length;
}

/**
 * Process a slice of concepts in parallel batches of 5 with no artificial
 * delays.  Rate-limit pauses are handled inside generateQuestionsForConcept
 * using the API's retry-after header.
 *
 * @param {string}   documentId
 * @param {object[]} concepts      - subset to process
 * @param {object}   opts
 * @param {number}   opts.logOffset  - display index offset (for logging)
 * @param {number}   opts.logTotal   - total concept count shown in logs
 */
async function processConcepts(documentId, concepts, { logOffset = 0, logTotal = null } = {}) {
  const displayTotal = logTotal ?? concepts.length;
  const BATCH_SIZE = 5;
  let totalQuestions = 0;

  for (let batchStart = 0; batchStart < concepts.length; batchStart += BATCH_SIZE) {
    const batch = concepts.slice(batchStart, batchStart + BATCH_SIZE);

    const batchCounts = await Promise.all(
      batch.map((concept, j) => {
        const displayIndex = logOffset + batchStart + j + 1;
        return (async () => {
          console.log(`[generateQuestions] Concept ${displayIndex}/${displayTotal}: ${concept.topic_name}`);

          const relevantChunks = await getRelevantChunks(documentId, concept.topic_name);
          const questions = await generateQuestionsForConcept(concept, relevantChunks);

          if (!questions.length) return 0;
          return validateAndStore(questions, documentId, concept.id);
        })();
      })
    );

    totalQuestions += batchCounts.reduce((sum, n) => sum + n, 0);
    // No artificial sleep — run at full speed; 429s are handled per-call above
  }

  return totalQuestions;
}

/**
 * Nullify concept references on questions and delete transient rows
 * (document_chunks, concepts) once generation is finished.
 */
async function cleanup(documentId) {
  const { error: nullifyErr } = await supabase
    .from('questions')
    .update({ concept_id: null })
    .eq('document_id', documentId);
  if (nullifyErr) throw nullifyErr;

  const { error: delChunksErr } = await supabase
    .from('document_chunks')
    .delete()
    .eq('document_id', documentId);
  if (delChunksErr) throw delChunksErr;

  const { error: delConceptsErr } = await supabase
    .from('concepts')
    .delete()
    .eq('document_id', documentId);
  if (delConceptsErr) throw delConceptsErr;

  console.log('Cleanup complete');
}

/**
 * Main entry point.
 *
 * @param {string}      documentId
 * @param {number|null} questionCount  - target number of questions.  If null,
 *                                       all concepts are processed before the
 *                                       document is marked ready.
 *
 * When questionCount is provided:
 *   1. Process ceil(questionCount/3) highest-importance concepts (priority batch).
 *   2. Immediately mark the document "ready" so students can start.
 *   3. Continue generating remaining concepts in the background.
 *
 * Returns the number of questions produced by the priority batch so the HTTP
 * response can acknowledge them quickly.
 */
async function generateQuestions(documentId, questionCount = null) {
  const { data: chunkRows, error: chunkErr } = await supabase
    .from('document_chunks')
    .select('chunk_text, chunk_index')
    .eq('document_id', documentId)
    .order('chunk_index', { ascending: true });

  if (chunkErr) throw chunkErr;

  const chunks = (chunkRows || []).map((r) => r.chunk_text).filter((t) => typeof t === 'string');

  const concepts = await extractConcepts(documentId, chunks);
  if (!concepts.length) return 0;

  // Sort highest importance first so the priority batch covers the best material
  const sorted = [...concepts].sort((a, b) => (b.importance_score ?? 0) - (a.importance_score ?? 0));
  const totalConcepts = sorted.length;

  // How many concepts to generate before marking "ready"
  const priorityCount = questionCount
    ? Math.min(Math.ceil(questionCount / 3), totalConcepts)
    : totalConcepts;

  const priorityConcepts  = sorted.slice(0, priorityCount);
  const remainingConcepts = sorted.slice(priorityCount);

  // ── Priority batch ──────────────────────────────────────────────────────────
  const priorityTotal = await processConcepts(documentId, priorityConcepts, {
    logOffset: 0,
    logTotal: totalConcepts,
  });

  // Mark document ready immediately after priority questions are stored
  const { error: readyErr } = await supabase
    .from('documents')
    .update({ status: 'ready' })
    .eq('id', documentId);
  if (readyErr) console.error('Failed to update document status to ready:', readyErr);

  console.log(`Document ready - ${priorityTotal} questions available for student`);

  // ── Remaining concepts (background) ────────────────────────────────────────
  if (remainingConcepts.length === 0) {
    await cleanup(documentId);
    console.log(`Full generation complete. Total questions: ${priorityTotal}`);
    return priorityTotal;
  }

  // Fire-and-forget — do NOT await; HTTP response returns immediately after priority batch
  (async () => {
    try {
      const remainingTotal = await processConcepts(documentId, remainingConcepts, {
        logOffset: priorityCount,
        logTotal: totalConcepts,
      });
      await cleanup(documentId);
      console.log(`Full generation complete. Total questions: ${priorityTotal + remainingTotal}`);
    } catch (err) {
      console.error('[background] Question generation error:', err);
      // Best-effort cleanup even if generation partially failed
      try { await cleanup(documentId); } catch (cleanupErr) {
        console.error('[background] Cleanup also failed:', cleanupErr);
      }
    }
  })();

  return priorityTotal;
}

module.exports = {
  generateQuestions,
};
