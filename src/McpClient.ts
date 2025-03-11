import { Validator } from "jsonschema";

import child_process from 'node:child_process';
import EventEmitter from 'node:events';

const JSONRPC_VERSION = "2.0";
const PROTOCOL_VERSION = "2024-11-05";

export enum ErrorCode {
    // SDK error codes
    ConnectionClosed = -32000,
    RequestTimeout = -32001,
    UnsupportedProtocolVersion = -32002,

    // Standard JSON-RPC error codes
    ParseError = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    InternalError = -32603,
}

export type RequestId = string | number;
export type ProgressToken = string | number;

export interface ClientCapabilities {
    experimental?: Record<string, any>;
    sampling?: object;
    roots?: {
        listChanged?: boolean;
    };
    tools?: {
        listChanged?: boolean;
    };
}

export interface ServerCapabilities {
    experimental?: Record<string, any>;
    logging?: object;
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

export interface RequestMetadata {
    progressToken?: ProgressToken;
    [key: string]: unknown;
}

export interface McpRequest {
    jsonrpc: typeof JSONRPC_VERSION;
    id: RequestId;
    method: string;
    params?: {
        _meta?: RequestMetadata;
        [key: string]: unknown;
    };
}

export interface McpResponse {
    jsonrpc: typeof JSONRPC_VERSION;
    id: RequestId;
    result?: {
        _meta?: { [key: string]: unknown };
        [key: string]: unknown;
    };
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}

export interface McpNotification {
    jsonrpc: typeof JSONRPC_VERSION;
    method: string;
    params?: {
        _meta?: { [key: string]: unknown };
        [key: string]: unknown;
    };
}

export interface McpClientConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

export interface Annotated {
    annotations?: {
        audience?: ("user" | "assistant")[];
        priority?: number;
    };
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
    private pendingRequests: Map<RequestId, {
        resolve: Function;
        reject: Function;
        method: string;
    }> = new Map();
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
                    protocolVersion: PROTOCOL_VERSION,
                    capabilities: this.clientCapabilities,
                    clientInfo: this.clientInfo,
                }).then((result: any) => {
                    // Verify protocol version compatibility
                    if (!this.isProtocolVersionSupported(result.protocolVersion)) {
                        throw new McpError(
                            ErrorCode.UnsupportedProtocolVersion,
                            `Server protocol version ${result.protocolVersion} is not supported`
                        );
                    }

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

    private isProtocolVersionSupported(version: string): boolean {
        // For now, we only support exact match
        // In the future, we could implement semver comparison
        return version === PROTOCOL_VERSION;
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

    private async sendRequest(method: string, params: any, progressToken?: ProgressToken): Promise<any> {
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
                params: {
                    ...params,
                    _meta: progressToken ? { progressToken } : undefined
                }
            };

            this.pendingRequests.set(id, { resolve, reject, method });

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
            params: params ? {
                ...params,
                _meta: {}
            } : undefined
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

        const pending = this.pendingRequests.get(message.id);
        if (!pending) {
            console.warn('Received response for unknown request:', message);
            return;
        }

        this.pendingRequests.delete(message.id);

        // Handle tool call responses specially
        if ('result' in message && pending.method === 'tools/call') {
            // For example, MemoryMesh wraps their response with `toolResults`.
            function findContentLevel(obj: any): any {
                if (obj?.content === undefined) {
                    // Check if there is only one property
                    if (Object.keys(obj).length === 1) {
                        return findContentLevel(obj[Object.keys(obj)[0]]);
                    }
                    return obj;
                }
                return obj;
            }

            const result = findContentLevel(message.result);
            if (result?.isError) {
                pending.reject(new McpError(
                    ErrorCode.InternalError,
                    result.content?.[0]?.text || 'Tool call failed',
                    result
                ));
                return;
            }

            pending.resolve(result);
            return;
        }

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
