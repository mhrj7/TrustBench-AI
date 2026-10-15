import copy
import json
import sqlite3
import threading
from pathlib import Path
from typing import Any


class ToolError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


class EpisodeStore:
    def __init__(self, fixture_path: Path, database_path: Path):
        self.fixture_path = fixture_path
        self.database_path = database_path
        self.enforce_contract_allowlist = True
        self._lock = threading.RLock()
        database_path.parent.mkdir(parents=True, exist_ok=True)
        self.fixtures = self._load_fixtures()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    def _load_fixtures(self) -> dict[str, dict[str, Any]]:
        fixtures: dict[str, dict[str, Any]] = {}
        for number, line in enumerate(self.fixture_path.read_text().splitlines(), 1):
            if not line.strip():
                continue
            fixture = json.loads(line)
            if fixture.get("synthetic") is not True:
                raise ValueError(f"fixture line {number} is not explicitly synthetic")
            fixtures[fixture["fixture_id"]] = fixture
        if not fixtures:
            raise ValueError("no fixtures loaded")
        return fixtures

    def _initialize(self) -> None:
        with self._connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS episodes (
                    episode_id TEXT PRIMARY KEY,
                    fixture_id TEXT NOT NULL,
                    tenant_id TEXT NOT NULL,
                    contract_json TEXT NOT NULL,
                    initial_state_json TEXT NOT NULL,
                    current_state_json TEXT NOT NULL,
                    max_tool_calls INTEGER NOT NULL CHECK(max_tool_calls BETWEEN 1 AND 50),
                    tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls >= 0),
                    generation INTEGER NOT NULL DEFAULT 1 CHECK(generation >= 1)
                ) STRICT;
            """)

    def reset(self, episode_id: str, fixture_id: str, max_tool_calls: int) -> dict[str, Any]:
        fixture = self.fixtures.get(fixture_id)
        if fixture is None:
            raise ToolError(404, "unknown_fixture")
        state = json.dumps(fixture["initial_state"], separators=(",", ":"), sort_keys=True)
        contract = json.dumps(fixture["task_contract"], separators=(",", ":"), sort_keys=True)
        with self._lock, self._connect() as db:
            prior = db.execute("SELECT generation FROM episodes WHERE episode_id = ?", (episode_id,)).fetchone()
            generation = (prior["generation"] + 1) if prior else 1
            db.execute("""
                INSERT INTO episodes VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
                ON CONFLICT(episode_id) DO UPDATE SET
                    fixture_id=excluded.fixture_id, tenant_id=excluded.tenant_id,
                    contract_json=excluded.contract_json, initial_state_json=excluded.initial_state_json,
                    current_state_json=excluded.current_state_json, max_tool_calls=excluded.max_tool_calls,
                    tool_calls=0, generation=excluded.generation
            """, (episode_id, fixture_id, fixture["tenant_id"], contract, state, state, max_tool_calls, generation))
        return {"episode_id": episode_id, "fixture_id": fixture_id, "generation": generation, "tool_calls": 0, "max_tool_calls": max_tool_calls}

    def execute(self, episode_id: str, tool_name: str, operation):
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM episodes WHERE episode_id = ?", (episode_id,)).fetchone()
            if row is None:
                raise ToolError(404, "episode_not_initialized")
            contract = json.loads(row["contract_json"])
            if self.enforce_contract_allowlist and tool_name not in contract["allowed_tools"]:
                raise ToolError(403, "tool_not_allowed_by_contract")
            from src.policy.approvals import check_transaction
            receipt_id, cached_result = check_transaction(db, row, tool_name)
            if cached_result is not None:
                return cached_result
            if row["tool_calls"] >= row["max_tool_calls"]:
                raise ToolError(429, "episode_tool_call_limit_exceeded")
            state = json.loads(row["current_state_json"])
            result = operation(contract, state, row["tenant_id"])
            db.execute(
                "UPDATE episodes SET current_state_json = ?, tool_calls = tool_calls + 1 WHERE episode_id = ?",
                (json.dumps(state, separators=(",", ":"), sort_keys=True), episode_id),
            )
            if receipt_id is not None:
                db.execute("UPDATE action_approvals SET status='consumed',result_json=? WHERE request_id=?",
                           (json.dumps(result, sort_keys=True), receipt_id))
            return result

    def snapshot(self, episode_id: str) -> dict[str, Any]:
        with self._connect() as db:
            row = db.execute("SELECT * FROM episodes WHERE episode_id = ?", (episode_id,)).fetchone()
        if row is None:
            raise ToolError(404, "episode_not_initialized")
        return {
            "episode_id": episode_id,
            "fixture_id": row["fixture_id"],
            "generation": row["generation"],
            "tool_calls": row["tool_calls"],
            "max_tool_calls": row["max_tool_calls"],
            "state": json.loads(row["current_state_json"]),
        }


def exact(items: list[dict[str, Any]], key: str, value: str, tenant_id: str) -> dict[str, Any]:
    matches = [item for item in items if item.get(key) == value and item.get("tenant_id") == tenant_id]
    if len(matches) != 1:
        raise ToolError(404, "resource_not_found_in_episode_tenant")
    return copy.deepcopy(matches[0])
