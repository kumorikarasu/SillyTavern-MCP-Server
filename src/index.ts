import fs from 'node:fs';
import path from 'node:path';
import { Router, Request as ExpressRequest, Response, json } from 'express';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { URL } from 'node:url';

// Use require for MCP SDK
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const ID = 'mcp';

// Extend the Express Request type to include user property
interface Request extends ExpressRequest {
    user: {
        directories: UserDirectoryList;
        [key: string]: any;
    };
}

const jsonParser = json({ limit: '200mb' });

// Define types
interface McpServerEntry {
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    type: string;
    url?: string;
}

interface McpServerDictionary {
    mcpServers: Record<string, McpServerEntry>;
}

interface UserDirectoryList {
    root: string;
    [key: string]: string;
}

// Map to store MCP clients
const mcpClients: Map<string, typeof Client> = new Map();

export const MCP_SETTINGS_FILE = 'mcp_settings.json';

/**
 * Reads MCP settings from the settings file
 */
export function readMcpSettings(directories: UserDirectoryList): McpServerDictionary {
    const filePath = path.join(directories.root, MCP_SETTINGS_FILE);

    if (!fs.existsSync(filePath)) {
        const defaultSettings: McpServerDictionary = { mcpServers: {} };
        writeFileAtomicSync(filePath, JSON.stringify(defaultSettings, null, 4), 'utf-8');
        return defaultSettings;
    }

    const fileContents = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(fileContents) as McpServerDictionary;
}

/**
 * Writes MCP settings to the settings file
 */
export function writeMcpSettings(directories: UserDirectoryList, settings: McpServerDictionary): void {
    const filePath = path.join(directories.root, MCP_SETTINGS_FILE);
    writeFileAtomicSync(filePath, JSON.stringify(settings, null, 4), 'utf-8');
}

/**
 * Starts an MCP server process and connects to it using the MCP SDK
 */
async function startMcpServer(serverName: string, config: McpServerEntry): Promise<boolean> {
    if (mcpClients.has(serverName)) {
        console.warn(`[MCP] Server "${serverName}" is already running`);
        return true;
    }

    try {
        // Create an MCP client
        const client = new Client(
            {
                name: 'sillytavern-client',
                version: '1.0.0',
            },
            {
                capabilities: {
                    prompts: {},
                    resources: {},
                    tools: {},
                },
            },
        );

        let transport;
        const transportType = config.type || 'stdio';

        if (transportType === 'stdio') {
            const env = { ...process.env, ...config.env } as Record<string, string>;
            let command = config.command;
            let args = config.args || [];

            // Windows-specific fix: Wrap the command in cmd /C to ensure proper path resolution
            if (process.platform === 'win32' && !command.toLowerCase().includes('cmd')) {
                const originalCommand = command;
                const originalArgs = [...args];
                command = 'cmd';
                args = ['/C', originalCommand, ...originalArgs];
                console.log(`[MCP] Windows detected, wrapping command: cmd /C ${originalCommand} ${originalArgs.join(' ')}`);
            }

            transport = new StdioClientTransport({
                command: command,
                args: args,
                env: env,
            });

            console.log(`[MCP] Using stdio transport for server "${serverName}"`);
        } else if (transportType === 'sse') {
            if (!config.url) {
                throw new Error('URL is required for SSE transport');
            }

            transport = new SSEClientTransport(new URL(config.url));

            console.log(`[MCP] Using SSE transport for server "${serverName}" with URL: ${config.url}`);
        } else {
            throw new Error(`Unsupported transport type: ${transportType}`);
        }

        // Connect to the server
        await client.connect(transport);
        mcpClients.set(serverName, client);

        console.log(`[MCP] Connected to server "${serverName}" using MCP SDK with ${transportType} transport`);
        return true;
    } catch (error) {
        console.error(`[MCP] Failed to start server "${serverName}":`, error);
        return false;
    }
}

/**
 * Stops an MCP server process
 */
async function stopMcpServer(serverName: string): Promise<boolean> {
    if (!mcpClients.has(serverName)) {
        console.warn(`[MCP] Server "${serverName}" is not running`);
        return true;
    }

    try {
        const client = mcpClients.get(serverName);
        await client?.close();
        mcpClients.delete(serverName);
        console.log(`[MCP] Disconnected from server "${serverName}"`);
        return true;
    } catch (error) {
        console.error(`[MCP] Failed to stop server "${serverName}":`, error);
        return false;
    }
}

