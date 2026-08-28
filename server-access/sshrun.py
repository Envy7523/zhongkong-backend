#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Remote SSH helper for zhongkong-backend Tencent Cloud server.
Usage:
  python sshrun.py exec "command"            # run one remote command
  python sshrun.py upload local remote       # upload one file/dir
  python sshrun.py download remote local     # download one file
Auth priority:
  1) SERVER_KEY env var -> path to private key file
  2) private key file named 'zhongkong_company' next to this script
  3) SERVER_PASS env var -> password
Host/user also from env: SERVER_HOST, SERVER_USER.
"""
import os
import sys
import paramiko

HOST = os.environ.get("SERVER_HOST", "134.175.41.247")
USER = os.environ.get("SERVER_USER", "ubuntu")
PASS = os.environ.get("SERVER_PASS", "")
PORT = int(os.environ.get("SERVER_PORT", "22"))

_HERE = os.path.dirname(os.path.abspath(__file__))
_KEY_CANDIDATES = [
    os.environ.get("SERVER_KEY", ""),
    os.path.join(_HERE, "zhongkong_company"),
    os.path.join(_HERE, "..", ".ssh", "zhongkong_company"),
]
KEY_FILE = next((p for p in _KEY_CANDIDATES if p and os.path.exists(p)), "")


def get_client():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    if KEY_FILE:
        c.connect(HOST, port=PORT, username=USER, key_filename=KEY_FILE,
                  timeout=30, banner_timeout=30)
    else:
        c.connect(HOST, port=PORT, username=USER, password=PASS,
                  timeout=30, banner_timeout=30)
    return c


def exec_cmd(client, cmd, timeout=1800):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout, get_pty=False)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    return code, out, err


def sftp_put_dir(sftp, local_dir, remote_dir):
    sftp.mkdir(remote_dir)
    for name in os.listdir(local_dir):
        lp = os.path.join(local_dir, name)
        rp = remote_dir.rstrip("/") + "/" + name
        if os.path.isdir(lp):
            try:
                sftp.mkdir(rp)
            except IOError:
                pass
            sftp_put_dir(sftp, lp, rp)
        else:
            sftp.put(lp, rp)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    cmd = sys.argv[1]
    if cmd == "exec":
        remote_cmd = sys.argv[2]
        c = get_client()
        code, out, err = exec_cmd(c, remote_cmd)
        print(out, end="")
        if err:
            print("[stderr]", err, end="", file=sys.stderr)
        print(f"[exit code: {code}]")
        c.close()
        sys.exit(0 if code == 0 else 1)
    elif cmd == "upload":
        local, remote = sys.argv[2], sys.argv[3]
        c = get_client()
        sftp = c.open_sftp()
        if os.path.isdir(local):
            sftp_put_dir(sftp, local, remote)
        else:
            sftp.put(local, remote)
        sftp.close()
        c.close()
        print(f"uploaded {local} -> {remote}")
    elif cmd == "download":
        local, remote = sys.argv[3], sys.argv[2]
        c = get_client()
        sftp = c.open_sftp()
        sftp.get(remote, local)
        sftp.close()
        c.close()
        print(f"downloaded {remote} -> {local}")
    else:
        print("unknown cmd", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
