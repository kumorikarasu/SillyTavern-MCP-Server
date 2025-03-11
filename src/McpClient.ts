import { Validator } from "jsonschema";

import child_process from 'node:child_process';
import EventEmitter from 'node:events';

const JSONRPC_VERSION = "2.0";

export enum ErrorCode {
    // SDK error codes
    ConnectionClosed = -32000,
    RequestTimeout = -32001,

    // Standard JSON-RPC error codes
    ParseError = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    InternalError = -32603,
}

export interface ClientCapabilities {
    experimental?: Record<string, any>;
    sampling?: Record<string, any>;
    roots?: {
        listChanged?: boolean;
    };
    tools?: {
        listChanged?: boolean;
    };
}

export interface ServerCapabilities {
    experimental?: Record<string, any>;
    logging?: Record<string, any>;
    prompts?: {
        listChanged?: boolean;
    };
    resources?: {
        subscribe?: boolean;
        listChanged?: boolean;
    };
    tools?: {
        listChanged?: boolean;
    };
}

export interface Implementation {
    name: string;
    version: string;
}

export interface McpRequest {
    jsonrpc: typeof JSONRPC_VERSION;
    id: number;
    method: string;
    params?: Record<string, any>;
}

export interface McpResponse {
    jsonrpc: typeof JSONRPC_VERSION;
    id: number;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}

export interface McpNotification {
    jsonrpc: typeof JSONRPC_VERSION;
    method: string;
    params?: Record<string, any>;
}

export interface McpClientConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

export class McpError extends Error {
    constructor(
        public readonly code: ErrorCode,
        message: string,
        public readonly data?: unknown,
    ) {
        super(`MCP error ${code}: ${message}`);
        this.name = "McpError";
    }
}

export class McpClient extends EventEmitter {
    private proc?: child_process.ChildProcess;
    private requestId: number = 0;
    private pending: Map<number, { resolve: Function; reject: Function }> = new Map();
    private isConnected: boolean = false;
    private capabilities?: ServerCapabilities;
    private initializePromise?: Promise<void>;

    constructor(
        private config: McpClientConfig,
        private clientInfo: Implementation = {
            name: 'sillytavern-client',
            version: '1.0.0'
        },
        private clientCapabilities: ClientCapabilities = {}
    ) {
        super();
    }

    public async connect(): Promise<void> {
        if (this.isConnected) {
            return;
        }

        if (this.initializePromise) {
            return this.initializePromise;
        }

        this.initializePromise = new Promise((resolve, reject) => {
            const { command, args = [], env } = this.config;

            this.proc = child_process.spawn(command, args, {
                env: { ...process.env, ...env },
                stdio: ['pipe', 'pipe', 'pipe']
            });

            this.proc.stdout?.on('data', (data) => {
                const lines = data.toString().split('\n');
                for (const line of lines) {
                    if (!line) continue;
                    try {
                        const message = JSON.parse(line);
                        this.handleMessage(message);
                    } catch (error) {
                        console.error('Failed to parse MCP message:', error);
                        this.emit('error', new McpError(ErrorCode.ParseError, 'Failed to parse message'));
                    }
                }
            });

            this.proc.stderr?.on('data', (data) => {
                // Log as info since these are usually initialization messages, not errors
                console.log(`[MCP Server] ${data}`);
            });

            this.proc.on('error', (error) => {
                this.isConnected = false;
                this.emit('error', new McpError(ErrorCode.ConnectionClosed, error.message));
                reject(error);
            });

            this.proc.on('close', (code) => {
                this.isConnected = false;
                this.initializePromise = undefined;
                this.emit('close', code);
            });

            // Wait a short moment for the process to start
            setTimeout(() => {
                if (!this.proc?.stdin) {
                    reject(new McpError(ErrorCode.ConnectionClosed, 'Failed to start MCP server process'));
                    return;
                }

                // Initialize connection
                this.sendRequest('initialize', {
                    protocolVersion: '2024-11-05',
                    capabilities: this.clientCapabilities,
                    clientInfo: this.clientInfo,
                }).then((result) => {
                    this.capabilities = result.capabilities;
                    this.isConnected = true;

                    // Send initialized notification
                    this.sendNotification('notifications/initialized');

                    resolve();
                }).catch(reject);
            }, 100); // Wait 100ms for process to start
        });

        return this.initializePromise;
    }

    public async close(): Promise<void> {
        if (!this.isConnected) {
            return;
        }

        return new Promise((resolve) => {
            if (!this.proc) {
                resolve();
                return;
            }

            this.proc.on('close', () => {
                this.isConnected = false;
                this.initializePromise = undefined;
                resolve();
            });

            if (this.proc) {
                this.proc.kill();
            }
        });
    }

    public async listTools(): Promise<any> {
        return this.sendRequest('tools/list', {});
    }

    public async callTool(params: { name: string; arguments: any }, schema: any): Promise<any> {
        new Validator().validate(params.arguments, schema, { throwError: true });
        return this.sendRequest('tools/call', params);
    }

    private async sendRequest(method: string, params: any): Promise<any> {
        // For initialization requests, we don't want to check isConnected
        if (method !== 'initialize' && (!this.isConnected || !this.proc?.stdin)) {
            throw new McpError(ErrorCode.ConnectionClosed, 'MCP client is not connected');
        }

        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            const request: McpRequest = {
                jsonrpc: JSONRPC_VERSION,
                id,
                method,
                params
            };

            this.pending.set(id, { resolve, reject });

            if (!this.proc?.stdin) {
                throw new McpError(ErrorCode.ConnectionClosed, 'Process stdin is not available');
            }
            this.proc.stdin.write(JSON.stringify(request) + '\n');
        });
    }

    private sendNotification(method: string, params?: any): void {
        if (!this.isConnected || !this.proc?.stdin) {
            throw new McpError(ErrorCode.ConnectionClosed, 'MCP client is not connected');
        }

        const notification: McpNotification = {
            jsonrpc: JSONRPC_VERSION,
            method,
            params
        };

        if (!this.proc?.stdin) {
            throw new McpError(ErrorCode.ConnectionClosed, 'Process stdin is not available');
        }
        this.proc.stdin.write(JSON.stringify(notification) + '\n');
    }

    private handleMessage(message: McpResponse | McpNotification): void {
        // Handle notifications
        if (!('id' in message)) {
            this.emit('notification', message);
            return;
        }

        const pending = this.pending.get(message.id);
        if (!pending) {
            console.warn('Received response for unknown request:', message);
            return;
        }

        this.pending.delete(message.id);
        if ('error' in message && message.error) {
            pending.reject(new McpError(
                message.error.code,
                message.error.message,
                message.error.data
            ));
        } else {
            pending.resolve(message.result);
        }
    }

    public getCapabilities(): ServerCapabilities | undefined {
        return this.capabilities;
    }
}
