import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'
import { getT } from '@/lib/i18n/translate'
import { extractText, getDocumentProxy } from 'unpdf'

const t = getT('Api')

// Max file size: 20 MB
const MAX_FILE_SIZE = 20 * 1024 * 1024

/**
 * Clean up text extracted from PDF or files.
 */
function cleanExtractedText(raw: string): string {
  return raw
    .replace(/\0/g, '') // remove null characters
    .replace(/\r\n/g, '\n') // normalize CRLF to LF
    .replace(/\f/g, '\n\n') // replace form feed with newlines
    .replace(/\n{3,}/g, '\n\n') // collapse excessive consecutive blank lines
    .trim()
}

/**
 * POST /api/ai/knowledge/upload  (admin+)
 *
 * Accepts a PDF (or text) file, extracts its text, and either returns the
 * parsed title & content for review in the UI, or directly ingests it into
 * the knowledge base if `auto_save=true`.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const formData = await request.formData().catch(() => null)
    if (!formData) {
      return NextResponse.json(
        { error: t('ai.knowledge.invalidFormData') },
        { status: 400 }
      )
    }

    const file = formData.get('file') as File | null
    const autoSave = formData.get('auto_save') === 'true'

    if (!file || typeof file === 'string') {
      return NextResponse.json(
        { error: t('ai.knowledge.noFileProvided') },
        { status: 400 }
      )
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: t('ai.knowledge.fileTooLarge') },
        { status: 400 }
      )
    }

    const filename = file.name || 'document.pdf'
    const ext = filename.split('.').pop()?.toLowerCase() || ''
    const defaultTitle = filename.replace(/\.[^/.]+$/, '').trim() || 'Uploaded Document'

    let extractedText = ''
    let totalPages = 1

    if (ext === 'pdf') {
      try {
        const arrayBuffer = await file.arrayBuffer()
        const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer))
        totalPages = pdf.numPages || 1
        const result = await extractText(pdf, { mergePages: true })
        extractedText = cleanExtractedText(result.text || '')
      } catch (pdfErr) {
        console.error('[ai/knowledge/upload] PDF parse error:', pdfErr)
        return NextResponse.json(
          { error: t('ai.knowledge.pdfParseFailed') },
          { status: 400 }
        )
      }
    } else if (['txt', 'md', 'markdown', 'csv', 'json'].includes(ext)) {
      try {
        const raw = await file.text()
        extractedText = cleanExtractedText(raw)
      } catch (txtErr) {
        console.error('[ai/knowledge/upload] Text read error:', txtErr)
        return NextResponse.json(
          { error: t('ai.knowledge.textReadFailed') },
          { status: 400 }
        )
      }
    } else {
      return NextResponse.json(
        { error: t('ai.knowledge.unsupportedFileType') },
        { status: 400 }
      )
    }

    if (!extractedText) {
      return NextResponse.json(
        {
          error: t('ai.knowledge.noReadableText'),
        },
        { status: 400 }
      )
    }

    // If auto_save is requested, insert into DB and run ingestDocument
    if (autoSave) {
      const { data: doc, error } = await supabase
        .from('ai_knowledge_documents')
        .insert({
          account_id: accountId,
          created_by: userId,
          title: defaultTitle,
          content: extractedText,
        })
        .select('id')
        .single()

      if (error || !doc) {
        console.error('[ai/knowledge/upload] insert error:', error)
        return NextResponse.json(
          { error: t('ai.knowledge.saveDocFailed') },
          { status: 500 }
        )
      }

      const { key: embeddingsApiKey } = await loadEmbeddingsKey(supabase, accountId)
      let warning: string | undefined

      try {
        await ingestDocument(
          supabase,
          accountId,
          { embeddingsApiKey },
          doc.id,
          extractedText
        )
      } catch (err) {
        const message = err instanceof AiError ? err.message : t('ai.knowledge.indexingFailed')
        console.error('[ai/knowledge/upload] ingest error:', err)
        warning = t('ai.knowledge.savedIndexFailed', { message })
      }

      return NextResponse.json({
        success: true,
        auto_saved: true,
        id: doc.id,
        title: defaultTitle,
        pages: totalPages,
        content_length: extractedText.length,
        warning,
      })
    }

    // Default: return the parsed text so user can review and edit in UI
    return NextResponse.json({
      success: true,
      auto_saved: false,
      title: defaultTitle,
      content: extractedText,
      pages: totalPages,
      content_length: extractedText.length,
      filename,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
