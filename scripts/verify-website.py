"""Check that https://pheme24.online serves the revision just published.

If the domain can't be reached yet (DNS or the SSL certificate still pending),
this reports a warning instead of claiming success. If the site is reachable
but serves a different revision, it fails.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

SITE = 'https://pheme24.online/'
PHEMICA_INPUT = 'api/phemica/v1/input.json'
MARKER = re.compile(r'<meta name="daybreak-build" content="([a-f0-9]{40})"')


def fetch(path='', limit=1024 * 1024):
    url = SITE + path + '?verify=' + os.environ.get('GITHUB_RUN_ID', 'local')
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'daybreak-deploy-check'})
    with urllib.request.urlopen(request, timeout=25) as response:
        return response.read(limit).decode('utf-8', 'replace')


def main():
    expected = os.environ.get('EXPECTED_REVISION', '')
    for attempt in range(1, 6):
        try:
            body = fetch()
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            reason = getattr(error, 'reason', error)
            print('::warning::Files were uploaded, but ' + SITE + ' could not be checked yet (' +
                  type(reason).__name__ + '). This is expected while DNS or the SSL certificate is still pending.')
            return 0
        found = MARKER.search(body)
        if found and found.group(1) == expected:
            try:
                feed = json.loads(fetch(PHEMICA_INPUT, limit=12 * 1024 * 1024))
                if (feed.get('schemaVersion') == 1 and feed.get('siteRevision') == expected
                        and isinstance(feed.get('articles'), list) and feed['articles']
                        and isinstance(feed.get('planEvents'), list)):
                    print('Live site and Phemica input serve revision ' + expected + '.')
                    return 0
                print('Phemica input revision or schema is not ready.', flush=True)
            except (urllib.error.URLError, TimeoutError, OSError, ValueError, AttributeError) as error:
                print('Phemica input check failed: ' + type(error).__name__, flush=True)
        else:
            print('Live site shows revision ' + (found.group(1) if found else 'none') + '.', flush=True)
        if attempt < 5:
            print('Waiting before attempt ' + str(attempt + 1) + '/5.', flush=True)
            time.sleep(10)
    print('The live site or Phemica feed does not serve the published revision. Check the build and the FTP web root.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
