#!/usr/bin/env python3
"""Read-only evidence for the authorized zero-stock test product; no Seller writes."""
import argparse
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import urllib.error
import urllib.request


OFFER = 'podhub-live-validation-f8c58027486c4ad9bd6dbdfd'
SKU = 'scs_43accc9523634d7b8046d36886b7975f'
PRODUCT = 'scp_72d518c6a6a54a81a6a93dce2806ba93'
HOST = 'https://api-seller.ozon.ru'
READS = {
    '/v5/product/info/prices': {'filter': {'offer_id': [OFFER], 'visibility': 'ALL'}, 'limit': 1},
    '/v3/product/info/list': {'offer_id': [OFFER]},
    '/v2/delivery-method/list': {'filter': {'warehouse_ids': ['1020005018305820']}, 'limit': 50},
}

META = r'''
import subprocess,json,shlex,hashlib,re
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
def query(sql):
 raw=subprocess.check_output(['docker','exec','-e','PGOPTIONS=-c default_transaction_read_only=on','podhub-postgres-1','sh','-c','psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c '+shlex.quote(sql)],stderr=subprocess.DEVNULL)
 return json.loads(raw) if raw.strip() else None
data={}
data['source_offer']=query("SELECT json_agg(json_build_object('sku_id',sku_id,'shipping_cost_cents',shipping_cost_cents,'shipping_updated_at_ms',updated_at_ms)) FROM sc_source_offers WHERE sku_id='scs_43accc9523634d7b8046d36886b7975f'")
data['seller_payable_price']=query("SELECT row_to_json(x) FROM (SELECT id AS price_version_id,sku_id,price_cents,created_at_ms,'CNY'::text AS currency FROM sc_price_versions WHERE sku_id='scs_43accc9523634d7b8046d36886b7975f' ORDER BY id DESC LIMIT 1)x")
data['catalog']=query("SELECT json_build_object('product_id',p.product_id,'product_revision',p.revision,'source_id',p.source_id,'pack_weight_g',p.pack_weight_g,'pack_width_mm',p.pack_width_mm,'pack_height_mm',p.pack_height_mm,'pack_depth_mm',p.pack_depth_mm,'product_updated_at_ms',p.updated_at_ms,'sku_id',s.sku_id,'sku_revision',s.revision,'published',p.published AND s.published,'suggested_retail_cents',s.suggested_retail_cents,'suggested_old_price_cents',s.suggested_old_price_cents,'sku_updated_at_ms',s.updated_at_ms,'config_currency',c.values->'fixed:currency_code','config_vat',c.values->'fixed:vat','config_updated_at_ms',c.updated_at_ms) FROM sc_products p JOIN sc_skus s USING(product_id) LEFT JOIN supplier_ozon_configs c USING(product_id) WHERE p.product_id='scp_72d518c6a6a54a81a6a93dce2806ba93' AND s.sku_id='scs_43accc9523634d7b8046d36886b7975f'")
data['shipping_binding']=query("SELECT json_agg(json_build_object('sku_id',b.sku_id,'preset_id',b.preset_id,'version',p.current_version,'payload_keys',(SELECT json_agg(k) FROM jsonb_object_keys(v.payload)k),'updated_at_ms',b.updated_at_ms)) FROM shipping_sku_bindings b JOIN shipping_presets p USING(preset_id) JOIN shipping_preset_versions v ON v.preset_id=p.preset_id AND v.version=p.current_version WHERE b.sku_id='scs_43accc9523634d7b8046d36886b7975f'")
data['fx_observations']=query("SELECT json_build_object('count_rows',(SELECT count(*) FROM store_product_metrics WHERE org_id=8 AND store_pk=39),'fx_groups',(SELECT json_agg(x) FROM (SELECT fx_quote,fx_rate,fx_as_of,fx_source,count(*) AS records,max(fetched_at_ms) AS newest_fetch_ms FROM store_product_metrics WHERE org_id=8 AND store_pk=39 GROUP BY fx_quote,fx_rate,fx_as_of,fx_source ORDER BY newest_fetch_ms DESC LIMIT 5)x),'store_currency',(SELECT currency FROM store_product_sync WHERE org_id=8 AND store_id='735eefeb-dbfb-42ea-8b47-76357a708a6e'))")
data['procurement_count']=query("SELECT json_build_object('count',count(*)) FROM sc_procurements WHERE source_id='src_be86fcac5cbd44faaae650939b66d82a' AND channel_sku='scs_43accc9523634d7b8046d36886b7975f'")
data['shipping_coverage']=query("SELECT json_build_object('published_skus',count(*),'has_seller_price',count(*) FILTER (WHERE EXISTS (SELECT 1 FROM sc_price_versions v WHERE v.sku_id=s.sku_id)),'has_source_shipping',count(*) FILTER (WHERE EXISTS (SELECT 1 FROM sc_source_offers o WHERE o.sku_id=s.sku_id AND o.shipping_cost_cents IS NOT NULL)),'has_shipping_binding',count(*) FILTER (WHERE EXISTS (SELECT 1 FROM shipping_sku_bindings b WHERE b.sku_id=s.sku_id))) FROM sc_skus s JOIN sc_products p USING(product_id) JOIN sc_sources src ON src.source_id=p.source_id WHERE s.published AND p.published AND NOT p.archived AND src.listed")
data['shipping_counts']=query("SELECT json_build_object('presets',(SELECT count(*) FROM shipping_presets),'versions',(SELECT count(*) FROM shipping_preset_versions),'bindings',(SELECT count(*) FROM shipping_sku_bindings))")
env=dict(x.split('=',1) for x in json.loads(subprocess.check_output(['docker','inspect','podhub-cloud-1'],stderr=subprocess.DEVNULL))[0]['Config']['Env'] if '=' in x)
row=query("SELECT json_build_object('revision',revision,'updated_at_ms',updated_at_ms,'nonce',encode(nonce,'hex'),'ciphertext',encode(ciphertext,'hex')) FROM platform_integration_config WHERE singleton=true")
aes=AESGCM(hashlib.sha256(env['CLOUD_INTEGRATION_CONFIG_KEY'].strip().encode()).digest())
try:plain=aes.decrypt(bytes.fromhex(row['nonce']),bytes.fromhex(row['ciphertext']),b'platform_integration_config|v1')
except Exception:plain=aes.decrypt(bytes.fromhex(row['nonce']),bytes.fromhex(row['ciphertext']),None)
snapshot=json.loads(plain); paths=[]
def walk(value,path):
 if isinstance(value,dict):
  for key,item in value.items():
   current=path+'.'+key
   if re.search('shipping|logistic|tariff|freight|exchange|currency|fx',key,re.I):paths.append({'path':current,'type':type(item).__name__,'size':len(item) if isinstance(item,(list,dict)) else None})
   walk(item,current)
 elif isinstance(value,list):
  for item in value:walk(item,path+'[]')
walk(snapshot,'snapshot')
data['integration_metadata']={'revision':row['revision'],'updated_at_ms':row['updated_at_ms'],'root_keys':sorted(snapshot),'matching_field_metadata':paths}
print(json.dumps(data))
'''


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify_target(path, body):
    assert isinstance(body, dict) and isinstance(body.get('items'), list)
    assert len(body['items']) == 1
    item = body['items'][0]
    assert item['offer_id'] == OFFER
    assert item['product_id' if path == '/v5/product/info/prices' else 'id'] == 6706622142
    price = item['price'] if path == '/v5/product/info/prices' else item
    assert price['currency_code'] == 'CNY'
    assert not isinstance(price['price'], bool)
    value = Decimal(str(price['price']))
    assert value.is_finite() and value > 0


