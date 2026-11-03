#!/usr/bin/env python3
"""Verify the public CBR CNY/RUB reference quote; never a settlement quote."""
import argparse
import datetime as dt
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import urllib.request
import xml.etree.ElementTree as ET


def quote(raw, requested):
    if len(raw) > 131072 or b'<!DOCTYPE' in raw or b'<!ENTITY' in raw:
        raise ValueError('Invalid quote document')
    root = ET.fromstring(raw)
    if root.tag != 'ValCurs':
        raise ValueError('Unexpected quote document')
    effective = dt.datetime.strptime(root.attrib['Date'], '%d.%m.%Y').date()
    if not 0 <= (requested - effective).days <= 7:
        raise ValueError('Future or stale quote')
    matches = [item for item in root if item.findtext('CharCode') == 'CNY']
    if len(matches) != 1:
        raise ValueError('Missing or duplicate CNY quote')
    item = matches[0]
    nominal = item.findtext('Nominal', '')
    value = item.findtext('Value', '').replace(',', '.')
    if not nominal.isdecimal() or not 0 < int(nominal) <= 10000:
        raise ValueError('Invalid nominal')
    if not value.replace('.', '', 1).isdecimal() or len(value) > 20:
        raise ValueError('Invalid value')
    rate = Decimal(value) / Decimal(nominal)
    if not rate.is_finite() or not 0 < rate <= 1000000 or rate.as_tuple().exponent < -8:
        raise ValueError('Invalid or imprecise rate')
    return {'base': 'CNY', 'quote': 'RUB', 'base_units': '1',
            'rate': format(rate, 'f'), 'as_of': effective.isoformat(),
            'reported_nominal': nominal, 'reported_value': value}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def self_test():
    day = dt.date(2026, 10, 22)
    sample = b'<ValCurs Date="22.10.2026"><Valute><CharCode>CNY</CharCode><Nominal>10</Nominal><Value>122,8060</Value></Valute></ValCurs>'
    assert quote(sample, day)['rate'] == '12.2806'
    for bad in [sample.replace(b'CNY', b'USD'), sample.replace(b'122,8060', b'NaN'),
                sample.replace(b'>10<', b'>0<'), sample.replace(b'22.10.', b'23.10.'),
                sample.replace(b'22.10.', b'01.10.'), sample + sample]:
        try:
            quote(bad, day)
        except (ValueError, ET.ParseError):
            continue
        raise AssertionError('Invalid quote accepted')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', required=True, type=dt.date.fromisoformat)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--input', type=Path, help='Validate an already captured official XML without network')
    args = parser.parse_args()
    self_test()
    url = 'https://www.cbr.ru/scripts/XML_daily.asp?date_req=' + args.date.strftime('%d/%m/%Y')
    headers, status = {}, None
    if args.input:
        raw = args.input.read_bytes()
    else:
        request = urllib.request.Request(url, headers={'Accept': 'application/xml'})
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
            status = response.status
            headers = {key: response.headers.get(key) for key in ['Date', 'Content-Type']}
            raw = response.read(131073)
        if status != 200:
            raise ValueError('Official quote unavailable')
    rate = quote(raw, args.date)
    args.output.mkdir(parents=True, exist_ok=True)
    body = args.output / 'cbr-quote.xml'
    body.write_bytes(raw)
    assert hashlib.sha256(body.read_bytes()).digest() == hashlib.sha256(raw).digest()
    report = {'passed': True, 'requested_day': args.date.isoformat(), **rate,
              'source': 'cbr', 'source_url': url, 'http_status': status,
              'read_mode': 'archived_xml' if args.input else 'live_https',
              'captured_at': dt.datetime.now(dt.timezone.utc).isoformat(),
              'response_headers': headers, 'body_sha256': hashlib.sha256(raw).hexdigest(),
              'arithmetic': 'Exact decimal reported RUB value divided by reported CNY nominal',
              'settlement_rate_verified': False, 'application_auto_fetch_verified': False,
              'boundary': 'Public reference quote only; no Ozon conversion spread, payout rate or bank fee established.'}
    path = args.output / 'fx-reference-result.json'
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    assert json.loads(path.read_text()) == report
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
