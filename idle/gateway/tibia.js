'use strict';
/*
 * "Cliente invisivel" do Destruitor Idle: entra com um personagem no Canary
 * (protocolo 15.11) e mantem a conexao viva enquanto ele caca.
 *
 * Por que manter a conexao: o Canary tem protecao anti x-log. Um jogador sem
 * conexao perde o alvo a cada passo do jogo (Player::sendPing) e os monstros nao
 * atacam quem esta desconectado (login protection). Com a conexao aberta e
 * respondendo ping, o personagem luta normalmente -- quem decide o que ele faz e
 * o idle.lua, no servidor. Tudo o que o servidor manda aqui e descartado.
 *
 * Formato (conferido na fonte do OTClient 4.1 e do Canary 3.6.1):
 *   quadro = u16 tamanho em blocos de 8 | u32 checksum ou sequencia | blocos
 *   bloco  = u8 quantidade de padding | mensagem | padding
 *   1o pacote do servidor: desafio 0x1F (u32 hora, u8 aleatorio), sem criptografia
 *   login: 0x0A, SO, versoes, hash dos assets, e um bloco RSA de 128 bytes com a
 *          chave XTEA, a sessao (authType = "session"), o personagem e o desafio.
 *   depois: tudo em XTEA; o cliente numera os pacotes (1, 2, 3...) e manda um pong
 *          (0x1E: no Canary e o 0x1E que atualiza o "ultimo pong"; o 0x1D so pede um ping de volta).
 */
const net = require('net');
const crypto = require('crypto');
const zlib = require('zlib');
const { EventEmitter } = require('events');

const CLIENT_VERSION = 1511;
const OS_OTCLIENT_WINDOWS = 11; // <= OTCLIENT_MAC: o Canary usa numero de sequencia
const DELTA = 0x9e3779b9;
const PING_EVERY = 3000;

function adler32(buf) {
  let a = 1;
  let b = 0;
  for (const x of buf) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function xteaEncrypt(buf, k) {
  for (let off = 0; off + 8 <= buf.length; off += 8) {
    let v0 = buf.readUInt32LE(off);
    let v1 = buf.readUInt32LE(off + 4);
    let sum = 0;
    for (let i = 0; i < 32; i++) {
      v0 = (v0 + (((((v1 << 4) ^ (v1 >>> 5)) + v1) >>> 0) ^ ((sum + k[sum & 3]) >>> 0))) >>> 0;
      sum = (sum + DELTA) >>> 0;
      v1 = (v1 + (((((v0 << 4) ^ (v0 >>> 5)) + v0) >>> 0) ^ ((sum + k[(sum >>> 11) & 3]) >>> 0))) >>> 0;
    }
    buf.writeUInt32LE(v0, off);
    buf.writeUInt32LE(v1, off + 4);
  }
}

function xteaDecrypt(buf, k) {
  for (let off = 0; off + 8 <= buf.length; off += 8) {
    let v0 = buf.readUInt32LE(off);
    let v1 = buf.readUInt32LE(off + 4);
    let sum = Math.imul(DELTA, 32) >>> 0;
    for (let i = 0; i < 32; i++) {
      v1 = (v1 - (((((v0 << 4) ^ (v0 >>> 5)) + v0) >>> 0) ^ ((sum + k[(sum >>> 11) & 3]) >>> 0))) >>> 0;
      sum = (sum - DELTA) >>> 0;
      v0 = (v0 - (((((v1 << 4) ^ (v1 >>> 5)) + v1) >>> 0) ^ ((sum + k[sum & 3]) >>> 0))) >>> 0;
    }
    buf.writeUInt32LE(v0, off);
    buf.writeUInt32LE(v1, off + 4);
  }
}

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
};
const str = (s) => {
  const b = Buffer.from(s, 'latin1');
  return Buffer.concat([u16(b.length), b]);
};

// [u8 padding][mensagem][padding] com tamanho multiplo de 8
function padded(body) {
  const pad = 7 - (body.length % 8);
  return Buffer.concat([Buffer.from([pad]), body, Buffer.alloc(pad)]);
}

function buildLogin({ sessionKey, character, ts, rand, publicKey, xtea }) {
  const block = Buffer.alloc(128); // o resto fica em zero (inclui o u16 do OTCv8)
  Buffer.concat([
    Buffer.from([0]), // o 1o byte do bloco RSA tem que ser 0
    ...xtea.map(u32),
    Buffer.from([0]), // nao e GM
    str(sessionKey),
    str(character),
    u32(ts),
    Buffer.from([rand]),
  ]).copy(block, 0);
  const encrypted = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_NO_PADDING }, block);
  const payload = padded(
    Buffer.concat([
      Buffer.from([0x0a]), // ClientPendingGame
      u16(OS_OTCLIENT_WINDOWS),
      u16(CLIENT_VERSION),
      u32(CLIENT_VERSION),
      str(String(CLIENT_VERSION)),
      str(''), // hash dos assets (o Canary so registra)
      Buffer.from([0]), // game preview state
      encrypted,
    ])
  );
  return Buffer.concat([u16(payload.length / 8), u32(adler32(payload)), payload]);
}

/**
 * Conexao de um personagem. Eventos: 'ready' (entrou no mundo), 'fail' (motivo),
 * 'close' (caiu depois de entrar).
 */
