#!/usr/bin/env python3
"""Opt-in publication preflight and one reviewed import; credentials use stdin only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

REMOTE = r'''
import subprocess,json,hashlib,hmac,shlex
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
run=lambda args: subprocess.check_output(args,stderr=subprocess.DEVNULL)
env=dict(x.split('=',1) for x in json.loads(run(['docker','inspect','podhub-cloud-1']))[0]['Config']['Env'] if '=' in x)
def query(sql):
 return json.loads(run(['docker','exec','-e','PGOPTIONS=-c default_transaction_read_only=on','podhub-postgres-1','sh','-c','psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c '+shlex.quote(sql)]))
row=query("SELECT json_build_object('client_id',s.client_id,'revision',s.credential_revision,'key_id',c.key_id,'nonce',encode(c.nonce,'hex'),'ciphertext',encode(c.ciphertext,'hex'),'wrapped',encode(c.wrapped_dek,'hex'),'dek_nonce',encode(c.dek_nonce,'hex'),'fingerprint',encode(c.key_fingerprint,'hex')) FROM organization_stores s JOIN store_seller_credentials c ON c.org_id=s.org_id AND c.store_id=s.id AND c.credential_revision=s.credential_revision WHERE s.org_id=8 AND s.id=39 AND s.uuid='735eefeb-dbfb-42ea-8b47-76357a708a6e' AND s.client_id='4877007' AND s.deleted_at_ms IS NULL AND NOT s.manual_disabled AND NOT s.quota_suspended AND (c.key_expires_at_ms IS NULL OR c.key_expires_at_ms > (extract(epoch from clock_timestamp())*1000)::bigint)")
key=hashlib.sha256(env['CLOUD_SELLER_CREDENTIAL_KEY'].strip().encode()).digest()
keys=[key]
current_id=env.get('CLOUD_SELLER_CREDENTIAL_KEY_ID') or 'k1'
if row['key_id']!=current_id and env.get('CLOUD_SELLER_CREDENTIAL_KEY_PREVIOUS','').strip(): keys.append(hashlib.sha256(env['CLOUD_SELLER_CREDENTIAL_KEY_PREVIOUS'].strip().encode()).digest())
aad=('store_seller_credential|v1|8|39|'+str(row['revision'])).encode()
plain=None
for candidate in keys:
 try:
  payload_key=candidate
  if row.get('wrapped') and row.get('dek_nonce'):
   wrap=('store_seller_dek|v2|8|39|'+row['key_id']).encode()
   payload_key=AESGCM(candidate).decrypt(bytes.fromhex(row['dek_nonce']),bytes.fromhex(row['wrapped']),wrap)
  plain=AESGCM(payload_key).decrypt(bytes.fromhex(row['nonce']),bytes.fromhex(row['ciphertext']),aad)
  break
 except Exception: pass
assert plain is not None
client,api_key=plain.decode().split('\0',1)
assert client==row['client_id']
pepper=hmac.new(key,b'seller-credential-fingerprint',hashlib.sha256).digest()
assert hmac.compare_digest(hmac.new(pepper,plain,hashlib.sha256).hexdigest(),row['fingerprint'])
print(json.dumps({'client_id':client,'api_key':api_key}))
'''


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
    source = out if (out / 'candidate-publication-input.json').exists() else out.parent
    if args.mode == 'submit':
        if args.approved_plan is None or not args.approved_sha256:
            raise SystemExit('Submit requires an explicitly reviewed plan and its exact SHA256.')
        approved = args.approved_plan.resolve()
        if hashlib.sha256(approved.read_bytes()).hexdigest() != args.approved_sha256:
            raise SystemExit('Reviewed request bytes changed.')
        if (source / 'seller-write-attempts.jsonl').exists():
            raise SystemExit('Refusing another dispatch: this validation already has an attempt ledger.')
    with tempfile.TemporaryDirectory(prefix='podhub-publish-live-') as tmp:
        binary = Path(tmp) / 'integration.test'
        subprocess.run(['go', 'test', '-c', '-o', str(binary), './tests/integration'], cwd=root, check=True)
        credentials = subprocess.check_output(['ssh', 'tx-podhub', 'python3', '-'], input=REMOTE.encode(), stderr=subprocess.DEVNULL)
        selected = json.loads(credentials)
        secrets = [selected['api_key']]
        child_env = os.environ.copy()
        child_env.update(PODHUB_PUBLISH_LIVE_MODE=args.mode, PODHUB_PUBLISH_LIVE_OUTPUT=str(out), PODHUB_PUBLISH_SOURCE_DIR=str(source), PODHUB_PARITY_DSN='')
        if args.mode == 'submit':
            child_env.update(PODHUB_PUBLISH_APPROVED_PLAN=str(approved), PODHUB_PUBLISH_APPROVED_SHA256=args.approved_sha256)
        result = subprocess.run([str(binary), '-test.run=^TestListingPublishLive$', '-test.v', '-test.timeout=12m'],
                                cwd=root, env=child_env, input=credentials, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        log = result.stdout.decode(errors='replace')
        for secret in secrets:
            log = log.replace(secret, '[REDACTED]')
        (out / ('publication-' + args.mode + '.log')).write_text(log)
        print('\n'.join(log.splitlines()[-16:]))
        if result.returncode:
            raise SystemExit(result.returncode)
        report = out / ('publication-' + args.mode + '.json')
        if not report.exists() or not json.loads(report.read_text()).get('passed'):
            raise SystemExit('Preflight did not pass; no Seller write is authorized by this runner.')


if __name__ == '__main__':
    main()
