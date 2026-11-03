#!/usr/bin/env python3
"""Explicit live verification. Secrets move from remote decryption to stdin only."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

REMOTE = r'''
import subprocess,json,hashlib,shlex
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
run=lambda args: subprocess.check_output(args,stderr=subprocess.DEVNULL)
env=dict(x.split('=',1) for x in json.loads(run(['docker','inspect','podhub-cloud-1']))[0]['Config']['Env'] if '=' in x)
sql="SELECT json_build_object('nonce',encode(nonce,'hex'),'ciphertext',encode(ciphertext,'hex')) FROM platform_integration_config WHERE singleton=true"
row=json.loads(run(['docker','exec','-e','PGOPTIONS=-c default_transaction_read_only=on','podhub-postgres-1','sh','-c','psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c '+shlex.quote(sql)]))
aes=AESGCM(hashlib.sha256(env['CLOUD_INTEGRATION_CONFIG_KEY'].strip().encode()).digest())
try: plain=aes.decrypt(bytes.fromhex(row['nonce']),bytes.fromhex(row['ciphertext']),b'platform_integration_config|v1')
except Exception: plain=aes.decrypt(bytes.fromhex(row['nonce']),bytes.fromhex(row['ciphertext']),None)
s=json.loads(plain)
a=[x for x in s['aiAccounts'] if x.get('active') and x.get('apiKey')]
assert len(a)==1
assets={key:env.get('R2_ASSETS_'+suffix,'') for key,suffix in [('id','ID'),('endpoint','ENDPOINT'),('bucket','BUCKET'),('publicBaseUrl','PUBLIC_BASE_URL'),('accessKeyId','ACCESS_KEY_ID'),('secretAccessKey','SECRET_ACCESS_KEY'),('sessionToken','SESSION_TOKEN'),('keyPrefix','KEY_PREFIX')]}
assets['id']=assets['id'] or 's3_assets'
assets['bucket']=assets['bucket'] or 'podhub-supplier'
assets['publicBaseUrl']=assets['publicBaseUrl'] or 'https://podhub-supplier.ozon-pod.com'
assert assets['bucket']=='podhub-supplier' and all(assets[key] for key in ['endpoint','accessKeyId','secretAccessKey'])
print(json.dumps({'ai':a[0],'assets':assets}))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['preflight', 'generate'], default='preflight')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    ledger = out / 'provider-attempts.jsonl'
    if args.mode == 'generate' and ledger.exists() and ledger.stat().st_size:
        raise SystemExit('Refusing another paid run: provider attempt ledger already exists.')
    for name in ['storage-preflight.json', args.mode + '.log']:
        previous = out / name
        if previous.exists():
            previous.rename(out / (str(time.time_ns()) + '-' + name))
    with tempfile.TemporaryDirectory(prefix='podhub-ai-live-') as tmp:
        binary = Path(tmp) / 'integration.test'
        subprocess.run(['go', 'test', '-c', '-o', str(binary), './tests/integration'], cwd=repo, check=True)
        # The plaintext is never a tool result, file, argument or environment value.
        credentials = subprocess.check_output(['ssh', 'tx-podhub', 'python3', '-'], input=REMOTE.encode(), stderr=subprocess.DEVNULL)
        selected = json.loads(credentials)
        secrets = [x for part in selected.values() for k, x in part.items()
                   if k in ['apiKey', 'accessKeyId', 'secretAccessKey', 'sessionToken'] and x]
        child_env = os.environ.copy()
        child_env.update(PODHUB_AI_LIVE_MODE=args.mode, PODHUB_AI_LIVE_OUTPUT=str(out), PODHUB_AI_LIVE_REPO=str(repo), PODHUB_PARITY_DSN='')
        completed = subprocess.run([str(binary), '-test.run=^TestAIImageSetsLive$', '-test.v', '-test.timeout=12m'],
                                   cwd=repo, input=credentials, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=child_env)
        output = completed.stdout.decode(errors='replace')
        for secret in secrets:
            output = output.replace(secret, '[REDACTED]')
        # Tests emit only fixed messages/statuses, never HTTP errors containing signed URLs.
        (out / (args.mode + '.log')).write_text(output)
        print('\n'.join(output.splitlines()[-16:]))
        if completed.returncode:
            raise SystemExit(completed.returncode)
        report = out / ('live-validation.json' if args.mode == 'generate' else 'storage-preflight.json')
        if not report.exists() or not json.loads(report.read_text()).get('passed'):
            raise SystemExit('Verification did not produce passing evidence (including skipped tests).')


if __name__ == '__main__':
    main()
