/**
 * Manual end-to-end test: process document → generate questions.
 *
 * Usage: npm run test:pipeline
 */

const { processDocument } = require('./process-document.js');
const { generateQuestions } = require('./generate-questions.js');

const DOCUMENT_ID = 'b575469a-d05c-42da-8ffc-5608cb1c0ce7';

async function main() {
  try {
    await processDocument(DOCUMENT_ID);
    await generateQuestions(DOCUMENT_ID);
    console.log('Pipeline complete!');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