def method_metadata(body):
    assert isinstance(body, dict) and isinstance(body.get('delivery_methods'), list)
    allowed = {'id', 'warehouse_id', 'status', 'is_express', 'provider_id', 'template_id',
               'tpl_integration_type', 'delivery_type', 'delivery_costs', 'min_weight',
               'max_weight', 'seller_payment', 'currency_code', 'min_order_price', 'max_order_price'}
    methods = body['delivery_methods']
    assert all(isinstance(item, dict) and item.get('warehouse_id') == 1020005018305820 for item in methods)
    return {'field_keys': sorted(body), 'has_next': body.get('has_next'),
            'delivery_methods': [{'field_keys': sorted(item), **{k: v for k, v in item.items() if k in allowed}}
                                 for item in methods]}


def write_json(path, value, secret):
    encoded = json.dumps(value, ensure_ascii=False, indent=2)
    assert secret not in encoded, 'Refusing to persist a secret'
    path.write_text(encoded + '\n')


def self_check():
    valid = {'items': [{'offer_id': OFFER, 'product_id': 6706622142,
                        'price': {'currency_code': 'CNY', 'price': '62.00'}}]}
    verify_target('/v5/product/info/prices', valid)
    for field, bad in [('offer_id', 'another-offer'), ('product_id', 1)]:
        changed = json.loads(json.dumps(valid))
        changed['items'][0][field] = bad
        try:
            verify_target('/v5/product/info/prices', changed)
        except AssertionError:
            continue
        raise AssertionError('Wrong target accepted')
    methods = method_metadata({'delivery_methods': [{'warehouse_id': 1020005018305820,
                               'id': 1, 'name': 'private name', 'tpl_dropoff_point': {'address': 'private'}}],
                               'has_next': False})
    assert 'name' not in methods['delivery_methods'][0]
    assert 'tpl_dropoff_point' not in methods['delivery_methods'][0]
    assert 'private' not in json.dumps(methods)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--self-check', action='store_true')
    args = parser.parse_args()
    self_check()
    if args.self_check:
        print('source reader self-check passed; no SSH or HTTP calls')
        return
    if args.output is None:
        parser.error('--output is required for live reads')
    root = Path(__file__).resolve().parents[1]
    args.output.mkdir(parents=True, exist_ok=True)
    module = runpy.run_path(str(root / 'scripts/verify-publish-live.py'))
    credentials = json.loads(subprocess.check_output(
        ['ssh', 'tx-podhub', 'python3', '-'], input=module['REMOTE'].encode(), stderr=subprocess.DEVNULL))
    secret = credentials['api_key']
    assert secret and '\r' not in secret and '\n' not in secret
    meta = json.loads(subprocess.check_output(
        ['ssh', 'tx-podhub', 'python3', '-'], input=META.encode(), stderr=subprocess.DEVNULL))
    write_json(args.output / 'cloud-source-readback.json', meta, secret)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    calls = []
    for path, body in READS.items():
        req = urllib.request.Request(HOST + path, json.dumps(body).encode(), {
            'Content-Type': 'application/json', 'Client-Id': credentials['client_id'], 'Api-Key': secret,
        }, method='POST')
        started = datetime.now(timezone.utc).isoformat()
        status, raw, error = 0, b'', None
        try:
            with opener.open(req, timeout=30) as response:
                status = response.status
                raw = response.read((1 << 20) + 1)
        except urllib.error.HTTPError as exc:
            status, raw = exc.code, exc.read((1 << 20) + 1)
        except Exception as exc:
            error = type(exc).__name__
        if len(raw) > 1 << 20:
            raise RuntimeError('Official read exceeded response bound')
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            parsed, error = None, 'non_json_response'
        if status == 200 and path in ('/v5/product/info/prices', '/v3/product/info/list'):
            verify_target(path, parsed)
        if status == 200 and path == '/v2/delivery-method/list':
            parsed = method_metadata(parsed)
        call = {'path': path, 'http_status': status, 'started_at': started,
                'received_at': datetime.now(timezone.utc).isoformat(), 'body': parsed,
                'raw_sha256': hashlib.sha256(raw).hexdigest(), 'error': error}
        write_json(args.output / ('official-' + path.strip('/').replace('/', '-') + '.json'), call, secret)
        calls.append({'path': path, 'http_status': status, 'error': error})
    report = {'completed_at': datetime.now(timezone.utc).isoformat(), 'offer_id': OFFER,
              'scope': 'org8/store39; authorized zero-stock test product only', 'official_reads': calls,
              'database_writes': 0, 'seller_writes': 0, 'credentials_persisted': False,
              'source_offer_cost_excluded': 'Supplier margin-sensitive cost is not seller payable catalog quote and is not exported.',
              'price_basis': 'Current seller-visible catalog procurement quote only; no completed purchase exists for this source/SKU.',
              'ready_for_automatic_profit': False,
              'limits': ['Official fee amounts describe current-price estimates, not settled invoices.',
                         'The RFBS percentage is verified for this product/current price bracket only, not every price bracket.',
                         'CBR observations are reference exchange quotes, not Ozon settlement rates.',
                         'Missing shipping cost or binding is unknown, not zero.',
                         'Acquiring is an amount at the current price, not a verified constant percentage.',
                         'Fulfillment-specific fees must not be mixed or extrapolated to a new price without a tariff model.']}
    write_json(args.output / 'source-validation.json', report, secret)
    print(json.dumps({'official_reads': calls, 'seller_payable_price': meta['seller_payable_price'],
                      'shipping_cost_present': bool(meta['source_offer']) and all(x['shipping_cost_cents'] is not None for x in meta['source_offer']),
                      'shipping_binding_present': bool(meta['shipping_binding']),
                      'seller_writes': 0, 'ready_for_automatic_profit': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
