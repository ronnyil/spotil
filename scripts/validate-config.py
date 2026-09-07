#!/usr/bin/env python3
"""Reject a proxy URL that cannot work from a visitor's browser.

This exists because a local test value - http://127.0.0.1:8795 - was committed
to data/config.json and reached production, where it silently disabled live
data for everyone. The site does not break visibly when this happens: it falls
back to the time-of-day prediction and keeps looking plausible.
"""

import ipaddress
import json
import sys
from urllib.parse import urlparse

CONFIG = "data/config.json"


def problem(url: str) -> str | None:
    if url == "":
        return None  # Running without a proxy is a supported configuration.

    parsed = urlparse(url)

    if parsed.scheme != "https":
        return f"scheme is {parsed.scheme or 'missing'}; a page served over https cannot call it"

    host = parsed.hostname
    if not host:
        return "no host"

    if host in ("localhost", "localhost.localdomain") or host.endswith(".local"):
        return f"{host} is a local name; it resolves to the visitor's own machine"

    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return None  # A public hostname, which is what we want.

    if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved:
        return f"{host} is not reachable from outside the machine that wrote it"

    return None


def main() -> int:
    with open(CONFIG) as handle:
        url = json.load(handle).get("adsbProxy", "")

    fault = problem(url)
    if fault:
        print(f"::error::{CONFIG} adsbProxy is unusable: {fault}")
        print(f"  value: {url!r}")
        return 1

    print(f"adsbProxy ok: {url or '(empty - the site will use the time-of-day prediction)'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