export async function init(router: Router): Promise<void> {
    // Get all MCP servers
    // @ts-ignore
    router.get('/servers', (request: Request, response: Response) => {
        try {
            const settings = readMcpSettings(request.user.directories);
            const servers = Object.entries(settings.mcpServers || {}).map(([name, config]) => ({
                name,
                isRunning: mcpClients.has(name),
                config: {
                    command: config.command,
                    args: config.args,
                    // Don't send environment variables for security
                },
            }));

            response.json(servers);
        } catch (error) {
            console.error('[MCP] Error getting servers:', error);
            response.status(500).json({ error: 'Failed to get MCP servers' });
        }
    });

    // Add or update an MCP server
    // @ts-ignore
    router.post('/servers', jsonParser, (request: Request, response: Response) => {
        try {
            const { name, config } = request.body;

            if (!name || typeof name !== 'string') {
                return response.status(400).json({ error: 'Server name is required' });
            }

            if (!config || typeof config !== 'object') {
                return response.status(400).json({ error: 'Server configuration is required' });
            }

            // Validate based on transport type
            const transportType = config.type || 'stdio';
            if (transportType === 'stdio') {
                if (!config.command || typeof config.command !== 'string') {
                    return response.status(400).json({ error: 'Server command is required for stdio transport' });
                }
            } else if (transportType === 'sse') {
                if (!config.url || typeof config.url !== 'string') {
                    return response.status(400).json({ error: 'Server URL is required for SSE transport' });
                }
            } else {
                return response.status(400).json({ error: `Unsupported transport type: ${transportType}` });
            }

            const settings = readMcpSettings(request.user.directories);

            if (!settings.mcpServers) {
                settings.mcpServers = {};
            }

            settings.mcpServers[name] = config;
            writeMcpSettings(request.user.directories, settings);

            response.json({ success: true });
        } catch (error) {
            console.error('[MCP] Error adding/updating server:', error);
            response.status(500).json({ error: 'Failed to add/update MCP server' });
        }
    });

    // Delete an MCP server
    // @ts-ignore
    router.delete('/servers/:name', (request: Request, response: Response) => {
        try {
            const { name } = request.params;

            if (mcpClients.has(name)) {
                stopMcpServer(name);
            } else {
                return response.status(404).json({ error: 'Server not found' });
            }

            const settings = readMcpSettings(request.user.directories);

            if (settings.mcpServers && settings.mcpServers[name]) {
                delete settings.mcpServers[name];
                writeMcpSettings(request.user.directories, settings);
            }

            response.json({ success: true });
        } catch (error) {
            console.error('[MCP] Error deleting server:', error);
            response.status(500).json({ error: 'Failed to delete MCP server' });
        }
    });

    // Start an MCP server
    // @ts-ignore
    router.post('/servers/:name/start', (request: Request, response: Response) => {
        try {
            const { name } = request.params;
            const settings = readMcpSettings(request.user.directories);

            if (!settings.mcpServers || !settings.mcpServers[name]) {
                return response.status(404).json({ error: 'Server not found' });
            }

            const config = settings.mcpServers[name];

            startMcpServer(name, config)
                .then(success => {
                    if (success) {
                        response.json({ success: true });
                    } else {
                        response.status(500).json({ error: 'Failed to start MCP server' });
                    }
                })
                .catch(error => {
                    console.error('[MCP] Error starting server:', error);
                    response.status(500).json({ error: 'Failed to start MCP server' });
                });
        } catch (error) {
            console.error('[MCP] Error starting server:', error);
            response.status(500).json({ error: 'Failed to start MCP server' });
        }
    });

    // Stop an MCP server
    // @ts-ignore
    router.post('/servers/:name/stop', (request: Request, response: Response) => {
        try {
            const { name } = request.params;

            if (!mcpClients.has(name)) {
                return response.status(400).json({ error: 'Server is not running' });
            }

            stopMcpServer(name)
                .then(success => {
                    if (success) {
                        response.json({ success: true });
                    } else {
                        response.status(500).json({ error: 'Failed to stop MCP server' });
                    }
                })
                .catch(error => {
                    console.error('[MCP] Error stopping server:', error);
                    response.status(500).json({ error: 'Failed to stop MCP server' });
                });
        } catch (error) {
            console.error('[MCP] Error stopping server:', error);
            response.status(500).json({ error: 'Failed to stop MCP server' });
        }
    });

    // List tools from an MCP server
    // @ts-ignore
    router.get('/servers/:name/list-tools', async (request: Request, response: Response) => {
        try {
            const { name } = request.params;

            if (!mcpClients.has(name)) {
                return response.status(400).json({ error: 'Server is not running' });
            }

            const client = mcpClients.get(name);

            console.log(`[MCP] Listing tools from server "${name}"`);

            try {
                // Use the MCP SDK to list tools
                const tools = await client?.listTools();
                response.json(tools?.tools || []);
            } catch (error: any) {
                console.error('[MCP] Error listing tools:', error);
                response.status(500).json({ error: `Failed to list tools: ${error.message}` });
            }
        } catch (error) {
            console.error('[MCP] Error listing tools:', error);
            response.status(500).json({ error: 'Failed to list tools from MCP server' });
        }
    });

    // Call a tool on an MCP server
    // @ts-ignore
    router.post('/servers/:name/call-tool', jsonParser, async (request: Request, response: Response) => {
        try {
            const { name } = request.params;
            const { toolName, arguments: toolArgs } = request.body;

            if (!mcpClients.has(name)) {
                return response.status(400).json({ error: 'Server is not running' });
            }

            if (!toolName || typeof toolName !== 'string') {
                return response.status(400).json({ error: 'Tool name is required' });
            }

            if (!toolArgs || typeof toolArgs !== 'object') {
                return response.status(400).json({ error: 'Tool arguments must be an object' });
            }

            const client = mcpClients.get(name);

            console.log(`[MCP] Calling tool "${toolName}" on server "${name}" with arguments:`, toolArgs);

            try {
                // Use the MCP SDK to call the tool
                const result = await client?.callTool({
                    name: toolName,
                    arguments: toolArgs,
                });

                response.json({
                    success: true,
                    result: {
                        toolName,
                        status: 'executed',
                        data: result,
                    },
                });
            } catch (error: any) {
                console.error('[MCP] Error executing tool:', error);
                response.status(500).json({
                    success: false,
                    error: `Failed to execute tool: ${error.message}`,
                });
            }
        } catch (error) {
            console.error('[MCP] Error calling tool:', error);
            response.status(500).json({ error: 'Failed to call tool on MCP server' });
        }
    });
}

interface PluginInfo {
    id: string;
    name: string;
    description: string;
}

export default {
    init,
    exit: (): void => {},
    info: {
        id: ID,
        name: 'MCP Server',
        description: 'Allows you to connect to an MCP server and execute tools',
    } as PluginInfo,
};