class GameLink extends EventEmitter {
  constructor({ host, port, worldName, sessionKey, character, publicKey }) {
    super();
    this.character = character;
    this.xtea = [0, 0, 0, 0].map(() => crypto.randomBytes(4).readUInt32LE(0));
    this.seq = 0;
    this.stage = 'challenge';
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.opts = { sessionKey, character, publicKey };

    this.sock = net.connect({ host, port });
    this.sock.setNoDelay(true);
    this.sock.on('connect', () => this.sock.write(Buffer.from(worldName + '\n', 'latin1')));
    this.sock.on('data', (chunk) => this.onData(chunk));
    this.sock.on('error', (e) => this.fail('Sem conexão com o servidor do jogo (' + e.code + ').'));
    this.sock.on('close', () => {
      clearInterval(this.pinger);
      if (this.stage === 'ready') {
        this.stage = 'closed';
        this.emit('close', this.lastMessage || '');
      } else {
        this.fail(this.lastMessage || 'O servidor do jogo fechou a conexão.');
      }
    });
    this.timer = setTimeout(() => this.fail('O servidor do jogo não respondeu.'), 10000);
  }

  fail(reason) {
    if (this.stage === 'ready' || this.stage === 'failed' || this.stage === 'closed') return;
    this.stage = 'failed';
    clearTimeout(this.timer);
    this.sock.destroy();
    this.emit('fail', reason);
  }

  send(body) {
    if (this.sock.destroyed) return;
    const payload = padded(body);
    xteaEncrypt(payload, this.xtea);
    this.seq = (this.seq + 1) & 0x7fffffff;
    this.sock.write(Buffer.concat([u16(payload.length / 8), u32(this.seq), payload]));
  }

  // passos na cidade (o personagem anda livre): dx, dy = -1, 0 ou 1
  step(dx, dy) {
    const op = { '0,-1': 0x65, '1,0': 0x66, '0,1': 0x67, '-1,0': 0x68, '1,-1': 0x6a, '1,1': 0x6b, '-1,1': 0x6c, '-1,-1': 0x6d }[dx + ',' + dy];
    if (op) this.send(Buffer.from([op]));
  }

  // andar ate um ponto: lista de passos [dx, dy]; o Canary le a lista de tras para frente
  // (1 leste, 2 nordeste, 3 norte, 4 noroeste, 5 oeste, 6 sudoeste, 7 sul, 8 sudeste)
  autoWalk(steps) {
    const code = { '1,0': 1, '1,-1': 2, '0,-1': 3, '-1,-1': 4, '-1,0': 5, '-1,1': 6, '0,1': 7, '1,1': 8 };
    const dirs = steps.map(([dx, dy]) => code[dx + ',' + dy]).filter(Boolean).slice(0, 120);
    if (!dirs.length) return;
    this.send(Buffer.from([0x64, dirs.length, ...dirs.reverse()]));
  }

  stopWalk() {
    this.send(Buffer.from([0x69]));
  }

  // pede para sair do jogo (so funciona fora de combate; senao a conexao cai e o
  // Canary tira o personagem quando puder)
  logout() {
    this.send(Buffer.from([0x14]));
    setTimeout(() => this.close(), 1500);
  }

  close() {
    this.closed = true;
    clearInterval(this.pinger);
    this.sock.destroy();
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const size = 2 + 4 + this.buf.readUInt16LE(0) * 8;
      if (this.buf.length < size) return;
      const frame = this.buf.subarray(0, size);
      this.buf = this.buf.subarray(size);

      if (this.stage === 'challenge') {
        // [u16][u32 checksum][u8 padding][0x1F][u32 hora][u8 aleatorio]
        if (frame[7] !== 0x1f) return this.fail('Resposta inesperada do servidor.');
        const ts = frame.readUInt32LE(8);
        const rand = frame[12];
        this.sock.write(buildLogin({ ...this.opts, ts, rand, xtea: this.xtea }));
        this.stage = 'login';
        continue;
      }

      // so olhamos o 1o byte de cada quadro: 0x14 = mensagem de desconexao
      const flags = frame.readUInt32LE(2);
      const data = Buffer.from(frame.subarray(6));
      xteaDecrypt(data, this.xtea);
      let msg = data.subarray(1, data.length - data[0]);
      if (flags & 0x80000000) {
        try {
          msg = zlib.inflateRawSync(msg);
        } catch {
          msg = Buffer.alloc(0);
        }
      }
      if (msg[0] === 0x14 && msg.length >= 3) {
        const len = msg.readUInt16LE(1);
        this.lastMessage = msg.subarray(3, 3 + len).toString('latin1');
        if (this.stage === 'login') return this.fail(this.lastMessage);
      } else if (msg[0] === 0x16 && this.stage === 'login') {
        return this.fail('O servidor está com fila de espera.');
      } else if (this.stage === 'login') {
        this.stage = 'ready';
        clearTimeout(this.timer);
        this.pinger = setInterval(() => this.send(Buffer.from([0x1e])), PING_EVERY);
        this.emit('ready');
      }
    }
  }
}

module.exports = { GameLink, xteaEncrypt, xteaDecrypt, adler32 };
