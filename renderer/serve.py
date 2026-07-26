"""
Запуск рендерера на сокете, слышном по обоим протоколам.

## Что было не так

Контейнер запускался строкой ``uvicorn app:app --host ${RENDERER_HOST:-::}``.
Значение ``::`` выбрали ради приватной сети Railway, которая работает по IPv6.
Но uvicorn отдаёт адрес в ``asyncio.create_server``, а тот выставляет сокету
``IPV6_V6ONLY``, — и слушатель получается **только** IPv6.

Замер в собранном образе: в ``/proc/net/tcp6`` слушатель есть, в
``/proc/net/tcp`` пусто, а ``curl http://127.0.0.1:8080/health`` изнутри
контейнера отвечает «соединение отвергнуто». Из-за этого проверка
работоспособности самого образа (она ходит на ``localhost``, то есть на
IPv4-петлю) не проходила никогда, и контейнер бесконечно числился нездоровым —
Railway показывал Healthcheck failure при исправном сервисе.

## Что здесь

Сокет создаётся заранее и с выключенным ``IPV6_V6ONLY``, поэтому один
слушатель принимает и IPv6, и IPv4 (последний — как отображённый адрес). Если
ядро двойной стек не поддерживает, берётся обычный IPv4 — лучше работать по
одному протоколу, чем не подняться вовсе.

Запуск: ``python serve.py``
"""

from __future__ import annotations

import os
import socket
import sys

import uvicorn


def _port() -> int:
    raw = (os.environ.get("PORT") or "8080").strip()
    try:
        return int(raw)
    except ValueError:
        return 8080


def create_listening_socket(host: str, port: int) -> socket.socket:
    """
    Сокет, слышный по обоим протоколам, когда это возможно.

    ``host`` пустой или ``::`` означает «слушать всё». Явно заданный адрес
    уважается как есть: если оператор просит IPv4-интерфейс, двойной стек ему
    не нужен.
    """
    wants_all = host in ("", "::", "*")
    if wants_all and socket.has_ipv6:
        try:
            sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            # Ключевая строка: без неё слушатель остаётся только IPv6.
            sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            sock.bind(("::", port))
            sock.listen(2048)
            sock.set_inheritable(True)
            return sock
        except OSError as exc:  # двойной стек недоступен — не повод не подняться
            print(f"[serve] двойной стек недоступен ({exc}); слушаю IPv4", file=sys.stderr)

    bind_host = "0.0.0.0" if wants_all else host
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((bind_host, port))
    sock.listen(2048)
    sock.set_inheritable(True)
    return sock


def main() -> None:
    host = (os.environ.get("RENDERER_HOST") or "::").strip()
    port = _port()
    sock = create_listening_socket(host, port)
    family = "IPv6+IPv4" if sock.family == socket.AF_INET6 else "IPv4"
    print(f"[serve] слушаю :{port} ({family})", file=sys.stderr)
    config = uvicorn.Config("app:app", log_level="info")
    uvicorn.Server(config).run(sockets=[sock])


if __name__ == "__main__":
    main()
