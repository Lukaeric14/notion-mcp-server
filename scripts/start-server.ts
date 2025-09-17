import path from 'node:path'
import { fileURLToPath } from 'url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID, randomBytes } from 'node:crypto'
import express from 'express'

import { initProxy, ValidationError } from '../src/init-server'

export async function startServer(argv: string[] = process.argv) {
  const filename = fileURLToPath(import.meta.url)
  const directory = path.dirname(filename)
  const specPath = path.resolve(directory, '../scripts/notion-openapi.json')
  
  const baseUrl = process.env.BASE_URL ?? undefined

  // Parse command line arguments manually (similar to slack-mcp approach)
  function parseArgs() {
    const args = process.argv.slice(2)

    type Transport = 'stdio' | 'http'
    const isSupportedTransport = (value: string | undefined): value is Transport =>
      value === 'stdio' || value === 'http'

    const parsePortNumber = (value: string | undefined, source: string): number | undefined => {
      if (value === undefined) {
        return undefined
      }

      const parsed = Number.parseInt(value, 10)
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
        console.warn(`Ignoring ${source} "${value}" because it is not a valid TCP port.`)
        return undefined
      }

      return parsed
    }

    const envPort = parsePortNumber(process.env.PORT, 'PORT environment variable')
    let port = envPort ?? 3000
    let portSource: 'env' | 'default' | 'cli' = envPort !== undefined ? 'env' : 'default'

    const envTransportValue = process.env.MCP_TRANSPORT?.toLowerCase()
    let transport: Transport = 'stdio'
    let transportSource: 'auto' | 'default' | 'env' | 'cli' = 'default'

    if (isSupportedTransport(envTransportValue)) {
      transport = envTransportValue
      transportSource = 'env'
    } else if (envTransportValue) {
      console.warn(`Ignoring MCP_TRANSPORT value "${process.env.MCP_TRANSPORT}". Supported transports are 'stdio' or 'http'.`)
    }

    if (transportSource === 'default' && portSource === 'env') {
      transport = 'http'
      transportSource = 'auto'
    }

    let authToken: string | undefined

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--transport' && i + 1 < args.length) {
        const cliTransport = args[i + 1]?.toLowerCase()
        if (isSupportedTransport(cliTransport)) {
          transport = cliTransport
          transportSource = 'cli'
        } else if (cliTransport) {
          console.warn(`Ignoring unsupported transport "${args[i + 1]}". Supported transports are 'stdio' or 'http'.`)
        }
        i++; // skip next argument
      } else if (args[i] === '--port' && i + 1 < args.length) {
        const parsedCliPort = parsePortNumber(args[i + 1], '--port option')
        if (parsedCliPort !== undefined) {
          port = parsedCliPort
          portSource = 'cli'
        }
        i++; // skip next argument
      } else if (args[i] === '--auth-token' && i + 1 < args.length) {
        authToken = args[i + 1];
        i++; // skip next argument
      } else if (args[i] === '--help' || args[i] === '-h') {
        console.log(`
Usage: notion-mcp-server [options]

Options:
  --transport <type>     Transport type: 'stdio' or 'http' (default: stdio)
  --port <number>        Port for HTTP server when using Streamable HTTP transport (default: 3000)
  --auth-token <token>   Bearer token for HTTP transport authentication (optional)
  --help, -h             Show this help message

Environment Variables:
  NOTION_TOKEN           Notion integration token (recommended)
  OPENAPI_MCP_HEADERS    JSON string with Notion API headers (alternative)
  AUTH_TOKEN             Bearer token for HTTP transport authentication (alternative to --auth-token)

Examples:
  notion-mcp-server                                    # Use stdio transport (default)
  notion-mcp-server --transport stdio                  # Use stdio transport explicitly
  notion-mcp-server --transport http                   # Use Streamable HTTP transport on port 3000
  notion-mcp-server --transport http --port 8080       # Use Streamable HTTP transport on port 8080
  notion-mcp-server --transport http --auth-token mytoken # Use Streamable HTTP transport with custom auth token
  AUTH_TOKEN=mytoken notion-mcp-server --transport http # Use Streamable HTTP transport with auth token from env var
`);
        process.exit(0);
      }
      // Ignore unrecognized arguments (like command name passed by Docker)
    }

    if (transportSource === 'auto') {
      console.log(`Detected PORT environment variable. Defaulting to HTTP transport.`)
    }

    if (portSource === 'env') {
      console.log(`Using port ${port} from PORT environment variable.`)
    }

    if (transportSource === 'env') {
      console.log(`Using ${transport} transport from MCP_TRANSPORT environment variable.`)
    }

    return { transport, port, authToken };
  }

  const options = parseArgs(argv)
  const transport = options.transport

  if (transport === 'stdio') {
    // Use stdio transport (default)
    const proxy = await initProxy(specPath, baseUrl)
    await proxy.connect(new StdioServerTransport())
    return proxy.getServer()
  } else if (transport === 'http') {
    // Use Streamable HTTP transport
    const app = express()
    app.use(express.json())

    // Generate or use provided auth token (from CLI arg or env var)
    const authToken = options.authToken || process.env.AUTH_TOKEN || randomBytes(32).toString('hex')
    if (!options.authToken && !process.env.AUTH_TOKEN) {
      console.log(`Generated auth token: ${authToken}`)
      console.log(`Use this token in the Authorization header: Bearer ${authToken}`)
    }

    // Authorization middleware
    const authenticateToken = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
      const authHeader = req.headers['authorization']
      const token = authHeader && authHeader.split(' ')[1] // Bearer TOKEN

      if (!token) {
        res.status(401).json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Unauthorized: Missing bearer token',
          },
          id: null,
        })
        return
      }

      if (token !== authToken) {
        res.status(403).json({
          jsonrpc: '2.0',
          error: {
            code: -32002,
            message: 'Forbidden: Invalid bearer token',
          },
          id: null,
        })
        return
      }

      next()
    }

    // Health endpoint (no authentication required)
    app.get('/health', (req, res) => {
      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        transport: 'http',
        port: options.port
      })
    })

    // Apply authentication to all /mcp routes
    app.use('/mcp', authenticateToken)

    // Map to store transports by session ID
    const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {}

    // Handle POST requests for client-to-server communication
    app.post('/mcp', async (req, res) => {
      try {
        // Check for existing session ID
        const sessionId = req.headers['mcp-session-id'] as string | undefined
        let transport: StreamableHTTPServerTransport

        if (sessionId && transports[sessionId]) {
          // Reuse existing transport
          transport = transports[sessionId]
        } else if (!sessionId && isInitializeRequest(req.body)) {
          // New initialization request
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId) => {
              // Store the transport by session ID
              transports[sessionId] = transport
            }
          })

          // Clean up transport when closed
          transport.onclose = () => {
            if (transport.sessionId) {
              delete transports[transport.sessionId]
            }
          }

          const proxy = await initProxy(specPath, baseUrl)
          await proxy.connect(transport)
        } else {
          // Invalid request
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: No valid session ID provided',
            },
            id: null,
          })
          return
        }

        // Handle the request
        await transport.handleRequest(req, res, req.body)
      } catch (error) {
        console.error('Error handling MCP request:', error)
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null,
          })
        }
      }
    })

    // Handle GET requests for server-to-client notifications via Streamable HTTP
    app.get('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID')
        return
      }
      
      const transport = transports[sessionId]
      await transport.handleRequest(req, res)
    })

    // Handle DELETE requests for session termination
    app.delete('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID')
        return
      }
      
      const transport = transports[sessionId]
      await transport.handleRequest(req, res)
    })

    const port = options.port
    app.listen(port, '0.0.0.0', () => {
      console.log(`MCP Server listening on port ${port}`)
      console.log(`Endpoint: http://0.0.0.0:${port}/mcp`)
      console.log(`Health check: http://0.0.0.0:${port}/health`)
      console.log(`Authentication: Bearer token required`)
      if (options.authToken) {
        console.log(`Using provided auth token`)
      }
    })

    // Return a dummy server for compatibility
    return { close: () => {} }
  } else {
    throw new Error(`Unsupported transport: ${transport}. Use 'stdio' or 'http'.`)
  }
}

startServer(process.argv).catch(error => {
  if (error instanceof ValidationError) {
    console.error('Invalid OpenAPI 3.1 specification:')
    error.errors.forEach(err => console.error(err))
  } else {
    console.error('Error:', error)
  }
  process.exit(1)
})
