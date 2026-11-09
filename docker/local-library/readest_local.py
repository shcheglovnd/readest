"""Authenticated Readest API access; configuration lives outside the repository."""
import json
import os
from pathlib import Path
import requests

BASE = Path(os.environ.get('READEST_STATE_DIR', '~/.local/share/readest-library')).expanduser()
ORIGIN = os.environ.get('READEST_URL', 'http://localhost:3000').rstrip('/')
CA = os.environ.get('READEST_CA_BUNDLE') or True


def env():
    config = BASE / '.env'
    values = dict(line.split('=', 1) for line in config.read_text().splitlines()
                  if '=' in line and not line.startswith('#')) if config.exists() else {}
    return {**values, **os.environ}


def response_json(response):
    if not response.ok:
        raise RuntimeError(f'Readest HTTP {response.status_code}: request failed')
    return response.json() if response.content else None


def login():
    session = requests.Session()
    session.verify = CA
    session.trust_env = False
    config = env()
    if config.get('READEST_EMAIL') and config.get('READEST_PASSWORD'):
        credentials = {'email': config['READEST_EMAIL'], 'password': config['READEST_PASSWORD']}
    else:
        credentials = json.loads((BASE / 'private/login.json').read_text())
    data = response_json(session.post(ORIGIN + '/auth/v1/token?grant_type=password',
        headers={'apikey': config['ANON_KEY']}, json=credentials, timeout=30))
    session.headers['Authorization'] = 'Bearer ' + data['access_token']
    return session, data['user']['id'], data


def api(session, method, path, **kwargs):
    return response_json(session.request(method, ORIGIN + path, timeout=90, **kwargs))
