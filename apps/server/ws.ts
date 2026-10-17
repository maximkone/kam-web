// ws.ts — minimal WebSocket server (RFC 6455) on node:http upgrade. Zero deps, node: builtins only.
// Transport only: it passes the text of each text frame up (the relay parses it with protocol.ts) and
// sends text frames down. Rules: masked client frames, no fragmentation, no binary, payload <= 64 KB
// (close 1009 before buffering it), ping every pingMs, idle close after idleMs without any frame.
// Style: ESM TypeScript that bare `node file.ts` runs (no enum, namespace or parameter properties).

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export const WS_CLOSE_NORMAL = 1000;
export const WS_CLOSE_GOING_AWAY = 1001;
export const WS_CLOSE_PROTOCOL = 1002;
export const WS_CLOSE_TOO_BIG = 1009;
export const WS_CLOSE_ABNORMAL = 1006;
export const WS_MAX_PAYLOAD = 65536;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsServerOptions {
  host: string;
  port: number;
  maxPayload?: number;
  pingMs?: number;
  idleMs?: number;
}

export class WsConn {
  readonly id: number;
  onmessage: ((text: string) => void) | null = null;
  onclose: ((code: number) => void) | null = null;
  lastSeen: number = Date.now();
  private socket: Socket;
  private server: WsServer;
  private buf: Buffer = Buffer.alloc(0);
  private open = true;
  private notified = false;

  constructor(id: number, socket: Socket, server: WsServer) {
    this.id = id;
    this.socket = socket;
    this.server = server;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.finish(WS_CLOSE_ABNORMAL));
    socket.on('error', () => this.finish(WS_CLOSE_ABNORMAL));
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Sends one text frame. Returns false when the connection is closed. */
  send(text: string): boolean {
    if (!this.open) return false;
    this.writeFrame(OP_TEXT, Buffer.from(text, 'utf8'));
    return true;
  }

  /** Sends a close frame, then closes the socket. onclose runs once, with this code. */
  close(code: number = WS_CLOSE_NORMAL): void {
    if (!this.open) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.writeFrame(OP_CLOSE, payload);
    this.open = false;
    this.finish(code);
    this.socket.end();
    const t = setTimeout(() => this.socket.destroy(), 1000);
    t.unref();
  }

  ping(): void {
    if (this.open) this.writeFrame(OP_PING, Buffer.alloc(0));
  }

  private finish(code: number): void {
    this.open = false;
    if (this.notified) return;
    this.notified = true;
    this.server.removeConn(this);
    this.onclose?.(code);
  }

  private fail(code: number): void {
    this.close(code);
  }

  private onData(chunk: Buffer): void {
    this.lastSeen = Date.now();
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    this.parse();
  }

  private parse(): void {
    while (this.open) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (rsv !== 0 || !fin || !masked) return this.fail(WS_CLOSE_PROTOCOL);
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        if (b.readUInt32BE(2) !== 0) return this.fail(WS_CLOSE_TOO_BIG);
        len = b.readUInt32BE(6);
        off = 10;
      }
      const control = op >= 0x8;
      if (control && len > 125) return this.fail(WS_CLOSE_PROTOCOL);
      if (len > this.server.maxPayload) return this.fail(WS_CLOSE_TOO_BIG);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === OP_TEXT) {
        this.onmessage?.(payload.toString('utf8'));
      } else if (op === OP_PING) {
        this.writeFrame(OP_PONG, payload);
      } else if (op === OP_PONG) {
        // a pong only refreshes lastSeen (set in onData)
      } else if (op === OP_CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : WS_CLOSE_NORMAL;
        this.close(code);
        return;
      } else {
        return this.fail(WS_CLOSE_PROTOCOL);
      }
    }
  }

  private writeFrame(op: number, payload: Buffer): void {
    const len = payload.length;
    let header: Buffer;
    if (len <= 125) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len <= 65535) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    header[0] = 0x80 | op;
    this.socket.write(Buffer.concat([header, payload]));
  }
}

export class WsServer {
  onconnection: ((conn: WsConn) => void) | null = null;
  readonly maxPayload: number;
  private host: string;
  private port: number;
  private pingMs: number;
  private idleMs: number;
  private http: Server;
  private conns = new Set<WsConn>();
  private nextId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: WsServerOptions) {
    this.host = opts.host;
    this.port = opts.port;
    this.maxPayload = opts.maxPayload ?? WS_MAX_PAYLOAD;
    this.pingMs = opts.pingMs ?? 1000;
    this.idleMs = opts.idleMs ?? 3000;
    this.http = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('use a WebSocket upgrade');
    });
    this.http.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => this.upgrade(req, socket, head));
  }

  get size(): number {
    return this.conns.size;
  }

  /** Listens; resolves with the bound port (port 0 picks a free one). */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.port, this.host, () => {
        this.http.off('error', reject);
        this.timer = setInterval(() => this.keepAlive(), this.pingMs);
        this.timer.unref();
        const addr = this.http.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : this.port);
      });
    });
  }

  stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const c of [...this.conns]) c.close(WS_CLOSE_GOING_AWAY);
    return new Promise((resolve) => {
      this.http.close(() => resolve());
      this.http.closeAllConnections();
    });
  }

  removeConn(conn: WsConn): void {
    this.conns.delete(conn);
  }

  private keepAlive(): void {
    const now = Date.now();
    for (const c of [...this.conns]) {
      if (now - c.lastSeen > this.idleMs) c.close(WS_CLOSE_GOING_AWAY);
      else c.ping();
    }
  }

  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const upgradeHeader = String(req.headers.upgrade ?? '').toLowerCase();
    const key = req.headers['sec-websocket-key'];
    if (upgradeHeader !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    socket.on('error', () => {});
    if (head.length > 0) socket.unshift(head);
    const conn = new WsConn(this.nextId++, socket, this);
    this.conns.add(conn);
    this.onconnection?.(conn);
  }
}
