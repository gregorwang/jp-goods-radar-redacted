"""Bounded AmiAmi-only HTTP transport. Credentials never pass through jobs."""
import base64
import json
import os
import sys
from urllib.parse import urlsplit

from curl_cffi import requests

MAX_BYTES = 1_700_000


def main():
    payload = sys.stdin.buffer.read(16_385)
    if len(payload) > 16_384:
        raise ValueError("request_too_large")
    url = json.loads(payload)["url"]
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname != "api.amiami.com"
            or parsed.username or parsed.password or parsed.port
            or parsed.fragment or parsed.path not in ("/api/v1.0/items", "/api/v1.0/item")):
        raise ValueError("url_rejected")
    proxy = os.environ.get("AMIAMI_PROXY_URL") or None
    with requests.Session(impersonate="chrome", proxy=proxy, trust_env=False) as session:
        with session.stream("GET", url, headers={"X-User-Key": "amiami_dev", "Accept": "application/json",
                         "Referer": "https://www.amiami.com/", "Origin": "https://www.amiami.com"},
                         timeout=20, allow_redirects=False) as response:
            body = bytearray()
            for chunk in response.iter_content():
                if len(body) + len(chunk) > MAX_BYTES:
                    raise ValueError("response_too_large")
                body.extend(chunk)
            headers = {k.lower(): v for k, v in response.headers.items()
                       if k.lower() in ("content-type", "location", "retry-after", "cf-ray")}
            print(json.dumps({"status": response.status_code, "headers": headers,
                              "body": base64.b64encode(body).decode("ascii")}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # curl exceptions may embed proxy credentials; report only a safe type.
        reason = str(error) if isinstance(error, ValueError) and str(error) in (
            "url_rejected", "response_too_large", "request_too_large") else type(error).__name__
        print(json.dumps({"error": reason}))
        sys.exit(1)
