import copy
import json
from pathlib import Path
import tempfile
import unittest

from cad_rl import main, suggest
from cad_rl_env import BeamEnv, benchmark_tasks
from cad_rl_policy import QPolicy, TEST_SEED, TRAIN_SEED, benchmark, features, fixed_order, rollout, train
from engineering_verification import design_digest


EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "rl-cantilever.json"


def task():
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


class CadRLTest(unittest.TestCase):
    def test_usage_changes_verdict_and_ranking_for_the_same_solids(self):
        fixture = json.loads(EXAMPLE.with_name("rl-cantilever-fit.json").read_text())
        for item, expected_width in [(fixture, 24), (task(), 22)]:
            size = item["plan"]["parts"][0]["primitives"][0]["size"]
            size[:] = [120, 22, 8]
            # 22x8 and 24x8 both fit; under the material-only contract also allow their working range.
            if item["id"] == "cantilever-example":
                item["plan"]["engineeringVerification"]["requirements"][1]["maxMm"] = 0.21
            env = BeamEnv(item, max_steps=2)
            env.reset()
            self.assertTrue(env.current.passed)
            env.step(1)
            self.assertTrue(env.current.passed)
            self.assertEqual(env.best.size[1], expected_width)
            slender = env.candidate((0, 5))  # 16 x 10
            self.assertEqual(slender.passed, item["id"] == "cantilever-example")
            if expected_width == 24:
                decisions = {c["id"]: c["decision"] for c in slender.report["verification"]["claims"]}
                self.assertEqual(decisions["strength"], "pass")
                self.assertEqual(decisions["fixture-width"], "fail")
                self.assertEqual(decisions["working-travel"], "hold")

    def test_unsupported_direction_and_review_require_evidence(self):
        item = task()
        contract = item["plan"]["engineeringVerification"]
        contract["loadCase"]["direction"] = "Y"
        result = suggest(QPolicy(), item, 8)
        self.assertIsNone(result["candidate"])
        self.assertIn("load_direction_out_of_scope", [c["reason"] for c in result["lastReport"]["verification"]["claims"]])
        contract["loadCase"]["direction"] = "Z"
        contract["requirements"].append({"kind": "design_review", "id": "service",
                                         "statement": "装配后扳手可达", "sourceIds": ["user-criteria"]})
        result = suggest(QPolicy(), item, 8)
        self.assertIsNone(result["candidate"])
        check = result["lastReport"]["verification"]["claims"][-1]
        self.assertEqual(check["decision"], "hold")
        self.assertEqual(check["evidence"]["statement"], "装配后扳手可达")
        self.assertEqual(check["sourceIds"], ["user-criteria"])

    def test_real_brep_and_locked_contract(self):
        item = task()
        frozen = copy.deepcopy(item)
        env = BeamEnv(item, max_steps=8)
        best = rollout(env, fixed_order)
        self.assertEqual(env.candidate(env.start).report["decision"], "fail")
        self.assertEqual(best.report["decision"], "pass")
        self.assertEqual(item, frozen)
        self.assertEqual(best.plan["engineeringVerification"], frozen["plan"]["engineeringVerification"])
        solid = best.report["verification"]["claims"][0]["evidence"]
        self.assertEqual(solid["solidCount"], 1)
        for measured, planned in zip(solid["dimensionsMm"], best.size):
            self.assertAlmostEqual(measured, planned)
        self.assertEqual(best.size[0], 120)
        self.assertLessEqual(len(env.seen), 9)

    def test_feature_tree_and_legacy_projection_stay_in_sync(self):
        item = task()
        part = item["plan"]["parts"][0]
        part["featureTree"] = [{"id": "base", "type": "base_box", "enabled": True,
                               "params": {"size": [120, 22, 6]}}]
        env = BeamEnv(item, max_steps=8)
        best = rollout(env, fixed_order)
        self.assertIsNotNone(best)
        changed = best.plan["parts"][0]
        self.assertEqual(changed["featureTree"][0]["params"]["size"], list(best.size))
        self.assertEqual(changed["primitives"][0]["size"], list(best.size))

    def test_missing_load_produces_hold_not_a_candidate(self):
        item = task()
        del item["plan"]["engineeringVerification"]["loadCase"]["forceN"]
        output = suggest(QPolicy(), item, 8)
        self.assertIsNone(output["candidate"])
        self.assertEqual(output["candidateEvaluations"], 1)
        self.assertEqual(output["initialReport"]["decision"], "hold")

    def test_trial_for_original_design_cannot_release_a_changed_design(self):
        item = task()
        plan = item["plan"]
        contract = plan["engineeringVerification"]
        plan["parts"][0]["primitives"][0]["size"] = [120, 30, 11]
        contract["requirements"].append({"id": "trial", "kind": "use_trial", "maxMm": 0.15})
        contract["useContext"] = {"environment": "bench", "forceN": 20, "fixture": "clamp", "materialId": "sample"}
        contract["trialEvidence"] = [{"id": "trial-1", "source": "fixture test record", "method": "physical_trial",
                                      **contract["useContext"], "measuredMm": 0.10, "uncertaintyMm": 0.01,
                                      "designDigest": design_digest({k: v for k, v in plan.items() if k != "engineeringVerification"})}]
        env = BeamEnv(item, max_steps=8)
        best = rollout(env, fixed_order)
        self.assertEqual(env.current.report["validation"]["decision"], "hold")
        self.assertEqual(best.coordinate, env.start)
        self.assertEqual(best.report["decision"], "pass")

    def test_edits_cannot_exceed_authorized_bounds(self):
        item = task()
        item["search"]["thicknessMm"]["max"] = 6
        env = BeamEnv(item, max_steps=8)
        env.reset()
        self.assertNotIn(0, env.actions())
        with self.assertRaisesRegex(ValueError, "unavailable action"):
            env.step(0)

    def test_q_values_change_after_reward_and_roundtrip(self):
        policy, metrics = train(35, 5, 42, 8)
        self.assertGreater(metrics["updates"], 0)
        self.assertGreater(metrics["distinctCandidateEvaluations"], 5)
        checkpoint = policy.checkpoint(metrics)
        replica = QPolicy.load(json.loads(json.dumps(checkpoint)))
        self.assertEqual(replica.checkpoint(metrics), checkpoint)
        self.assertTrue(any(weight != 0 for row in checkpoint["weights"] for weight in row.values()))
        env = BeamEnv(task(), max_steps=8)
        env.reset()
        self.assertEqual(policy.act(env, env.actions()), replica.act(env, env.actions()))
        self.assertEqual(policy.value(features(env), 0), replica.value(features(env), 0))

    def test_test_split_is_disjoint_and_benchmark_does_not_train(self):
        def lengths(split, seed):
            return {t["plan"]["parts"][0]["primitives"][0]["size"][0] for t in benchmark_tasks(split, 120, seed)}
        self.assertFalse(lengths("train", TRAIN_SEED) & lengths("test", TEST_SEED))
        policy, metrics = train(20, 6, 31, 8)
        before = policy.checkpoint(metrics)
        report = benchmark(policy, 8, 8)
        self.assertEqual(before, policy.checkpoint(metrics))
        for row in report["cases"]:
            for result in row["results"].values():
                self.assertLessEqual(result["candidateEvaluations"], 9)

    def test_cli_can_resume_on_explicit_tasks_without_overwriting_input(self):
        with tempfile.TemporaryDirectory() as root:
            before, after = (Path(root) / x for x in ("before.json", "after.json"))
            self.assertEqual(main(["train", "--episodes", "4", "--tasks", "1", "--out", str(before)]), 0)
            checkpoint = before.read_bytes()
            self.assertEqual(main(["train", "--episodes", "4", "--tasks", "0", "--task-file", str(EXAMPLE),
                                   "--resume", str(before), "--out", str(after)]), 0)
            self.assertEqual(before.read_bytes(), checkpoint)
            resumed = json.loads(after.read_bytes())
            self.assertEqual(resumed["training"]["totalEpisodes"], 8)
            self.assertFalse(resumed["training"]["builtInTrainingOnly"])
            self.assertNotEqual(resumed["weights"], json.loads(checkpoint)["weights"])


if __name__ == "__main__":
    unittest.main()
