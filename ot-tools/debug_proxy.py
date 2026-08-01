"""Proxy de depuracao: escuta 7272, repassa para o jogo em 7172 e grava os bytes."""
import socket
import threading
import time

LISTEN = ("127.0.0.1", 7272)
TARGET = ("127.0.0.1", 7172)
LOG = r"C:\Users\julio\Aldruna\ot-tools\proxy_capture.log"

lock = threading.Lock()


def log(line):
    with lock:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%H:%M:%S')}] {line}\n")


def pump(src, dst, tag):
    try:
        while True:
            data = src.recv(4096)
            if not data:
                log(f"{tag}: FIM (fechou normal)")
                break
            log(f"{tag}: {len(data)} bytes: {data.hex()}")
            dst.sendall(data)
    except ConnectionResetError:
        log(f"{tag}: RESET")
    except OSError as e:
        log(f"{tag}: erro {e}")
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(client):
    log("=== nova conexao do cliente ===")
    try:
        server = socket.create_connection(TARGET, timeout=5)
    except OSError as e:
        log(f"nao conectou no jogo: {e}")
        client.close()
        return
    threading.Thread(target=pump, args=(client, server, "CLIENTE->JOGO"), daemon=True).start()
    pump(server, client, "JOGO->CLIENTE")


srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(LISTEN)
srv.listen(5)
print(f"proxy {LISTEN} -> {TARGET}, log em {LOG}")
while True:
    conn, _ = srv.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
