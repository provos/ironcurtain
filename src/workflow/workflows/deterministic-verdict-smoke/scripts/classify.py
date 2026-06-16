import json
import pathlib

ws = pathlib.Path("/workspace")
out = ws / ".workflow"
out.mkdir(exist_ok=True)
task = (ws / "task.txt").read_text().strip().lower() if (ws / "task.txt").exists() else ""

# An "error" task exercises the missing-file -> result_file_error path: the helper
# exits 0 but writes no result file, so the orchestrator must route to error_terminal.
if "error" not in task:
    verdict = "block" if "block" in task else "pass"
    (out / "result.json").write_text(
        json.dumps({"verdict": verdict, "payload": {"task": task}, "passed": True}) + "\n"
    )

# stdout is verdict-blind regardless of branch — routing can only come from the file.
print("classified")
