/**
 * Schema translation and sanitization from MCP Tool Schemas to DeepSeek Harness / dsh-tools schemas.
 *
 * dsh-tools enforces a strict JSON Schema subset:
 * - Constraint keywords: type, oneOf, properties, required, additionalProperties, items, enum, const
 * - Annotation keywords: description, title, default, examples
 * - Supported types: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
 */

const ALLOWED_CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])

const ALLOWED_ANNOTATION_KEYWORDS = new Set([
  'description',
  'title',
  'default',
  'examples',
])

const ALLOWED_TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
])

/**
 * Recursively sanitize a JSON Schema node into the strict subset accepted by dsh-tools.
 */
export function sanitizeJsonSchemaNode(raw: any, depth = 0): any {
  if (depth > 20 || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { type: 'string' }
  }

  const result: Record<string, any> = {}
  const extraHints: string[] = []

  // 1. Handle type
  let nodeType = raw.type
  if (Array.isArray(nodeType)) {
    // Union type array e.g. ['string', 'null']
    const validTypes = nodeType.filter((t: string) => ALLOWED_TYPES.has(t))
    if (validTypes.length === 1) {
      nodeType = validTypes[0]
    } else if (validTypes.length > 1) {
      return {
        oneOf: validTypes.map((t: string) => ({ type: t })),
      }
    } else {
      nodeType = 'string'
    }
  }

  if (typeof nodeType === 'string' && ALLOWED_TYPES.has(nodeType)) {
    result.type = nodeType
  } else if (!raw.oneOf && !raw.anyOf) {
    if (raw.properties) {
      result.type = 'object'
    } else if (raw.items) {
      result.type = 'array'
    } else {
      result.type = 'string'
    }
  }

  // 2. Handle oneOf / anyOf
  if (Array.isArray(raw.oneOf) && raw.oneOf.length > 0) {
    result.oneOf = raw.oneOf.map((branch: any) => sanitizeJsonSchemaNode(branch, depth + 1))
  } else if (Array.isArray(raw.anyOf) && raw.anyOf.length > 0) {
    result.oneOf = raw.anyOf.map((branch: any) => sanitizeJsonSchemaNode(branch, depth + 1))
  }

  // 3. Handle properties
  if (raw.properties && typeof raw.properties === 'object' && !Array.isArray(raw.properties)) {
    const sanitizedProps: Record<string, any> = {}
    for (const [key, propSchema] of Object.entries(raw.properties)) {
      sanitizedProps[key] = sanitizeJsonSchemaNode(propSchema, depth + 1)
    }
    result.properties = sanitizedProps
  }

  // 4. Handle required
  if (Array.isArray(raw.required)) {
    const propKeys = result.properties ? Object.keys(result.properties) : []
    const validRequired = raw.required.filter(
      (r: any) => typeof r === 'string' && (propKeys.length === 0 || propKeys.includes(r))
    )
    if (validRequired.length > 0) {
      result.required = validRequired
    }
  }

  // 5. Handle additionalProperties
  if (typeof raw.additionalProperties === 'boolean') {
    result.additionalProperties = raw.additionalProperties
  }

  // 6. Handle items
  if (raw.items) {
    if (Array.isArray(raw.items)) {
      // Tuple-style items -> simplify to first item or union
      result.items = sanitizeJsonSchemaNode(raw.items[0] || {}, depth + 1)
    } else if (typeof raw.items === 'object') {
      result.items = sanitizeJsonSchemaNode(raw.items, depth + 1)
    }
  }

  // 7. Handle enum
  if (Array.isArray(raw.enum) && raw.enum.length > 0) {
    result.enum = raw.enum
  }

  // 8. Handle const
  if (raw.const !== undefined) {
    result.const = raw.const
  }

  // 9. Collect extra validation constraints into hints
  for (const [key, val] of Object.entries(raw)) {
    if (!ALLOWED_CONSTRAINT_KEYWORDS.has(key) && !ALLOWED_ANNOTATION_KEYWORDS.has(key)) {
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        extraHints.push(`${key}: ${val}`)
      }
    }
  }

  // 10. Handle annotations (description, title, default, examples)
  let description = typeof raw.description === 'string' ? raw.description : ''
  if (extraHints.length > 0) {
    description = description ? `${description} (${extraHints.join(', ')})` : `(${extraHints.join(', ')})`
  }
  if (description) {
    result.description = description
  }

  if (typeof raw.title === 'string' && raw.title) {
    result.title = raw.title
  }

  if (raw.default !== undefined && isJsonValue(raw.default)) {
    result.default = raw.default
  }

  return result
}

function isJsonValue(val: any): boolean {
  if (val === null || typeof val === 'boolean' || typeof val === 'number' || typeof val === 'string') {
    return true
  }
  if (Array.isArray(val)) {
    return val.every(isJsonValue)
  }
  if (typeof val === 'object') {
    try {
      JSON.stringify(val)
      return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * Sanitize an MCP inputSchema for a tool, ensuring it is a valid object root schema for dsh-tools.
 */
export function sanitizeMcpToolParameters(inputSchema?: any): any {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return {
      type: 'object',
      properties: {},
      additionalProperties: true,
    }
  }

  const sanitized = sanitizeJsonSchemaNode(inputSchema)
  if (sanitized.type !== 'object') {
    return {
      type: 'object',
      properties: {
        input: sanitized,
      },
      additionalProperties: true,
    }
  }

  if (!sanitized.properties) {
    sanitized.properties = {}
  }

  if (sanitized.additionalProperties === undefined) {
    sanitized.additionalProperties = true
  }

  return sanitized
}
