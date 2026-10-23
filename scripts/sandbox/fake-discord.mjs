// Minimal fake Discord IPC server for a sandboxed daemon run: answers the
// handshake with READY, acks every request, and appends each SET_ACTIVITY
// payload to a log file. Usage: node fake-discord.mjs <socketPath> <logFile> <ipcModule>
import net from 'node:net';
import fs from 'node:fs';
const [sockPath, logFile, ipcModule] = process.argv.slice(2);
const { encodeFrame, createFrameDecoder } = await import(ipcModule);
const OP_HANDSHAKE = 0, OP_FRAME = 1;
try { fs.unlinkSync(sockPath); } catch {}
net.createServer((socket) => {
  const decode = createFrameDecoder();
  socket.on('data', (chunk) => {
    for (const f of decode(chunk)) {
      if (f.op === OP_HANDSHAKE) {
        socket.write(encodeFrame(OP_FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { user: { id: '1', username: 'sandbox' } } }));
      } else if (f.op === OP_FRAME) {
        if (f.data?.cmd === 'SET_ACTIVITY') fs.appendFileSync(logFile, JSON.stringify(f.data.args?.activity ?? null) + '\n');
        socket.write(encodeFrame(OP_FRAME, { cmd: f.data?.cmd, data: {}, evt: null, nonce: f.data?.nonce }));
      }
    }
  });
}).listen(sockPath);
