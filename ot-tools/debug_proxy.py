"""Proxy de depuracao: escuta 7272, repassa para o jogo em 7172 e grava os bytes.

Usado so para diagnostico: aponte GAME_PORT do login_server.py para 7272,
rode este script, tente entrar no jogo e leia proxy_capture.log.
"""
import socket
import threading
import time

LISTEN = ("127.0.0.1", 7272)
TARGET = ("127.0.0.1", 7172)
LOG = r"C:\Users\julio\Aldruna\ot-tools\proxy_capture.log"

lock = threading.Lock()
start = time.time()


def log(line):
    with lock:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"[+{time.time() - start:7.3f}s] {line}\n")
            f.flush()


def pump(src, dst, tag):
    total = 0
    try:
        while True:
            data = src.recv(4096)
            if not data:
                log(f"{tag}: FIM apos {total} bytes (outro lado fechou)")
                break
            total += len(data)
            log(f"{tag}: {len(data)} bytes: {data[:120].hex()}")
            dst.sendall(data)
    except ConnectionResetError:
        log(f"{tag}: RESET apos {total} bytes")
    except OSError as e:
        log(f"{tag}: erro {e}")


def handle(client, addr):
    log(f"=== conexao de {addr} ===")
    try:
        server = socket.create_connection(TARGET, timeout=5)
    except OSError as e:
        log(f"nao conectou no jogo: {e}")
        client.close()
        return
    t = threading.Thread(target=pump, args=(client, server, "CLIENTE->JOGO"), daemon=True)
    t.start()
    pump(server, client, "JOGO->CLIENTE")
    t.join(timeout=10)
    log("=== conexao encerrada ===")
    client.close()
    server.close()


srv = socket.socket()
srv.bind(LISTEN)
srv.listen(5)
print(f"proxy {LISTEN} -> {TARGET}, log em {LOG}")
while True:
    conn, addr = srv.accept()
    threading.Thread(target=handle, args=(conn, addr), daemon=True).start()
