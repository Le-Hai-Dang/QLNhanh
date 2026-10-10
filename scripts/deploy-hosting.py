"""Run in the authenticated Google Cloud Shell; Firebase Hosting REST only."""
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

PROJECT = SITE = "qlnhanh"
ROOT = Path(__file__).resolve().parents[1]
FILES = ["index.html", "styles.css", "firebase-config.js", "js/app.js", "js/domain.js", "js/repository.js"]
API = "https://firebasehosting.googleapis.com/v1beta1/"


def deploy():
    # Capture the ephemeral token in memory only; never print or persist it.
    token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
    if not token:
        raise RuntimeError("Cloud Shell must already be authorized.")

    def request(url, method="GET", data=None, binary=False):
        if urlparse(url).hostname not in ("firebasehosting.googleapis.com", "upload-firebasehosting.googleapis.com"):
            raise RuntimeError("Unexpected Hosting endpoint")
        payload = data if binary else (json.dumps(data).encode() if data is not None else None)
        headers = {"Authorization": "Bearer " + token,
                   "Content-Type": "application/octet-stream" if binary else "application/json"}
        with urlopen(Request(url, data=payload, headers=headers, method=method), timeout=120) as response:
            body = response.read()
            return json.loads(body) if body and not binary else None

    sites = request(API + f"projects/{PROJECT}/sites").get("sites", [])
    if not any(s.get("name") == f"projects/{PROJECT}/sites/{SITE}" for s in sites):
        raise RuntimeError("Expected existing qlnhanh Hosting site is missing; no site created.")
    contents, hashes = {}, {}
    for name in FILES:
        compressed = gzip.compress((ROOT / name).read_bytes(), mtime=0)
        digest = hashlib.sha256(compressed).hexdigest()
        contents[digest] = compressed
        hashes["/" + name] = digest
    config = {"headers": [{"glob": "**", "headers": {"Cache-Control": "no-cache"}}]}
    version = request(API + f"sites/{SITE}/versions", "POST", {"config": config})["name"]
    print("Created", version, flush=True)
    upload = request(API + version + ":populateFiles", "POST", {"files": hashes})
    for digest in upload.get("uploadRequiredHashes", []):
        request(upload["uploadUrl"] + "/" + digest, "POST", contents[digest], binary=True)
    finalized = request(API + version + "?update_mask=status", "PATCH", {"status": "FINALIZED"})
    if finalized.get("status") != "FINALIZED":
        raise RuntimeError("Version was not finalized; no release created.")
    release = request(API + f"sites/{SITE}/releases?" + urlencode({"versionName": version}), "POST", {})
    print(json.dumps({"release": release.get("name"), "releaseTime": release.get("releaseTime"),
                      "version": version, "fileCount": len(FILES), "url": f"https://{SITE}.web.app"}))


if __name__ == "__main__":
    deploy()
