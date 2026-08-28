"""Audit the project handoff package against its character policy."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class Result:
    path: str
    exists: bool
    characters: int
    limit: int

    @property
    def ok(self) -> bool:
        return self.exists and self.characters <= self.limit


def count_non_whitespace(text: str) -> int:
    return sum(not character.isspace() for character in text)


def audit(root: Path, policy_path: Path | None = None) -> list[Result]:
    root = root.resolve()
    policy_path = policy_path or root / "docs" / "handoff" / "context-policy.json"
    if not policy_path.is_absolute():
        policy_path = root / policy_path
    policy = json.loads(policy_path.read_text(encoding="utf-8"))
    required = policy.get("required_files")
    if not isinstance(required, dict) or not required:
        raise ValueError("context policy must define a non-empty required_files object")

    results: list[Result] = []
    for relative_path, raw_limit in required.items():
        target = root / relative_path
        exists = target.is_file()
        text = target.read_text(encoding="utf-8") if exists else ""
        results.append(Result(
            path=str(relative_path),
            exists=exists,
            characters=count_non_whitespace(text),
            limit=int(raw_limit),
        ))
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit the project handoff package")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--policy", type=Path)
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args()

    try:
        results = audit(args.root, args.policy)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"[FAIL] {error}")
        return 1

    if args.as_json:
        print(json.dumps([asdict(result) | {"ok": result.ok} for result in results], indent=2))
    else:
        for result in results:
            state = "OK" if result.ok else "FAIL"
            print(f"[{state}] {result.path}: {result.characters}/{result.limit} chars")
    return 0 if all(result.ok for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
