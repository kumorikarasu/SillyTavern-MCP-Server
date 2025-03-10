import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { URL } from 'node:url';

import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { Router, Request as ExpressRequest, Response, json } from 'express';

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

interface ClientInfo {
    name: string;
    version: string;
}

interface CapabilitiesConfig {
    prompts: Record<string, any>;
    resources: Record<string, any>;
    tools: Record<string, any>;
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timeoutId?: NodeJS.Timeout;
}

interface TransportConfig {
    type: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
}

interface JsonRpcRequest {
    jsonrpc: string;
    id: number;
    method: string;
    params: any;
}

interface JsonRpcResponse {
    jsonrpc: string;
    id: number;
    result?: any;
    error?: {
        code: number;
        message: string;
    };
}

interface ToolCallParams {
    name: string;
    arguments: Record<string, any>;
}

export const MCP_SETTINGS_FILE = 'mcp_settings.json';

// Map to store MCP clients
const mcpClients: Map<string, McpJsonRpcClient> = new Map();

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
 * JSON-RPC client for MCP communication
 */
class McpJsonRpcClient {
    private clientInfo: ClientInfo;
    private capabilities: CapabilitiesConfig;
    private transport: TransportConfig | null;
    private connected: boolean;
    private requestId: number;
    private childProcess: ChildProcess | null;
    private eventSource: EventSource | null;
    private protocolVersion: string;
    private pendingRequests: Map<number, PendingRequest>;
    private requestTimeout: number;

    /**
     * @param clientInfo Client metadata
     * @param capabilities Client capabilities
     */
    constructor(clientInfo: ClientInfo, capabilities: CapabilitiesConfig) {
        this.clientInfo = clientInfo;
        this.capabilities = capabilities;
        this.transport = null;
        this.connected = false;
        this.requestId = 1;
        this.childProcess = null;
        this.eventSource = null;
        this.protocolVersion = '2024-11-05'; // Latest protocol version

        // Map to store pending requests
        this.pendingRequests = new Map();

        // Request timeout in milliseconds
        this.requestTimeout = 30000;
    }

    /**
     * Connect to an MCP server using the specified transport
     */
    async connect(transportConfig: TransportConfig): Promise<void> {
        if (this.connected) {
            throw new Error('Client is already connected');
        }

        this.transport = transportConfig;

        if (transportConfig.type === 'stdio') {
            await this.connectStdio(transportConfig);
        } else if (transportConfig.type === 'sse') {
            await this.connectSse(transportConfig);
        } else {
            throw new Error(`Unsupported transport type: ${transportConfig.type}`);
        }

        // Set connected to true after successful connection
        this.connected = true;
    }

