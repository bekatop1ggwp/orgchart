"""SQLite persistence and integrity rules for the organization chart."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DATABASE_PATH = DATA_DIR / "org_chart.db"
DEMO_PATH = ROOT / "demo-data.json"
ROLES = {"founder", "director", "manager", "employee"}


class ValidationError(ValueError):
    """Raised when a structure cannot be stored without breaking integrity."""


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _nullable(value: Any) -> str | None:
    cleaned = _clean(value)
    return cleaned or None


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(exist_ok=True)
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


def initialize() -> None:
    with connect() as connection:
        connection.executescript(
            """
            PRAGMA journal_mode = WAL;

            CREATE TABLE IF NOT EXISTS departments (
                id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
                name TEXT NOT NULL DEFAULT '',
                parent_department_id TEXT,
                reports_to_id TEXT,
                head_id TEXT,
                CHECK (parent_department_id IS NULL OR parent_department_id <> id),
                CHECK (parent_department_id IS NULL OR reports_to_id IS NULL),
                FOREIGN KEY (parent_department_id) REFERENCES departments(id)
                    ON UPDATE CASCADE ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
                FOREIGN KEY (reports_to_id) REFERENCES people(id)
                    ON UPDATE CASCADE ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
                FOREIGN KEY (head_id) REFERENCES people(id)
                    ON UPDATE CASCADE ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
            );

            CREATE TABLE IF NOT EXISTS people (
                id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
                name TEXT NOT NULL DEFAULT '',
                position TEXT NOT NULL DEFAULT '',
                role TEXT NOT NULL DEFAULT 'employee'
                    CHECK (role IN ('founder', 'director', 'manager', 'employee')),
                department_id TEXT,
                manager_id TEXT,
                CHECK (manager_id IS NULL OR manager_id <> id),
                FOREIGN KEY (department_id) REFERENCES departments(id)
                    ON UPDATE CASCADE ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
                FOREIGN KEY (manager_id) REFERENCES people(id)
                    ON UPDATE CASCADE ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
            );

            CREATE INDEX IF NOT EXISTS idx_people_department ON people(department_id);
            CREATE INDEX IF NOT EXISTS idx_people_manager ON people(manager_id);
            CREATE INDEX IF NOT EXISTS idx_departments_parent ON departments(parent_department_id);
            CREATE INDEX IF NOT EXISTS idx_departments_reports_to ON departments(reports_to_id);

            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TRIGGER IF NOT EXISTS people_id_globally_unique
            BEFORE INSERT ON people
            WHEN EXISTS (SELECT 1 FROM departments WHERE id = NEW.id)
            BEGIN
                SELECT RAISE(ABORT, 'ID already belongs to a department');
            END;

            CREATE TRIGGER IF NOT EXISTS department_id_globally_unique
            BEFORE INSERT ON departments
            WHEN EXISTS (SELECT 1 FROM people WHERE id = NEW.id)
            BEGIN
                SELECT RAISE(ABORT, 'ID already belongs to a person');
            END;
            """
        )
        connection.execute(
            "INSERT OR IGNORE INTO metadata(key, value) VALUES ('revision', '0')"
        )
        count = connection.execute(
            "SELECT (SELECT count(*) FROM people) + (SELECT count(*) FROM departments)"
        ).fetchone()[0]

    if count == 0:
        reset_to_demo()


def normalize_structure(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValidationError("Ожидался JSON-объект структуры.")

    raw_people = payload.get("people", [])
    raw_departments = payload.get("departments", [])
    if not isinstance(raw_people, list) or not isinstance(raw_departments, list):
        raise ValidationError("people и departments должны быть массивами.")

    people = []
    for raw in raw_people:
        if not isinstance(raw, dict):
            raise ValidationError("Некорректная запись сотрудника.")
        role = _clean(raw.get("role")) or "employee"
        if role not in ROLES:
            raise ValidationError(f"Неизвестная роль: {role}.")
        people.append(
            {
                "id": _clean(raw.get("id")),
                "name": _clean(raw.get("name")),
                "position": _clean(raw.get("position")),
                "role": role,
                "departmentId": _clean(raw.get("departmentId")),
                "managerId": _clean(raw.get("managerId")),
            }
        )

    departments = []
    for raw in raw_departments:
        if not isinstance(raw, dict):
            raise ValidationError("Некорректная запись отдела.")
        departments.append(
            {
                "id": _clean(raw.get("id")),
                "name": _clean(raw.get("name")),
                "parentDepartmentId": _clean(raw.get("parentDepartmentId")),
                "reportsToId": _clean(raw.get("reportsToId")),
                "headId": _clean(raw.get("headId")),
            }
        )

    structure = {"version": 2, "people": people, "departments": departments}
    validate_structure(structure)
    return structure


def _has_cycle(parent_by_id: dict[str, str]) -> bool:
    for start in parent_by_id:
        current = start
        path: set[str] = set()
        while current:
            if current in path:
                return True
            path.add(current)
            current = parent_by_id.get(current, "")
    return False


def validate_structure(structure: dict[str, Any]) -> None:
    people = structure["people"]
    departments = structure["departments"]
    all_ids = [item["id"] for item in people] + [item["id"] for item in departments]

    if any(not item_id for item_id in all_ids):
        raise ValidationError("ID не может быть пустым.")
    if len(all_ids) != len(set(all_ids)):
        raise ValidationError("ID сотрудников и отделов должны быть уникальными.")

    people_ids = {person["id"] for person in people}
    department_ids = {department["id"] for department in departments}

    for person in people:
        if person["managerId"] and person["managerId"] not in people_ids:
            raise ValidationError(f"Руководитель сотрудника «{person['name']}» не найден.")
        if person["departmentId"] and person["departmentId"] not in department_ids:
            raise ValidationError(f"Отдел сотрудника «{person['name']}» не найден.")

    for department in departments:
        if department["parentDepartmentId"] and department["parentDepartmentId"] not in department_ids:
            raise ValidationError(f"Родитель для отдела «{department['name']}» не найден.")
        if department["reportsToId"] and department["reportsToId"] not in people_ids:
            raise ValidationError(f"Куратор отдела «{department['name']}» не найден.")
        if department["headId"] and department["headId"] not in people_ids:
            raise ValidationError(f"Руководитель отдела «{department['name']}» не найден.")
        if department["parentDepartmentId"] and department["reportsToId"]:
            raise ValidationError(
                f"Отдел «{department['name']}» не может одновременно входить в отдел и подчиняться сотруднику."
            )
        if department["headId"]:
            head = next(person for person in people if person["id"] == department["headId"])
            if head["departmentId"] != department["id"]:
                raise ValidationError(
                    f"Руководитель отдела «{department['name']}» должен состоять в этом отделе."
                )

    if _has_cycle({person["id"]: person["managerId"] for person in people}):
        raise ValidationError("Обнаружен цикл в подчинении сотрудников.")
    if _has_cycle(
        {department["id"]: department["parentDepartmentId"] for department in departments}
    ):
        raise ValidationError("Обнаружен цикл во вложенности отделов.")


def get_structure() -> dict[str, Any]:
    with connect() as connection:
        people = [
            {
                "id": row["id"],
                "name": row["name"],
                "position": row["position"],
                "role": row["role"],
                "departmentId": row["department_id"] or "",
                "managerId": row["manager_id"] or "",
            }
            for row in connection.execute(
                "SELECT id, name, position, role, department_id, manager_id FROM people ORDER BY rowid"
            )
        ]
        departments = [
            {
                "id": row["id"],
                "name": row["name"],
                "parentDepartmentId": row["parent_department_id"] or "",
                "reportsToId": row["reports_to_id"] or "",
                "headId": row["head_id"] or "",
            }
            for row in connection.execute(
                """
                SELECT id, name, parent_department_id, reports_to_id, head_id
                FROM departments ORDER BY rowid
                """
            )
        ]
        revision = int(
            connection.execute("SELECT value FROM metadata WHERE key = 'revision'").fetchone()[0]
        )
    return {"version": 2, "revision": revision, "people": people, "departments": departments}


def replace_structure(payload: Any) -> dict[str, Any]:
    structure = normalize_structure(payload)
    with connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("PRAGMA defer_foreign_keys = ON")
        connection.execute("DELETE FROM people")
        connection.execute("DELETE FROM departments")

        connection.executemany(
            """
            INSERT INTO departments(id, name, parent_department_id, reports_to_id, head_id)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (
                    item["id"],
                    item["name"],
                    _nullable(item["parentDepartmentId"]),
                    _nullable(item["reportsToId"]),
                    _nullable(item["headId"]),
                )
                for item in structure["departments"]
            ],
        )
        connection.executemany(
            """
            INSERT INTO people(id, name, position, role, department_id, manager_id)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    item["id"],
                    item["name"],
                    item["position"],
                    item["role"],
                    _nullable(item["departmentId"]),
                    _nullable(item["managerId"]),
                )
                for item in structure["people"]
            ],
        )
        connection.execute(
            "UPDATE metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'"
        )
    return get_structure()


def reset_to_demo() -> dict[str, Any]:
    with DEMO_PATH.open("r", encoding="utf-8") as source:
        return replace_structure(json.load(source))


if __name__ == "__main__":
    initialize()
    snapshot = get_structure()
    print(
        f"SQLite ready: {DATABASE_PATH} "
        f"({len(snapshot['people'])} people, {len(snapshot['departments'])} departments)"
    )
