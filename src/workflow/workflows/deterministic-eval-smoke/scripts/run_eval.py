import importlib.util
import json
import os
from pathlib import Path

import numpy as np


workspace = Path("/workspace")
candidate_path = workspace / "candidate.py"
workflow_dir = workspace / ".workflow"
workflow_dir.mkdir(exist_ok=True)

if not candidate_path.exists():
    raise SystemExit("missing /workspace/candidate.py")

spec = importlib.util.spec_from_file_location("candidate", candidate_path)
if spec is None or spec.loader is None:
    raise SystemExit("failed to load candidate.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

cases = [[], [1, 2, 3], [-5, 10, 12]]
expected = [0, 6, 17]
actual = [module.solve(xs) for xs in cases]
passed = bool(np.array_equal(np.array(actual), np.array(expected)))
score = 1.0 if passed else 0.0

result = {
    "score": score,
    "passed": passed,
    "cases": len(cases),
    "actual": actual,
    "expected": expected,
    "dependency": "numpy",
}

(workflow_dir / "eval.json").write_text(json.dumps(result, indent=2) + "\n")
print(f"{len(cases)} tests pass" if passed else "evaluation failed")
if not passed:
    raise SystemExit(1)
