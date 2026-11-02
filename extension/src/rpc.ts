import * as net from 'node:net';

export const MAX_FRAME = 8 * 1024 * 1024;

export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length < 1 || length > MAX_FRAME) throw new Error('Invalid CodeConverge frame size');
      if (this.buffer.length < 4 + length) break;
      messages.push(JSON.parse(this.buffer.subarray(4, 4 + length).toString('utf8')));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return messages;
  }
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_FRAME) throw new Error('CodeConverge message exceeds limit');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class RpcConnection {
  private sequence = 0;
  private pending = new Map<number, {resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout}>();
  private decoder = new FrameDecoder();
  private constructor(private socket: net.Socket, onClose: () => void) {
    socket.on('data', data => {
      try {
        for (const raw of this.decoder.push(data)) {
          const message = raw as {id: number; result?: unknown; error?: {code: string; message: string}};
          const request = this.pending.get(message.id);
          if (!request) continue;
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.error) request.reject(new Error(`${message.error.code}: ${message.error.message}`));
          else request.resolve(message.result);
        }
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('CodeConverge engine connection closed'));
      }
      this.pending.clear();
      onClose();
    });
  }

  static connect(pipe: string, onClose: () => void): Promise<RpcConnection> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(pipe);
      const timer = setTimeout(() => socket.destroy(new Error('CodeConverge pipe connection timeout')), 10000);
      socket.once('error', reject);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeListener('error', reject);
        resolve(new RpcConnection(socket, onClose));
      });
      socket.once('close', () => clearTimeout(timer));
    });
  }

  call(op: string, values: Record<string, unknown> = {}): Promise<any> {
    if (this.socket.destroyed) return Promise.reject(new Error('CodeConverge connection is closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CodeConverge ${op} timed out`));
      }, 15000);
      this.pending.set(id, {resolve, reject, timer});
      this.socket.write(encodeFrame({id, op, ...values}));
    });
  }

  dispose(): void { this.socket.destroy(); }
}
