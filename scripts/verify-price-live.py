#!/usr/bin/env python3
"""Normal-role price preflight and one reviewed one-cent change; key stays on stdin."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--mode', choices=['preflight', 'submit'], default='preflight')
    parser.add_argument('--approved-plan', type=Path)
    parser.add_argument('--approved-sha256')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    budget = out.parent / 'seller-price-write-attempts.jsonl'
    if args.mode == 'submit':
        if args.approved_plan is None or not args.approved_sha256:
            raise SystemExit('Submit requires an explicitly reviewed plan and exact SHA256.')
        approved = args.approved_plan.resolve()
        if hashlib.sha256(approved.read_bytes()).hexdigest() != args.approved_sha256:
            raise SystemExit('Reviewed request bytes changed.')
        if budget.exists():
            raise SystemExit('One-write budget is already consumed; do not dispatch again.')
    module = importlib.util.spec_from_file_location('publish_credentials', root / 'scripts/verify-publish-live.py')
    imported = importlib.util.module_from_spec(module)
    module.loader.exec_module(imported)
    with tempfile.TemporaryDirectory(prefix='podhub-price-live-') as tmp:
        binary = Path(tmp) / 'integration.test'
        subprocess.run(['go', 'test', '-c', '-o', str(binary), './tests/integration'], cwd=root, check=True)
        credentials = subprocess.check_output(['ssh', 'tx-podhub', 'python3', '-'], input=imported.REMOTE.encode(), stderr=subprocess.DEVNULL)
        selected = json.loads(credentials)
        env = os.environ.copy()
        env.update(PODHUB_PRICE_LIVE_MODE=args.mode, PODHUB_PRICE_LIVE_OUTPUT=str(out), PODHUB_PARITY_DSN='')
        if args.mode == 'submit':
            env.update(PODHUB_PRICE_APPROVED_PLAN=str(approved), PODHUB_PRICE_APPROVED_SHA256=args.approved_sha256, PODHUB_PRICE_WRITE_LEDGER=str(budget))
        result = subprocess.run([str(binary), '-test.run=^TestOpsPriceLive$', '-test.v', '-test.timeout=8m'], cwd=root, env=env, input=credentials, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        log = result.stdout.decode(errors='replace').replace(selected['api_key'], '[REDACTED]')
        (out / ('price-' + args.mode + '.log')).write_text(log)
        print('\n'.join(log.splitlines()[-16:]))
        if result.returncode:
            raise SystemExit(result.returncode)
        report = out / ('price-' + args.mode + '.json')
        if not report.exists() or not json.loads(report.read_text()).get('passed'):
            raise SystemExit('Price validation did not pass.')


if __name__ == '__main__':
    main()
