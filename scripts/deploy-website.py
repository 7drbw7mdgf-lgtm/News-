"""Publish the built Daybreak site to Fasthosts over explicit FTPS.

Same approach as Sparkboard's deployment:
- explicit FTPS with certificate and hostname validation, encrypted data connections;
- the FTP master account's login directory is the destination (not htdocs);
- every file is uploaded under a temporary name, read back and checked by
  SHA-256, then renamed into place; nothing live is ever deleted;
- the previous homepage is backed up and index.html is published last.
"""
import ftplib
import hashlib
import io
import json
import os
import ssl
import sys
import time
from pathlib import Path, PurePosixPath

HOST = 'ftp.fasthosts.co.uk'
PORT = 21
USERNAME = 'pheme24.online'
BACKUP_DIR = '_daybreak'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def connect(password):
    try:
        return _connect(password, 'utf-8')
    except ftplib.error_perm as error:
        # A password with characters such as £ is sent as different bytes in
        # UTF-8 and Latin-1; servers differ in which they expect. Try both.
        if str(error).startswith('530') and not password.isascii():
            print('Login refused with UTF-8; retrying with Latin-1 encoding.', flush=True)
            try:
                return _connect(password, 'latin-1')
            except ftplib.error_perm as second:
                error = second
        code = str(error)[:3]
        raise ValueError('FTPS master-account login failed (reply ' + (code if code.isdigit() else '?') + ').') from None


def _connect(password, encoding):
    ftp = ftplib.FTP_TLS(context=ssl.create_default_context(), timeout=30, encoding=encoding)
    stage = 'connection'
    try:
        ftp.connect(HOST, PORT)
        stage = 'master-account login'
        ftp.login(USERNAME, password)
        stage = 'encrypted data setup'
        ftp.prot_p()  # encrypt file transfers, not just the login
    except ftplib.error_perm:
        ftp.close()
        if stage == 'master-account login':
            raise  # let connect() decide whether to retry with another encoding
        raise ValueError('FTPS ' + stage + ' failed.') from None
    except ftplib.Error as error:
        ftp.close()
        code = str(error)[:3]
        raise ValueError('FTPS ' + stage + ' failed (reply ' + (code if code.isdigit() else '?') + ').') from None
    except Exception:
        ftp.close()
        raise
    return ftp


def read_remote(ftp, name):
    """Return the remote file's bytes, or None if it does not exist."""
    data = io.BytesIO()
    try:
        ftp.retrbinary('RETR ' + name, data.write)
    except ftplib.error_perm as error:
        if str(error).startswith('550'):
            return None
        raise
    return data.getvalue()


def remote_size(ftp, name):
    """Return the remote file's byte length, or None if unavailable."""
    try:
        return ftp.size(name)
    except ftplib.error_perm:
        return None


def read_manifest(ftp):
    raw = read_remote(ftp, BACKUP_DIR + '/manifest.json')
    if not raw:
        return {}
    try:
        parsed = json.loads(raw.decode('utf-8'))
        return parsed if isinstance(parsed, dict) else {}
    except (UnicodeDecodeError, ValueError):
        return {}


def ensure_directory(ftp, directory):
    try:
        ftp.mkd(directory)
    except ftplib.error_perm:
        previous = ftp.pwd()
        ftp.cwd(directory)  # raises if it exists but is not a directory
        ftp.cwd(previous)


def atomic_write(ftp, path, data, tag):
    temporary = path + '.daybreak-' + tag
    ftp.storbinary('STOR ' + temporary, io.BytesIO(data))
    if digest(read_remote(ftp, temporary) or b'') != digest(data):
        raise ValueError('Upload checksum mismatch for ' + path + '.')
    ftp.rename(temporary, path)  # same-directory rename; never delete first


def collect(build):
    files = []
    for local in sorted(Path(build).rglob('*')):
        if local.is_symlink():
            raise ValueError('Refusing to publish a symbolic link.')
        if local.is_file():
            name = local.relative_to(build).as_posix()
            parts = PurePosixPath(name).parts
            if '..' in parts or name.startswith('/') or '\\' in name:
                raise ValueError('Unsafe public file path.')
            files.append((name, local.read_bytes()))
    names = [n for n, _ in files]
    if 'index.html' not in names:
        raise ValueError('Build has no index.html.')
    return files


