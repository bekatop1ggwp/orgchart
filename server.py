"""Local static server and JSON API backed by SQLite."""

from __future__ import annotations

import argparse
import json
import sqlite3
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import database


ROOT = Path(__file__).resolve().parent
MAX_BODY_SIZE = 5 * 1024 * 1024


class OrgChartHandler(SimpleHTTPRequestHandler):
    server_version = "OrgChartLocal/2.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Некорректный Content-Length.") from error
        if length <= 0:
            raise ValueError("Тело запроса пустое.")
        if length > MAX_BODY_SIZE:
            raise OverflowError("Запрос превышает допустимый размер 5 МБ.")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/structure":
            return self._send_json(database.get_structure())
        if path == "/api/health":
            snapshot = database.get_structure()
            return self._send_json(
                {
                    "status": "ok",
                    "database": str(database.DATABASE_PATH.name),
                    "revision": snapshot["revision"],
                }
            )
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_PUT(self):
        if urlparse(self.path).path != "/api/structure":
            return self._send_json({"error": "Маршрут не найден."}, HTTPStatus.NOT_FOUND)
        try:
            return self._send_json(database.replace_structure(self._read_json()))
        except OverflowError as error:
            return self._send_json({"error": str(error)}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            status = HTTPStatus.UNPROCESSABLE_ENTITY if isinstance(error, database.ValidationError) else HTTPStatus.BAD_REQUEST
            return self._send_json({"error": str(error)}, status)
        except sqlite3.IntegrityError as error:
            return self._send_json(
                {"error": f"SQLite отклонил изменения: {error}"},
                HTTPStatus.CONFLICT,
            )

    def do_POST(self):
        if urlparse(self.path).path != "/api/reset":
            return self._send_json({"error": "Маршрут не найден."}, HTTPStatus.NOT_FOUND)
        try:
            return self._send_json(database.reset_to_demo())
        except (database.ValidationError, sqlite3.IntegrityError) as error:
            return self._send_json({"error": str(error)}, HTTPStatus.CONFLICT)

    def end_headers(self):
        if not urlparse(self.path).path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def parse_args():
    parser = argparse.ArgumentParser(description="Локальный сервер оргструктуры")
    parser.add_argument("--host", default="127.0.0.1", help="Адрес (по умолчанию 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Порт (по умолчанию 8000)")
    return parser.parse_args()


def main():
    args = parse_args()
    database.initialize()
    server = ThreadingHTTPServer((args.host, args.port), OrgChartHandler)
    print(f"Оргструктура: http://{args.host}:{args.port}")
    print(f"SQLite: {database.DATABASE_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
