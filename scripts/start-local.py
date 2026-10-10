"""Start a loopback-only server that survives the calling terminal session."""

from pathlib import Path
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
URL = "http://127.0.0.1:8000/"
LOG = Path(tempfile.gettempdir()) / "qlnhanh-local-server.log"


def running():
    try:
        with urlopen(URL, timeout=1) as response:
            if b"LE CORNER Inventory" not in response.read(4096):
                raise RuntimeError("Port 8000 belongs to another application.")
        return True
    except URLError:
        return False


if running():
    print("LE CORNER is already running: http://localhost:8000/")
else:
    with LOG.open("ab") as log:
        process = subprocess.Popen(
            [sys.executable, "-m", "http.server", "8000", "--bind", "127.0.0.1"],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
    for _ in range(20):
        if running():
            print(f"LE CORNER is running: http://localhost:8000/ (PID {process.pid})")
            break
        if process.poll() is not None:
            raise RuntimeError(f"Server failed to start; see {LOG}")
        time.sleep(0.1)
    else:
        raise RuntimeError(f"Server did not respond; see {LOG}")
