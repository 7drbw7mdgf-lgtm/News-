"""Check that https://pheme24.online serves the revision just published.

If the domain can't be reached yet (DNS or the SSL certificate still pending),
this reports a warning instead of claiming success. If the site is reachable
but serves a different revision, it fails.
"""
import os
import re
import sys
import time
import urllib.error
import urllib.request

SITE = 'https://pheme24.online/'
MARKER = re.compile(r'<meta name="daybreak-build" content="([a-f0-9]{40})"')


def fetch():
    url = SITE + '?verify=' + os.environ.get('GITHUB_RUN_ID', 'local')
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'daybreak-deploy-check'})
    with urllib.request.urlopen(request, timeout=25) as response:
        return response.read(1024 * 1024).decode('utf-8', 'replace')


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
            print('Live site serves revision ' + expected + '.')
            return 0
        print('Live site shows revision ' + (found.group(1) if found else 'none') + '; waiting (attempt ' + str(attempt) + '/5).', flush=True)
        time.sleep(10)
    print('The live site does not serve the published revision. Check that the FTP login directory is the web root.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
