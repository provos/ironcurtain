import json
import pathlib

ws = pathlib.Path("/workspace")
out = ws / ".workflow"
out.mkdir(exist_ok=True)
task = (ws / "task.txt").read_text().strip().lower() if (ws / "task.txt").exists() else ""

verdict = "block" if "block" in task else "pass"

(out / "result.json").write_text(
    json.dumps({"verdict": verdict, "payload": {"task": task}, "passed": True}) + "\n"
)

print("classified")