    /**
     * Connect to an MCP server using stdio transport
     */
    async connectStdio(config: TransportConfig): Promise<void> {
        const env = { ...process.env, ...config.env };
        let command = config.command || '';
        let args = config.args || [];

        if (!command) {
            throw new Error('Command is required for stdio transport');
        }

        // Windows-specific fix: Wrap the command in cmd /C to ensure proper path resolution
        if (process.platform === 'win32' && !command.toLowerCase().includes('cmd')) {
            const originalCommand = command;
            const originalArgs = [...args];
            command = 'cmd';
            args = ['/C', originalCommand, ...originalArgs];
            console.log(`[MCP] Windows detected, wrapping command: cmd /C ${originalCommand} ${originalArgs.join(' ')}`);
        }

        return new Promise<void>((resolve, reject) => {
            try {
                this.childProcess = spawn(command, args, {
                    env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });

                this.childProcess.on('error', (error) => {
                    console.error('[MCP] Child process error:', error);
                    this.connected = false;
                    reject(error);
                });

                this.childProcess.on('exit', (code, signal) => {
                    console.log(`[MCP] Child process exited with code ${code} and signal ${signal}`);
                    this.connected = false;
                });

                // Buffer for incomplete data
                let buffer = '';

                if (this.childProcess.stdout) {
                    this.childProcess.stdout.on('data', (data) => {
                        const text = data.toString();
                        buffer += text;

                        // Try to parse complete JSON objects
                        let newlineIndex;
                        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                            const line = buffer.substring(0, newlineIndex);
                            buffer = buffer.substring(newlineIndex + 1);

                            if (line.trim()) {
                                try {
                                    const message = JSON.parse(line) as JsonRpcResponse;
                                    console.log('[MCP] Received message:', message);

                                    // Check if this is a response to a pending request
                                    if (message.jsonrpc === '2.0' && message.id !== undefined) {
                                        const pendingRequest = this.pendingRequests.get(message.id);
                                        if (pendingRequest) {
                                            // Clear the timeout
                                            if (pendingRequest.timeoutId) {
                                                clearTimeout(pendingRequest.timeoutId);
                                            }

                                            // Resolve or reject the promise
                                            if (message.error) {
                                                pendingRequest.reject(new Error(`JSON-RPC error ${message.error.code}: ${message.error.message}`));
                                            } else {
                                                pendingRequest.resolve(message);
                                            }

                                            // Remove from pending requests
                                            this.pendingRequests.delete(message.id);
                                        }
                                    }
                                } catch (error) {
                                    console.error('[MCP] Error parsing JSON:', error, 'Line:', line);
                                }
                            }
                        }
                    });
                }

                if (this.childProcess.stderr) {
                    this.childProcess.stderr.on('data', (data) => {
                        console.error(`[MCP] stderr: ${data.toString()}`);
                    });
                }

                // Send initialization message with ignoreConnectionCheck=true
                this.sendJsonRpcRequest('initialize', {
                    clientInfo: this.clientInfo,
                    capabilities: this.capabilities,
                    protocolVersion: this.protocolVersion,
                }, true);

                // Wait a bit to ensure the server has started
                setTimeout(() => resolve(), 500);
            } catch (error) {
                console.error('[MCP] Error spawning child process:', error);
                reject(error);
            }
        });
    }

    /**
     * Connect to an MCP server using SSE transport
     */
    async connectSse(config: TransportConfig): Promise<void> {
        if (!config.url) {
            throw new Error('URL is required for SSE transport');
        }

        // For SSE transport, we just mark the connection as established
        // The actual SSE connection will be handled by the frontend
        this.connected = true;
        console.log('[MCP] SSE transport configured, connection will be handled by frontend');

        // Send initialization message via POST with ignoreConnectionCheck=true
        try {
            await this.sendJsonRpcRequest('initialize', {
                clientInfo: this.clientInfo,
                capabilities: this.capabilities,
                protocolVersion: this.protocolVersion,
            }, true);
        } catch (error) {
            console.error('[MCP] Error sending initialization message:', error);
            throw error;
        }

        return Promise.resolve();
    }

    /**
     * Send a JSON-RPC request to the MCP server
     */
    async sendJsonRpcRequest(method: string, params: any, ignoreConnectionCheck = false): Promise<JsonRpcResponse> {
        if (!ignoreConnectionCheck && !this.connected) {
            throw new Error('Client is not connected');
        }

        const request: JsonRpcRequest = {
            jsonrpc: '2.0',
            id: this.requestId++,
            method,
            params,
        };

        return new Promise<JsonRpcResponse>(async (resolve, reject) => {
            try {
                // For initialization and shutdown, we don't need to wait for a response
                const isSpecialMethod = method === 'initialize' || method === 'shutdown';

                if (this.transport?.type === 'stdio' && this.childProcess) {
                    const requestStr = JSON.stringify(request) + '\n';

                    // Store the request in pendingRequests if it's not a special method
                    if (!isSpecialMethod) {
                        // Set up timeout
                        const timeoutId = setTimeout(() => {
                            if (this.pendingRequests.has(request.id)) {
                                this.pendingRequests.delete(request.id);
                                reject(new Error(`Request timed out after ${this.requestTimeout}ms`));
                            }
                        }, this.requestTimeout);

                        // Store the request
                        this.pendingRequests.set(request.id, { resolve, reject, timeoutId });
                    }

                    // Send the request
                    if (this.childProcess.stdin) {
                        this.childProcess.stdin.write(requestStr, (error) => {
                            if (error) {
                                console.error('[MCP] Error writing to stdin:', error);

                                // Clean up the pending request
                                if (!isSpecialMethod && this.pendingRequests.has(request.id)) {
                                    const pendingRequest = this.pendingRequests.get(request.id);
                                    if (pendingRequest && pendingRequest.timeoutId) {
                                        clearTimeout(pendingRequest.timeoutId);
                                    }
                                    this.pendingRequests.delete(request.id);
                                }

                                reject(error);
                            } else if (isSpecialMethod) {
                                // For special methods, resolve immediately
                                resolve({
                                    jsonrpc: '2.0',
                                    id: request.id,
                                    result: { success: true },
                                });
                            }
                        });
                    } else {
                        reject(new Error('Child process stdin is not available'));
                    }
                } else if (this.transport?.type === 'sse') {
                    // For SSE transport, we only handle special methods (initialize, shutdown) directly
                    // Regular methods will be handled by the frontend
                    if (isSpecialMethod && this.transport.url) {
                        try {
                            const url = new URL(this.transport.url);
                            const response = await fetch(`${url.origin}${url.pathname}`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify(request),
                            });

                            if (!response.ok) {
                                throw new Error(`HTTP error! status: ${response.status}`);
                            }

                            // For special methods, resolve immediately
                            resolve({
                                jsonrpc: '2.0',
                                id: request.id,
                                result: { success: true },
                            });
                        } catch (error) {
                            console.error('[MCP] Error sending request via fetch:', error);
                            reject(error);
                        }
                    } else {
                        // For regular methods, we'll just resolve with a message indicating
                        // that the request should be handled by the frontend
                        console.log('[MCP] SSE request will be handled by frontend:', request);
                        resolve({
                            jsonrpc: '2.0',
                            id: request.id,
                            result: {
                                handled_by_frontend: true,
                                request: request,
                            },
                        });
                    }
                } else {
                    reject(new Error('No valid transport available'));
                }
            } catch (error) {
                console.error('[MCP] Error sending JSON-RPC request:', error);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    /**
     * List tools available from the MCP server
     */
    async listTools(): Promise<{ tools: Array<any> }> {
        try {
            const response = await this.sendJsonRpcRequest('tools/list', {});
            return response.result || { tools: [] };
        } catch (error) {
            console.error('[MCP] Error listing tools:', error);
            throw error;
        }
    }

    /**
     * Call a tool on the MCP server
     */
    async callTool(params: ToolCallParams): Promise<any> {
        try {
            const response = await this.sendJsonRpcRequest('tools/call', params);
            return response.result;
        } catch (error) {
            console.error('[MCP] Error calling tool:', error);
            throw error;
        }
    }

    /**
     * Close the connection to the MCP server
     */
    async close(): Promise<void> {
        if (!this.connected) {
            return;
        }

        try {
            // Send shutdown request
            await this.sendJsonRpcRequest('shutdown', {}, true);

            if (this.eventSource) {
                this.eventSource.close();
            }
        } catch (error) {
            console.error('[MCP] Error closing connection:', error);
        } finally {
            if (this.childProcess) {
                // Give the process a chance to exit gracefully
                setTimeout(() => {
                    this.childProcess?.kill();
                    this.childProcess = null;
                }, 1000);
            }

            this.connected = false;
            this.eventSource = null;
        }
    }
}

/**
 * Starts an MCP server process and connects to it using JSON-RPC
 */
async function startMcpServer(serverName: string, config: McpServerEntry): Promise<boolean> {
    if (mcpClients.has(serverName)) {
        console.warn(`[MCP] Server "${serverName}" is already running`);
        return true;
    }

    try {
        // Create a JSON-RPC client
        const client = new McpJsonRpcClient(
            {
                name: 'sillytavern-client',
                version: '1.0.0',
            },
            {
                prompts: {},
                resources: {},
                tools: {},
            },
        );

        // Set the transport type in the config
        const transportConfig: TransportConfig = {
            ...config,
            type: config.type || 'stdio',
        };

        // Connect to the server
        await client.connect(transportConfig);
        mcpClients.set(serverName, client);

        console.log(`[MCP] Connected to server "${serverName}" using JSON-RPC with ${transportConfig.type} transport`);
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
                // Use JSON-RPC to list tools
                const tools = await client?.listTools();
                response.json(tools?.tools || []);
            } catch (error) {
                console.error('[MCP] Error listing tools:', error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                response.status(500).json({ error: `Failed to list tools: ${errorMessage}` });
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
                // Use JSON-RPC to call the tool
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
            } catch (error) {
                console.error('[MCP] Error executing tool:', error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                response.status(500).json({
                    success: false,
                    error: `Failed to execute tool: ${errorMessage}`,
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
