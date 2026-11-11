import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(() => ({ success: true })),
  loadEmbeddingsKey: vi.fn(() => Promise.resolve({ key: null })),
  ingestDocument: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn((err) =>
    Response.json({ error: String(err) }, { status: 500 })
  ),
}))

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: vi.fn(),
  RATE_LIMITS: { adminAction: {} },
}))

vi.mock('@/lib/ai/config', () => ({
  loadEmbeddingsKey: mocks.loadEmbeddingsKey,
}))

vi.mock('@/lib/ai/knowledge', () => ({
  ingestDocument: mocks.ingestDocument,
}))

import { POST } from './route'

function makeMockSupabase() {
  const inserted: Record<string, unknown>[] = []
  return {
    inserted,
    from: vi.fn((table: string) => ({
      insert: vi.fn((row: Record<string, unknown>) => {
        inserted.push(row)
        return {
          select: vi.fn(() => ({
            single: vi.fn(() =>
              Promise.resolve({ data: { id: 'doc-123', ...row }, error: null })
            ),
          })),
        }
      }),
    })),
  }
}

describe('POST /api/ai/knowledge/upload', () => {
  let mockDb: ReturnType<typeof makeMockSupabase>

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb = makeMockSupabase()
    mocks.requireRole.mockResolvedValue({
      supabase: mockDb,
      accountId: 'account-1',
      userId: 'user-1',
      role: 'admin',
    })
  })

  it('rejects when no file is provided', async () => {
    const formData = new FormData()
    const req = new Request('http://localhost/api/ai/knowledge/upload', {
      method: 'POST',
      body: formData,
    })

    const res = await POST(req)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/No file provided/i)
  })

  it('extracts text from a text/markdown file without saving', async () => {
    const formData = new FormData()
    const file = new File(['FAQ: What are your clinic hours?\nWe are open 9am to 6pm.'], 'clinic-faq.txt', {
      type: 'text/plain',
    })
    formData.append('file', file)

    const req = new Request('http://localhost/api/ai/knowledge/upload', {
      method: 'POST',
      body: formData,
    })

    const res = await POST(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.auto_saved).toBe(false)
    expect(json.title).toBe('clinic-faq')
    expect(json.content).toContain('What are your clinic hours?')
    expect(mockDb.inserted.length).toBe(0)
  })

  it('extracts text from a PDF file using unpdf', async () => {
    // Minimal valid PDF with text stream
    const minimalPdf =
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 300 144]/Parent 2 0 R/Resources<<>>/Contents 4 0 R>>endobj\n4 0 obj<</Length 46>>stream\nBT /F1 12 Tf 50 100 Td (Treatment Price List 2026) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000216 00000 n \ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n312\n%%EOF'

    const buffer = Buffer.from(minimalPdf)
    const file = new File([buffer], 'Treatment Prices.pdf', {
      type: 'application/pdf',
    })

    const formData = new FormData()
    formData.append('file', file)

    const req = new Request('http://localhost/api/ai/knowledge/upload', {
      method: 'POST',
      body: formData,
    })

    const res = await POST(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.title).toBe('Treatment Prices')
    expect(json.content).toContain('Treatment Price List 2026')
    expect(json.pages).toBe(1)
  })

  it('inserts and ingests document when auto_save=true', async () => {
    const formData = new FormData()
    const file = new File(['Return policy: 30 days.'], 'returns.md', {
      type: 'text/markdown',
    })
    formData.append('file', file)
    formData.append('auto_save', 'true')

    const req = new Request('http://localhost/api/ai/knowledge/upload', {
      method: 'POST',
      body: formData,
    })

    const res = await POST(req)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(json.auto_saved).toBe(true)
    expect(json.id).toBe('doc-123')
    expect(mockDb.inserted.length).toBe(1)
    expect(mocks.ingestDocument).toHaveBeenCalledWith(
      mockDb,
      'account-1',
      { embeddingsApiKey: null },
      'doc-123',
      'Return policy: 30 days.'
    )
  })
})
