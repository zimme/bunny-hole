"""Offline deployment guard tests. All Terraform/GitHub commands are fakes."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
COMMIT = "a" * 40


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copytree(ROOT / "scripts", self.root / "scripts")
        (self.root / "terraform").mkdir()
        (self.root / "terraform/backend.tf").write_text("configured backend\n")
        self.config = self.root / "terraform/deployment.auto.tfvars.json"
        self.config.write_text("{}\n")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.fake("git", 'echo "' + COMMIT + '"')
        self.fake("curl", 'printf \'{"sha":"%s"}\\n\' "${FAKE_TIP}"')
        # Portable hashing for the tests; production uses Ubuntu's sha256sum.
        self.fake("sha256sum", 'shasum -a 256 "$@"')
        self.fake("terraform", '''
printf '%s\\n' "$*" >> "$CALLS"
shift
case "$1" in
  state)
    if [[ "$2" == list ]]; then
      printf '%s\\n' bunnynet_compute_container_app.host
      if [[ "${ADOPTION_STATE:-complete}" != empty ]]; then
        printf '%s\\n' bunnynet_pullzone.public
      fi
      if [[ "${ADOPTION_STATE:-complete}" == complete ]]; then
        printf '%s\\n' bunnynet_pullzone.connector
      fi
    elif [[ "${@: -1}" == "${MISSING_RESOURCE:-}" ]]; then
      exit 1
    elif [[ "${@: -1}" == bunnynet_pullzone.public ]]; then
      echo 'id = "101"'
    elif [[ "${@: -1}" == bunnynet_pullzone.connector ]]; then
      printf 'id = "%s"\\n' "${FAKE_CONNECTOR_STATE_ID:-102}"
    fi ;;
  plan) exit 0 ;;
  show) printf '%s\\n' '{"format_version":"1.2","timestamp":"ignored"}' ;;
  output)
    case "${@: -1}" in
      bootstrap_public_pullzone_id) echo 101 ;;
      bootstrap_connector_pullzone_id) echo 102 ;;
      bootstrap_handoff) echo '{}' ;;
    esac ;;
  apply|import) exit 0 ;;
  *) exit 2 ;;
esac
''')
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}",
                        OPERATION="apply", DEFAULT_BRANCH="main",
                        GITHUB_API_URL="https://offline.invalid", GITHUB_REPOSITORY="fixture/repo",
                        GITHUB_TOKEN="offline-fixture", REVIEWED_COMMIT=COMMIT, FAKE_TIP=COMMIT,
                        GITHUB_STEP_SUMMARY=str(self.root / "summary"),
                        RUNNER_TEMP=str(self.root), CALLS=str(self.root / "calls"))
        # jq -S pretty-prints the fake JSON after removing timestamp.
        canonical = json.dumps({"format_version": "1.2"}, indent=2) + "\n"
        self.env["REVIEWED_PLAN_SHA256"] = hashlib.sha256(canonical.encode()).hexdigest()

    def fake(self, name, body):
        path = self.bin / name
        path.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + body + "\n")
        path.chmod(0o755)

    def run_script(self, name, *args, success=True):
        result = subprocess.run(["bash", f"scripts/{name}.sh", *args], cwd=self.root,
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def calls(self):
        path = self.root / "calls"
        return path.read_text() if path.exists() else ""

    def test_general_placeholders_block_bootstrap(self):
        self.env["OPERATION"] = "bootstrap"
        self.config.write_text('{"region":"REPLACE_WITH_CONFIRMED_REGION"}')
        self.run_script("verify-inputs", success=False)
        self.assertEqual(self.calls(), "")

    def test_setup_preserves_existing_configuration(self):
        backend = self.root / "terraform/backend.tf"
        before = (backend.read_bytes(), self.config.read_bytes())
        self.run_script("setup")
        self.run_script("setup")
        self.assertEqual((backend.read_bytes(), self.config.read_bytes()), before)

    def test_setup_creates_only_missing_configuration(self):
        self.config.unlink()
        (self.root / "terraform/deployment.auto.tfvars.json.example").write_text('{}\n')
        self.run_script("setup")
        self.assertEqual(self.config.read_text(), '{}\n')
        self.assertEqual((self.root / "terraform/backend.tf").read_text(), 'configured backend\n')

    def test_bootstrap_markers_only_allowed_for_bootstrap(self):
        self.config.write_text('{"id":"REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_ID"}')
        self.run_script("verify-inputs", success=False)
        self.env["OPERATION"] = "bootstrap"
        self.run_script("verify-inputs")

    def test_missing_host_blocks_full_apply(self):
        self.env["MISSING_RESOURCE"] = "bunnynet_compute_container_app.host"
        self.run_script("deployment", "apply", success=False)
        self.assertNotIn(" apply ", self.calls())

    def test_missing_zone_blocks_full_apply(self):
        self.env["MISSING_RESOURCE"] = "bunnynet_pullzone.connector"
        self.run_script("deployment", "apply", success=False)
        self.assertNotIn(" plan ", self.calls())

    def test_changed_plan_blocks_apply(self):
        self.env["REVIEWED_PLAN_SHA256"] = "0" * 64
        self.run_script("deployment", "apply", success=False)
        self.assertNotIn(" apply ", self.calls())
        self.assertEqual(list(self.root.glob("bunny-hole-plan.*")), [])

    def test_changed_tip_blocks_apply(self):
        self.env["FAKE_TIP"] = "b" * 40
        self.run_script("deployment", "apply", success=False)
        self.assertNotIn(" apply ", self.calls())

    def test_matching_plan_and_tip_allow_apply(self):
        self.run_script("deployment", "apply")
        self.assertIn(" apply -auto-approve ", self.calls())
        self.assertNotIn(" import ", self.calls())
        self.assertEqual(list(self.root.glob("bunny-hole-plan.*")), [])

    def test_bootstrap_existing_host_uses_refresh_only(self):
        self.env["OPERATION"] = "bootstrap"
        self.run_script("deployment", "apply")
        self.assertIn("-refresh-only -target=bunnynet_compute_container_app.host", self.calls())
        self.assertNotIn(" import ", self.calls())

    def test_bootstrap_initial_host_uses_target(self):
        self.env.update(OPERATION="bootstrap", MISSING_RESOURCE="bunnynet_compute_container_app.host")
        self.run_script("deployment", "plan")
        self.assertIn("-target=bunnynet_compute_container_app.host", self.calls())
        self.assertNotIn("-refresh-only", self.calls())
        self.assertNotIn(" apply ", self.calls())
        self.assertIn("Reviewed commit: " + COMMIT, (self.root / "summary").read_text())

    def test_bootstrap_refuses_wrong_adopted_zone(self):
        self.env.update(OPERATION="bootstrap", FAKE_CONNECTOR_STATE_ID="999")
        self.run_script("deployment", "apply", success=False)
        self.assertNotIn(" import ", self.calls())
        self.assertFalse((self.root / "summary").exists())

    def test_initial_bootstrap_applies_host_and_adopts_both_zones(self):
        self.env.update(OPERATION="bootstrap", ADOPTION_STATE="empty",
                        MISSING_RESOURCE="bunnynet_compute_container_app.host")
        self.run_script("deployment", "apply")
        calls = self.calls()
        self.assertIn("-target=bunnynet_compute_container_app.host", calls)
        self.assertNotIn("-refresh-only", calls)
        self.assertIn("import bunnynet_pullzone.public 101", calls)
        self.assertIn("import bunnynet_pullzone.connector 102", calls)
        self.assertEqual(calls.count(" apply "), 1)
        self.assertLess(calls.index(" apply "), calls.index(" import "))
        self.assertIn("Safe bootstrap handoff", (self.root / "summary").read_text())
        self.assertEqual(list(self.root.glob("bunny-hole-plan.*")), [])

    def test_partial_bootstrap_imports_only_missing_zone(self):
        self.env.update(OPERATION="bootstrap", ADOPTION_STATE="partial")
        self.run_script("deployment", "apply")
        self.assertIn("-refresh-only -target=bunnynet_compute_container_app.host", self.calls())
        self.assertNotIn("import bunnynet_pullzone.public", self.calls())
        self.assertIn("import bunnynet_pullzone.connector 102", self.calls())

    def test_setup_missing_source_leaves_no_destination_and_can_retry(self):
        backend = self.root / "terraform/backend.tf"
        original = backend.read_text()
        self.config.unlink()
        self.run_script("setup", success=False)
        self.assertFalse(self.config.exists())
        self.assertEqual(backend.read_text(), original)
        self.assertEqual(list((self.root / "terraform").glob(".bunny-hole-config.*")), [])
        self.config.with_name(self.config.name + ".example").write_text('{"region":"DE"}\n')
        self.run_script("setup")
        self.assertEqual(self.config.read_text(), '{"region":"DE"}\n')

    def test_setup_partial_read_failure_never_installs_destination(self):
        self.config.unlink()
        self.config.with_name(self.config.name + ".example").write_text('{}\n')
        self.fake("cat", 'printf \'{"partial":\'; exit 1')
        self.run_script("setup", success=False)
        self.assertFalse(self.config.exists())
        self.assertEqual(list((self.root / "terraform").glob(".bunny-hole-config.*")), [])


if __name__ == "__main__":
    unittest.main()
