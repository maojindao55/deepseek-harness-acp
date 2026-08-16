import { describe, it, expect } from 'vitest'
import { sanitizeJsonSchemaNode, sanitizeMcpToolParameters } from '../src/mcp/schema.js'
import { assertSupportedJsonSchema, assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'

describe('MCP Schema Sanitizer', () => {
  it('handles empty or missing schema', () => {
    const s1 = sanitizeMcpToolParameters(undefined)
    expect(s1.type).toBe('object')
    expect(s1.properties).toEqual({})
    expect(s1.additionalProperties).toBe(true)
    expect(() => assertSupportedJsonSchema(s1)).not.toThrow()
    expect(() => assertObjectJsonSchema(s1)).not.toThrow()
  })

  it('strips unsupported keywords and appends them to description', () => {
    const raw = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        endpoint: {
          type: 'string',
          format: 'uri',
          minLength: 5,
          description: 'API endpoint URL',
        },
        retryCount: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
        },
      },
      required: ['endpoint'],
      additionalProperties: false,
    }

    const sanitized = sanitizeMcpToolParameters(raw)

    expect(sanitized.type).toBe('object')
    expect(sanitized.$schema).toBeUndefined()
    expect(sanitized.properties.endpoint.format).toBeUndefined()
    expect(sanitized.properties.endpoint.minLength).toBeUndefined()
    expect(sanitized.properties.endpoint.description).toContain('format: uri')
    expect(sanitized.properties.endpoint.description).toContain('minLength: 5')
    expect(sanitized.properties.retryCount.description).toContain('minimum: 1')
    expect(sanitized.required).toEqual(['endpoint'])
    expect(sanitized.additionalProperties).toBe(false)

    expect(() => assertSupportedJsonSchema(sanitized)).not.toThrow()
    expect(() => assertObjectJsonSchema(sanitized)).not.toThrow()
  })

  it('sanitizes nested objects and arrays', () => {
    const raw = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: {
            type: 'string',
            pattern: '^[a-z0-9]+$',
          },
        },
        meta: {
          type: 'object',
          properties: {
            author: { type: 'string' },
          },
        },
      },
    }

    const sanitized = sanitizeMcpToolParameters(raw)
    expect(sanitized.properties.tags.type).toBe('array')
    expect(sanitized.properties.tags.items.type).toBe('string')
    expect(sanitized.properties.meta.type).toBe('object')
    expect(sanitized.properties.meta.properties.author.type).toBe('string')

    expect(() => assertSupportedJsonSchema(sanitized)).not.toThrow()
    expect(() => assertObjectJsonSchema(sanitized)).not.toThrow()
  })

  it('handles anyOf and union types by converting to oneOf or selecting valid types', () => {
    const raw = {
      type: 'object',
      properties: {
        value: {
          anyOf: [{ type: 'string' }, { type: 'number' }],
        },
        flexibleField: {
          type: ['string', 'number'],
        },
      },
    }

    const sanitized = sanitizeMcpToolParameters(raw)
    expect(sanitized.properties.value.oneOf).toHaveLength(2)
    expect(sanitized.properties.flexibleField.oneOf).toHaveLength(2)

    expect(() => assertSupportedJsonSchema(sanitized)).not.toThrow()
    expect(() => assertObjectJsonSchema(sanitized)).not.toThrow()
  })
})