def choose_root(ftp, server_dir):
    print('FTP login directory: ' + ftp.pwd(), flush=True)
    if server_dir:
        ftp.cwd(server_dir)
        print('Using configured directory: ' + ftp.pwd(), flush=True)
        return
    listing = [PurePosixPath(n).name.lower() for n in ftp.nlst()]
    if 'htdocs' in listing:
        raise ValueError(
            'The FTP login directory contains an htdocs folder, so it is not the web root. '
            'No files were changed. Set the repository variable FTP_SERVER_DIR to htdocs and re-run.')


def deploy(ftp, build, tag, server_dir=''):
    files = collect(build)  # validate everything before touching the server
    choose_root(ftp, server_dir)
    ensure_directory(ftp, BACKUP_DIR)
    previous = read_remote(ftp, 'index.html')
    if previous is not None:
        ftp.storbinary('STOR ' + BACKUP_DIR + '/previous-index-' + tag + '.html', io.BytesIO(previous))
        print('Backed up the existing homepage.', flush=True)
    made, uploaded, skipped = set(), 0, 0
    remote_manifest = read_manifest(ftp)
    next_manifest = dict(remote_manifest)
    index = None
    for name, data in files:
        if name == 'index.html':
            index = data
            continue
        parent = PurePosixPath(name).parent
        for directory in reversed([parent, *parent.parents]):
            d = str(directory)
            if d != '.' and d not in made:
                ensure_directory(ftp, d)
                made.add(d)
        local_hash = digest(data)
        if remote_manifest.get(name) == local_hash and remote_size(ftp, name) == len(data):
            skipped += 1
            continue
        if digest(read_remote(ftp, name) or b'') == local_hash:
            next_manifest[name] = local_hash
            skipped += 1
            continue
        atomic_write(ftp, name, data, tag)
        next_manifest[name] = local_hash
        uploaded += 1
    next_manifest['index.html'] = digest(index)
    manifest_bytes = json.dumps(next_manifest, sort_keys=True, separators=(',', ':')).encode('utf-8')
    atomic_write(ftp, BACKUP_DIR + '/manifest.json', manifest_bytes, tag)
    atomic_write(ftp, 'index.html', index, tag)  # homepage last
    print('Uploaded ' + str(uploaded + 1) + ' files (' + str(skipped) + ' unchanged skipped); index.html published last.', flush=True)


def publish_with_retries(build, password, tag, server_dir, attempts=4):
    transient = (ssl.SSLEOFError, ConnectionResetError, BrokenPipeError, TimeoutError, EOFError, ftplib.error_temp)
    for attempt in range(1, attempts + 1):
        ftp = connect(password)
        try:
            deploy(ftp, build, tag, server_dir)
            return
        except transient as error:
            if attempt >= attempts:
                raise
            print('Temporary FTPS disconnect (' + type(error).__name__ + '); retrying ' +
                  str(attempt + 1) + '/' + str(attempts) + '.', flush=True)
            time.sleep(min(2 ** attempt, 8))
        finally:
            try:
                ftp.quit()
            except Exception:
                ftp.close()


def main():
    password = os.environ.get('FASTHOSTS_FTP_PASSWORD', '')
    if not password:
        raise ValueError('Set the FASTHOSTS_FTP_PASSWORD secret in the fasthosts-production environment first '
                         '(the pheme24.online FTP master password).')
    tag = os.environ.get('GITHUB_RUN_ID', 'local') + '-' + os.environ.get('GITHUB_RUN_ATTEMPT', '1')
    build = Path(__file__).resolve().parent.parent / 'build' / 'site'
    publish_with_retries(build, password, tag, os.environ.get('FTP_SERVER_DIR', '').strip())


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print connection parameters or library output that could contain credentials.
        if isinstance(error, ValueError):
            print(str(error), file=sys.stderr)
        else:
            print('Website deployment failed (' + type(error).__name__ + '). Check FTP access and the TLS connection.', file=sys.stderr)
        sys.exit(1)
