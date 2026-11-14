#!/usr/bin/env python3
"""Run cloudflared in the foreground; save the last observed Quick Tunnel URL."""
import argparse
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess

from room import private_dir, private_write, room_url


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', required=True, type=Path)
    parser.add_argument('--room-url')
    local = Path.home() / '.local/bin/cloudflared'
    parser.add_argument('--cloudflared', default=str(local) if local.is_file() else shutil.which('cloudflared'))
    parser.add_argument('extra', nargs=argparse.REMAINDER, help='Additional cloudflared args after --')
    args = parser.parse_args()
    if not args.cloudflared:
        parser.error('cloudflared is not installed; provide --cloudflared')
    directory = private_dir(args.state_dir)
    url = room_url(directory, args.room_url)
    saved_url = directory / 'tunnel-url.txt'
    saved_url.unlink(missing_ok=True)
    extra = args.extra[1:] if args.extra[:1] == ['--'] else args.extra
    command = [args.cloudflared, 'tunnel', '--no-autoupdate', '--url', url, '--protocol', 'http2', *extra]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        signal.signal(signal.SIGTERM, signal.default_int_handler)
        for line in process.stdout:
            match = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', line)
            if match:
                private_write(saved_url, match.group(0) + '\n')
            print(line, end='', flush=True)
        return process.wait()
    except KeyboardInterrupt:
        return 130
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == '__main__':
    raise SystemExit(main())
