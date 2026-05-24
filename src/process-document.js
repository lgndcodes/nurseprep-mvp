/**
 * Document processing pipeline — Storage → text (PDF / PPTX) → chunks → embeddings → document_chunks.
 */

const pdfParse = require('pdf-parse');
const officeparser = require('officeparser');
const supabase = require('./supabase');
const { embedTexts } = require('./embeddings');

function chunkText(text, chunkSize = 2000, overlap = 200) {
  if (overlap >= chunkSize) {
    throw new Error('chunkText: overlap must be less than chunkSize');
  }

  const chunks = [];
  const stride = chunkSize - overlap;
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start += stride;
  }

  return chunks;
}

async function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return Buffer.from(await data.arrayBuffer());
  }
  throw new Error('Unexpected storage download payload; expected Buffer, Blob, or ArrayBuffer');
}

async function processDocument(documentId) {
  try {
    const { error: processingUpdateError } = await supabase
      .from('documents')
      .update({ status: 'processing' })
      .eq('id', documentId);

    if (processingUpdateError) throw processingUpdateError;

    console.log(`Starting document processing for: ${documentId}`);

    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('storage_path, filename, quiz_style')
      .eq('id', documentId)
      .single();

    if (docError) throw docError;
    if (!doc) throw new Error('Document not found');

    const { storage_path: storagePath, filename, quiz_style: quizStyle } = doc;
    console.log(`Found document: ${filename}`);

    console.log('Downloading from bucket: documents, path:', JSON.stringify(storagePath));

    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from('documents')
      .download(storagePath);

    if (downloadError) throw downloadError;
    if (!fileBlob) throw new Error('Storage download returned empty data');

    const buffer = await toBuffer(fileBlob);
    console.log('Downloaded file from storage');

    const lowerName = (filename || '').toLowerCase();
    let rawText;

    if (lowerName.endsWith('.pdf')) {
      const parsed = await pdfParse(buffer);
      rawText = typeof parsed.text === 'string' ? parsed.text : '';
    } else if (lowerName.endsWith('.pptx') || lowerName.endsWith('.ppt')) {
      const extracted = await officeparser.parseOfficeAsync(buffer);
      rawText = typeof extracted === 'string' ? extracted : String(extracted ?? '');
    } else {
      throw new Error('Unsupported file type. Supported formats are PDF and PPTX.');
    }

    console.log(`Extracted ${rawText.length} characters from document`);

    if (rawText.trim().length < 100) {
      throw new Error('Could not extract text from document - supported formats are PDF and PPTX');
    }

    const chunks = chunkText(rawText);
    console.log(`Split into ${chunks.length} chunks`);

    const embeddings = await embedTexts(chunks);

    const rows = chunks.map((chunk_text, chunk_index) => ({
      document_id: documentId,
      chunk_text,
      embedding: embeddings[chunk_index],
      chunk_index,
    }));

    const { error: insertError } = await supabase.from('document_chunks').insert(rows);

    if (insertError) throw insertError;

    console.log(`Stored ${chunks.length} chunks with embeddings`);

    const { error: readyError } = await supabase
      .from('documents')
      .update({ status: 'ready' })
      .eq('id', documentId);

    if (readyError) throw readyError;

    const { error: removeError } = await supabase.storage.from('documents').remove([storagePath]);
    if (removeError) {
      console.error('Failed to remove source file from storage:', removeError);
    } else {
      console.log('Source file removed from storage after processing');
    }

    console.log('Document processing complete!');
  } catch (err) {
    console.error(err);

    const { error: failedUpdateError } = await supabase
      .from('documents')
      .update({ status: 'failed' })
      .eq('id', documentId);

    if (failedUpdateError) {
      console.error(failedUpdateError);
    }

    throw err;
  }
}

module.exports = {
  processDocument,
};
