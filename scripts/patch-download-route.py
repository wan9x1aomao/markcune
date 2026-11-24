#!/usr/bin/env python3
"""Remove an inherited Nginx rate cap from the self-hosted installer route."""
from pathlib import Path
import os
import shutil
import subprocess
import sys


ROUTES = Path("/etc/nginx/snippets/wsmknows-routes.conf")
BACKUP = Path("/root/wsmknows-deploy-backups/download-rate/routes.conf")
LOCATION = "location ~* ^/[a-z0-9-]+/downloads/[^/]+\\.(?:dmg|exe|deb|appimage|tar\\.gz)$ {"
MARKER = "    try_files $uri =404;\n"


def main():
    source = ROUTES.read_text()
    if "limit_rate 0;" in source and "limit_rate_after 0;" in source:
        print("下载路由已取消继承限速")
        return
    start = source.find(LOCATION)
    if start < 0:
        raise RuntimeError(f"下载路由不存在：{ROUTES}")
    marker_at = source.find(MARKER, start)
    if marker_at < 0:
        raise RuntimeError(f"下载路由缺少 try_files：{ROUTES}")

    insertion = (
        MARKER
        + "    # Installer downloads must not inherit a global per-connection rate cap.\n"
        + "    limit_rate 0;\n"
        + "    limit_rate_after 0;\n"
    )
    updated = source[:marker_at] + source[marker_at:].replace(MARKER, insertion, 1)
    BACKUP.parent.mkdir(parents=True, exist_ok=True)
    if not BACKUP.exists():
        shutil.copy2(ROUTES, BACKUP)
    temporary = ROUTES.with_name(ROUTES.name + ".next")
    temporary.write_text(updated)
    try:
        subprocess.run(["nginx", "-t"], check=True)
        os.replace(temporary, ROUTES)
        subprocess.run(["nginx", "-t"], check=True)
        subprocess.run(["systemctl", "reload", "nginx"], check=True)
    except Exception:
        if temporary.exists():
            temporary.unlink()
        shutil.copy2(BACKUP, ROUTES)
        raise
    print(f"已更新 {ROUTES}，备份保存在 {BACKUP}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"下载路由更新失败：{error}", file=sys.stderr)
        raise SystemExit(1)
